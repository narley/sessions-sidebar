import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const FILES: Record<string, object> = {
  // the effort each model starts at; 'me' runs on Opus
  '/cfg/settings.json': {
    model: 'opus[1m]',
    effortLevel: 'medium',
    modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } },
  },
  '/cfg/sessions/1.json': {
    pid: 1,
    sessionId: 'me',
    cwd: '/repo/ioi',
    startedAt: 10,
    kind: 'interactive',
    name: 'ioi-main',
    status: 'busy',
    bridgeSessionId: 'session_me',
  },
  '/cfg/sessions/2.json': {
    pid: 2,
    sessionId: 'crashed',
    cwd: '/repo/ioi',
    startedAt: 20,
    kind: 'interactive',
    name: 'gone',
    status: 'idle',
  },
  '/cfg/sessions/3.json': {
    pid: 3,
    sessionId: 'other',
    cwd: '/repo/ioi/.claude/worktrees/2412',
    startedAt: 5,
    kind: 'interactive',
    status: 'idle',
    bridgeSessionId: 'session_other',
  },
  '/cfg/sessions/4.json': {
    pid: 4,
    sessionId: 'auto',
    cwd: '/repo/ioi',
    startedAt: 30,
    kind: 'interactive',
    name: '2441-autopilot',
    status: 'idle',
    // Remote Control turned off
    bridgeSessionId: null,
  },
  // a background session (claude --bg) that session 3 started; dead unless a test's ps lists pid 8
  '/cfg/sessions/8.json': {
    pid: 8,
    sessionId: 'bgjob',
    cwd: '/repo/ioi',
    startedAt: 70,
    kind: 'bg',
    entrypoint: 'cli',
    jobId: 'ab12cd34',
    name: 'probe-2412',
    status: 'busy',
    bridgeSessionId: 'session_bg',
  },
  // its job, as the background daemon keeps it
  '/cfg/jobs/ab12cd34/state.json': { color: 'green' },
  // a script's headless run inside session 3's tab, through the Agent SDK; never listed
  '/cfg/sessions/7.json': {
    pid: 7,
    sessionId: 'scripted',
    cwd: '/repo/ioi/.claude/worktrees/2412',
    startedAt: 60,
    kind: 'interactive',
    entrypoint: 'sdk-py',
    name: '2412-9b',
    status: 'busy',
  },
  // launched in ioi, then moved on to work in the fix repo; dead unless a test's ps lists pid 6
  '/cfg/sessions/6.json': {
    pid: 6,
    sessionId: 'wander',
    cwd: '/repo/ioi',
    startedAt: 50,
    kind: 'interactive',
    name: 'fix-notes',
    status: 'idle',
  },
  // named after ticket 2412 while sitting in the repo: shares the 2412 worktree with session 3;
  // dead unless a test's ps lists pid 5
  '/cfg/sessions/5.json': {
    pid: 5,
    sessionId: 'twin',
    cwd: '/repo/ioi',
    startedAt: 40,
    kind: 'interactive',
    name: '2412-second-look',
    status: 'idle',
  },
}

const NOW = 1_000_000_000

// what each session published; 'me' rewrites its own when its agents or its transcript differ
const STATES: Record<string, object> = {
  '/cfg/sessions-sidebar/state/other.json': {
    running: 4,
    model: 'claude-sonnet-5-5',
    color: 'pink',
    cost: 3.05,
    context: { percent: 92, window: 200_000 },
  },
  '/cfg/sessions-sidebar/state/me.json': {
    running: 1,
    isAutopilot: true,
    model: 'claude-opus-5-5[1m]',
    effort: 'xhigh',
    cost: 12.4,
    context: { percent: 12, window: 1_000_000 },
  },
  // nothing folded; with no file Closed Sessions starts folded
  '/cfg/sessions-sidebar/collapsed.json': [],
}

// grep -o of each transcript's autopilot markers: 'me' finished one run and started another
const AUTOPILOT_MARKS: Record<string, string> = {
  '/cfg/projects/-repo-ioi/me.jsonl': [
    '"content":"<command-message>ioi-autopilot</command-message>',
    'stage:: review\\"',
    '"name":"Skill","input":{"skill":"ioi-autopilot"',
  ].join('\n'),
}

// grep -o of each transcript's response efforts: 'me' went from high to xhigh
const EFFORT_MARKS: Record<string, string> = {
  '/cfg/projects/-repo-ioi/me.jsonl': '"effort":"high"\n"effort":"xhigh"',
}

// grep -o of each transcript's /color choices: 'me' was blue, then took it away
const COLOR_MARKS: Record<string, string> = {
  '/cfg/projects/-repo-ioi/me.jsonl': '"agentColor":"blue"\n"agentColor":"default"',
}

// /rename titles of sessions no longer running
const TITLES: Record<string, object> = {
  '/cfg/projects/-repo-ioi/closed1/custom-title.json': { customTitle: '2399-remove-expiry' },
  '/cfg/projects/-repo-ioi/closed2/custom-title.json': { customTitle: '2418-first-attempt' },
  // named, but only ever in the main checkout: 'recent' this week, 'chat' long ago
  '/cfg/projects/-repo-ioi/chat/custom-title.json': { customTitle: 'Troubleshooting' },
  '/cfg/projects/-repo-ioi/recent/custom-title.json': { customTitle: 'Session Panel Design' },
  '/cfg/projects/-repo-ioi/closed3/custom-title.json': { customTitle: '2401-prefix-e2e' },
  // another repo's, this week, its ticket the number of an ioi worktree
  '/cfg/projects/-repo-fix/fixside/custom-title.json': { customTitle: '2418-fix-side' },
  // and eleven more from long ago, so the older ones take two pages
  ...Object.fromEntries(
    Array.from({ length: 11 }, (_, index) => [
      `/cfg/projects/-repo-ioi/older${index}/custom-title.json`,
      { customTitle: `Old chat ${index}` },
    ]),
  ),
}

// grep -m 1 -o -H: the first cwd of each folder's newest transcript, which gives the folder's repo
const PROJECT_CWDS: Record<string, string> = {
  '-repo-ioi': '/repo/ioi',
  '-repo-ioi--claude-worktrees-2418': '/repo/ioi/.claude/worktrees/2418',
  '-repo-fix': '/repo/fix',
}

// grep -m 1: the first worktree each named transcript worked in
const FIRST_WORKTREES = [
  '/cfg/projects/-repo-ioi/closed1.jsonl:"cwd":"/repo/ioi/.claude/worktrees/2399',
  '/cfg/projects/-repo-ioi/closed2.jsonl:"cwd":"/repo/ioi/.claude/worktrees/2418-v1',
  '/cfg/projects/-repo-ioi/closed3.jsonl:"cwd":"/repo/ioi/.claude/worktrees/2401',
].join('\n')

// grep -o -H of each named transcript's saved /cost totals, the last one per file its cost:
// closed1 (Finished) cost 2.25, closed2 (2418-first-attempt, the 2418 worktree's session) 2097,
// recent (Ad hoc) 0.4
const SAVED_COSTS = [
  '/cfg/projects/-repo-ioi/closed1.jsonl:"totalCostUSD":1.5',
  '/cfg/projects/-repo-ioi/closed1.jsonl:"totalCostUSD":2.25',
  '/cfg/projects/-repo-ioi/closed2.jsonl:"totalCostUSD":2097',
  '/cfg/projects/-repo-ioi/recent.jsonl:"totalCostUSD":0.4',
].join('\n')

// a worktree's lock file, as Claude Code writes it for a worktree it creates; only 2441's is here
const LOCKS: Record<string, string> = {
  '/repo/ioi/.git/worktrees/2441/locked':
    'claude session 2441 (pid 4 start Sat Oct  3 21:35:57 2026)\n',
}

const TRANSCRIPT_TAILS: Record<string, string> = {
  // its last API response came 22 minutes before NOW and wrote to the 1-hour cache
  '/cfg/projects/-repo-ioi/me.jsonl':
    '{"cwd":"/repo/ioi"}\n' +
    '{"type":"assistant","message":{"usage":{"cache_creation":{"ephemeral_1h_input_tokens":2214,"ephemeral_5m_input_tokens":0}}},"timestamp":"1970-01-12T13:24:40.000Z"}\n',
  '/cfg/projects/-repo-ioi--claude-worktrees-2412/other.jsonl':
    '{"cwd":"/repo/ioi/.claude/worktrees/2412"}\n{"cwd":"/repo/ioi/.claude/worktrees/2412/packages/api"}\n',
  '/cfg/projects/-repo-ioi/auto.jsonl': '{"cwd":"/repo/ioi"}\n',
  '/cfg/projects/-repo-ioi/wander.jsonl': '{"cwd":"/repo/ioi"}\n{"cwd":"/repo/fix"}\n',
  // a background session runs no sidebar: what it is and costs comes from here
  '/cfg/projects/-repo-ioi/bgjob.jsonl':
    '{"cwd":"/repo/ioi"}\n{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001"},"effort":"low"}\n{"type":"cost-state","totalCostUSD":0.057}\n',
}

const WORKTREES = [
  'worktree /repo/ioi\nHEAD a\nbranch refs/heads/main',
  'worktree /repo/ioi/.claude/worktrees/2412\nHEAD b\nbranch refs/heads/2412-refuse',
  'worktree /repo/ioi/.claude/worktrees/2441\nHEAD c\nbranch refs/heads/2441-ioi-review',
  'worktree /repo/ioi/.claude/worktrees/2418\nHEAD d\nbranch refs/heads/2418-currency',
  'worktree /repo/ioi/.claude/worktrees/2437-cleanup\nHEAD e\nbranch refs/heads/2437-cleanup-fixes',
  'worktree /repo/ioi/.claude/worktrees/2300\nHEAD f\nbranch refs/heads/2300-old\nprunable gitdir file points to non-existent location',
].join('\n\n')

// a second repo, with no worktree but its main checkout
const FIX_WORKTREES = 'worktree /repo/fix\nHEAD z\nbranch refs/heads/main'

const ran = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const entry = (name: string, kind: 'file' | 'dir', mtimeMs = 0) => ({
  name,
  kind,
  size: 1,
  mtimeMs,
  isLink: false,
})

const LISTINGS: Record<string, ReturnType<typeof entry>[]> = {
  '/cfg/sessions': [
    ...Object.keys(FILES).map(path => entry(path.split('/').pop() ?? path, 'file')),
    entry('1.abc.key', 'file'),
  ],
  '/cfg/projects': [
    entry('-repo-ioi', 'dir'),
    entry('-repo-ioi--claude-worktrees-2418', 'dir'),
    entry('-repo-other', 'dir'),
    entry('-repo-fix', 'dir'),
  ],
  '/cfg/projects/-repo-fix': [entry('fixside.jsonl', 'file', NOW - 120_000)],
  '/cfg/projects/-repo-ioi': [
    entry('old.jsonl', 'file', 1),
    entry('named.jsonl', 'file', 5),
    // finished an hour ago: Done lists it; closed3, long ago, goes under its older menu
    entry('closed1.jsonl', 'file', NOW - 3_600_000),
    entry('closed2.jsonl', 'file', 4),
    entry('chat.jsonl', 'file', 2),
    entry('recent.jsonl', 'file', NOW - 60_000),
    ...Array.from({ length: 11 }, (_, index) => entry(`older${index}.jsonl`, 'file', 0)),
    entry('closed3.jsonl', 'file', 6),
  ],
  '/cfg/projects/-repo-ioi--claude-worktrees-2418': [entry('review.jsonl', 'file', 9)],
  // 'me' runs one workflow (wf_live) with one agent still writing; wf_done has finished
  '/cfg/projects/-repo-ioi/me/subagents/workflows': [
    entry('wf_live', 'dir'),
    entry('wf_done', 'dir'),
  ],
  '/cfg/projects/-repo-ioi/me/subagents/workflows/wf_live': [
    entry('agent-busy.jsonl', 'file', NOW - 5_000),
    entry('agent-quiet.jsonl', 'file', NOW - 120_000),
    entry('journal.jsonl', 'file', NOW),
  ],
  '/cfg/projects/-repo-ioi/me/subagents/workflows/wf_done': [
    entry('agent-old.jsonl', 'file', NOW - 1_000),
  ],
}

const openSidebar = async (
  $: Engine,
  on: On,
  psStdout: string,
  onOtherCommand: (argv: readonly string[]) => string = () => '',
  written: { path: string; text: string }[] = [],
) => {
  mock.env(on, {
    CLAUDE_CONFIG_DIR: '/cfg',
    HOME: '/home/u',
    WARP_FOCUS_URL: 'warppreview://session/me',
  })
  on('fs.list', (_$, e) => ({ value: LISTINGS[e.path] ?? [] }))
  // what a test wrote reads back
  on('fs.read', (_$, e) => ({
    value:
      written.findLast(one => one.path === e.path)?.text ??
      LOCKS[e.path] ??
      JSON.stringify(FILES[e.path] ?? STATES[e.path] ?? TITLES[e.path]),
  }))
  on('fs.exists', (_$, e) => ({
    value:
      written.some(one => one.path === e.path) ||
      ['/repo/ioi', '/cfg/projects/-repo-ioi/me/workflows/wf_done.json'].includes(e.path),
  }))
  // held: a wait resolves only when a test moves the clock on
  const clock = mock.clock(on, { now: NOW })
  on('fs.write', (_$, e) => {
    written.push({ path: e.path, text: e.text })

    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    const [command, ...rest] = e.argv
    if (command === 'ps' && rest[0] === '-o') return ran(psStdout)
    if (command === 'date' && rest[1] === '1273600') return ran('Thu 5:46 PM\n')
    if (command === 'git' && rest.includes('worktree')) {
      const at = rest[rest.indexOf('-C') + 1] ?? ''
      if (at === '/repo/fix') return ran(FIX_WORKTREES)
      if (at.startsWith('/repo/ioi')) return ran(WORKTREES)

      return { value: { ...ran('').value, exitCode: 128 } }
    }
    // the background session's id, which only the transcript of the session that ran it holds
    if (command === 'grep' && rest.includes('-F') && rest.includes('ab12cd34')) {
      return ran('/cfg/projects/-repo-ioi--claude-worktrees-2412/other.jsonl:ab12cd34')
    }
    if (command === 'grep' && rest.includes('"cwd":"[^"]*"')) {
      return ran(
        rest
          .filter(arg => arg.endsWith('.jsonl'))
          .flatMap(path => {
            const cwd = PROJECT_CWDS[path.split('/').at(-2) ?? '']

            return cwd === undefined ? [] : [`${path}:"cwd":"${cwd}"`]
          })
          .join('\n'),
      )
    }
    if (command === 'tail') return ran(TRANSCRIPT_TAILS[rest.at(-1) ?? ''] ?? '')
    if (command === 'grep' && rest.includes('-m')) return ran(FIRST_WORKTREES)
    if (command === 'grep' && rest.some(arg => arg.includes('totalCostUSD'))) {
      return ran(SAVED_COSTS)
    }
    if (command === 'grep' && rest.some(arg => arg.includes('ioi-autopilot'))) {
      return ran(AUTOPILOT_MARKS[rest.at(-1) ?? ''] ?? '')
    }
    if (command === 'grep' && rest.some(arg => arg.includes('"effort"'))) {
      return ran(EFFORT_MARKS[rest.at(-1) ?? ''] ?? '')
    }
    if (command === 'grep' && rest.some(arg => arg.includes('agentColor'))) {
      return ran(COLOR_MARKS[rest.at(-1) ?? ''] ?? '')
    }

    return ran(onOtherCommand(e.argv))
  })
  on('session.id', () => ({ value: 'me' }))
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 1_000_000, tokens: 120_000, percent: 12 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 35.4, resetsAt: '1970-01-12T14:45:40.000Z' },
        { kind: 'seven_day', percentUsed: 81, resetsAt: '1970-01-15T17:46:40.000Z' },
      ],
      cost: { usd: 12.4012 },
    },
  }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))

  await $.command.run({
    command: 'sessions-sidebar',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })

  return clock
}

const mountPane = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({
    plugin: 'sessions-sidebar',
    surface,
    component: 'Pane',
    requestId: 'sessions-sidebar',
    props: {
      title: 'Sessions',
      isFocused: false,
      bodyColumns: 34,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })

test('lists live sessions, drops dead pids, marks the current one', async ($, on) => {
  await openSidebar($, on, '    1\n    3\n    4\n')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: 'Live' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'ioi-main' })).toBeDefined()
    // every live session shows its branch and its worktree, the main checkout included
    expect(await ui.find({ type: 'Text', text: /^main$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ioi$/ })).toBeDefined()
    // works inside the 2412 worktree
    expect(await ui.find({ type: 'Text', text: /^2412-refuse$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^worktree 2412$/ })).toBeDefined()
    // sits in the repo but is named after ticket 2441
    expect(await ui.find({ type: 'Text', text: /^2441-ioi-review$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^worktree 2441$/ })).toBeDefined()
    // no name of its own: named after its worktree
    expect(await ui.find({ type: 'Button', text: 'worktree 2412' })).toBeDefined()
    expect(await ui.find({ text: /gone/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('shows how many agents each session is running', async ($, on) => {
  const written: { path: string; text: string }[] = []
  on('agent.list', () => ({
    value: [
      { id: 'a', description: 'review', type: 'general-purpose', status: 'running' },
      { id: 'b', description: 'search', type: 'Explore', status: 'completed' },
    ],
  }))
  await openSidebar($, on, '    1\n    3\n    4\n', () => '', written)

  // one subagent running, plus the one workflow agent still writing in an unfinished run
  expect(written).toContainEqual({
    path: '/cfg/sessions-sidebar/state/me.json',
    text: '{"running":2,"isAutopilot":true,"model":"claude-opus-5-5[1m]","effort":"xhigh","cost":12.4,"context":{"percent":12,"window":1000000}}',
  })
  const ui = await mountPane($, 'terminal')
  // 'me' is busy: its own loop counts as one more
  expect(await ui.find({ type: 'Text', text: /^ {2}⚙ 3 agents working$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {2}⚙ 4 agents working$/ })).toBeDefined()
  // 2441-autopilot is idle and published nothing: no line
  expect(await ui.find({ type: 'Text', text: /⚙ [^34]/ })).toBeUndefined()
})

test('a session whose last autopilot run has not reached review shows a bolt', async ($, on) => {
  await openSidebar($, on, '    1\n    3\n    4\n')

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: ' ⚡ AUTOPILOT ' })).toBeDefined()
})

test('lists worktrees no live session works in or is named after as dormant', async ($, on) => {
  await openSidebar($, on, '    1\n    3\n    4\n')

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'Closed' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '2418-currency' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {3}⌂ worktree 2418$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '2437-cleanup-fixes' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {3}⌂ worktree 2437-cleanup$/ })).toBeDefined()
  // 2412: a session works inside it; 2441: a session is named after its ticket; 2300: prunable
  expect(
    await ui.find({ type: 'Button', text: /2412-refuse|2441-ioi-review|2300-old/ }),
  ).toBeUndefined()
  expect(await ui.find({ text: /2300-old/ })).toBeUndefined()
})

test('lists named sessions whose worktree was deleted as closed, and resumes one', async ($, on) => {
  const opened: string[] = []
  const written: { path: string; text: string }[] = []
  await openSidebar(
    $,
    on,
    '    1\n    3\n    4\n',
    argv => {
      if (argv[0] === 'head') return '{"cwd":"/repo/ioi","sessionId":"closed1"}\n'
      opened.push(argv.join(' '))

      return ''
    },
    written,
  )

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: 'Done' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '2399-remove-expiry' })).toBeDefined()
  // the worktree is gone: red ⌂, its name struck through
  expect(await ui.find({ type: 'Text', text: 'worktree 2399' })).toBeDefined()
  // 2418 still has a worktree (dormant); Troubleshooting never worked in one
  expect(await ui.find({ text: /2418-first-attempt|Troubleshooting/ })).toBeUndefined()

  await ui.press({ key: 'closed-closed1' })
  expect(written[0]?.text).toContain('directory = "/repo/ioi"')
  expect(written[0]?.text).toContain(
    `commands = ["CLAUDE_CONFIG_DIR='/cfg' claude --dangerously-skip-permissions --resume 'closed1'"]`,
  )
  expect(opened).toEqual(['open warppreview://tab_config/sessions-sidebar-resume'])
})

test('Closed lists idle worktrees and named sessions with none; its filter picks either', async ($, on) => {
  const written: { path: string; text: string }[] = []
  await openSidebar($, on, '    1\n    3\n    4\n', () => '', written)

  const ui = await mountPane($, 'terminal')
  // both kinds: the worktree first, then the named sessions of the last week
  expect(await ui.find({ type: 'Button', text: '2418-currency' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Session Panel Design' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Troubleshooting' })).toBeUndefined()
  // 2 worktrees and 1 named session this week
  expect((await ui.find({ type: 'Text', text: /^All 3$/ }))?.props.color).toBe('cyan')
  expect(await ui.find({ key: 'dormant-choice-worktrees', text: 'Worktrees 2' })).toBeDefined()
  expect(await ui.find({ key: 'dormant-choice-adhoc', text: 'Ad hoc 1' })).toBeDefined()

  // the filter is shared, like the detail level
  await ui.press({ key: 'dormant-choice-worktrees' })
  expect(written.at(-1)).toEqual({
    path: '/cfg/sessions-sidebar/filters.json',
    text: '{"dormant":"worktrees"}',
  })
  expect(await ui.find({ type: 'Button', text: '2418-currency' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Session Panel Design' })).toBeUndefined()
  expect(await ui.find({ key: 'checkout-older' })).toBeUndefined()
  await ui.press({ key: 'dormant-choice-adhoc' })
  expect(await ui.find({ type: 'Button', text: '2418-currency' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: 'Session Panel Design' })).toBeDefined()
  await ui.press({ key: 'dormant-choice-all' })

  // the older ones are a menu under their row, ten at a time
  await ui.press({ key: 'checkout-older' })
  expect(await ui.find({ type: 'Text', text: '1–10 of 12' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '› Troubleshooting' })).toBeDefined()
  await ui.press({ key: 'checkout-older-more' })
  expect(await ui.find({ type: 'Text', text: '11–12 of 12' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '› Old chat 10' })).toBeDefined()

  // typing narrows it, from its first page
  await ui.input({ key: 'checkout-older-search', text: 'CHAT 1', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: '1–2 of 2' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '› Troubleshooting' })).toBeUndefined()
  await ui.press({ key: 'checkout-older-pick-1' })
  expect(written.at(-1)?.text).toContain("--resume 'older10'")

  // Enter resumes the first match
  await ui.press({ key: 'checkout-older' })
  await ui.input({ key: 'checkout-older-search', text: 'trouble' })
  expect(written.at(-1)?.text).toContain("--resume 'chat'")

  await ui.press({ key: 'checkout-recent-menu' })
  await ui.press({ key: 'answer-checkout-recent-1' })
  expect(written.at(-1)).toEqual({
    path: '/cfg/sessions-sidebar/archived.json',
    text: '["recent"]',
  })
  // archived, it moves to Done, and from there back to Closed
  expect(await ui.find({ key: 'checkout-recent' })).toBeUndefined()
  await ui.press({ key: 'closed-recent-menu' })
  expect(
    await ui.find({ type: 'Text', text: 'Resume it, or move it back to Closed?' }),
  ).toBeDefined()
  await ui.press({ key: 'answer-closed-recent-1' })
  expect(written.at(-1)).toEqual({ path: '/cfg/sessions-sidebar/archived.json', text: '[]' })
  expect(await ui.find({ key: 'checkout-recent' })).toBeDefined()
})

test('Live and Done have the same filter, each its own', async ($, on) => {
  const written: { path: string; text: string }[] = []
  await openSidebar($, on, '    1\n    3\n    4\n', () => '', written)

  const ui = await mountPane($, 'terminal')
  // 'other' works in the 2412 worktree and 2441-autopilot in 2441's; 'me' in the main checkout
  expect(await ui.find({ key: 'live-choice-worktrees', text: 'Worktrees 2' })).toBeDefined()
  expect(await ui.find({ key: 'live-choice-adhoc', text: 'Ad hoc 1' })).toBeDefined()
  await ui.press({ key: 'live-choice-worktrees' })
  expect(await ui.find({ type: 'Text', text: 'ioi-main' })).toBeUndefined()
  expect(await ui.find({ key: 'session-3' })).toBeDefined()
  // Close all takes what is shown
  await ui.press({ key: 'heading-live-menu' })
  expect(await ui.find({ type: 'Text', text: /Close all 2 live sessions/ })).toBeDefined()
  await ui.press({ key: 'heading-live-menu' })
  // the footer still counts every live session: 12.40 + 3.05
  expect(await ui.find({ type: 'Text', text: /^ \$ 15\.45 live/ })).toBeDefined()
  // Closed keeps its own
  expect((await ui.find({ type: 'Text', text: /^All \d+$/ }))?.props.color).toBe('cyan')

  // archive the ad hoc one; Done then holds it beside the finished one
  await ui.press({ key: 'checkout-recent-menu' })
  await ui.press({ key: 'answer-checkout-recent-1' })
  expect(await ui.find({ key: 'closed-choice-worktrees', text: 'Worktrees 1' })).toBeDefined()
  expect(await ui.find({ key: 'closed-choice-adhoc', text: 'Ad hoc 1' })).toBeDefined()
  await ui.press({ key: 'closed-choice-adhoc' })
  expect(await ui.find({ key: 'closed-recent' })).toBeDefined()
  expect(await ui.find({ key: 'closed-closed1' })).toBeUndefined()
  expect(written.at(-1)).toEqual({
    path: '/cfg/sessions-sidebar/filters.json',
    text: '{"live":"worktrees","closed":"adhoc"}',
  })
})

test('≡ on the Closed heading archives the ad hoc sessions listed, never a worktree', async ($, on) => {
  const written: { path: string; text: string }[] = []
  await openSidebar($, on, '    1\n    3\n    4\n', () => '', written)

  const ui = await mountPane($, 'terminal')
  // with worktrees only there is nothing to archive
  await ui.press({ key: 'dormant-choice-worktrees' })
  await ui.press({ key: 'heading-dormant-menu' })
  expect(await ui.find({ type: 'Button', text: '› Reopen all' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '› Archive all' })).toBeUndefined()
  await ui.press({ key: 'heading-dormant-menu' })

  await ui.press({ key: 'dormant-choice-all' })
  await ui.press({ key: 'heading-dormant-menu' })
  expect(
    await ui.find({
      type: 'Text',
      text: /^The \d+ closed sessions listed: reopen each in a new tab, or archive the 1 ad hoc ones\?$/,
    }),
  ).toBeDefined()
  await ui.press({ key: 'answer-heading-dormant-1' })
  // a second step before anything moves
  expect(written.some(file => file.path.endsWith('/archived.json'))).toBe(false)
  await ui.press({ key: 'answer-heading-dormant-0' })

  // the older ones are not listed, so they stay
  expect(written.at(-1)).toEqual({
    path: '/cfg/sessions-sidebar/archived.json',
    text: '["recent"]',
  })
})

test('a section collapses and expands from its heading, for every session', async ($, on) => {
  const written: { path: string; text: string }[] = []
  await openSidebar($, on, '    1\n    3\n    4\n', () => '', written)

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'toggle-dormant' })
  expect(await ui.find({ type: 'Text', text: 'Closed' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '2418-currency' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: '2399-remove-expiry' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '+ New Session' })).toBeDefined()
  // the other sessions' sidebars pick it up on their next refresh
  expect(written.at(-1)).toEqual({
    path: '/cfg/sessions-sidebar/collapsed.json',
    text: '{"live":false,"dormant":true,"closed":false}',
  })

  await ui.press({ key: 'toggle-dormant' })
  expect(await ui.find({ type: 'Button', text: '2418-currency' })).toBeDefined()
  expect(written.at(-1)?.text).toBe('{"live":false,"dormant":false,"closed":false}')
})

test('≡ Finish on a merged session closes it, its worktree removed once it has exited', async ($, on) => {
  const commands: (readonly string[])[] = []
  await openSidebar($, on, '    1\n    3\n    4\n', argv => {
    commands.push(argv)

    return argv[0] === 'glab' ? '[{"iid":2220,"state":"closed"},{"iid":2222,"state":"merged"}]' : ''
  })

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'menu-3' })
  expect(await ui.find({ type: 'Text', text: 'Close this session?' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '› Close, keep worktree' })).toBeDefined()
  await ui.press({ key: 'answer-live-3-1' })

  // merged: no second question
  expect(await ui.find({ key: 'answer-live-3-0' })).toBeUndefined()

  // the MR, the worktree's status, its lock
  expect(commands.map(argv => argv[0])).toEqual(['glab', 'git', 'git', 'sh', 'ps', 'sh', 'kill'])
  expect(commands[0]?.[2]).toBe(
    'projects/:fullpath/merge_requests?source_branch=2412-refuse&state=all',
  )
  expect(commands[1]).toEqual([
    'git',
    '-C',
    '/repo/ioi/.claude/worktrees/2412',
    'status',
    '--porcelain',
  ])
  // clean: no --force
  expect(commands[3]?.slice(3)).toEqual([
    'remover',
    '3',
    '/repo/ioi',
    '/repo/ioi/.claude/worktrees/2412',
    '',
    '/cfg/sessions-sidebar/remover.log',
    // not locked
    '',
  ])
  expect(commands[6]).toEqual(['kill', '-TERM', '3'])
})

test('≡ Finish refuses while another live session works in the same worktree', async ($, on) => {
  const commands: string[] = []
  await openSidebar($, on, '    1\n    3\n    4\n    5\n', argv => {
    commands.push(argv[0] ?? '')

    return ''
  })

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'menu-3' })
  await ui.press({ key: 'answer-live-3-1' })

  expect(commands).toEqual([])
})

test('≡ Finish on an unmerged session asks again under the row, and Cancel leaves it running', async ($, on) => {
  const commands: string[] = []
  await openSidebar($, on, '    1\n    3\n    4\n', argv => {
    commands.push(argv[0] ?? '')

    return argv[0] === 'glab' ? '[{"iid":2222,"state":"opened"}]' : ''
  })

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'menu-3' })
  await ui.press({ key: 'answer-live-3-1' })
  expect(
    await ui.find({
      type: 'Text',
      text: 'MR !2222 is opened, not merged. Delete worktree 2412 anyway?',
    }),
  ).toBeDefined()
  // Cancel
  await ui.press({ key: 'answer-live-3-1' })

  expect(await ui.find({ key: 'answer-live-3-0' })).toBeUndefined()
  expect(commands).toEqual(['glab'])
})

test('≡ asks under the row; a second ≡ folds it, and the main checkout can only close', async ($, on) => {
  await openSidebar($, on, '    1\n    3\n    4\n')

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'menu-1' })
  // 'me' is busy and in the main checkout
  expect(await ui.find({ type: 'Text', text: 'Busy right now. Close it anyway?' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '› Close session' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Finish/ })).toBeUndefined()

  await ui.press({ key: 'menu-1' })
  expect(await ui.find({ key: 'answer-live-1-0' })).toBeUndefined()
})

test('≡ Finish on a worktree with uncommitted changes asks before forcing it', async ($, on) => {
  const commands: (readonly string[])[] = []
  await openSidebar($, on, '    1\n    3\n    4\n', argv => {
    commands.push(argv)
    if (argv[0] === 'glab') return '[{"iid":2222,"state":"merged"}]'

    return argv[0] === 'git' ? ' M packages/api/src/x.ts\n' : ''
  })

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'menu-3' })
  await ui.press({ key: 'answer-live-3-1' })
  expect(
    await ui.find({ type: 'Text', text: 'Worktree 2412 has uncommitted changes.' }),
  ).toBeDefined()
  expect(commands.map(argv => argv[0])).toEqual(['glab', 'git'])

  await ui.press({ key: 'answer-live-3-0' })
  expect(commands.map(argv => argv[0])).toEqual(['glab', 'git', 'git', 'sh', 'ps', 'sh', 'kill'])
  expect(commands[3]?.[7]).toBe('--force')
})

test('≡ Finish unlocks a worktree its own Claude session locked, once that session has exited', async ($, on) => {
  const commands: (readonly string[])[] = []
  await openSidebar($, on, '    1\n    3\n    4\n', argv => {
    commands.push(argv)
    if (argv[0] === 'glab') return '[{"iid":2225,"state":"merged"}]'

    return argv.includes('--absolute-git-dir') ? '/repo/ioi/.git/worktrees/2441\n' : ''
  })

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'menu-4' })
  await ui.press({ key: 'answer-live-4-1' })

  expect(commands.map(argv => argv[0])).toEqual(['glab', 'git', 'git', 'sh', 'ps', 'sh', 'kill'])
  expect(commands[3]?.[9]).toBe('unlock')
})

test('Done lists the last week’s finished sessions, each with ↻, older ones under its menu', async ($, on) => {
  const written: { path: string; text: string }[] = []
  await openSidebar($, on, '    1\n    3\n    4\n', () => '', written)

  const ui = await mountPane($, 'terminal')
  // nothing to archive: a finished session just resumes
  expect(await ui.find({ key: 'closed-closed1' })).toBeDefined()
  expect(await ui.find({ key: 'closed-closed1-menu' })).toBeUndefined()
  expect(await ui.find({ key: 'heading-closed-menu' })).toBeUndefined()
  expect(await ui.find({ key: 'closed-closed3' })).toBeUndefined()

  await ui.press({ key: 'done-older' })
  expect(await ui.find({ key: 'done-older-pick-0', text: '› 2401-prefix-e2e' })).toBeDefined()
  await ui.press({ key: 'done-older-pick-0' })
  expect(written.at(-1)?.text).toContain("--resume 'closed3'")
})

test('above New Session: the 5h and 7d windows and how long this prompt cache stays warm', async ($, on) => {
  await openSidebar($, on, '    1\n    3\n    4\n')

  const ui = await mountPane($, 'terminal')
  // 35%: three and a half cells, then the dim track
  expect(await ui.find({ type: 'Text', text: '━━━╸' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '━━━━━━' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  35%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  resets 59m' })).toBeDefined()
  // 81%: eight cells, the track opening on a half-cell gap
  expect(await ui.find({ type: 'Text', text: '━━━━━━━━' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '╺━' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  81%' })).toBeDefined()
  // days away, so its weekday and local time
  expect(await ui.find({ type: 'Text', text: '  resets Thu 5:46 PM' })).toBeDefined()
  // 1h cache, last response 22 minutes ago
  expect(await ui.find({ type: 'Text', text: '● warm, 38m left' })).toBeDefined()
})

test('before its first response a session shows the effort saved for its model', async ($, on) => {
  const written: { path: string; text: string }[] = []
  const efforts = EFFORT_MARKS['/cfg/projects/-repo-ioi/me.jsonl']
  delete EFFORT_MARKS['/cfg/projects/-repo-ioi/me.jsonl']
  try {
    await openSidebar($, on, '    1\n    3\n    4\n', () => '', written)
  } finally {
    EFFORT_MARKS['/cfg/projects/-repo-ioi/me.jsonl'] = efforts ?? ''
  }

  expect(written.find(one => one.path.endsWith('/state/me.json'))?.text).toContain(
    '"effort":"high"',
  )
})

test('each live session shows its model as a letter avatar, on its /color when it has one', async ($, on) => {
  await openSidebar($, on, '    1\n    3\n    4\n')

  const ui = await mountPane($, 'terminal')
  // 'me' has no /color: Opus's coral, its last response at xhigh; 'other' is pink, by the theme's
  // key for it, and has not answered yet
  const colorsOf = async (text: RegExp) =>
    (await ui.findAll({ type: 'Text', text })).map(
      found => found.props.backgroundColor ?? found.props.color,
    )
  expect(await colorsOf(/^Ox$/)).toEqual(['#D97757'])
  expect(await colorsOf(/^S$/)).toEqual(['pink_FOR_SUBAGENTS_ONLY'])
  // half a cell of padding each side in the same colour; 'other' started first, so it is listed first
  expect(await colorsOf(/^[▐▌]$/)).toEqual([
    'pink_FOR_SUBAGENTS_ONLY',
    'pink_FOR_SUBAGENTS_ONLY',
    '#D97757',
    '#D97757',
  ])
  // 2441-autopilot has published no model: no avatar
  expect(await ui.find({ type: 'Text', text: / [FH] / })).toBeUndefined()
})

test('each live session shows what it has cost, and the footer their sum', async ($, on) => {
  await openSidebar($, on, '    1\n    3\n    4\n')

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^12\.40 spent$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^3\.05 spent$/ })).toBeDefined()
  // 2441-autopilot has published none: no line
  expect(await ui.findAll({ type: 'Text', text: /^\d+\.\d\d spent$/ })).toHaveLength(2)
  // the $ in its own colour, the rest dim
  expect((await ui.find({ type: 'Text', text: /^\$$/ }))?.props.color).toBe('#98C379')
  // one line: the live ones (15.45), then the week and the repo, which add what the others saved:
  // recent 0.4 this week, closed1 2.25 and closed2 2097 before; thousands shortened
  expect(
    await ui.find({ type: 'Text', text: /^ \$ 15\.45 live · 18\.10 7d · 2\.1k repo$/ }),
  ).toBeDefined()
})

test('each live session shows how full its context window is', async ($, on) => {
  await openSidebar($, on, '    1\n    3\n    4\n')

  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ type: 'Text', text: /^▤$/ }))?.props.color).toBe('#E5C07B')
  // the fill in the status line's colours, the track and figures dim
  expect((await ui.find({ type: 'Text', text: /^━$/ }))?.props.color).toBe('green')
  expect(await ui.find({ type: 'Text', text: /^╺━{8} 12% of 1M$/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^━{9}$/ }))?.props.color).toBe('red')
  expect(await ui.find({ type: 'Text', text: /^╺ 92% of 200k$/ })).toBeDefined()
  // 2441-autopilot has published none: no line
  expect(await ui.findAll({ type: 'Text', text: /^[━╸╺]+ \d+% of \d+[kM]$/ })).toHaveLength(2)
})

test('⌂ at the top picks the repos every section shows', async ($, on) => {
  const written: { path: string; text: string }[] = []
  await openSidebar($, on, '    1\n    3\n    4\n', () => '', written)

  const ui = await mountPane($, 'terminal')
  // with no choice saved, the repos the live sessions run in
  expect(await ui.find({ key: 'repos-toggle', text: 'ioi ▾' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '2418-fix-side' })).toBeUndefined()

  await ui.press({ key: 'repos-toggle' })
  // the busiest first, with how many run in it
  expect(await ui.find({ key: 'repos-pick-0', text: '■ ioi ● 3' })).toBeDefined()
  expect(await ui.find({ key: 'repos-pick-1', text: '□ fix' })).toBeDefined()
  await ui.press({ key: 'repos-pick-1' })

  // every sidebar follows the file
  expect(written).toContainEqual({
    path: '/cfg/sessions-sidebar/repos.json',
    text: '["/repo/ioi","/repo/fix"]',
  })
  expect(await ui.find({ key: 'repos-toggle', text: 'ioi, fix ▾' })).toBeDefined()
  // fix's own 2418 shows, though ioi has a 2418 worktree
  expect(await ui.find({ type: 'Button', text: '2418-fix-side' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {3}⌂ fix$/ })).toBeDefined()

  // ioi off: its closed worktrees and its live sessions go
  expect(await ui.find({ type: 'Button', text: '2418-currency' })).toBeDefined()
  expect(await ui.find({ key: 'session-3' })).toBeDefined()
  await ui.press({ key: 'repos-pick-0' })
  expect(await ui.find({ type: 'Button', text: '2418-currency' })).toBeUndefined()
  expect(await ui.find({ key: 'session-3' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'ioi-main' })).toBeUndefined()
  expect(await ui.find({ key: 'repos-toggle', text: 'fix ▾' })).toBeDefined()
})

test('/statusline-toggle hides the status line in every session, then shows it again', async ($, on) => {
  const commands: string[] = []
  const written: { path: string; text: string }[] = []
  await openSidebar(
    $,
    on,
    '    1\n',
    argv => {
      commands.push(argv.join(' '))

      return ''
    },
    written,
  )
  const toggle = () =>
    $.command.run({
      command: 'statusline-toggle',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 200 },
    })

  expect(await toggle()).toMatchObject({ text: 'Status line hidden in every session.' })
  expect(written).toContainEqual({ path: '/cfg/statusline.hidden', text: '' })
  // ponytail: the stub's fs.exists remembers the write, not the rm
  expect(await toggle()).toMatchObject({ text: 'Status line shown in every session.' })
  expect(commands).toContain('rm -f /cfg/statusline.hidden')
})

test('a live session with Remote Control on shows rc after its context', async ($, on) => {
  await openSidebar($, on, '    1\n    3\n    4\n')

  const ui = await mountPane($, 'terminal')
  // 'me' and 'other' have it on; 2441-autopilot turned it off
  const marks = await ui.findAll({ type: 'Text', text: /^ {2}rc$/ })
  expect(marks.map(found => found.props.color)).toEqual(['#E06C75', '#E06C75'])
})

test('a session that moved on to another repo counts under that repo, with its branch', async ($, on) => {
  const written: { path: string; text: string }[] = []
  await openSidebar($, on, '    1\n    6\n', () => '', written)

  const ui = await mountPane($, 'terminal')
  // no choice saved: every repo a live session works in
  expect(await ui.find({ key: 'repos-toggle', text: 'ioi, fix ▾' })).toBeDefined()
  expect(await ui.find({ key: 'session-6' })).toBeDefined()
  // fix's main checkout and its branch, though it was launched in ioi
  expect(await ui.find({ type: 'Text', text: /^fix$/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Text', text: /^main$/ })).toHaveLength(2)

  // fix unticked: it leaves Live
  await ui.press({ key: 'repos-toggle' })
  expect(await ui.find({ key: 'repos-pick-0', text: '■ fix ● 1' })).toBeDefined()
  await ui.press({ key: 'repos-pick-0' })
  expect(await ui.find({ key: 'session-6' })).toBeUndefined()
})

test('closed, ad hoc and finished sessions show what they last saved as their cost', async ($, on) => {
  await openSidebar($, on, '    1\n    3\n    4\n')

  const ui = await mountPane($, 'terminal')
  // the 2418 worktree's session, the newest titled after its ticket
  expect(await ui.find({ type: 'Text', text: /^ {3}\$ 2097\.00 spent$/ })).toBeDefined()
  // Done: closed1's last saved total
  expect(await ui.find({ type: 'Text', text: /^ {3}\$ 2\.25 spent$/ })).toBeDefined()
  // Ad hoc
  expect(await ui.find({ type: 'Text', text: /^ {3}\$ 0\.40 spent$/ })).toBeDefined()
  // the footer's live figure still sums the live ones alone
  expect(await ui.find({ type: 'Text', text: /^ \$ 15\.45 live/ })).toBeDefined()
})

test('clicking a session opens its Warp tab by focus URL', async ($, on) => {
  const commands: string[] = []
  await openSidebar($, on, '    1\n    3\n', argv => {
    commands.push(argv.join(' '))

    return argv[0] === 'ps'
      ? 'claude --x HOME=/u WARP_FOCUS_URL=warppreview://session/abc123 TERM=xterm\n'
      : ''
  })

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'session-3' })

  expect(commands).toEqual(['ps -E -ww -o command= -p 3', 'open warppreview://session/abc123'])
})

test('⌕ on a heading searches its section as you type; Enter opens the first match', async ($, on) => {
  const commands: string[] = []
  await openSidebar($, on, '    1\n    3\n    4\n', argv => {
    commands.push(argv.join(' '))

    return argv[0] === 'ps' ? 'claude WARP_FOCUS_URL=warppreview://session/abc4\n' : ''
  })

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'search-live-toggle' })
  // the branch counts too: 2441's is 2441-ioi-review
  await ui.input({ key: 'search-live', text: 'REVIEW', kind: 'change' })
  expect(await ui.find({ key: 'session-4' })).toBeDefined()
  expect(await ui.find({ key: 'session-3' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '  1/3' })).toBeDefined()

  await ui.input({ key: 'search-live', text: 'nothing like it', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: ' No match' })).toBeDefined()

  await ui.input({ key: 'search-live', text: 'autopilot' })
  expect(commands.slice(-2)).toEqual([
    'ps -E -ww -o command= -p 4',
    'open warppreview://session/abc4',
  ])
  // Enter closes the search, every row back
  expect(await ui.find({ key: 'search-live' })).toBeUndefined()
  expect(await ui.find({ key: 'session-3' })).toBeDefined()
})

test('clicking a dormant session resumes its ticket-titled session in a new Warp tab', async ($, on) => {
  const opened: string[] = []
  const written: { path: string; text: string }[] = []
  await openSidebar(
    $,
    on,
    '    1\n    3\n    4\n',
    argv => {
      if (argv[0] === 'grep') {
        // only named.jsonl carries a 2418 title; the worktree's own review.jsonl is headless
        return argv.includes('"customTitle":"2418-') ? '/cfg/projects/-repo-ioi/named.jsonl\n' : ''
      }
      if (argv[0] === 'head') return '{"type":"x"}\n{"cwd":"/repo/ioi","sessionId":"named"}\n'
      opened.push(argv.join(' '))

      return ''
    },
    written,
  )

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'dormant-/repo/ioi/.claude/worktrees/2418' })

  expect(written.map(file => file.path)).toEqual([
    '/home/u/.warp-preview/tab_configs/sessions-sidebar-resume.toml',
  ])
  expect(written[0]?.text).toContain('directory = "/repo/ioi"')
  expect(written[0]?.text).toContain(
    `commands = ["CLAUDE_CONFIG_DIR='/cfg' claude --dangerously-skip-permissions --resume 'named'"]`,
  )
  expect(opened).toEqual(['open warppreview://tab_config/sessions-sidebar-resume'])
})

test('≡ on the Closed heading reopens every closed session, one tab at a time', async ($, on) => {
  const opened: string[] = []
  const written: { path: string; text: string }[] = []
  const clock = await openSidebar(
    $,
    on,
    '    1\n    3\n    4\n',
    argv => {
      if (argv[0] === 'open') opened.push(argv.join(' '))

      return ''
    },
    written,
  )

  const ui = await mountPane($, 'terminal')
  // the worktrees only: Reopen all takes what the filter shows
  await ui.press({ key: 'dormant-choice-worktrees' })
  await ui.press({ key: 'heading-dormant-menu' })
  expect(
    await ui.find({ type: 'Text', text: /^Reopen all \d+ closed worktrees, each in a new tab\?$/ }),
  ).toBeDefined()
  await ui.press({ key: 'answer-heading-dormant-0' })
  // the next waits until Warp has read the tab config the first rewrote
  expect(opened).toHaveLength(1)

  await clock.advance(60_000)
  const tabs = written.filter(file => file.path.endsWith('/sessions-sidebar-resume.toml'))
  expect(tabs.length).toBeGreaterThan(1)
  expect(opened).toHaveLength(tabs.length)
  // each tab its own worktree
  expect(new Set(tabs.map(tab => /directory = "(.+)"/.exec(tab.text)?.[1])).size).toBe(tabs.length)
})

test('a background session sits under the one that started it; a click attaches it in a new tab', async ($, on) => {
  const commands: string[] = []
  const written: { path: string; text: string }[] = []
  await openSidebar(
    $,
    on,
    '    1\n    3\n    8\n',
    argv => {
      commands.push(argv.join(' '))

      return ''
    },
    written,
  )

  const ui = await mountPane($, 'terminal')
  // right after session 3, which ran claude --bg; 'me' (current) is a Text, not a Button
  expect(
    (await ui.findAll({ type: 'Button', text: /^(worktree 2412|probe-2412)$/ })).map(
      found => found.key,
    ),
  ).toEqual(['session-3', 'session-8'])
  expect(await ui.find({ type: 'Text', text: /^↳ $/ })).toBeDefined()
  // Haiku at low on its job's colour, its cost from its transcript
  expect((await ui.find({ type: 'Text', text: /^Hl$/ }))?.props.backgroundColor).toBe(
    'green_FOR_SUBAGENTS_ONLY',
  )
  expect(await ui.find({ type: 'Text', text: /^0\.06 spent$/ })).toBeDefined()

  // no tab of its own: a new one attaches it
  await ui.press({ key: 'session-8' })
  expect(written.at(-1)?.text).toContain(`CLAUDE_CONFIG_DIR='/cfg' claude attach ab12cd34"]`)

  // its ≡ stops it; Close all leaves it running
  await ui.press({ key: 'menu-8' })
  await ui.press({ key: 'answer-live-8-0' })
  expect(commands).toContain('sh -c CLAUDE_CONFIG_DIR="$1" claude stop "$2" stop /cfg ab12cd34')
  await ui.press({ key: 'heading-live-menu' })
  expect(await ui.find({ type: 'Text', text: /Close all 2 live sessions/ })).toBeDefined()
})

test('a session records the background sessions its shell starts, so they always nest under it', async ($, on) => {
  const written: { path: string; text: string }[] = []
  // the shell's answer, in the format with no `backgrounded` line
  on('tool.call', () => ({
    result: { stdout: 'ab12cd34 probe-2412 busy working', stderr: '', interrupted: false },
  }))
  const clock = await openSidebar($, on, '    1\n    3\n    8\n', () => '', written)

  await $.tool.call({
    tool: 'Bash',
    command: "claude --bg --name probe-2412 'look around' | head -1",
  })
  for (let i = 0; i < 50 && !written.some(one => one.path.endsWith('/launches.json')); i += 1) {
    await clock.advance(1)
  }
  expect(written).toContainEqual({
    path: '/cfg/sessions-sidebar/launches.json',
    text: '{"ab12cd34":"me"}',
  })

  // under 'me', which recorded it, though session 3's transcript holds its id too
  // closed and opened again, the sidebar refreshes
  const toggle = () =>
    $.command.run({
      command: 'sessions-sidebar',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 200 },
    })
  await toggle()
  await toggle()
  const ui = await mountPane($, 'terminal')
  expect(
    (await ui.findAll({ type: 'Box' })).flatMap(found =>
      /^row-\d+$/.test(String(found.key)) ? [found.key] : [],
    ),
  ).toEqual(['row-3', 'row-1', 'row-8'])
})

test('leaves out a script’s headless run, which has no tab of its own', async ($, on) => {
  await openSidebar($, on, '    1\n    3\n    7\n')

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ key: 'session-3' })).toBeDefined()
  expect(await ui.find({ key: 'session-7' })).toBeUndefined()
  expect(await ui.find({ text: /2412-9b/ })).toBeUndefined()
})

test('keeps every session when ps sees nothing', async ($, on) => {
  await openSidebar($, on, '')

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Button', text: /gone/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ioi-main' })).toBeDefined()
})

// ps -A: 'me' (1) and 4 run in shells Warp opened, 3 in one under tmux
const PROCESSES = [
  '    1   101 claude',
  '    3   103 claude',
  '    4   104 claude',
  '  101   900 -zsh',
  '  103   950 -zsh',
  '  104   900 /bin/zsh',
  '  900     1 /Applications/WarpPreview.app/Contents/MacOS/preview',
  '  950     1 tmux',
].join('\n')

test('≡ Close ends an idle session, keeping its worktree, and closes its Warp tab after', async ($, on) => {
  const commands: string[] = []
  await openSidebar($, on, '    1\n    3\n    4\n', argv => {
    commands.push(argv.join(' '))

    return argv[0] === 'ps' ? PROCESSES : ''
  })

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'menu-4' })
  await ui.press({ key: 'answer-live-4-0' })

  // detached: once 4 has exited, its tab's shell is hung up
  expect(commands).toEqual([
    'ps -A -o pid=,ppid=,comm=',
    expect.stringMatching(
      /^sh -c nohup .* closer .*kill -HUP "\$2" 4 104 \/cfg\/sessions-sidebar\/closer\.log$/,
    ),
    'kill -TERM 4',
  ])
})

test('≡ on the Live heading closes every live session, this one last and without switching tabs', async ($, on) => {
  const commands: string[] = []
  await openSidebar($, on, '    1\n    3\n    4\n', argv => {
    commands.push(argv.join(' '))

    return argv[0] === 'ps' ? PROCESSES : ''
  })

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'heading-live-menu' })
  // 'me' is busy
  expect(
    await ui.find({
      type: 'Text',
      text: 'Showing full detail. Close all 3 live sessions, keeping their worktrees? 1 is busy.',
    }),
  ).toBeDefined()
  // after Show compact and Show standard
  await ui.press({ key: 'answer-heading-live-2' })
  // nothing yet: it asks again
  expect(commands).toEqual([])
  expect(
    await ui.find({
      type: 'Text',
      text: 'Really close all 3, this one too? Their worktrees stay.',
    }),
  ).toBeDefined()
  await ui.press({ key: 'answer-heading-live-0' })

  expect(commands.filter(command => command.startsWith('kill'))).toEqual([
    'kill -TERM 3',
    'kill -TERM 4',
    'kill -TERM 1',
  ])
  expect(
    commands.flatMap(
      command => / (\d+ \d+) \/cfg\/sessions-sidebar\/closer\.log$/.exec(command)?.[1] ?? [],
    ),
  ).toEqual(['4 104', '1 101'])
  // 3's shell is under tmux, not Warp: left alone, and logged
  expect(commands).toContainEqual(
    expect.stringMatching(
      /not a shell Warp opened.* closer 3 \/cfg\/sessions-sidebar\/closer\.log$/,
    ),
  )
})

test('≡ on the Live heading sets how much each session shows, for every sidebar', async ($, on) => {
  const written: { path: string; text: string }[] = []
  await openSidebar($, on, '    1\n    3\n    4\n', () => '', written)

  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^ioi$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^12\.40 spent$/ })).toBeDefined()

  await ui.press({ key: 'heading-live-menu' })
  expect(await ui.find({ type: 'Button', text: '› Show compact' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '› Show full' })).toBeUndefined()
  await ui.press({ key: 'answer-heading-live-0' })
  expect(written.at(-1)).toEqual({
    path: '/cfg/sessions-sidebar/detail.json',
    text: '"compact"',
  })
  // the name line alone
  expect(await ui.find({ key: 'session-3' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ioi$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^main$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /% of 1M$/ })).toBeUndefined()

  // standard, first of the two others now: worktree, branch and context, not cost or agents
  await ui.press({ key: 'heading-live-menu' })
  await ui.press({ key: 'answer-heading-live-0' })
  expect(await ui.find({ type: 'Text', text: /^ioi$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^main$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^╺━{8} 12% of 1M$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^12\.40 spent$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /agents? working/ })).toBeUndefined()
})

test('/exit switches to the next session in the sidebar, wrapping round', async ($, on) => {
  const commands: string[] = []
  await openSidebar($, on, '    1\n    3\n    4\n', argv => {
    commands.push(argv.join(' '))

    return argv[0] === 'ps' ? 'claude WARP_FOCUS_URL=warppreview://session/abc4\n' : ''
  })

  // order by start: 3 (5), me (10), 4 (30); after me comes 4
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'me', resume: { id: 'me' } })

  expect(commands).toEqual(['ps -E -ww -o command= -p 4', 'open warppreview://session/abc4'])
})

test('a session ended from outside (SIGTERM) does not switch tabs', async ($, on) => {
  const commands: string[] = []
  await openSidebar($, on, '    1\n    3\n    4\n', argv => {
    commands.push(argv.join(' '))

    return ''
  })

  await $.session.end({ reason: 'other', sessionId: 'me', resume: { id: 'me' } })

  expect(commands).toEqual([])
})

test('New Session asks for the model and effort, each badge as its session would wear it', async ($, on) => {
  const written: { path: string; text: string }[] = []
  on('session.root', () => ({ value: '/repo/ioi' }))
  await openSidebar($, on, '    1\n    3\n    4\n', () => '', written)

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'new-session' })
  // settings: opus[1m] by default, Opus saved at high, the rest at medium
  expect(
    await ui.find({ key: 'new-session-pick-default', text: 'Default · Opus 5.5 1M' }),
  ).toBeDefined()
  expect(await ui.findAll({ type: 'Text', text: /^Oh$/ })).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: /^Sm$/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^saved$/ }))?.props.color).toBe('cyan')

  await ui.press({ key: 'new-session-effort-max' })
  expect(await ui.find({ type: 'Text', text: /^S\+$/ })).toBeDefined()
  await ui.press({ key: 'new-session-pick-sonnet' })
  expect(written.at(-1)?.text).toContain(
    `claude --dangerously-skip-permissions --model 'sonnet' --effort max"]`,
  )
  // it closes once picked
  expect(await ui.find({ key: 'new-session-cancel' })).toBeUndefined()
})

test('the new session button opens a Warp tab running claude in the repo', async ($, on) => {
  const commands: string[] = []
  const written: { path: string; text: string }[] = []
  on('session.root', () => ({ value: '/repo/ioi' }))
  await openSidebar(
    $,
    on,
    '    1\n    3\n    4\n',
    argv => {
      commands.push(argv.join(' '))

      return ''
    },
    written,
  )

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'new-session' })
  await ui.press({ key: 'new-session-pick-default' })

  expect(written[0]?.text).toContain('directory = "/repo/ioi"')
  expect(written[0]?.text).toContain(
    `commands = ["SESSIONS_SIDEBAR_COLOR=random CLAUDE_CONFIG_DIR='/cfg' claude --dangerously-skip-permissions"]`,
  )
  expect(commands).toEqual(['open warppreview://tab_config/sessions-sidebar-resume'])
})

const startSession = async ($: Engine, on: On, isPublished: boolean) => {
  const colored: string[] = []
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', SESSIONS_SIDEBAR_COLOR: 'random' })
  on('session.id', () => ({ value: 'fresh' }))
  on('fs.exists', (_$, e) => ({
    value: isPublished && e.path === '/cfg/sessions-sidebar/state/fresh.json',
  }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ran(''))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.panes', () => ({ value: [] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.run', { command: 'color' }, (_$, e) => {
    colored.push(e.args)

    return { text: '' }
  })
  await $.session.start({ cwd: '/repo/ioi', surface: 'terminal', isInteractive: true })
  // the start's own refresh runs on in the background; an awaited one lets it end with the test
  await $.command.run({
    command: 'sessions-sidebar',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 200 },
  })

  return colored
}

test('a session New Session opened runs /color with no colour, which picks one at random', async ($, on) => {
  expect(await startSession($, on, false)).toEqual([''])
})

test('a reload leaves the colour alone: the session has published its state by then', async ($, on) => {
  expect(await startSession($, on, true)).toEqual([])
})
