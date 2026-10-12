export type Kind = 'long-turn-done' | 'permission-waiting' | 'question-waiting' | 'subagent-done' | 'failed' | 'test'

/** One moment that wanted the user's attention. */
export type AttentionEvent = {
  id: string
  /** Epoch milliseconds, from $.clock.now(). */
  at: number
  kind: Kind
  title: string
  /** One line. */
  body: string
  /** false until the user is back (prompt.submit), the wait resolves, or Mark all seen. */
  seen: boolean
  agentId?: string
  toolUseId?: string
  /** The tool a permission wait is for. */
  tool?: string
  /** A permission or question wait that has been answered or ended. */
  resolved?: boolean
}

/** Defaults, then ~/.claude/attention.json, then <cwd>/.claude/attention.json, then /attention settings. */
export type Config = {
  /** Master switch (/attention on|off). */
  enabled: boolean
  /** Play a sound with each notification. */
  sound: boolean
  /** Send a desktop notification ($.ui.notify or notify-send). */
  native: boolean
  /** Draw the one-line band above the prompt while unseen events exist. */
  band: boolean
  /** A main-loop turn at least this long raises long-turn-done. */
  longTurnMs: number
  /** A subagent that ran at least this long raises subagent-done. */
  subagentMs: number
  /** No native notification or sound this long after the user's own prompt. */
  quietAfterPromptMs: number
  /** Raise permission waits from subagents too (off: the user can't approve those calls). */
  includeSubagents: boolean
  /**
   * What raises a permission wait. "dialog": only classic.PermissionRequest (a dialog really
   * shown). "grace": a tool.check 'ask' still unanswered after permissionGraceMs, or the dialog.
   */
  permissionSignal: 'dialog' | 'grace'
  /** How long a main-loop 'ask' must stay unanswered before it notifies (auto mode approves most within it). */
  permissionGraceMs: number
  /** A sound file to play instead of the system or bundled one; "" for the default. */
  soundFile: string
}

declare module 'claude-code' {
  interface PluginState {
    'lk-attention': {
      inbox: AttentionEvent[]
      config: Config
      /** Keys already raised (one per tool_use_id, render id or agent turn), newest last. */
      claimed: string[]
      /** Last native notification time per kind, for the rate limit. */
      lastNative: Record<string, number>
      /** When the user last submitted a prompt; null before the first. */
      lastPromptAt: number | null
      cwd: string
    }
  }
}
