export type Action = 'warn' | 'deny-agents' | 'stop'

/** The merged settings: defaults, then /budget settings in $.store, then the project file. */
export type Config = {
  /** Session budget in tokens; 0 means no session limit. */
  session: number
  /** Per-subagent budget in tokens; 0 turns the per-agent limit off. */
  perAgent: number
  /** Fraction of the session budget where the band's budget chip turns to the warn tone, in (0, 1]. */
  warnAt: number
  action: Action
  countCacheReads: boolean
  /** false: count and draw, never deny or nag (/budget off). */
  enforce: boolean
  /** Draw the band above the prompt (/budget band on|off). */
  band: boolean
  /** Assumed prompt-cache lifetime after the main session's last request, in minutes. */
  cacheTtlMinutes: number
  /** Minutes before the cache goes cold at which a toast pings, largest first. */
  cacheWarnMinutes: number[]
  /** Toast at each warn threshold and once when the cache goes cold (/budget pings on|off). */
  cachePings: boolean
  /** Send the keep-warm on its own when autoKeepWarmMinutes are left (/budget autowarm on|off). Off by default; a project file can only turn it off. */
  autoKeepWarm: boolean
  /** Minutes before the cache goes cold at which the automatic keep-warm fires: at least 1, and under cacheTtlMinutes or it never fires. */
  autoKeepWarmMinutes: number
  /** Most automatic refreshes per idle stretch (from one turn's start to the next). */
  autoKeepWarmMax: number
  /** Price overrides by model family, USD per million tokens: [input, output, cacheRead, cacheWrite1h]. */
  prices: Record<string, [number, number, number, number]>
}

/** The main session's prompt cache, as the mod's own clock sees it. */
export type CacheState = {
  /** $.clock.now() of the main loop's last answered request (or keep-warm); 0 before the first. */
  lastRequestAt: number
  /** The model that answered it, for the price of a cold resend. */
  model: string | null
  /** Context tokens a cold resend re-writes: $.session.usage() after each main turn. */
  contextTokens: number
  /** A compaction since the last request: the next request starts a new cache, nothing to re-warm. */
  compacted: boolean
  /** The warn threshold (minutes) that last pinged in this warm window. */
  lastPing: number | null
  /** The timer saw the cache go cold (and toasted once). */
  cold: boolean
  /** Automatic keep-warm refreshes in this idle stretch; turn.start sets it back to 0. */
  autoWarms: number
  /** lastRequestAt of the warm window an automatic keep-warm was tried in: one try per window. */
  autoTriedAt: number
  /** An automatic fork re-wrote the cache instead of reading it: no more until the next turn. */
  autoHalted: boolean
  /** A main-loop turn is running (turn.start until its turn.complete): no automatic keep-warm. */
  turnRunning: boolean
}

/** What the session has spent, as counted from turn.step usage. */
export type Tally = {
  /** The session these counts belong to, so a hot reload keeps them. */
  sessionId: string
  /** Counted tokens (see countedOf). */
  total: number
  /** Cache reads, tracked for display whether or not they count. */
  cacheRead: number
  byModel: Record<string, number>
  /** Keyed by agentId, or "main" for the main loop. */
  byAgent: Record<string, number>
  requests: number
  /** Main-loop turns completed. */
  turns: number
  /** Counted tokens per main-loop turn, last 50. */
  perTurn: number[]
  /** total at the last main-loop turn.complete. */
  turnMark: number
  /** Counted tokens not yet added to the per-project lifetime total. */
  unflushed: number
}

declare module 'claude-code' {
  interface PluginState {
    'lk-token-budget': {
      tally: Tally
      config: Config
      warned: boolean
      lifetime: number
      ctx: number | null
      cwd: string
      cache: CacheState
    }
  }
}
