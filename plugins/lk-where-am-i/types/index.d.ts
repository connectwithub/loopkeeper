/** One entry of `git worktree list --porcelain`. */
export type Worktree = {
  path: string
  head: string | null
  /** Short branch name, or null when detached or bare. */
  branch: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  prunable: boolean
}

/** Where the session is, as the last git refresh found it. */
export type Location = {
  /** false outside a git work tree: only `folder` and `cwd` mean anything. */
  isRepo: boolean
  cwd: string
  folder: string
  /** The main repository's folder name, also from a linked worktree. */
  repo: string
  toplevel: string
  /** null when HEAD is detached or unknown. */
  branch: string | null
  /** Short sha of HEAD, shown when detached. */
  sha: string | null
  isLinkedWorktree: boolean
  worktreeName: string | null
  /** `git status --porcelain` lines; null when unknown. */
  dirty: number | null
  /** 'none' when the branch tracks nothing; 'unknown' when the check failed. */
  upstream: 'set' | 'none' | 'unknown'
  upstreamName: string | null
  /** Commits on HEAD not on the upstream; null when unknown or no upstream. */
  ahead: number | null
  /** Last commit time, Unix seconds. */
  lastCommitAt: number | null
  lastSubject: string | null
  /** origin/HEAD's branch, such as main. */
  defaultBranch: string | null
  worktrees: Worktree[]
  /** $.clock.now() when this was read. */
  checkedAt: number
}

/** One rate-limit window as session.measure and $.session.usage() report it. */
export type RateWindow = { kind: string; percentUsed: number; resetsAt?: string }

/** A usage window's level as a kit tone: ok, warn from 80%, danger from 95%. */
export type Level = 'ok' | 'warn' | 'danger'

export type CacheState =
  | { kind: 'unknown' }
  | { kind: 'cold' }
  | { kind: 'low'; leftMs: number }
  | { kind: 'warm'; leftMs: number }

/** Settings saved by /where in $.store under "settings". */
export type Settings = { band?: boolean; cacheTtlMin?: number }

declare module 'claude-code' {
  interface PluginState {
    'lk-where-am-i': {
      loc: Location | null
      windows: RateWindow[]
      costUsd: number | null
      /** Kinds already toasted at 90%, re-armed when the window drops back. */
      warned: Record<string, boolean>
      /** $.clock.now() at the end of the last main-loop model request. */
      lastStep: number | null
      /** The time the band reads, moved on by every refresh and the 60 s tick. */
      now: number
      band: boolean
      ttlMin: number
      /** Where ttlMin came from: default, ~/.claude/where-am-i.json, or /where cache. */
      ttlSource: string
      cwd: string
    }
  }
}
