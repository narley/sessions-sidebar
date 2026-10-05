import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  CheckoutRow,
  KindFilter,
  ClosedRow,
  DetailLevel,
  DormantRow,
  RepoOption,
  Section,
  SessionRow,
} from '../types'

const PANE = 'sessions-sidebar'
const PANE_COLUMNS = 34
const REFRESH_MS = 3000
const rows = atom({ plugin: 'sessions-sidebar', key: 'rows' } as const, [])
const dormantRows = atom({ plugin: 'sessions-sidebar', key: 'dormant' } as const, [])
const closedRows = atom({ plugin: 'sessions-sidebar', key: 'closed' } as const, [])
const checkoutRows = atom({ plugin: 'sessions-sidebar', key: 'checkout' } as const, [])
// Ad hoc lists its sessions used this recently; older ones are offered in pages from a menu
const RECENT_MS = 7 * 24 * 3_600_000
const OLDER_PAGE_SIZE = 10
// what the older sessions' menu is filtered by, as typed; this sidebar's own
const olderSearch = atom({ plugin: 'sessions-sidebar', key: 'olderSearch' } as const, '')
// the repos the sidebar shows, and every repo there is to pick from
const repoChoice = atom({ plugin: 'sessions-sidebar', key: 'repos' } as const, {
  selected: [],
  options: [],
})
// what the repo menu is filtered by, as typed; this sidebar's own
const repoSearch = atom({ plugin: 'sessions-sidebar', key: 'repoSearch' } as const, '')
// each section's search as typed, while its ⌕ has it open; this sidebar's own
const sectionSearches = atom({ plugin: 'sessions-sidebar', key: 'searches' } as const, {})
// ids of closed sessions moved to Archived, shared by every session's sidebar
const archivedIds = atom({ plugin: 'sessions-sidebar', key: 'archived' } as const, [])
const SECTIONS: Section[] = ['live', 'dormant', 'closed']
// how a section starts until someone folds or opens it: Done only grows, and is the least looked at
const IS_COLLAPSED_BY_DEFAULT: Record<Section, boolean> = {
  live: false,
  dormant: false,
  closed: true,
}
// which of a section's two kinds it lists: those with a worktree, and ad hoc ones without
const KIND_FILTERS: { id: KindFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'worktrees', label: 'Worktrees' },
  { id: 'adhoc', label: 'Ad hoc' },
]
// each section's, shared by every session's sidebar like the detail level; absent is all
const sectionFilters = atom({ plugin: 'sessions-sidebar', key: 'filters' } as const, {})
// New Session's picker while open: the profile's default model, each model's saved effort, and the
// effort picked for this launch (absent: each keeps its saved one); this sidebar's own
const newSessionMenu = atom({ plugin: 'sessions-sidebar', key: 'newSession' } as const, null)
// what New Session offers, by the alias `claude --model` takes and the key settings saves effort under
const NEW_SESSION_MODELS = [
  { model: 'opus[1m]', family: 'opus', label: 'Opus 5.5 1M', settingsKey: 'claude-opus-5-5' },
  { model: 'sonnet', family: 'sonnet', label: 'Sonnet 5.5', settingsKey: 'claude-sonnet-5-5' },
  { model: 'fable', family: 'fable', label: 'Fable 5.1', settingsKey: 'claude-fable-5-1' },
  { model: 'haiku', family: 'haiku', label: 'Haiku 4.5', settingsKey: 'claude-haiku-4-5' },
]
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const DEFAULT_COLLAPSED = SECTIONS.filter(section => IS_COLLAPSED_BY_DEFAULT[section])
const collapsedSections = atom(
  { plugin: 'sessions-sidebar', key: 'collapsed' } as const,
  DEFAULT_COLLAPSED,
)
// how much each live session shows, shared by every session's sidebar
const DETAIL_LEVELS: DetailLevel[] = ['compact', 'standard', 'full']
const detailLevel = atom({ plugin: 'sessions-sidebar', key: 'detail' } as const, 'full')
// how many blocks (a heading, a session) the list is scrolled past
const listOffset = atom({ plugin: 'sessions-sidebar', key: 'offset' } as const, 0)
// flips each PULSE_MS while a session runs ioi-autopilot, swapping its card's colours
const PULSE_MS = 1000
const pulse = atom({ plugin: 'sessions-sidebar', key: 'pulse' } as const, false)
// the account's 5h and 7d windows and this session's prompt cache, drawn above New Session
const usageInfo = atom({ plugin: 'sessions-sidebar', key: 'usage' } as const, { limits: [] })
// the one question the sidebar is asking, drawn under the row its key names
const question = atom({ plugin: 'sessions-sidebar', key: 'question' } as const, null)
// set by each render, read by the scroll hook, which has no layout of its own to clamp against
let maxListOffset = 0

// shape of <config dir>/sessions/<pid>.json, the engine's registry of running sessions
type RegisteredSession = {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  kind: string
  name?: string
  status?: string
  // set while Remote Control is on, null once it is turned off
  bridgeSessionId?: string | null
  // how it was started: `cli` in a terminal, `sdk-py`/`sdk-ts` when a script drives it
  entrypoint?: string
}

type Worktree = { path: string; branch?: string; repo: string; isMain: boolean }

const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path

const placeOf = (cwd: string) => {
  const worktree = /\/\.claude\/worktrees\/([^/]+)/.exec(cwd)

  return worktree ? `worktree ${worktree[1]}` : baseName(cwd)
}

const isInside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`)

const ticketOf = (text: string | undefined) =>
  text === undefined ? undefined : /^(\d+)(?:-|$)/.exec(text)?.[1]

const configDirOf = async ($: EngineInterface) =>
  (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`

// how Claude Code names a folder's transcript directory under <config dir>/projects
const projectKeyOf = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-')

const transcriptOf = (configDir: string, one: RegisteredSession) =>
  `${configDir}/projects/${projectKeyOf(one.cwd)}/${one.sessionId}.jsonl`

const tailOf = async ($: EngineInterface, configDir: string, one: RegisteredSession) =>
  (
    await $.process
      .run(['tail', '-c', '262144', transcriptOf(configDir, one)])
      .catch(() => undefined)
  )?.stdout ?? ''

// the registry keeps the launch folder; the transcript's newest cwd is where the session works now
const currentCwdIn = (tail: string, one: RegisteredSession) =>
  [...tail.matchAll(/"cwd":"([^"]+)"/g)].at(-1)?.[1] ?? one.cwd

type CacheWrites = { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }

// the prompt cache lives for its lifetime (1h or 5m, by the kind of cache write the responses made)
// past the last API response
const cacheExpiryIn = (tail: string) => {
  const responses = tail.split('\n').flatMap(line => {
    if (!line.includes('"type":"assistant"') || !line.includes('"cache_creation"')) return []
    try {
      const entry = JSON.parse(line) as {
        timestamp?: string
        message?: { usage?: { cache_creation?: CacheWrites } }
      }

      return entry.timestamp === undefined ? [] : [entry]
    } catch {
      return []
    }
  })
  const last = responses.at(-1)
  if (last?.timestamp === undefined) return undefined
  const isHourLong = responses.some(
    one => (one.message?.usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0,
  )

  return Date.parse(last.timestamp) + (isHourLong ? 3_600_000 : 300_000)
}

const worktreesOf = async ($: EngineInterface, cwd: string): Promise<Worktree[]> => {
  const listed = await $.process
    .run(['git', '-C', cwd, 'worktree', 'list', '--porcelain'])
    .catch(() => undefined)
  if (listed === undefined || listed.exitCode !== 0) return []

  // git always lists the main worktree first
  const blocks = listed.stdout.trim().split(/\n\n+/)
  const repo = /^worktree (.+)$/m.exec(blocks[0] ?? '')?.[1] ?? cwd

  return blocks.flatMap((block, index) => {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    if (path === undefined || /^prunable/m.test(block)) return []

    return [
      { path, repo, isMain: index === 0, branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] },
    ]
  })
}

// a folder's repo: the main checkout git lists first, a Claude worktree's though it is gone; a
// folder outside git is its own, and one that is gone has none
const repoOf = async ($: EngineInterface, cwd: string) => {
  const folder = cwd.replace(/\/\.claude\/worktrees\/.*$/, '')
  const [main] = await worktreesOf($, folder)
  if (main !== undefined) return main.repo

  return (await $.fs.exists(folder).catch(() => false)) ? folder : undefined
}

// ponytail: a transcript folder's name cannot be read back as a path, so its repo comes from the cwd
// of its newest transcript, found once per folder; one with no transcript yet is tried again
const repoOfProject = new Map<string, string | undefined>()

const projectFoldersOf = async ($: EngineInterface, projects: string) => {
  const folders = (await $.fs.list(projects).catch(() => [])).filter(entry => entry.kind === 'dir')
  const unknown = await Promise.all(
    folders
      .filter(entry => !repoOfProject.has(entry.name))
      .map(async entry => {
        const newest = (await $.fs.list(`${projects}/${entry.name}`).catch(() => []))
          .filter(file => file.kind === 'file' && file.name.endsWith('.jsonl'))
          .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]

        return {
          name: entry.name,
          transcript: newest === undefined ? undefined : `${projects}/${entry.name}/${newest.name}`,
        }
      }),
  )
  const transcripts = unknown.flatMap(one => (one.transcript === undefined ? [] : [one.transcript]))
  const found =
    transcripts.length === 0
      ? ''
      : (
          await $.process
            .run(['grep', '-m', '1', '-o', '-H', '"cwd":"[^"]*"', ...transcripts])
            .catch(() => undefined)
        )?.stdout
  const cwdOf = new Map(
    [...(found ?? '').matchAll(/^(.+?):"cwd":"([^"]*)"$/gm)].map(match => [match[1], match[2]]),
  )
  await Promise.all(
    unknown.map(async one => {
      const cwd = cwdOf.get(one.transcript ?? '')
      if (cwd !== undefined) repoOfProject.set(one.name, await repoOf($, cwd))
    }),
  )

  return folders.flatMap(entry => {
    const repo = repoOfProject.get(entry.name)

    return repo === undefined ? [] : [{ dir: `${projects}/${entry.name}`, repo }]
  })
}

// a session belongs to the linked worktree it works inside, else the one in its repo named after
// its ticket (sessions often sit in the repo while working on a worktree), else the main checkout
const worktreeOf = (cwd: string, name: string | undefined, worktrees: readonly Worktree[]) => {
  const containing = worktrees
    .filter(tree => isInside(cwd, tree.path))
    .sort((a, b) => b.path.length - a.path.length)
  const ticket = ticketOf(name)

  return (
    containing.find(tree => !tree.isMain) ??
    worktrees.find(
      tree =>
        !tree.isMain &&
        tree.repo === containing[0]?.repo &&
        ticket !== undefined &&
        (ticketOf(baseName(tree.path)) ?? ticketOf(tree.branch)) === ticket,
    ) ??
    containing[0]
  )
}

// a run starts with /ioi-autopilot or the model's Skill call and ends when it moves the ticket to
// stage:: review; the skill's own text quotes that label in backticks, so a quote must follow it
const AUTOPILOT_MARKERS =
  '"(content|text)":"<command-message>ioi-autopilot</command-message>|"name":"Skill","input":\\{"skill":"ioi-autopilot"|stage:: review\\\\*"'

const isRunningAutopilot = async ($: EngineInterface, transcript: string) => {
  const found = await $.process
    .run(['grep', '-o', '-E', AUTOPILOT_MARKERS, transcript])
    .catch(() => undefined)

  return (found?.stdout ?? '').trim().split('\n').at(-1)?.includes('ioi-autopilot') ?? false
}

// what /color offers; `default` takes the colour away
const SESSION_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']

// /color appends its choice to the transcript, the last one wins
const sessionColorOf = async ($: EngineInterface, transcript: string) => {
  const found = await $.process
    .run(['grep', '-o', '-E', '"agentColor":"[a-z]+"', transcript])
    .catch(() => undefined)
  const color = (found?.stdout ?? '').trim().split('\n').at(-1)?.split('"')[3]

  return SESSION_COLORS.find(known => known === color)
}

// the effort its last response ran at, which /effort changes from the next one on; from the whole
// transcript, as a tail can hold none (big tool results, or a resume's "No response requested.")
const lastEffortOf = async ($: EngineInterface, transcript: string) => {
  const found = await $.process
    .run(['grep', '-o', '-E', '"effort":"(low|medium|high|xhigh|max)"', transcript])
    .catch(() => undefined)

  return (found?.stdout ?? '').trim().split('\n').at(-1)?.split('"')[3]
}

// before its first response, the effort a session started at: CLAUDE_CODE_EFFORT_LEVEL, its
// --effort, or the one saved for its model, else for every model
const startingEffortOf = async (
  $: EngineInterface,
  { configDir, own, model }: { configDir: string; own: RegisteredSession; model?: string },
) => {
  const fromEnv = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')
  if (fromEnv !== undefined) return fromEnv

  const args = await $.process
    .run(['ps', '-ww', '-o', 'args=', '-p', String(own.pid)])
    .catch(() => undefined)
  const fromFlag = /--effort[ =](\S+)/.exec(args?.stdout ?? '')?.[1]
  if (fromFlag !== undefined) return fromFlag

  const settings = await $.fs
    .read(`${configDir}/settings.json`)
    .then(
      text =>
        JSON.parse(String(text)) as {
          effortLevel?: string
          modelSettings?: Record<string, { effortLevel?: string } | undefined>
        },
    )
    .catch(() => undefined)

  // settings key the model without its context-window suffix ([1m])
  return (
    settings?.modelSettings?.[(model ?? '').replace(/\[.*\]$/, '')]?.effortLevel ??
    settings?.effortLevel
  )
}

// `model` as /model shows it, `color` as /color set it and `effort` as the last response ran, so
// another session's sidebar can draw its avatar
type OwnState = {
  running: number
  isAutopilot: boolean
  model?: string
  color?: string
  effort?: string
  cost?: number
  context?: { percent: number; window: number }
}

// $.agent.list and the transcript are cheap only to the session itself, so each one publishes its
// own state for the others' sidebars
const stateFileOf = (configDir: string, sessionId: string) =>
  `${configDir}/sessions-sidebar/state/${sessionId}.json`

const readState = ($: EngineInterface, configDir: string, sessionId: string): Promise<OwnState> =>
  $.fs
    .read(stateFileOf(configDir, sessionId))
    .then(text => JSON.parse(String(text)) as Partial<OwnState>)
    .then(state => ({
      running: state.running ?? 0,
      isAutopilot: state.isAutopilot ?? false,
      model: state.model,
      color: state.color,
      effort: state.effort,
      cost: state.cost,
      context: state.context,
    }))
    .catch(() => ({ running: 0, isAutopilot: false }))

// $.agent.list leaves out a workflow's agents; like the status line, count those of runs not yet
// finished (a run writes workflows/<run>.json at its end) that wrote in the last minute
const WORKFLOW_AGENT_ACTIVE_MS = 60_000

const runningWorkflowAgents = async ($: EngineInterface, sessionDir: string) => {
  const runsDir = `${sessionDir}/subagents/workflows`
  const [runs, now] = await Promise.all([$.fs.list(runsDir).catch(() => []), $.clock.now()])
  const counts = await Promise.all(
    runs
      .filter(run => run.kind === 'dir')
      .map(async run => {
        if (await $.fs.exists(`${sessionDir}/workflows/${run.name}.json`).catch(() => false)) {
          return 0
        }
        const files = await $.fs.list(`${runsDir}/${run.name}`).catch(() => [])

        return files.filter(
          file =>
            /^agent-.+\.jsonl$/.test(file.name) && now - file.mtimeMs <= WORKFLOW_AGENT_ACTIVE_MS,
        ).length
      }),
  )

  return counts.reduce((sum, count) => sum + count, 0)
}

const publishOwnState = async (
  $: EngineInterface,
  configDir: string,
  own: RegisteredSession | undefined,
): Promise<OwnState> => {
  if (own === undefined) return { running: 0, isAutopilot: false }

  const transcript = transcriptOf(configDir, own)
  const [agents, workflowAgents, isAutopilot, model, color, lastEffort, usage] = await Promise.all([
    $.agent.list().catch(() => []),
    runningWorkflowAgents($, transcript.replace(/\.jsonl$/, '')),
    isRunningAutopilot($, transcript),
    $.session.model().catch(() => undefined),
    sessionColorOf($, transcript),
    lastEffortOf($, transcript),
    $.session.usage().catch(() => undefined),
  ])
  const usd = usage?.cost?.usd
  const percent = usage?.context.percent
  const state = {
    running: agents.filter(agent => agent.status === 'running').length + workflowAgents,
    isAutopilot,
    model,
    color,
    effort: lastEffort ?? (await startingEffortOf($, { configDir, own, model })),
    // to the cent, so the file is rewritten as often as the figure drawn changes
    cost: usd === undefined ? undefined : Math.round(usd * 100) / 100,
    // absent until the live window's first response, and again just after a compaction
    context:
      usage === undefined || percent === undefined
        ? undefined
        : { percent, window: usage.context.window },
  }
  const published = await readState($, configDir, own.sessionId)
  if (JSON.stringify(state) !== JSON.stringify(published)) {
    await $.fs.write(stateFileOf(configDir, own.sessionId), JSON.stringify(state))
  }

  return state
}

// ponytail: grepping every transcript takes ~1 s, so each one is read once per change; a session's
// own module keeps this, so a long-lived session holds one entry per transcript in the repo
const transcriptCache = new Map<
  string,
  { mtimeMs: number; name?: string; worktree?: string; cost?: number }
>()

// named sessions not running whose worktree is gone; a session's worktree is the first it worked in
const loadClosedSessions = async (
  $: EngineInterface,
  {
    folders,
    worktrees,
    liveIds,
    liveNames,
  }: {
    // the transcript folders of the repos shown
    folders: readonly { dir: string; repo: string }[]
    worktrees: readonly Worktree[]
    liveIds: ReadonlySet<string>
    liveNames: ReadonlySet<string | undefined>
  },
): Promise<{
  closed: ClosedRow[]
  checkout: CheckoutRow[]
  costOfTicket: ReadonlyMap<string, number>
  spend: { week: number; repo: number }
}> => {
  const transcripts = (
    await Promise.all(
      folders.map(async ({ dir, repo }) =>
        (await $.fs.list(dir).catch(() => []))
          .filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl'))
          .map(entry => ({
            path: `${dir}/${entry.name}`,
            sessionId: entry.name.replace(/\.jsonl$/, ''),
            mtimeMs: entry.mtimeMs,
            repo,
          })),
      ),
    )
  )
    .flat()
    .filter(one => !liveIds.has(one.sessionId))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  const stale = transcripts.filter(one => transcriptCache.get(one.path)?.mtimeMs !== one.mtimeMs)
  const names = await Promise.all(
    stale.map(one =>
      $.fs
        .read(one.path.replace(/\.jsonl$/, '/custom-title.json'))
        .then(text => (JSON.parse(String(text)) as { customTitle?: string }).customTitle)
        .catch(() => undefined),
    ),
  )
  const named = stale.filter((_, index) => names[index] !== undefined)
  const firsts =
    named.length === 0
      ? ''
      : (
          await $.process
            .run([
              'grep',
              '-o',
              '-H',
              '-m',
              '1',
              '-E',
              '"cwd":"[^"]*/\\.claude/worktrees/[^/"]+',
              ...named.map(one => one.path),
            ])
            .catch(() => undefined)
        )?.stdout
  // Claude Code saves a session's running /cost total as it goes; the last one is what it cost
  // every one, named or not, for the footer's totals; the first scan reads them all (~2 s for
  // 375 transcripts), then only those that changed
  const costs =
    stale.length === 0
      ? ''
      : (
          await $.process
            .run([
              'grep',
              '-o',
              '-H',
              '-E',
              '"totalCostUSD":[0-9.eE+-]+',
              ...stale.map(one => one.path),
            ])
            .catch(() => undefined)
        )?.stdout
  // a failed grep is retried next refresh rather than cached as "no worktree"
  if (firsts !== undefined && costs !== undefined) {
    const firstWorktreeOf = new Map(
      [...firsts.matchAll(/^(.+?):"cwd":"(.+)$/gm)].map(match => [match[1], match[2]]),
    )
    // in file order, so each transcript's last total wins
    const costOf = new Map(
      [...costs.matchAll(/^(.+?):"totalCostUSD":(.+)$/gm)].map(match => [
        match[1],
        Number(match[2]),
      ]),
    )
    stale.forEach((one, index) =>
      transcriptCache.set(one.path, {
        mtimeMs: one.mtimeMs,
        name: names[index],
        worktree: firstWorktreeOf.get(one.path),
        cost: costOf.get(one.path),
      }),
    )
  }

  // by repo and ticket: two repos may each have a 123
  const ticketsWithWorktree = new Set(
    worktrees
      .filter(tree => !tree.isMain)
      .map(tree => `${tree.repo}#${ticketOf(baseName(tree.path)) ?? ticketOf(tree.branch)}`),
  )
  const now = await $.clock.now()
  const spend = transcripts.reduce(
    (sum, one) => {
      const cost = transcriptCache.get(one.path)?.cost ?? 0

      return {
        week: sum.week + (now - one.mtimeMs <= RECENT_MS ? cost : 0),
        repo: sum.repo + cost,
      }
    },
    { week: 0, repo: 0 },
  )
  const titled = transcripts.flatMap(one => {
    const { name, worktree, cost } = transcriptCache.get(one.path) ?? {}
    if (name === undefined) return []
    if (worktree !== undefined && worktrees.some(tree => tree.path === worktree)) return []
    const ticket = ticketOf(name)
    // a worktree for its ticket still exists: it shows as live or dormant instead
    if (ticket !== undefined && ticketsWithWorktree.has(`${one.repo}#${ticket}`)) return []

    return [
      {
        sessionId: one.sessionId,
        name,
        place: placeOf(worktree ?? one.repo),
        repo: one.repo,
        transcript: one.path,
        hasWorktree: worktree !== undefined,
        isRecent: now - one.mtimeMs <= RECENT_MS,
        modifiedAt: one.mtimeMs,
        cost,
      },
    ]
  })
  // newest first; a name reused by an older session shows once
  const unique = titled.filter(
    (one, index) => titled.findIndex(other => other.name === one.name) === index,
  )

  return {
    closed: unique.filter(one => one.hasWorktree).map(({ hasWorktree, ...one }) => one),
    // one resumed under its old name is live, its new transcript id aside
    checkout: unique
      .filter(one => !one.hasWorktree && !liveNames.has(one.name))
      .map(({ hasWorktree, ...one }) => one),
    spend,
    // a dormant worktree's cost: the newest session in its repo titled after its ticket, the one its
    // ↻ resumes; by `<repo>#<ticket>`
    costOfTicket: new Map(
      [...transcripts].reverse().flatMap(one => {
        const { name, cost } = transcriptCache.get(one.path) ?? {}
        const ticket = ticketOf(name)

        return ticket === undefined || cost === undefined
          ? []
          : [[`${one.repo}#${ticket}`, cost] as const]
      }),
    ),
  }
}

const loadSessions = async (
  $: EngineInterface,
): Promise<{
  live: SessionRow[]
  dormant: DormantRow[]
  closed: ClosedRow[]
  checkout: CheckoutRow[]
  cacheExpiresAt?: number
  spend?: { week: number; repo: number }
  repos: { selected: string[]; options: RepoOption[] }
}> => {
  const configDir = await configDirOf($)
  const dir = `${configDir}/sessions`
  const entries = await $.fs.list(dir).catch(() => [])
  const parsed = await Promise.all(
    entries
      .filter(entry => entry.name.endsWith('.json'))
      .map(entry =>
        $.fs
          .read(`${dir}/${entry.name}`)
          .then(text => JSON.parse(String(text)) as RegisteredSession)
          .catch(() => undefined),
      ),
  )
  // a script's headless run (the Agent SDK) registers too, inside its parent's tab: not a session
  // of its own to list or switch to
  const registered = parsed.filter(
    (one): one is RegisteredSession =>
      one?.kind === 'interactive' &&
      typeof one.pid === 'number' &&
      !(one.entrypoint ?? 'cli').startsWith('sdk'),
  )
  if (registered.length === 0) {
    return { live: [], dormant: [], closed: [], checkout: [], repos: { selected: [], options: [] } }
  }

  // ponytail: a crashed session's file stays until its pid is reused; compare procStart if that bites
  const ps = await $.process
    .run(['ps', '-o', 'pid=', '-p', registered.map(one => one.pid).join(',')])
    .catch(() => undefined)
  const alive = new Set((ps?.stdout ?? '').split(/\s+/).filter(Boolean).map(Number))
  // this session is always alive, so an empty set means ps could not see anything: keep all
  const isLivenessKnown = alive.size > 0
  const live = registered
    .filter(one => !isLivenessKnown || alive.has(one.pid))
    .sort((a, b) => a.startedAt - b.startedAt)
  const [current, tails, folders, saved] = await Promise.all([
    $.session.id(),
    Promise.all(live.map(one => tailOf($, configDir, one))),
    projectFoldersOf($, `${configDir}/projects`),
    $.fs
      .read(reposFileOf(configDir))
      .then((text): unknown => JSON.parse(String(text)))
      .catch(() => undefined),
  ])
  const cwds = live.map((one, index) => currentCwdIn(tails[index] ?? '', one))
  // where each was launched and where it works now: a session can move on to another repo
  const worktreeLists = await Promise.all(
    [...new Set([...live.map(one => one.cwd), ...cwds])].map(cwd => worktreesOf($, cwd)),
  )
  const ownIndex = live.findIndex(one => one.sessionId === current)
  const ownState = await publishOwnState(
    $,
    configDir,
    live.find(one => one.sessionId === current),
  )
  const states = await Promise.all(
    live.map(one =>
      one.sessionId === current ? ownState : readState($, configDir, one.sessionId),
    ),
  )
  const worktrees = [...new Map(worktreeLists.flat().map(tree => [tree.path, tree])).values()]
  const trees = live.map((one, index) => worktreeOf(cwds[index] ?? one.cwd, one.name, worktrees))
  // a session outside git counts its folder as its repo
  const rowRepos = live.map((one, index) => trees[index]?.repo ?? cwds[index] ?? one.cwd)
  const liveRepos = [...new Set([...worktrees.map(tree => tree.repo), ...rowRepos])]
  // with no choice saved, the repos the live sessions run in
  const selected = isPathList(saved) ? saved : liveRepos
  // a live session's own worktrees as they are, so a dormant one is told apart by identity
  const selectedWorktrees = (
    await Promise.all(
      selected.map(repo => {
        const known = worktrees.filter(tree => tree.repo === repo)

        return known.length > 0 ? known : worktreesOf($, repo)
      }),
    )
  ).flat()
  const { closed, checkout, costOfTicket, spend } = await loadClosedSessions($, {
    folders: folders.filter(one => selected.includes(one.repo)),
    worktrees: selectedWorktrees,
    liveIds: new Set(live.map(one => one.sessionId)),
    liveNames: new Set(live.map(one => one.name)),
  })

  return {
    closed,
    checkout,
    spend,
    repos: {
      selected,
      // the busiest first, then by name
      options: [...new Set([...liveRepos, ...folders.map(one => one.repo)])]
        .map(path => ({ path, live: rowRepos.filter(repo => repo === path).length }))
        .sort((a, b) => b.live - a.live || baseName(a.path).localeCompare(baseName(b.path))),
    },
    cacheExpiresAt: ownIndex === -1 ? undefined : cacheExpiryIn(tails[ownIndex] ?? ''),
    live: live.map((one, index) => {
      const tree = trees[index]
      const place = placeOf(tree?.path ?? cwds[index] ?? one.cwd)

      return {
        pid: one.pid,
        name: one.name ?? place,
        status: one.status ?? 'idle',
        place,
        branch: tree?.branch,
        repo: rowRepos[index] ?? one.cwd,
        worktree:
          tree === undefined || tree.isMain ? undefined : { path: tree.path, repo: tree.repo },
        // a busy session's own loop is an agent at work too
        agents: (one.status === 'busy' ? 1 : 0) + (states[index]?.running ?? 0),
        isAutopilot: states[index]?.isAutopilot ?? false,
        model: states[index]?.model,
        color: states[index]?.color,
        effort: states[index]?.effort,
        cost: states[index]?.cost,
        context: states[index]?.context,
        // Remote Control is on; whether a phone has it open is not told to mods
        isRemote: typeof one.bridgeSessionId === 'string',
        isCurrent: one.sessionId === current,
      }
    }),
    dormant: selectedWorktrees
      .filter(tree => !tree.isMain && !trees.includes(tree))
      .map(tree => ({
        path: tree.path,
        repo: tree.repo,
        name: tree.branch ?? baseName(tree.path),
        place: placeOf(tree.path),
        cost: costOfTicket.get(
          `${tree.repo}#${ticketOf(baseName(tree.path)) ?? ticketOf(tree.branch)}`,
        ),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

// the collapsed sections, shared so every session's sidebar folds the same way
const collapsedFileOf = (configDir: string) => `${configDir}/sessions-sidebar/collapsed.json`

// the file maps each section to whether it is folded, so one added later starts as its default;
// an older copy is the list of folded sections among the three there were then
const collapsedOf = (saved: unknown): Section[] => {
  const isFolded: Partial<Record<Section, boolean>> = Array.isArray(saved)
    ? {
        live: saved.includes('live'),
        dormant: saved.includes('dormant'),
        closed: saved.includes('closed'),
      }
    : typeof saved === 'object' && saved !== null
      ? saved
      : {}

  return SECTIONS.filter(section => isFolded[section] ?? IS_COLLAPSED_BY_DEFAULT[section])
}

// written before the atom, so a refresh reading the file in between cannot fold it back
const toggleSection = async ($: EngineInterface, section: Section) => {
  const sections = await read($, collapsedSections)
  const toggled = sections.includes(section)
    ? sections.filter(one => one !== section)
    : [...sections, section]
  await $.fs.write(
    collapsedFileOf(await configDirOf($)),
    JSON.stringify(Object.fromEntries(SECTIONS.map(one => [one, toggled.includes(one)]))),
  )
  await update($, collapsedSections, () => toggled)
}

const archivedFileOf = (configDir: string) => `${configDir}/sessions-sidebar/archived.json`

const detailFileOf = (configDir: string) => `${configDir}/sessions-sidebar/detail.json`

// the repos picked, shared by every session's sidebar; absent until the first pick
const reposFileOf = (configDir: string) => `${configDir}/sessions-sidebar/repos.json`

const isPathList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(one => typeof one === 'string')

const filtersFileOf = (configDir: string) => `${configDir}/sessions-sidebar/filters.json`

const setSectionFilter = async ($: EngineInterface, section: Section, filter: KindFilter) => {
  const changed = { ...(await read($, sectionFilters)), [section]: filter }
  await $.fs.write(filtersFileOf(await configDirOf($)), JSON.stringify(changed))
  await update($, sectionFilters, () => changed)
}

const isKindFilter = (value: unknown): value is KindFilter =>
  KIND_FILTERS.some(one => one.id === value)

const setDetailLevel = async ($: EngineInterface, level: DetailLevel) => {
  await $.fs.write(detailFileOf(await configDirOf($)), JSON.stringify(level))
  await update($, detailLevel, () => level)
}

const setArchived = async (
  $: EngineInterface,
  sessionIds: readonly string[],
  isArchived: boolean,
) => {
  const ids = await read($, archivedIds)
  const others = ids.filter(one => !sessionIds.includes(one))
  const changed = isArchived ? [...others, ...sessionIds] : others
  await $.fs.write(archivedFileOf(await configDirOf($)), JSON.stringify(changed))
  await update($, archivedIds, () => changed)
}

// 3d 4h, 2h 15m, 38m: a minute's resolution, so the footer redraws at most once a minute
const durationText = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)

  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

const refresh = async ($: EngineInterface) => {
  const configDir = await configDirOf($)
  const [
    { live, dormant, closed, checkout, cacheExpiresAt, spend, repos },
    collapsed,
    archived,
    detail,
    filters,
    usage,
    now,
  ] = await Promise.all([
    loadSessions($),
    $.fs
      .read(collapsedFileOf(configDir))
      .then(text => collapsedOf(JSON.parse(String(text))))
      .catch(() => DEFAULT_COLLAPSED),
    $.fs
      .read(archivedFileOf(configDir))
      .then(text => JSON.parse(String(text)) as string[])
      .catch(() => []),
    $.fs
      .read(detailFileOf(configDir))
      .then(text => {
        const saved: unknown = JSON.parse(String(text))

        return DETAIL_LEVELS.find(level => level === saved) ?? 'full'
      })
      .catch((): DetailLevel => 'full'),
    $.fs
      .read(filtersFileOf(configDir))
      .then((text): Partial<Record<Section, KindFilter>> => {
        const saved: unknown = JSON.parse(String(text))
        if (typeof saved !== 'object' || saved === null) return {}

        return Object.fromEntries(
          Object.entries(saved).filter(
            ([section, kind]) => SECTIONS.some(one => one === section) && isKindFilter(kind),
          ),
        )
      })
      .catch((): Partial<Record<Section, KindFilter>> => ({})),
    $.session.usage().catch(() => undefined),
    $.clock.now(),
  ])
  const info = {
    limits: (usage?.rateLimits ?? []).flatMap(limit => {
      const label = { five_hour: '5h', seven_day: '7d' }[limit.kind]
      if (label === undefined) return []

      return [
        {
          label,
          percent: Math.round(limit.percentUsed),
          resetsIn:
            limit.resetsAt === undefined
              ? undefined
              : durationText(Date.parse(limit.resetsAt) - now),
        },
      ]
    }),
    cache:
      cacheExpiresAt === undefined
        ? undefined
        : {
            isWarm: cacheExpiresAt > now,
            left: durationText(cacheExpiresAt - now),
          },
    spend,
  }
  if (JSON.stringify(info) !== JSON.stringify(await read($, usageInfo))) {
    await update($, usageInfo, () => info)
  }
  if (JSON.stringify(collapsed) !== JSON.stringify(await read($, collapsedSections))) {
    await update($, collapsedSections, () => collapsed)
  }
  if (detail !== (await read($, detailLevel))) await update($, detailLevel, () => detail)
  if (JSON.stringify(filters) !== JSON.stringify(await read($, sectionFilters))) {
    await update($, sectionFilters, () => filters)
  }
  if (JSON.stringify(repos) !== JSON.stringify(await read($, repoChoice))) {
    await update($, repoChoice, () => repos)
  }
  if (JSON.stringify(archived) !== JSON.stringify(await read($, archivedIds))) {
    await update($, archivedIds, () => archived)
  }
  if (JSON.stringify(live) !== JSON.stringify(await read($, rows))) {
    await update($, rows, () => live)
  }
  if (JSON.stringify(dormant) !== JSON.stringify(await read($, dormantRows))) {
    await update($, dormantRows, () => dormant)
  }
  if (JSON.stringify(checkout) !== JSON.stringify(await read($, checkoutRows))) {
    await update($, checkoutRows, () => checkout)
  }
  if (JSON.stringify(closed) !== JSON.stringify(await read($, closedRows))) {
    await update($, closedRows, () => closed)
  }
}

// Warp puts WARP_FOCUS_URL (warp://session/<uuid>, warppreview:// on Preview) in each tab's env;
// the claude process inherits it, and opening it brings that tab to the front
const focusWarpTab = async ($: EngineInterface, one: SessionRow) => {
  const ps = await $.process.run(['ps', '-E', '-ww', '-o', 'command=', '-p', String(one.pid)])
  const url = /(?:^|\s)WARP_FOCUS_URL=(warp[a-z]*:\/\/session\/[0-9a-f]+)(?:\s|$)/.exec(
    ps.stdout,
  )?.[1]
  if (url === undefined) {
    $.ui.toast(`${one.name}: not running in a Warp tab`)

    return
  }

  const opened = await $.process.run(['open', url])
  if (opened.exitCode !== 0) $.ui.toast(`${one.name}: could not open its Warp tab`)
}

const newestOf = (files: readonly { path: string; mtimeMs: number }[], paths: readonly string[]) =>
  files.filter(file => paths.includes(file.path)).sort((a, b) => b.mtimeMs - a.mtimeMs)[0]

const grepFiles = async (
  $: EngineInterface,
  needles: readonly string[],
  paths: readonly string[],
) => {
  if (paths.length === 0) return []
  const found = await $.process.run([
    'grep',
    '-l',
    '-F',
    ...needles.flatMap(needle => ['-e', needle]),
    ...paths,
  ])

  return found.stdout.split('\n').filter(Boolean)
}

// the session a dormant worktree belongs to: one titled after its ticket anywhere in the repo's
// transcripts (sessions often start in the repo and work in the worktree), else the newest
// interactive one started inside the worktree; headless (-p, SDK) runs are never picked
const findSessionOf = async ($: EngineInterface, configDir: string, one: DormantRow) => {
  const projects = `${configDir}/projects`
  const repoKey = projectKeyOf(one.repo)
  const treeKey = projectKeyOf(one.path)
  const dirs = (await $.fs.list(projects).catch(() => [])).filter(
    entry =>
      entry.kind === 'dir' &&
      (entry.name === repoKey ||
        entry.name === treeKey ||
        entry.name.startsWith(`${repoKey}--claude-worktrees-`)),
  )
  const files = (
    await Promise.all(
      dirs.map(async dir =>
        (await $.fs.list(`${projects}/${dir.name}`).catch(() => []))
          .filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl'))
          .map(entry => ({
            path: `${projects}/${dir.name}/${entry.name}`,
            mtimeMs: entry.mtimeMs,
          })),
      ),
    )
  ).flat()
  const ticket = ticketOf(baseName(one.path)) ?? ticketOf(one.name)
  const titled =
    ticket === undefined
      ? []
      : await grepFiles(
          $,
          [`"customTitle":"${ticket}-`, `"customTitle":"${ticket}"`],
          files.map(file => file.path),
        )
  const startedInside = await grepFiles(
    $,
    ['"entrypoint":"cli"'],
    files.filter(file => file.path.startsWith(`${projects}/${treeKey}/`)).map(file => file.path),
  )
  const chosen = newestOf(files, titled) ?? newestOf(files, startedInside)
  if (chosen === undefined) return undefined

  return {
    id: baseName(chosen.path).replace(/\.jsonl$/, ''),
    cwd: (await startCwdOf($, chosen.path)) ?? one.path,
  }
}

// --resume finds a session from the folder it was started in
const startCwdOf = async ($: EngineInterface, transcript: string) => {
  const head = await $.process.run(['head', '-c', '262144', transcript]).catch(() => undefined)

  return /"cwd":"([^"]+)"/.exec(head?.stdout ?? '')?.[1]
}

const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

const claudeCommand = (configDir: string, args: string) =>
  `CLAUDE_CONFIG_DIR=${shellQuote(configDir)} claude --dangerously-skip-permissions${args}`

const TAB_CONFIG = 'sessions-sidebar-resume'

// Warp's new_tab link cannot run a command, a tab config can: rewrite one and open it by name
// (warppreview://tab_config/<name> on Preview, whose configs live in ~/.warp-preview)
const openWarpTabRunning = async (
  $: EngineInterface,
  tab: { title: string; directory: string; command: string },
) => {
  const scheme = /^(warp[a-z]*):\/\//.exec((await $.env.get('WARP_FOCUS_URL')) ?? '')?.[1]
  if (scheme === undefined) {
    $.ui.toast('Not running in Warp')

    return
  }

  const warpDir = `.warp${scheme === 'warp' ? '' : `-${scheme.slice('warp'.length)}`}`
  const toml = [
    '# Written by the sessions-sidebar mod each time it opens a tab; safe to delete.',
    `name = ${JSON.stringify(`Sessions sidebar: ${tab.title}`)}`,
    `title = ${JSON.stringify(tab.title)}`,
    '',
    '[[panes]]',
    'id = "main"',
    'type = "terminal"',
    `directory = ${JSON.stringify(tab.directory)}`,
    `commands = [${JSON.stringify(tab.command)}]`,
    'is_focused = true',
    '',
  ].join('\n')
  await $.fs.write(`${await $.env.get('HOME')}/${warpDir}/tab_configs/${TAB_CONFIG}.toml`, toml)

  const opened = await $.process.run(['open', `${scheme}://tab_config/${TAB_CONFIG}`])
  if (opened.exitCode !== 0) $.ui.toast(`${tab.title}: could not open a Warp tab`)
}

const resumeInWarpTab = async ($: EngineInterface, one: DormantRow) => {
  const configDir = await configDirOf($)
  const session = await findSessionOf($, configDir, one)
  if (session === undefined) $.ui.toast(`${one.name}: no session found, opening the resume picker`)
  const target = session?.id ?? ticketOf(baseName(one.path)) ?? one.name

  await openWarpTabRunning($, {
    title: one.name,
    directory: session?.cwd ?? one.path,
    command: claudeCommand(configDir, ` --resume ${shellQuote(target)}`),
  })
}

// ponytail: every tab goes through the one tab config, which Warp reads some time after `open`, so
// they open one at a time, this far apart; a Warp slower than that would open one twice, and a
// config per tab would end it
const TAB_CONFIG_READ_MS = 1_500

const reopenAll = async ($: EngineInterface, opens: readonly (() => Promise<void>)[]) => {
  const [first, ...rest] = opens
  if (first === undefined) return

  await first()
  $.clock.after(TAB_CONFIG_READ_MS, () => void reopenAll($, rest))
}

const resumeClosedSession = async ($: EngineInterface, one: ClosedRow) => {
  const startedIn = await startCwdOf($, one.transcript)
  // ponytail: one started inside its deleted worktree is tried from the repo; --resume may not find it
  const directory =
    startedIn !== undefined && (await $.fs.exists(startedIn).catch(() => false))
      ? startedIn
      : one.repo

  await openWarpTabRunning($, {
    title: one.name,
    directory,
    command: claudeCommand(await configDirOf($), ` --resume ${shellQuote(one.sessionId)}`),
  })
}

// the new session's own sidebar gives it a random colour
const startNewSession = async (
  $: EngineInterface,
  { model, effort }: { model?: string; effort?: string },
) =>
  openWarpTabRunning($, {
    title: 'New session',
    directory: await $.session.root(),
    command: `SESSIONS_SIDEBAR_COLOR=random ${claudeCommand(
      await configDirOf($),
      `${model === undefined ? '' : ` --model ${shellQuote(model)}`}${
        effort === undefined ? '' : ` --effort ${effort}`
      }`,
    )}`,
  })

// a second press folds it; the settings are read as it opens, so the badges show the saved efforts
const toggleNewSessionMenu = async ($: EngineInterface) => {
  if ((await read($, newSessionMenu)) !== null) return update($, newSessionMenu, () => null)

  const settings = await $.fs
    .read(`${await configDirOf($)}/settings.json`)
    .then(
      text =>
        JSON.parse(String(text)) as {
          model?: string
          effortLevel?: string
          modelSettings?: Record<string, { effortLevel?: string }>
        },
    )
    .catch(() => undefined)

  return update($, newSessionMenu, () => ({
    defaultModel: settings?.model,
    saved: Object.fromEntries(
      NEW_SESSION_MODELS.map(one => [
        one.model,
        settings?.modelSettings?.[one.settingsKey]?.effortLevel ?? settings?.effortLevel,
      ]),
    ),
  }))
}

// the row after this session in the sidebar's order, wrapping round to the first
const nextSessionAfter = (list: readonly SessionRow[], pid: number) => {
  const index = list.findIndex(one => one.pid === pid)

  return [...list.slice(index + 1), ...list.slice(0, Math.max(index, 0))].find(
    one => one.pid !== pid,
  )
}

const focusNextSession = async ($: EngineInterface) => {
  const list = await read($, rows)
  const current = list.find(one => one.isCurrent)
  const target = current === undefined ? undefined : nextSessionAfter(list, current.pid)
  if (target !== undefined) await focusWarpTab($, target)
}

// Warp closes a tab whose shell exits, so once the session has exited its tab's shell is hung up;
// detached, so it outlives a session that closes itself, and deaf to the TERM that may reach it with
// that session's. $1 the session's pid, $2 its shell's, $3 the log
const TAB_CLOSER = [
  'trap \'echo "$(date +%FT%T) closer for $1 got TERM, carrying on" >>"$3"\' TERM',
  'i=0',
  'while kill -0 "$1" 2>/dev/null; do i=$((i+1)); [ $i -gt 120 ] && { echo "$(date +%FT%T) kept tab of $1: it did not exit" >>"$3"; exit 1; }; sleep 1; done',
  'echo "$(date +%FT%T) $1 exited, hanging up its tab shell $2" >>"$3"',
  'kill -HUP "$2"',
].join('; ')

// the shell Warp opened the session's tab with; none when it runs under anything else (tmux, a
// script, or straight from Warp), so no other process is ever hung up
const warpTabShellOf = async ($: EngineInterface, pid: number) => {
  const listed = await $.process.run(['ps', '-A', '-o', 'pid=,ppid=,comm=']).catch(() => undefined)
  const processes = new Map(
    (listed?.stdout ?? '').split('\n').flatMap(line => {
      const fields = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)

      return fields === null
        ? []
        : [[Number(fields[1]), { parent: Number(fields[2]), command: fields[3] }] as const]
    }),
  )
  const shell = processes.get(pid)?.parent
  const isTabShell =
    shell !== undefined &&
    /^-?(.*\/)?(zsh|bash|fish|sh)$/.test(processes.get(shell)?.command ?? '') &&
    /Warp/.test(processes.get(processes.get(shell)?.parent ?? 0)?.command ?? '')

  return isTabShell ? shell : undefined
}

// SIGTERM ends a session as a closed terminal would: its transcript kept, `--resume` returns to it;
// its Warp tab closes after it
const endSession = async (
  $: EngineInterface,
  one: SessionRow,
  { shouldFocusNext = one.isCurrent }: { shouldFocusNext?: boolean } = {},
) => {
  if (shouldFocusNext) await focusNextSession($)

  const shell = await warpTabShellOf($, one.pid)
  const log = `${await configDirOf($)}/sessions-sidebar/closer.log`
  await $.process.run(
    shell === undefined
      ? [
          'sh',
          '-c',
          'echo "$(date +%FT%T) kept tab of $1: not a shell Warp opened" >>"$2"',
          'closer',
          String(one.pid),
          log,
        ]
      : [
          'sh',
          '-c',
          // the script as an argument: it has quotes of its own
          'nohup sh -c "$1" closer "$2" "$3" "$4" >>"$4" 2>&1 </dev/null &',
          'closer',
          TAB_CLOSER,
          String(one.pid),
          String(shell),
          log,
        ],
  )
  const killed = await $.process.run(['kill', '-TERM', String(one.pid)])
  if (killed.exitCode !== 0) $.ui.toast(`${one.name}: could not close it`)
}

// the others first: ending this session also ends the sidebar that signals the rest; with every
// tab closing there is none to switch to
const closeAllSessions = async ($: EngineInterface, list: readonly SessionRow[]) => {
  await Promise.all(list.filter(one => !one.isCurrent).map(one => endSession($, one)))
  const current = list.find(one => one.isCurrent)
  if (current !== undefined) await endSession($, current, { shouldFocusNext: false })
}

// the branch's MR through GitLab's API (glab is signed in)
const mergeRequestOf = async ($: EngineInterface, repo: string, branch: string) => {
  const listed = await $.process
    .run(
      [
        'glab',
        'api',
        `projects/:fullpath/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all`,
      ],
      { cwd: repo },
    )
    .catch(() => undefined)
  if (listed === undefined || listed.exitCode !== 0) {
    return { isMerged: false, summary: 'Its MR could not be checked' }
  }

  const requests = (() => {
    try {
      return JSON.parse(listed.stdout) as { iid: number; state: string }[]
    } catch {
      return []
    }
  })()
  // newest first from the API; an open MR means the branch is still in use, even after a merge
  const request =
    requests.find(one => one.state === 'opened') ??
    requests.find(one => one.state === 'merged') ??
    requests[0]

  return request === undefined
    ? { isMerged: false, summary: 'Its branch has no MR' }
    : {
        isMerged: request.state === 'merged',
        summary: `MR !${request.iid} is ${request.state}, not merged`,
      }
}

// waits for the session to exit (its exit hooks still run in the worktree), then removes the
// worktree; detached, so it outlives a session that closes itself. The branch is kept.
// $1 pid, $2 repo, $3 worktree, $4 --force or empty, $5 the log, $6 non-empty to unlock it first
const WORKTREE_REMOVER = [
  'i=0',
  'while kill -0 "$1" 2>/dev/null; do i=$((i+1)); [ $i -gt 120 ] && { echo "$(date +%FT%T) kept $3: session $1 did not exit"; exit 1; }; sleep 1; done',
  'echo "$(date +%FT%T) removing $3"',
  '[ -n "$6" ] && git -C "$2" worktree unlock "$3"',
  'git -C "$2" worktree remove $4 "$3"',
].join('; ')

// Claude Code locks a worktree it creates ("claude session <name> (pid N start …)") and leaves the
// lock behind when that session ends; it is stale once its pid is the session being closed or gone.
// Any other lock is kept, and the removal fails into the log.
const hasStaleClaudeLock = async ($: EngineInterface, worktreePath: string, closingPid: number) => {
  const gitDir = await $.process
    .run(['git', '-C', worktreePath, 'rev-parse', '--absolute-git-dir'])
    .catch(() => undefined)
  const reason = await $.fs
    .read(`${(gitDir?.stdout ?? '').trim()}/locked`)
    .then(String)
    .catch(() => '')
  const lockPid = /claude session .*\(pid (\d+) /.exec(reason)?.[1]
  if (lockPid === undefined) return false
  if (Number(lockPid) === closingPid) return true

  const alive = await $.process.run(['ps', '-o', 'pid=', '-p', lockPid]).catch(() => undefined)

  return alive !== undefined && alive.stdout.trim() === ''
}

const removeWorktreeAndEnd = async (
  $: EngineInterface,
  one: SessionRow,
  worktree: { path: string; repo: string },
  isForced: boolean,
) => {
  const isLockStale = await hasStaleClaudeLock($, worktree.path, one.pid)
  await $.process.run([
    'sh',
    '-c',
    `nohup sh -c '${WORKTREE_REMOVER}' remover "$@" >>"$5" 2>&1 </dev/null &`,
    'remover',
    String(one.pid),
    worktree.repo,
    worktree.path,
    isForced ? '--force' : '',
    `${await configDirOf($)}/sessions-sidebar/remover.log`,
    isLockStale ? 'unlock' : '',
  ])
  $.ui.toast(`${one.name}: closing; worktree ${baseName(worktree.path)} goes once it has exited`)
  await endSession($, one)
}

const CLOSE = 'Close, keep worktree'
const CLOSE_MAIN = 'Close session'
const CLOSE_ALL = 'Close all sessions'
const REOPEN_ALL = 'Reopen all'
const FINISH = 'Finish, delete worktree'
const DELETE_ANYWAY = 'Delete anyway'
const DELETE_CHANGES = 'Delete with changes'
// the second step Close all and Archive all ask for, as both act on a whole section at once
const CONFIRM_CLOSE_ALL = 'Yes, close all'
const CONFIRM_ARCHIVE_ALL = 'Yes, archive all'
// drawn red under the pointer
const DESTRUCTIVE = [FINISH, DELETE_ANYWAY, DELETE_CHANGES, CONFIRM_CLOSE_ALL, CONFIRM_ARCHIVE_ALL]
const RESUME = 'Resume in a new tab'
const ARCHIVE = 'Archive'
const UNARCHIVE_TO = (section: string) => `Move back to ${section}`
const ARCHIVE_ALL = 'Archive all'

// a question drawn under the row `key` names (live-<pid>, dormant-<path>, archived-<path>); each
// step of a menu replaces the last
const ask = ($: EngineInterface, key: string, text: string, options: string[]) =>
  update($, question, () => ({ key, text, options: [...options, 'Cancel'] }))

// ≡ opens its row's question, so a stray click never acts; a second ≡ folds it away
const toggleQuestion = async ($: EngineInterface, key: string, text: string, options: string[]) => {
  if ((await read($, question))?.key === key) {
    await update($, question, () => null)

    return
  }

  await ask($, key, text, options)
}

// a press on a question since replaced does nothing
const answerQuestion = async (
  $: EngineInterface,
  key: string,
  choice: string,
  handle: (choice: string) => Promise<unknown>,
) => {
  const asked = await read($, question)
  await update($, question, () => null)
  if (asked?.key !== key || choice === 'Cancel') return

  await handle(choice)
}

const liveKey = (one: SessionRow) => `live-${one.pid}`

const removeWorktreeIfClean = async ($: EngineInterface, one: SessionRow) => {
  const { worktree } = one
  if (worktree === undefined) return

  const status = await $.process
    .run(['git', '-C', worktree.path, 'status', '--porcelain'])
    .catch(() => undefined)
  if ((status?.stdout ?? '').trim() === '') return removeWorktreeAndEnd($, one, worktree, false)

  await ask($, liveKey(one), `Worktree ${baseName(worktree.path)} has uncommitted changes.`, [
    DELETE_CHANGES,
  ])
}

const finishSession = async ($: EngineInterface, one: SessionRow) => {
  const { worktree, branch } = one
  if (worktree === undefined) return
  const place = baseName(worktree.path)
  const sharing = (await read($, rows)).find(
    other => other.pid !== one.pid && other.worktree?.path === worktree.path,
  )
  if (sharing !== undefined) {
    $.ui.toast(`${one.name}: ${sharing.name} also works in worktree ${place}; close that one first`)

    return
  }

  const request =
    branch === undefined
      ? { isMerged: false, summary: 'It has no branch' }
      : await mergeRequestOf($, worktree.repo, branch)
  if (request.isMerged) return removeWorktreeIfClean($, one)

  await ask($, liveKey(one), `${request.summary}. Delete worktree ${place} anyway?`, [
    DELETE_ANYWAY,
  ])
}

const openSessionMenu = ($: EngineInterface, one: SessionRow) =>
  toggleQuestion(
    $,
    liveKey(one),
    one.status === 'busy' ? 'Busy right now. Close it anyway?' : 'Close this session?',
    one.worktree === undefined ? [CLOSE_MAIN] : [CLOSE, FINISH],
  )

const answerSessionQuestion = async ($: EngineInterface, one: SessionRow, choice: string) => {
  if (choice === CLOSE || choice === CLOSE_MAIN) return endSession($, one)
  if (choice === FINISH) return finishSession($, one)
  if (choice === DELETE_ANYWAY) return removeWorktreeIfClean($, one)
  if (choice === DELETE_CHANGES && one.worktree !== undefined) {
    return removeWorktreeAndEnd($, one, one.worktree, true)
  }
}

// the status line's scale: green, yellow from half, orange from three quarters, red from 90
const usageColor = (percent: number) =>
  percent >= 90 ? 'red' : percent >= 75 ? '#ff8700' : percent >= 50 ? 'yellow' : 'green'

// a slim line to half a cell, its track dim; like rich's, a half cell's gap sets the fill apart
const usageBar = (percent: number) => {
  const halves = Math.min(20, Math.max(0, Math.round(percent / 5)))
  const whole = Math.floor(halves / 2)
  const isHalf = halves % 2 === 1
  const rest = 10 - whole - (isHalf ? 1 : 0)

  return {
    filled: `${'━'.repeat(whole)}${isHalf ? '╸' : ''}`,
    track: !isHalf && whole > 0 && rest > 0 ? `╺${'━'.repeat(rest - 1)}` : '━'.repeat(rest),
  }
}

// a chat-style avatar per model family: its initial on its colour; Opus in Claude's coral
const AVATARS = [
  { family: 'opus', letter: 'O', color: '#D97757' },
  { family: 'sonnet', letter: 'S', color: '#6A9BCC' },
  { family: 'fable', letter: 'F', color: '#A989D9' },
  { family: 'haiku', letter: 'H', color: '#7FB069' },
]

// on the session's /color, by its theme key, so it matches the prompt's border; else the model's
const avatarOf = ({ model, color }: SessionRow) => {
  const avatar =
    model === undefined
      ? undefined
      : AVATARS.find(each => model.toLowerCase().includes(each.family))

  return avatar === undefined || color === undefined
    ? avatar
    : { ...avatar, color: `${color}_FOR_SUBAGENTS_ONLY` }
}

// the effort's initial after the model's, so Opus at xhigh reads Ox; + for max
const EFFORT_LETTERS: Record<string, string> = {
  low: 'l',
  medium: 'm',
  high: 'h',
  xhigh: 'x',
  max: '+',
}

// a detail line's icon, each in its own muted tone so the lines tell apart at a glance
const DETAIL_ICONS = {
  place: { glyph: '⌂', color: '#6FA8DC' },
  branch: { glyph: '⎇', color: '#C586C0' },
  cost: { glyph: '$', color: '#98C379' },
  // a window of lines
  context: { glyph: '▤', color: '#E5C07B' },
}

const statusColor = (status: string) =>
  status === 'busy' ? 'yellow' : status === 'idle' ? 'green' : 'red'

// a shape per state as well as a colour, so it reads without colour too
const statusGlyph = (status: string) => (status === 'busy' ? '◐' : status === 'idle' ? '●' : '◆')

// the first pick saves the repos shown until then with it, so the choice stops following the live
// sessions
const toggleRepo = async ($: EngineInterface, repo: string) => {
  const { selected } = await read($, repoChoice)
  const changed = selected.includes(repo)
    ? selected.filter(one => one !== repo)
    : [...selected, repo]
  await $.fs.write(reposFileOf(await configDirOf($)), JSON.stringify(changed))
  await update($, repoChoice, choice => ({ ...choice, selected: changed }))
  await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (!e.isInteractive) return next(e)

    await $.command.register({
      name: 'sessions-sidebar',
      description: 'Toggle the sidebar of open Claude Code sessions',
    })
    await $.command.register({
      name: 'statusline-toggle',
      description: 'Hide or show the status line in every session of this profile',
    })
    // only a session that has never published its state is new: a reload keeps the person's /color
    const isOpenedByNewSession = (await $.env.get('SESSIONS_SIDEBAR_COLOR')) === 'random'
    const ownState = stateFileOf(await configDirOf($), await $.session.id())
    if (isOpenedByNewSession && !(await $.fs.exists(ownState).catch(() => true))) {
      // named no colour, /color picks one at random
      void $.command.run({ command: 'color' }).catch(() => undefined)
    }
    void refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    // redraws only while an autopilot card is on screen, and settles back when none is
    $.clock.every(PULSE_MS, async () => {
      const isAnyAutopilot = (await read($, rows)).some(one => one.isAutopilot)
      if (isAnyAutopilot || (await read($, pulse)))
        await update($, pulse, isLit => isAnyAutopilot && !isLit)
    })
    void $.ui.open({ id: PANE, title: 'Sessions', columns: PANE_COLUMNS })

    return next(e)
  })

  // /exit, ctrl+c, ctrl+d; a close from the sidebar ends as `other` and has already moved on
  on('session.end', async ($, e, next) => {
    if (e.reason === 'prompt_input_exit') await focusNextSession($).catch(() => undefined)

    return next(e)
  })

  // the profile's status line script prints nothing while this file sits beside it, so every
  // session hides it at its next redraw
  on('command.run', { command: 'statusline-toggle' }, async $ => {
    const marker = `${await configDirOf($)}/statusline.hidden`
    if (await $.fs.exists(marker).catch(() => false)) {
      await $.process.run(['rm', '-f', marker])

      return { text: 'Status line shown in every session.' }
    }

    await $.fs.write(marker, '')

    return { text: 'Status line hidden in every session.' }
  })

  on('command.run', { command: 'sessions-sidebar' }, async $ => {
    const isPlaced = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
    if (isPlaced) {
      await $.ui.close({ id: PANE })

      return { text: 'Sessions sidebar closed.' }
    }

    await refresh($)
    await $.ui.open({ id: PANE, title: 'Sessions', columns: PANE_COLUMNS })

    return { text: 'Sessions sidebar opened.' }
  })

  // the engine never scrolls the pane, so New Session stays pinned: the list moves under it instead,
  // a block (a heading, a session) per wheel tick
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const step = Math.sign(e.by) * Math.max(1, Math.round(Math.abs(e.by) / 3))
    await update($, listOffset, offset => Math.min(Math.max(0, offset + step), maxListOffset))

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // mobile draws no field yet
    const Input = 'Input' in elements ? elements.Input : undefined
    const [
      allLive,
      dormant,
      closed,
      checkout,
      search,
      searches,
      collapsed,
      offset,
      isPulsing,
      asked,
      archived,
      usage,
      level,
      repos,
      repoQuery,
      filters,
      newMenu,
    ] = await Promise.all([
      read($, rows),
      read($, dormantRows),
      read($, closedRows),
      read($, checkoutRows),
      read($, olderSearch),
      read($, sectionSearches),
      read($, collapsedSections),
      read($, listOffset),
      read($, pulse),
      read($, question),
      read($, archivedIds),
      read($, usageInfo),
      read($, detailLevel),
      read($, repoChoice),
      read($, repoSearch),
      read($, sectionFilters),
      read($, newSessionMenu),
    ])
    const columns = Math.max(1, e.props.bodyColumns)
    const rule = '─'.repeat(columns)
    const ruleWith = (label: string) => {
      const left = Math.max(0, Math.floor((columns - label.length) / 2))

      return `${'─'.repeat(left)}${label}${'─'.repeat(Math.max(0, columns - left - label.length))}`
    }
    // the question under a row: its frame, its wrapped text and one row per answer
    const questionRows = (key: string) =>
      asked?.key === key
        ? 2 + Math.ceil(asked.text.length / Math.max(1, columns - 6)) + asked.options.length
        : 0
    const questionBox = (key: string, handle: (choice: string) => Promise<unknown>) =>
      asked?.key === key && (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" marginLeft={2}>
          <Text wrap="wrap">{asked.text}</Text>
          {asked.options.map((option, index) => (
            <Box key={`answer-row-${key}-${index}`}>
              <Button
                key={`answer-${key}-${index}`}
                plain
                dimColor={option === 'Cancel'}
                hover={{
                  color: DESTRUCTIVE.includes(option) ? 'red' : 'cyan',
                  dimColor: false,
                }}
                onPress={() => answerQuestion($, key, option, handle)}
              >
                {`› ${option}`}
              </Button>
            </Box>
          ))}
        </Box>
      )
    // rows a wrapped name takes, rounded up so the last block is never cut off the bottom
    const nameRows = (name: string) => Math.ceil((name.length + 4) / Math.max(1, columns - 4))

    // a section's title and count, matches first while a search narrows it; on the right a ⌕ that
    // opens a search field under the title (Enter opens the first match), and with a `menu` a ≡
    const heading = ({
      id: section,
      title,
      count,
      matched,
      menu,
      openFirst,
      choices,
    }: {
      id: Section
      title: string
      count: number
      matched: number
      menu?: { text: string; options: string[]; handle: (choice: string) => Promise<unknown> }
      openFirst: (query: string) => Promise<unknown>
      // a line of filters under the title: the active one bold cyan, the others Buttons
      choices?: {
        active: string
        options: { id: string; label: string }[]
        choose: (id: string) => Promise<unknown>
      }
    }) => ({
      rows:
        3 +
        questionRows(`heading-${section}`) +
        (isSearching(section) && !collapsed.includes(section) ? 1 : 0) +
        (choices !== undefined && !collapsed.includes(section) ? 1 : 0),
      element: (
        <Box flexDirection="column" marginBottom={1} flexShrink={0}>
          <Box flexDirection="row">
            <Box key={`toggle-row-${section}`} flexShrink={0}>
              <Button
                key={`toggle-${section}`}
                plain
                dimColor
                hover={{ color: 'cyan', dimColor: false }}
                onPress={() => void toggleSection($, section)}
              >
                {collapsed.includes(section) ? '▸' : '▾'}
              </Button>
            </Box>
            <Box flexGrow={1}>
              <Text>
                {' '}
                <Text bold>{title}</Text>
                <Text dimColor>{`  ${matched === count ? count : `${matched}/${count}`}`}</Text>
              </Text>
            </Box>
            {!collapsed.includes(section) && Input !== undefined && (
              <Box key={`search-${section}-toggle-row`} flexShrink={0} marginRight={1}>
                <Button
                  key={`search-${section}-toggle`}
                  plain
                  dimColor
                  hover={{ color: 'cyan', dimColor: false }}
                  onPress={() => setSearch(section, isSearching(section) ? undefined : '')}
                >
                  ⌕
                </Button>
              </Box>
            )}
            {menu !== undefined && (
              <Box key={`heading-${section}-menu-row`} flexShrink={0}>
                <Button
                  key={`heading-${section}-menu`}
                  plain
                  dimColor
                  hover={{ color: 'cyan', dimColor: false }}
                  onPress={() => toggleQuestion($, `heading-${section}`, menu.text, menu.options)}
                >
                  ≡
                </Button>
              </Box>
            )}
          </Box>
          {isSearching(section) && !collapsed.includes(section) && Input !== undefined && (
            <Input
              key={`search-${section}`}
              placeholder="Search…"
              value={searches[section]}
              submitLabel="open"
              autoFocus
              onInput={text => void setSearch(section, text)}
              onSubmit={async text => {
                await setSearch(section, undefined)
                await openFirst(text)
              }}
            />
          )}
          {menu !== undefined && questionBox(`heading-${section}`, menu.handle)}
          {choices !== undefined && !collapsed.includes(section) && (
            <Box key={`${section}-choices-row`} flexDirection="row">
              <Text> </Text>
              {choices.options.map((one, index) => (
                <Box key={`${section}-choice-${one.id}-row`} flexDirection="row" flexShrink={0}>
                  <Text dimColor>{index === 0 ? ' ' : ' · '}</Text>
                  {one.id === choices.active ? (
                    <Text bold color="cyan">
                      {one.label}
                    </Text>
                  ) : (
                    <Button
                      key={`${section}-choice-${one.id}`}
                      plain
                      dimColor
                      hover={{ color: 'cyan', dimColor: false }}
                      onPress={() => choices.choose(one.id)}
                    >
                      {one.label}
                    </Button>
                  )}
                </Box>
              ))}
            </Box>
          )}
          <Text dimColor>{rule}</Text>
        </Box>
      ),
    })
    const none = (text: string) => ({
      rows: 2,
      element: (
        <Box marginBottom={1} flexShrink={0}>
          <Text dimColor>{` ${text}`}</Text>
        </Box>
      ),
    })
    const accent = isPulsing ? 'magenta' : 'yellow'
    // a Text shrinks beside a long one and wraps onto a line the bar leaves blank: only names give way
    // a session's detail: its icon in colour, the rest dim
    const detail = (indent: string, icon: keyof typeof DETAIL_ICONS, text: string) => (
      <Text wrap="truncate-end">
        {indent}
        <Text color={DETAIL_ICONS[icon].color}>{DETAIL_ICONS[icon].glyph}</Text>
        <Text dimColor>{` ${text}`}</Text>
      </Text>
    )
    const marker = (one: SessionRow) => (
      <Box flexShrink={0}>
        <Text color="cyan">{one.isCurrent ? '▎' : ' '}</Text>
      </Box>
    )
    // a line of a live session's block, its coloured lead apart; under the pointer another session's
    // block lights as one, its lines brighter and its name bold. Only the name opens it: every
    // Button inverts under the pointer
    const liveLine = ({
      one,
      icon,
      fill,
      text,
      trail,
    }: {
      one: SessionRow
      icon: keyof typeof DETAIL_ICONS
      fill?: { text: string; color: string }
      text: string
      // drawn right after the text, which gives way to it
      trail?: { text: string; color?: string; isDim: boolean }
    }) => (
      <Box flexDirection="row">
        {marker(one)}
        <Box flexShrink={0}>
          <Text>
            {'  '}
            <Text color={DETAIL_ICONS[icon].color}>{DETAIL_ICONS[icon].glyph}</Text>{' '}
            {fill !== undefined && <Text color={fill.color}>{fill.text}</Text>}
          </Text>
        </Box>
        <Box flexShrink={1} overflow="hidden">
          <Text
            dimColor
            wrap="truncate-end"
            hover={one.isCurrent ? undefined : { scope: `session-${one.pid}`, dimColor: false }}
          >
            {text}
          </Text>
        </Box>
        {trail !== undefined && (
          <Box flexShrink={0}>
            <Text color={trail.color} dimColor={trail.isDim}>
              {trail.text}
            </Text>
          </Box>
        )}
      </Box>
    )
    const isCompact = level === 'compact'
    const isFull = level === 'full'
    // compact rows sit without a gap, all but the last, which keeps the one before the next heading
    const liveRow = (one: SessionRow, index: number, shown: readonly SessionRow[]) => ({
      rows:
        1 +
        (isCompact && index < shown.length - 1 ? 0 : 1) +
        (isCompact
          ? 0
          : 1 + (one.branch === undefined ? 0 : 1) + (one.context === undefined ? 0 : 1)) +
        (isFull ? (one.agents > 0 ? 1 : 0) + (one.cost === undefined ? 0 : 1) : 0) +
        // the frame's two edges and the badge
        (one.isAutopilot ? 3 : 0) +
        questionRows(liveKey(one)),
      element: (
        <Box
          flexDirection="column"
          marginBottom={isCompact && index < shown.length - 1 ? 0 : 1}
          flexShrink={0}
          borderStyle={one.isAutopilot ? 'round' : undefined}
          borderColor={accent}
        >
          {one.isAutopilot && (
            <Text backgroundColor={accent} color="black" bold>
              {' ⚡ AUTOPILOT '}
            </Text>
          )}
          <Box flexDirection="row">
            {marker(one)}
            <Box flexShrink={0}>
              <Text color={statusColor(one.status)}>{`${statusGlyph(one.status)} `}</Text>
            </Box>
            {avatarOf(one) !== undefined && (
              // half-cell blocks pad it evenly at full height; Hack's half circles came out too small
              <Box flexShrink={0}>
                <Text>
                  <Text color={avatarOf(one)?.color}>▐</Text>
                  <Text backgroundColor={avatarOf(one)?.color} color="black" bold>
                    {`${avatarOf(one)?.letter}${EFFORT_LETTERS[one.effort ?? ''] ?? ''}`}
                  </Text>
                  <Text color={avatarOf(one)?.color}>▌</Text>
                  {/* a session yet to answer has no effort: pad, so the names still line up */}
                  {EFFORT_LETTERS[one.effort ?? ''] === undefined ? '  ' : ' '}
                </Text>
              </Box>
            )}
            <Box key={`row-${one.pid}`} flexGrow={1} flexShrink={1} overflow="hidden">
              {one.isCurrent ? (
                <Text bold color="cyan" wrap="truncate-end">
                  {one.name}
                </Text>
              ) : (
                <Button
                  key={`session-${one.pid}`}
                  plain
                  hover={{ scope: `session-${one.pid}`, bold: true }}
                  onPress={() => focusWarpTab($, one)}
                >
                  {one.name}
                </Button>
              )}
            </Box>
            <Box key={`menu-row-${one.pid}`} flexShrink={0}>
              <Button
                key={`menu-${one.pid}`}
                plain
                dimColor
                hover={{ color: 'cyan', dimColor: false }}
                onPress={() => openSessionMenu($, one)}
              >
                ≡
              </Button>
            </Box>
          </Box>
          {!isCompact && liveLine({ one, icon: 'place', text: one.place })}
          {!isCompact &&
            one.branch !== undefined &&
            liveLine({ one, icon: 'branch', text: one.branch })}
          {!isCompact &&
            one.context !== undefined &&
            liveLine({
              one,
              icon: 'context',
              fill: {
                text: usageBar(one.context.percent).filled,
                color: usageColor(one.context.percent),
              },
              text: `${usageBar(one.context.percent).track} ${one.context.percent}% of ${
                one.context.window >= 1_000_000
                  ? `${one.context.window / 1_000_000}M`
                  : `${Math.round(one.context.window / 1000)}k`
              }`,
              // Remote Control is on, in a soft red
              trail: one.isRemote ? { text: '  rc', color: '#E06C75', isDim: false } : undefined,
            })}
          {isFull &&
            one.cost !== undefined &&
            liveLine({ one, icon: 'cost', text: `${one.cost.toFixed(2)} spent` })}
          {isFull && one.agents > 0 && (
            <Box flexDirection="row">
              {marker(one)}
              <Text color="yellow" wrap="truncate-end">
                {`  ⚙ ${one.agents} ${one.agents === 1 ? 'agent' : 'agents'} working`}
              </Text>
            </Box>
          )}
          {questionBox(liveKey(one), choice => answerSessionQuestion($, one, choice))}
        </Box>
      ),
    })
    // a dormant, closed or archived session: its name resumes it in a new Warp tab; on its right a
    // ≡ asking `menu` under the row, or with no menu a ↻ that resumes too
    const resumableRow = (
      one: {
        key: string
        glyph: string
        name: string
        place: string
        isGone: boolean
        cost?: number
      },
      onPress: () => Promise<void>,
      menu?: { text: string; options: string[]; handle: (choice: string) => Promise<unknown> },
    ) => ({
      rows: nameRows(one.name) + 2 + (one.cost === undefined ? 0 : 1) + questionRows(one.key),
      element: (
        <Box flexDirection="column" marginBottom={1} flexShrink={0}>
          <Box flexDirection="row">
            <Box flexShrink={0}>
              <Text dimColor>{` ${one.glyph} `}</Text>
            </Box>
            {/* no overflow clip: a long name wraps onto the next line instead of being cut */}
            <Box key={`${one.key}-row`} flexGrow={1} flexShrink={1}>
              <Button
                key={one.key}
                plain
                dimColor
                hover={{ underline: true, dimColor: false }}
                onPress={onPress}
              >
                {one.name}
              </Button>
            </Box>
            {menu === undefined ? (
              <Box key={`${one.key}-resume-row`} flexShrink={0}>
                <Button
                  key={`${one.key}-resume`}
                  plain
                  dimColor
                  hover={{ color: 'green', dimColor: false }}
                  onPress={onPress}
                >
                  ↻
                </Button>
              </Box>
            ) : (
              <Box key={`${one.key}-menu-row`} flexShrink={0}>
                <Button
                  key={`${one.key}-menu`}
                  plain
                  dimColor
                  hover={{ color: 'cyan', dimColor: false }}
                  onPress={() => toggleQuestion($, one.key, menu.text, menu.options)}
                >
                  ≡
                </Button>
              </Box>
            )}
          </Box>
          {one.isGone ? (
            <Text wrap="truncate-end">
              {'   '}
              <Text color="red">⌂</Text>{' '}
              <Text dimColor strikethrough>
                {one.place}
              </Text>
            </Text>
          ) : (
            detail('   ', 'place', one.place)
          )}
          {one.cost !== undefined && detail('   ', 'cost', `${one.cost.toFixed(2)} spent`)}
          {menu !== undefined && questionBox(one.key, menu.handle)}
        </Box>
      ),
    })

    const isSearching = (section: Section) => searches[section] !== undefined
    const setSearch = (section: Section, text: string | undefined) =>
      update($, sectionSearches, all => ({ ...all, [section]: text }))
    // a row matches while one of its texts holds the query, case aside
    const holds = (query: string, texts: readonly (string | undefined)[]) => {
      const wanted = query.trim().toLowerCase()

      return wanted === '' || texts.some(text => text?.toLowerCase().includes(wanted) ?? false)
    }
    const liveTexts = (one: SessionRow) => [one.name, one.branch, one.place]
    const placeTexts = (one: { name: string; place: string }) => [one.name, one.place]
    // what Enter opens: the first row the text as submitted matches, ahead of any redraw
    const firstOf =
      <T,>(
        rows: readonly T[],
        textsOf: (one: T) => (string | undefined)[],
        open: (one: T) => Promise<unknown>,
      ) =>
      async (query: string) => {
        const first = rows.find(one => holds(query, textsOf(one)))
        if (first !== undefined) await open(first)
      }
    const kindOf = (section: Section) => filters[section] ?? 'all'
    const keeps = (section: Section, hasWorktree: boolean) =>
      kindOf(section) === 'all' || (kindOf(section) === 'worktrees') === hasWorktree
    // the filter line under a heading, each choice with how many it lists, the search aside
    const kindChoices = (section: Section, counts: { worktrees: number; adhoc: number }) => ({
      active: kindOf(section),
      options: KIND_FILTERS.map(one => ({
        ...one,
        label: `${one.label} ${
          (one.id === 'adhoc' ? 0 : counts.worktrees) + (one.id === 'worktrees' ? 0 : counts.adhoc)
        }`,
      })),
      choose: (id: string) => setSectionFilter($, section, isKindFilter(id) ? id : 'all'),
    })
    // only those in the repos picked; the rows atom keeps them all for /exit's next tab
    const inRepos = allLive.filter(one => repos.selected.includes(one.repo))
    // then the kind: a linked worktree, or the main checkout; Close all takes what is left
    const list = inRepos.filter(one => keeps('live', one.worktree !== undefined))
    const shownLive = list.filter(one => holds(searches.live ?? '', liveTexts(one)))
    const shownDormant = dormant.filter(one => holds(searches.dormant ?? '', placeTexts(one)))
    // Done: sessions whose worktree is gone, and the ad hoc ones archived from Closed; newest first,
    // the last week listed and the rest under its own older menu
    const doneAll = [
      ...closed.map(one => ({ ...one, isArchived: false })),
      ...checkout
        .filter(one => archived.includes(one.sessionId))
        .map(one => ({ ...one, isArchived: true })),
    ].sort((a, b) => b.modifiedAt - a.modifiedAt)
    const doneKept = doneAll.filter(one => keeps('closed', !one.isArchived))
    const doneRecent = doneKept.filter(one => one.isRecent)
    const matchedDone = doneRecent.filter(one => holds(searches.closed ?? '', placeTexts(one)))
    // picking an archived one up again takes it out of the archive, so it returns to Closed after
    const resumeDone = async (one: ClosedRow) => {
      if (archived.includes(one.sessionId)) await setArchived($, [one.sessionId], false)
      await resumeClosedSession($, one)
    }
    const busyCount = list.filter(one => one.status === 'busy').length
    const resumeOrArchive = (one: ClosedRow) => ({
      text: 'Resume it, or archive it to Done?',
      options: [RESUME, ARCHIVE],
      handle: (choice: string) =>
        choice === ARCHIVE ? setArchived($, [one.sessionId], true) : resumeClosedSession($, one),
    })
    const shownCheckout = checkout.filter(one => !archived.includes(one.sessionId) && one.isRecent)
    const matchedCheckout = shownCheckout.filter(one =>
      holds(searches.dormant ?? '', placeTexts(one)),
    )
    // a section's sessions older than a week, under one row whose menu pages and searches them; the
    // menu is open while the question's key names it with the page on offer, <id>-older-<page>, and
    // takes the question's place, so one menu is open at a time
    const olderPicker = (
      id: string,
      rows: readonly ClosedRow[],
      pick: (one: ClosedRow) => Promise<unknown>,
    ) => {
      const olderPage = asked?.key.startsWith(`${id}-older-`)
        ? Number(asked.key.split('-').at(-1))
        : undefined
      const matching = rows.filter(one => holds(search, [one.name]))
      const start = (olderPage ?? 0) * OLDER_PAGE_SIZE
      const offered = matching.slice(start, start + OLDER_PAGE_SIZE)
      const hasMore = matching.length > start + offered.length
      const showOlderPage = (page: number) =>
        update($, question, () => ({ key: `${id}-older-${page}`, text: '', options: [] }))
      const closeOlder = () => update($, question, () => null)
      const pickOlder = async (one: ClosedRow) => {
        await closeOlder()
        await pick(one)
      }
      return {
        // the frame, the field, the count, the page, More and Cancel
        rows: 2 + (olderPage === undefined ? 0 : 5 + offered.length + (hasMore ? 1 : 0)),
        element: (
          <Box flexDirection="column" marginBottom={1} flexShrink={0}>
            <Box key={`${id}-older-row`}>
              <Button
                key={`${id}-older`}
                plain
                dimColor
                hover={{ color: 'cyan', dimColor: false }}
                onPress={async () => {
                  if (olderPage !== undefined) return closeOlder()
                  await update($, olderSearch, () => '')
                  await showOlderPage(0)
                }}
              >
                {` ≡ ${rows.length} older`}
              </Button>
            </Box>
            {olderPage !== undefined && (
              <Box flexDirection="column" borderStyle="round" borderColor="cyan" marginLeft={2}>
                {Input !== undefined && (
                  <Input
                    key={`${id}-older-search`}
                    placeholder="Search…"
                    value={search}
                    submitLabel="resume"
                    autoFocus
                    onInput={text =>
                      void Promise.all([update($, olderSearch, () => text), showOlderPage(0)])
                    }
                    // Enter resumes the first match
                    onSubmit={text => {
                      const first = rows.find(one => holds(text, [one.name]))
                      if (first !== undefined) void pickOlder(first)
                    }}
                  />
                )}
                <Text dimColor>
                  {matching.length === 0
                    ? 'No match'
                    : `${start + 1}–${start + offered.length} of ${matching.length}`}
                </Text>
                {offered.map((one, index) => (
                  <Box key={`${id}-older-pick-row-${index}`}>
                    <Button
                      key={`${id}-older-pick-${index}`}
                      plain
                      hover={{ color: 'cyan' }}
                      onPress={() => pickOlder(one)}
                    >
                      {`› ${one.name}`}
                    </Button>
                  </Box>
                ))}
                {hasMore && (
                  <Box key={`${id}-older-more-row`}>
                    <Button
                      key={`${id}-older-more`}
                      plain
                      dimColor
                      hover={{ color: 'cyan', dimColor: false }}
                      onPress={() => showOlderPage(start / OLDER_PAGE_SIZE + 1)}
                    >
                      › More…
                    </Button>
                  </Box>
                )}
                <Box key={`${id}-older-cancel-row`}>
                  <Button
                    key={`${id}-older-cancel`}
                    plain
                    dimColor
                    hover={{ color: 'cyan', dimColor: false }}
                    onPress={closeOlder}
                  >
                    › Cancel
                  </Button>
                </Box>
              </Box>
            )}
          </Box>
        ),
      }
    }
    const older = checkout.filter(one => !archived.includes(one.sessionId) && !one.isRecent)
    const olderMenu = olderPicker('checkout', older, one => resumeClosedSession($, one))
    const checkoutRow = (one: CheckoutRow) =>
      resumableRow(
        { ...one, key: `checkout-${one.sessionId}`, glyph: '○', isGone: false },
        () => resumeClosedSession($, one),
        resumeOrArchive(one),
      )
    // the repos every section and the costs cover; its menu opens like Ad hoc's older one, under the
    // question key repos-<page>
    const repoPage = asked?.key.startsWith('repos-')
      ? Number(asked.key.split('-').at(-1))
      : undefined
    const matchingRepos = repos.options.filter(one =>
      holds(repoQuery, [baseName(one.path), one.path]),
    )
    const repoStart = (repoPage ?? 0) * OLDER_PAGE_SIZE
    const offeredRepos = matchingRepos.slice(repoStart, repoStart + OLDER_PAGE_SIZE)
    const hasMoreRepos = matchingRepos.length > repoStart + offeredRepos.length
    const showRepoPage = (page: number) =>
      update($, question, () => ({ key: `repos-${page}`, text: '', options: [] }))
    const closeRepos = () => update($, question, () => null)
    const repoNames = repos.selected.map(baseName)
    // one line: past the pane's width, the first and how many more
    const repoLabel =
      repoNames.length === 0
        ? 'No repo'
        : repoNames.join(', ').length <= columns - 6
          ? repoNames.join(', ')
          : `${repoNames[0]} +${repoNames.length - 1}`
    const repoPicker = {
      // the line and its gap; open, the frame, the field, the ticks or No match, More and Done
      rows:
        2 +
        (repoPage === undefined
          ? 0
          : 4 + Math.max(1, offeredRepos.length) + (hasMoreRepos ? 1 : 0)),
      element: (
        <Box flexDirection="column" marginBottom={1} flexShrink={0}>
          <Box key="repos-row" flexDirection="row">
            <Box flexShrink={0}>
              <Text color={DETAIL_ICONS.place.color}> ⌂ </Text>
            </Box>
            <Button
              key="repos-toggle"
              plain
              dimColor
              hover={{ color: 'cyan', dimColor: false }}
              onPress={async () => {
                if (repoPage !== undefined) return closeRepos()
                await update($, repoSearch, () => '')
                await showRepoPage(0)
              }}
            >
              {`${repoLabel} ▾`}
            </Button>
          </Box>
          {repoPage !== undefined && (
            <Box flexDirection="column" borderStyle="round" borderColor="cyan" marginLeft={2}>
              {Input !== undefined && (
                <Input
                  key="repos-search"
                  placeholder="Search…"
                  value={repoQuery}
                  submitLabel="tick"
                  autoFocus
                  onInput={text =>
                    void Promise.all([update($, repoSearch, () => text), showRepoPage(0)])
                  }
                  // Enter ticks or unticks the first match
                  onSubmit={text => {
                    const first = repos.options.find(one =>
                      holds(text, [baseName(one.path), one.path]),
                    )
                    if (first !== undefined) void toggleRepo($, first.path)
                  }}
                />
              )}
              {offeredRepos.length === 0 && <Text dimColor>No match</Text>}
              {offeredRepos.map((one, index) => (
                <Box key={`repos-pick-row-${index}`}>
                  <Button
                    key={`repos-pick-${index}`}
                    plain
                    hover={{ color: 'cyan' }}
                    onPress={() => toggleRepo($, one.path)}
                  >
                    {`${repos.selected.includes(one.path) ? '■' : '□'} ${baseName(one.path)}${
                      one.live === 0 ? '' : ` ● ${one.live}`
                    }`}
                  </Button>
                </Box>
              ))}
              {hasMoreRepos && (
                <Box key="repos-more-row">
                  <Button
                    key="repos-more"
                    plain
                    dimColor
                    hover={{ color: 'cyan', dimColor: false }}
                    onPress={() => showRepoPage(repoStart / OLDER_PAGE_SIZE + 1)}
                  >
                    › More…
                  </Button>
                </Box>
              )}
              <Box key="repos-done-row">
                <Button
                  key="repos-done"
                  plain
                  dimColor
                  hover={{ color: 'cyan', dimColor: false }}
                  onPress={closeRepos}
                >
                  › Done
                </Button>
              </Box>
            </Box>
          )}
        </Box>
      ),
    }
    // Closed's rows as the filter has them, before and after its search
    const filter = kindOf('dormant')
    const closedCount =
      (filter === 'adhoc' ? 0 : dormant.length) +
      (filter === 'worktrees' ? 0 : shownCheckout.length)
    const closedMatched =
      (filter === 'adhoc' ? 0 : shownDormant.length) +
      (filter === 'worktrees' ? 0 : matchedCheckout.length)
    // the heading's ≡ acts on what the filter shows; only a session, not a worktree, is archived
    const closedEntries = [
      ...(filter === 'adhoc'
        ? []
        : dormant.map(one => ({ texts: placeTexts(one), open: () => resumeInWarpTab($, one) }))),
      ...(filter === 'worktrees'
        ? []
        : shownCheckout.map(one => ({
            texts: placeTexts(one),
            open: () => resumeClosedSession($, one),
          }))),
    ]
    const reopenable = closedEntries.map(entry => entry.open)
    const archivable = filter === 'worktrees' ? [] : shownCheckout
    const closedMenu =
      reopenable.length === 0
        ? undefined
        : {
            text:
              archivable.length === 0
                ? `Reopen all ${reopenable.length} closed ${
                    filter === 'worktrees' ? 'worktrees' : 'sessions'
                  }, each in a new tab?`
                : archivable.length === reopenable.length
                  ? `The ${reopenable.length} ad hoc sessions listed: reopen each in a new tab, or archive them?`
                  : `The ${reopenable.length} closed sessions listed: reopen each in a new tab, or archive the ${archivable.length} ad hoc ones?`,
            options: archivable.length === 0 ? [REOPEN_ALL] : [REOPEN_ALL, ARCHIVE_ALL],
            handle: (choice: string) =>
              choice === ARCHIVE_ALL
                ? ask(
                    $,
                    'heading-dormant',
                    `Really archive all ${archivable.length} ad hoc sessions listed? They move to Done.`,
                    [CONFIRM_ARCHIVE_ALL],
                  )
                : choice === CONFIRM_ARCHIVE_ALL
                  ? setArchived(
                      $,
                      archivable.map(one => one.sessionId),
                      true,
                    )
                  : reopenAll($, reopenable),
          }
    const sections = [
      {
        id: 'live' as const,
        title: 'Live',
        count: list.length,
        matched: shownLive.length,
        openFirst: firstOf(list, liveTexts, one => focusWarpTab($, one)),
        choices: kindChoices('live', {
          worktrees: inRepos.filter(one => one.worktree !== undefined).length,
          adhoc: inRepos.filter(one => one.worktree === undefined).length,
        }),
        // the other two levels to switch to, then Close all
        menu: {
          text: `Showing ${level} detail. Close all ${list.length} live sessions, keeping their worktrees?${
            busyCount === 0 ? '' : ` ${busyCount} ${busyCount === 1 ? 'is' : 'are'} busy.`
          }`,
          options: [
            ...DETAIL_LEVELS.filter(other => other !== level).map(other => `Show ${other}`),
            CLOSE_ALL,
          ],
          handle: (choice: string) => {
            if (choice === CLOSE_ALL) {
              return ask(
                $,
                'heading-live',
                `Really close all ${list.length}${
                  list.some(one => one.isCurrent) ? ', this one too' : ''
                }? Their worktrees stay.`,
                [CONFIRM_CLOSE_ALL],
              )
            }
            if (choice === CONFIRM_CLOSE_ALL) return closeAllSessions($, list)
            const chosen = DETAIL_LEVELS.find(other => choice === `Show ${other}`)

            return chosen === undefined ? Promise.resolve() : setDetailLevel($, chosen)
          },
        },
        items: shownLive.map(liveRow),
      },
      // paused work: worktrees no session runs in (↻), then named sessions that never had one
      // (≡), newest first, with the older of those in their own menu; the filter picks either
      {
        id: 'dormant' as const,
        title: 'Closed',
        count: closedCount,
        matched: closedMatched,
        openFirst: firstOf(
          closedEntries,
          entry => entry.texts,
          entry => entry.open(),
        ),
        choices: kindChoices('dormant', {
          worktrees: dormant.length,
          adhoc: shownCheckout.length,
        }),
        menu: closedMenu,
        items: [
          ...(filter === 'adhoc'
            ? []
            : shownDormant.map(one =>
                resumableRow(
                  { ...one, key: `dormant-${one.path}`, glyph: '○', isGone: false },
                  () => resumeInWarpTab($, one),
                ),
              )),
          ...(filter === 'worktrees' ? [] : matchedCheckout.map(checkoutRow)),
          ...(filter === 'worktrees' || older.length === 0 ? [] : [olderMenu]),
        ],
      },
      {
        id: 'closed' as const,
        title: 'Done',
        count: doneRecent.length,
        matched: matchedDone.length,
        openFirst: firstOf(doneRecent, placeTexts, resumeDone),
        // Worktrees: their worktree is gone; Ad hoc: archived from Closed
        choices: kindChoices('closed', {
          worktrees: doneAll.filter(one => one.isRecent && !one.isArchived).length,
          adhoc: doneAll.filter(one => one.isRecent && one.isArchived).length,
        }),
        items: [
          ...matchedDone.map(one =>
            resumableRow(
              {
                ...one,
                key: `closed-${one.sessionId}`,
                glyph: one.isArchived ? '·' : '◌',
                isGone: !one.isArchived,
              },
              () => resumeDone(one),
              one.isArchived
                ? {
                    text: 'Resume it, or move it back to Closed?',
                    options: [RESUME, UNARCHIVE_TO('Closed')],
                    handle: async choice => {
                      await setArchived($, [one.sessionId], false)
                      if (choice === RESUME) await resumeClosedSession($, one)
                    },
                  }
                : undefined,
            ),
          ),
          ...(doneKept.length === doneRecent.length
            ? []
            : [
                olderPicker(
                  'done',
                  doneKept.filter(one => !one.isRecent),
                  resumeDone,
                ),
              ]),
        ],
      },
    ]
    const blocks = [
      repoPicker,
      ...sections.flatMap(section => [
        heading(section),
        ...(collapsed.includes(section.id)
          ? []
          : section.items.length === 0
            ? [none(section.count === 0 ? 'None' : 'No match')]
            : section.items),
      ]),
    ]
    // pinned below the list: a rule and New Session, then its own section of usage figures under
    // another rule
    // every live session's cost, whatever a search hides; none when no session has one yet
    // the repos', whatever Live's filter hides, so the 7d and repo totals stay whole
    const costs = inRepos.flatMap(one => (one.cost === undefined ? [] : [one.cost]))
    const totalCost = costs.length === 0 ? undefined : costs.reduce((sum, cost) => sum + cost, 0)
    // the live ones as they stand now; the week and the repo add what every other session saved
    const spent = [
      ...(totalCost === undefined ? [] : [{ usd: totalCost, label: 'live' }]),
      ...(usage.spend === undefined
        ? []
        : [
            { usd: usage.spend.week + (totalCost ?? 0), label: '7d' },
            { usd: usage.spend.repo + (totalCost ?? 0), label: 'repo' },
          ]),
    ]
    // short enough for one line: cents under $100, dollars under $1,000, then thousands
    const compactDollars = (usd: number) =>
      usd < 100
        ? usd.toFixed(2)
        : usd < 1000
          ? String(Math.round(usd))
          : `${(usd / 1000).toFixed(usd < 10_000 ? 1 : 0)}k`
    const usageRows =
      usage.limits.length + (usage.cache === undefined ? 0 : 1) + (spent.length === 0 ? 0 : 1)
    // Default first, as settings names it, then each model with the badge its session would wear
    const newSessionPicker = (picker: NonNullable<typeof newMenu>) => {
      const defaultModel = NEW_SESSION_MODELS.find(
        one => one.model === picker.defaultModel || one.family === picker.defaultModel,
      )
      const launch = async (model: string | undefined) => {
        await update($, newSessionMenu, () => null)
        await startNewSession($, { model, effort: picker.effort })
      }
      const badge = (one: (typeof NEW_SESSION_MODELS)[number] | undefined) => {
        const avatar = AVATARS.find(each => each.family === one?.family)
        if (avatar === undefined || one === undefined) return <Text>{'     '}</Text>
        const letter = EFFORT_LETTERS[picker.effort ?? picker.saved[one.model] ?? ''] ?? ''

        return (
          <Text>
            <Text color={avatar.color}>▐</Text>
            <Text backgroundColor={avatar.color} color="black" bold>
              {`${avatar.letter}${letter}`}
            </Text>
            <Text color={avatar.color}>▌</Text>
            {letter === '' ? '  ' : ' '}
          </Text>
        )
      }
      const choices = [
        {
          key: 'default',
          label: `Default${defaultModel === undefined ? '' : ` · ${defaultModel.label}`}`,
          one: defaultModel,
          model: undefined,
        },
        ...NEW_SESSION_MODELS.map(one => ({
          key: one.family,
          label: one.label,
          one,
          model: one.model,
        })),
      ]

      return (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" marginX={1}>
          {choices.map(choice => (
            <Box key={`new-session-pick-${choice.key}-row`} flexDirection="row">
              <Box flexShrink={0}>{badge(choice.one)}</Box>
              <Button
                key={`new-session-pick-${choice.key}`}
                plain
                hover={{ color: 'cyan' }}
                onPress={() => launch(choice.model)}
              >
                {choice.label}
              </Button>
            </Box>
          ))}
          <Box key="new-session-effort-row" flexDirection="row">
            <Text dimColor>effort </Text>
            {[undefined, ...EFFORT_LEVELS].map(level => (
              <Box key={`new-session-effort-${level ?? 'saved'}-row`} flexShrink={0}>
                <Text> </Text>
                {picker.effort === level ? (
                  <Text bold color="cyan">
                    {level === undefined ? 'saved' : EFFORT_LETTERS[level]}
                  </Text>
                ) : (
                  <Button
                    key={`new-session-effort-${level ?? 'saved'}`}
                    plain
                    dimColor
                    hover={{ color: 'cyan', dimColor: false }}
                    onPress={() => update($, newSessionMenu, () => ({ ...picker, effort: level }))}
                  >
                    {level === undefined ? 'saved' : (EFFORT_LETTERS[level] ?? level)}
                  </Button>
                )}
              </Box>
            ))}
          </Box>
          <Box key="new-session-cancel-row">
            <Button
              key="new-session-cancel"
              plain
              dimColor
              hover={{ color: 'cyan', dimColor: false }}
              onPress={() => update($, newSessionMenu, () => null)}
            >
              › Cancel
            </Button>
          </Box>
        </Box>
      )
    }
    // the picker: its frame, Default, the models, the effort line and Cancel
    const newMenuRows = newMenu === null ? 0 : 4 + NEW_SESSION_MODELS.length + 1
    const footerRows = 2 + newMenuRows + (usageRows > 0 ? 1 + usageRows : 0)
    // the list's rows: the pane's, less the footer and the top line that shows "more above"
    const listRows = e.props.scroll.bodyRows - footerRows - 1
    const firstThatFitsToTheEnd = blocks.findIndex(
      (_, index) => blocks.slice(index).reduce((sum, block) => sum + block.rows, 0) <= listRows,
    )
    const maxOffset = firstThatFitsToTheEnd === -1 ? blocks.length - 1 : firstThatFitsToTheEnd
    // the terminal's limit; a phone or desktop drawing the same pane has rows of its own
    if (e.surface === 'terminal') maxListOffset = maxOffset
    // a collapse or a shorter list can leave the stored offset past the end
    const shown = Math.min(offset, maxOffset)

    return (
      <Box flexDirection="column" height={e.props.scroll.bodyRows}>
        <Box
          flexDirection="column"
          height={e.props.scroll.bodyRows - footerRows}
          flexShrink={0}
          overflow="hidden"
        >
          {/* kept from shrinking: an overflowing list squeezed this gap away */}
          <Box flexShrink={0}>
            <Text dimColor>{shown > 0 ? ruleWith(' ▲ more ') : ' '}</Text>
          </Box>
          {blocks.slice(shown).map(block => block.element)}
        </Box>
        <Box flexDirection="column" flexShrink={0}>
          <Text dimColor>{shown < maxOffset ? ruleWith(' ▼ more ') : rule}</Text>
          <Box key="new-session-row" justifyContent="center">
            <Button key="new-session" variant="primary" onPress={() => toggleNewSessionMenu($)}>
              + New Session
            </Button>
          </Box>
          {newMenu !== null && newSessionPicker(newMenu)}
          {usageRows > 0 && <Text dimColor>{rule}</Text>}
          {usage.limits.map(limit => (
            <Text wrap="truncate-end">
              <Text dimColor>{` ${limit.label} `}</Text>
              <Text color={usageColor(limit.percent)}>{usageBar(limit.percent).filled}</Text>
              <Text dimColor>{usageBar(limit.percent).track}</Text>
              <Text color={usageColor(limit.percent)} bold>
                {` ${String(limit.percent).padStart(3)}%`}
              </Text>
              {limit.resetsIn !== undefined && <Text dimColor>{`  resets ${limit.resetsIn}`}</Text>}
            </Text>
          ))}
          {usage.cache !== undefined && (
            <Text wrap="truncate-end">
              <Text dimColor> cache </Text>
              {usage.cache.isWarm ? (
                <Text color="green">{`● warm, ${usage.cache.left} left`}</Text>
              ) : (
                <Text color="red">○ expired</Text>
              )}
            </Text>
          )}
          {spent.length > 0 && (
            <Text wrap="truncate-end">
              {' '}
              <Text color={DETAIL_ICONS.cost.color}>$</Text>
              {spent.map((part, index) => (
                <Text>
                  <Text dimColor>{index === 0 ? ' ' : ' · '}</Text>
                  {compactDollars(part.usd)}
                  <Text dimColor>{` ${part.label}`}</Text>
                </Text>
              ))}
            </Text>
          )}
        </Box>
      </Box>
    )
  })
}
