/** A transition kind the mod can toast for (config `notifyOn`). */
export type NotifyKind = 'failed' | 'green' | 'review' | 'merged'

/** The merged settings: defaults, then ~/.claude/pr-watch.json, then <cwd>/.claude/pr-watch.json. */
export type Config = {
  /** Seconds between polls when nothing is pending or the hot window is over. */
  pollSec: number
  /** Seconds between polls while a check is pending inside the hot window after a push. */
  hotPollSec: number
  /** Which transitions toast. */
  notifyOn: NotifyKind[]
  /** Give Claude a one-line note when a check newly fails. */
  appendNoteOnFailure: boolean
}

/** pass / fail / pending / skipping / cancel, the buckets `gh pr checks` uses. */
export type Bucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel'

/** One check (the latest run per check name). */
export type Check = {
  /** Lineage key: type, app, workflow, event and name. */
  key: string
  name: string
  bucket: Bucket
  /** The run's URL, or ''. */
  link: string
  /** ISO time the run started, or ''. */
  startedAt: string
  /** ISO time the run completed, or ''. */
  completedAt: string
}

/** What one GraphQL poll returned for a PR. */
export type Snapshot = {
  number: number
  title: string
  /** OPEN | CLOSED | MERGED */
  state: string
  isDraft: boolean
  /** MERGEABLE | CONFLICTING | UNKNOWN */
  mergeable: string
  /** CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, ... */
  mergeStateStatus: string
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | '' */
  reviewDecision: string
  checks: Check[]
}

/** One watched PR. */
export type Watched = {
  /** owner/repo#number */
  id: string
  url: string
  owner: string
  repo: string
  number: number
  /** 'branch': found for the current branch; 'user': added by URL or /pr add. */
  source: 'branch' | 'user'
  /** The last good poll, or null before the first one. */
  snap: Snapshot | null
  /** The last poll's error, or ''. */
  error: string
  /** Clock time of the last poll, or 0. */
  polledAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'lk-pr-watch': {
      prs: Watched[]
      config: Config
      band: boolean
      cwd: string
      /** Clock time until which polling runs at hotPollSec while a check is pending. */
      hotUntil: number
      /** Clock time of the last poll round. */
      lastPoll: number
    }
  }
}
