export type SessionRow = {
  pid: number
  name: string
  status: string
  place: string
  branch?: string
  // the main checkout of the repo it works in; outside git, its folder
  repo: string
  // the linked worktree it works in, and the repo that owns it; absent in the main checkout
  worktree?: { path: string; repo: string }
  agents: number
  isAutopilot: boolean
  // the main loop's model, as /model shows it
  model?: string
  // the session's colour as /color set it; absent when it has none
  color?: string
  // the effort its last response ran at; absent before its first
  effort?: string
  // what it has cost so far in US dollars, as /cost totals it
  cost?: number
  // how full its context window is, as the status line reads it; absent before its first response
  context?: { percent: number; window: number }
  // Remote Control is on
  isRemote: boolean
  isCurrent: boolean
}

export type DormantRow = {
  path: string
  repo: string
  name: string
  place: string
  // what the session titled after its ticket last saved as its cost, in US dollars
  cost?: number
}

// how much each live session shows: its name line alone; with worktree, branch and context; with all
export type DetailLevel = 'compact' | 'standard' | 'full'

export type Section = 'live' | 'dormant' | 'closed' | 'archived'

// what a section lists: both kinds, those with a worktree only, or the ad hoc ones only
export type KindFilter = 'all' | 'worktrees' | 'adhoc'

// a repo there are sessions of, by its main checkout's path, with how many run in it now
export type RepoOption = { path: string; live: number }

export type ClosedRow = {
  sessionId: string
  name: string
  place: string
  repo: string
  transcript: string
  // what it last saved as its cost, in US dollars
  cost?: number
}

// a named session that only ever worked in its repo's main checkout, now not running; recent when
// used in the last week
export type CheckoutRow = ClosedRow & { isRecent: boolean }

declare module 'claude-code' {
  interface PluginState {
    'sessions-sidebar': {
      rows: SessionRow[]
      dormant: DormantRow[]
      closed: ClosedRow[]
      checkout: CheckoutRow[]
      collapsed: Section[]
      archived: string[]
      offset: number
      pulse: boolean
      usage: {
        limits: { label: string; percent: number; resetsIn?: string }[]
        cache?: { isWarm: boolean; left: string }
        // what every session not running saved as its cost: those used in the last week, and all
        spend?: { week: number; repo: number }
      }
      question: { key: string; text: string; options: string[] } | null
      olderSearch: string
      searches: Partial<Record<Section, string>>
      detail: DetailLevel
      filters: Partial<Record<Section, KindFilter>>
      repos: { selected: string[]; options: RepoOption[] }
      repoSearch: string
    }
  }
}
