export type Mode = 'ask' | 'auto' | 'off'

/** The merged settings: defaults, ~/.claude/handoff-guard.json, <cwd>/.claude/handoff-guard.json, then /handoff changes in $.store. */
export type Config = {
  /** Context fraction where the band turns yellow and one toast shows, in (0, 1]. */
  warnAt: number
  /** Context fraction where the handoff is due (ask, auto or just a red band). */
  handoffAt: number
  /** Where "Later" asks again. */
  reaskAt: number
  /** In auto mode, new tool calls are refused from here until the handoff clears the session. */
  denyAt: number
  mode: Mode
  /** Model alias for the brief when $.model.fork is unavailable. */
  model: string
  /** maxTokens for the $.model.complete fallback; also caps the words asked for. */
  maxBriefTokens: number
  /** Draw the band above the prompt (/handoff band on|off). */
  band: boolean
}

/** One context measurement. */
export type Reading = {
  tokens: number | null
  window: number | null
  /** Fill as a fraction of the window, 0..1. */
  frac: number
  /** $.clock.now() when it was taken. */
  at: number
  /** start, step, complete or compact. */
  where: string
}

/** The last handoff written, kept in $.state and mirrored to $.store per project. */
export type BriefInfo = {
  at: number
  /** Local "YYYY-MM-DD HH:MM". */
  when: string
  /** Absolute path of project.md. */
  path: string
  sessionId: string
  /** fork, complete, or facts (the model reply was unusable). */
  source: string
  /** Figures in the model text that the facts do not hold. */
  flagged: string[]
  /** The brief as written, capped for display. */
  preview: string
}

declare module 'claude-code' {
  interface PluginState {
    'lk-handoff-guard': {
      config: Config
      reading: Reading | null
      /** The last 30 readings, oldest first. */
      history: Reading[]
      /** The warnAt toast has shown this session. */
      warned: boolean
      /** The next fill that asks in ask mode; 0 means handoffAt. */
      nextAskAt: number
      /** No more asks this session (Later at the re-ask level). */
      askedOut: boolean
      /** "Off this session" was picked. */
      sessionOff: boolean
      /** Auto mode has tried once this session. */
      autoTried: boolean
      /** A handoff was written since the last /clear (or compaction). */
      written: boolean
      /** A /clear is queued after a handoff. */
      clearing: boolean
      /** A handoff is being written. */
      busy: boolean
      /** Files changed by Edit/Write/MultiEdit/NotebookEdit this session and this turn. */
      editedSession: string[]
      editedTurn: string[]
      lastBrief: BriefInfo | null
      /** "written <when>" while this session was seeded from a handoff and the user has not typed yet. */
      resumed: string
      cwd: string
    }
  }
}
