export type AgentStatus = 'running' | 'done' | 'failed' | 'aborted' | 'stopped'

export type TokenCounts = {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

/** One message edge: `to` on the sender's record, `from` on the receiver's. */
export type MessageEdge = { to?: string; from?: string; at: number }

export type AgentRecord = {
  id: string
  /** The agent type (subagent_type), such as general-purpose or Explore. */
  name: string
  description: string
  prompt: string
  model: string
  /** The agentId of the loop that spawned it, or "main". */
  parent: string
  isTeammate: boolean
  /** A fork of its parent (agent.spawn e.fork): it inherits the parent's context. */
  isFork: boolean
  isBackground: boolean
  /** False for a loop seen only through tool.call or turn.step (an engine fork). */
  isSpawned: boolean
  startedAt: number
  /** When the current run began; a resumed agent starts a new run. */
  runStartedAt: number
  endedAt?: number
  /** Summed duration of finished runs. */
  durationMs?: number
  status: AgentStatus
  requests: number
  toolCalls: number
  toolsByName: Record<string, number>
  lastTool: string
  /** The last thing it did, such as `Bash: npm test` (tool and the first 40 characters of its input). */
  activity: string
  /** The last tool.call or turn.step in this loop, for the idle alert. */
  lastActiveAt: number
  /** Tool calls of this loop that tool.check put to the person ('ask'), until the call runs. */
  waiting: WaitingCall[]
  /** The idle toast went out for the current stall. */
  stuckNotified: boolean
  /** Who stopped it, when status is 'stopped'. */
  stoppedBy?: string
  /** TaskStop could not stop it: its further tool calls are refused. */
  muted: boolean
  tokens: TokenCounts
  messages: MessageEdge[]
  /** Estimated tokens (characters / 4) of the results this agent returned to its caller's context. */
  returnedTokens?: number
  /** The effort of its latest request (turn.step e.effort), else the spawn's, else ''. */
  effort: string
  /** input + cache read + cache write of its latest request: what its context held then. */
  lastRequestTokens: number
  /** Progress from its latest TodoWrite call; null when it never wrote a list (or cleared it). */
  todo: TodoProgress | null
  /** Estimated cost in USD from each request's tokens and model (hooks/prices.ts); null while no request had a known model. */
  costUsd: number | null
}

/** A TodoWrite list in short: completed items, all items, and the in_progress item's activeForm or content. */
export type TodoProgress = { done: number; total: number; current: string }

/** USD per million tokens: [family, input, output, cacheRead, cacheWrite (1 h)]. */
export type PriceRow = [string, number, number, number, number]

/** The spawn caps and warning thresholds, merged from defaults, the plugin's settings, files and /agent-map cap. */
export type CapConfig = {
  /** Running subagents at once (forks and teammates included); 0 turns it off. */
  maxConcurrent: number
  /** Spawns in one main-loop turn (forks and teammates not counted); 0 turns it off. */
  maxPerTurn: number
  /** Spawns in the session; 0 turns it off. */
  maxPerSession: number
  /** Share of a cap (0..1) at which the band turns yellow and a toast goes out. */
  warnAt: number
  /** Tokens of subagent results in the main context before the warning; 0 turns it off. */
  maxReturnedTokens: number
  /** How long a permission 'ask' stays unresolved before the agent shows ⏸ waiting; 0 marks at once. */
  waitGraceMs: number
}

/** Where a cap's value came from, last layer first: the defaults, the plugin's settings (/config), ~/.claude/agent-map.json,
 *  <cwd>/.claude/agent-map.json, or what /agent-map cap saved. */
export type CapSource = 'default' | 'settings' | 'user file' | 'project file' | 'saved (/agent-map cap)'

/** The source of each cap's value. */
export type CapSources = Record<keyof CapConfig, CapSource>

export type CapKind = 'concurrent' | 'turn' | 'session'

/** Spawn counters for the cap checks and the band. */
export type CapCounters = {
  /** Spawns this main-loop turn, forks and teammates left out. */
  turn: number
  session: number
  /** A spawn was denied this turn: the band turns red. */
  deniedThisTurn: boolean
  /** The near-cap toast went out this turn. */
  warnedThisTurn: boolean
  /** The person allowed spawns past the caps for the rest of this turn. */
  overrideTurn: boolean
  /** Estimated tokens of subagent results returned to the main context this session. */
  returnedTotal: number
  /** The returned-tokens toast went out. */
  returnedWarned: boolean
}

export type LogKind =
  | 'spawned'
  | 'denied'
  | 'override'
  | 'first-tool'
  | 'waiting'
  | 'resumed'
  | 'idle'
  | 'stopped'
  | 'muted'
  | 'done'
  | 'failed'
  | 'aborted'
  | 'returned'

/** One lifecycle event of one agent. */
export type LogEntry = { at: number; id: string; label: string; kind: LogKind; text: string }

export type PaneView = 'tree' | 'cards' | 'team'

export type WaitingCall = { toolUseId: string; tool: string; at: number }

/** An Agent tool call waiting for its agent.spawn. */
export type PendingCall = {
  toolUseId: string
  caller: string
  description: string
  subagentType: string
  model: string
  prompt: string
  isBackground: boolean
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'lk-agent-map': {
      agents: Record<string, AgentRecord>
      order: string[]
      pending: PendingCall[]
      expanded: string[]
      now: number
      band: boolean
      everSpawned: boolean
      /** The agent whose Stop button is armed (pressed once), or null. */
      armed: string | null
      caps: CapConfig
      /** Where each cap's value came from, for the pane's Caps block. */
      capSources: CapSources
      counters: CapCounters
      log: LogEntry[]
      /** The view the person chose; null until they choose one (the pane then draws cards, /agent-map text the tree). */
      view: PaneView | null
      showLog: boolean
      /** The cards view draws one line per agent. */
      collapsed: boolean
      /** The session's context window in tokens, for the ctx % approximation. */
      window: number
      /** The price table after the config files' `prices` overrides. */
      prices: PriceRow[]
    }
  }
}
