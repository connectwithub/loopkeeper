// The state contract of loopkeeper: every atom, by concern, under PluginState['loopkeeper'].
// Each concern declares its atoms in its own hooks file with the same literal keys; an atom is
// one value however many files declare it. Comments name the concern that writes the atom.
// Shapes are exported types, so the declare module block below is read as an augmentation of PluginState.

// ---- Shapes used by more than one atom ----------------------------------------------------

/** requiresAgent: a case-insensitive regex an Agent call's subagent_type or description must match. */
export type LkStage = { id: string; label: string; gate?: boolean; requiresAgent?: string }

export type LkTransition = {
  stage: string
  at: number
  by: 'tool' | 'command' | 'auto' | 'resume'
  note?: string
  // a note rather than a move: a shipping command met by a ship gate, a verifier that satisfied requiresAgent,
  // or a gate opened without /lk approve (a small task's waiver or a validator's consistent verdict)
  event?: 'ship-attempt' | 'verified' | 'approved'
}

/** What a plan validator found, recorded through set_stage or by the review_cycle wrapper. */
export type LkVerdict = { ok: boolean; by: string; at: number }

/** The file budget's numbers from the changeControl section: maxFilesPerTurn, planSlack, autoBudgetMax. */
export type LkStageLimits = { base: number; slack: number; autoMax: number }

export type LkProtectedRule = { glob: string; action: 'ask' | 'deny' }

export type LkGateConfig = {
  maxFilesPerTurn: number
  planSlack: number
  autoBudgetMax: number
  protected: LkProtectedRule[]
  requirePlan: boolean
  mergeGate: boolean
  requireGreenCi: boolean
  blockAmend: boolean
  blockAddAll: boolean
  countSubagents: boolean
  shipGate: boolean
  planPaths: string[]
}

export type LkGateLogRow = {
  at: number
  rule: 'files' | 'protected' | 'plan' | 'merge' | 'amend' | 'add-all' | 'ship'
  target: string
  outcome: 'denied' | 'allowed'
  detail: string
}

/** One file Claude read, opened through an @-mention, edited or created; or one Glob/Grep search. */
export type LkTouchEntry = {
  id: string
  kind: 'file' | 'search'
  path: string
  pattern?: string
  tool: string
  read: boolean
  edited: boolean
  created: boolean
  at: number
}

export type LkFilesActivity = {
  id: string
  verb: 'reading' | 'editing' | 'searching'
  path: string
  pattern?: string
  tool: string
  at: number
}

export type LkFilesLive = { live: LkFilesActivity[]; last: string }
export type LkFilesGit = { branch: string; changed: Record<string, string> }
export type LkFilesView = { root: string; expanded: string[]; showSizes: boolean; showHidden: boolean; filter: string }
export type LkListEntry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }
export type LkFolderListing = { entries: LkListEntry[]; total: number; error?: string }

export type LkRole = 'recon' | 'execute' | 'verify' | 'hard' | 'default'
export type LkRoleRoute = { model: string; keywords: string[]; source: string }
export type LkRoutingConfig = {
  override: boolean
  enabled: boolean | null
  models: Record<string, string>
  roles: Record<LkRole, LkRoleRoute>
}
export type LkRouteDecision = {
  at: number
  label: string
  type: string
  role: LkRole | ''
  model: string
  matched: string[]
  source: 'routed' | 'explicit' | 'tag' | 'off'
  isTeammate: boolean
}

// The next function a /lk command.run hook passes the run on with, and the one a tool hook passes it on with. Kept
// here, not in the hook files: the directory reads a function-type alias in a hook file as an expression that runs
// into the line after it.
export type LkNext = (e: any) => Promise<{ text?: string } | undefined>
export type LkAnyNext = (e: any) => Promise<any>

export type LkReviewKind = 'critic' | 'review' | 'plan' | 'qa' | 'copy' | 'design'
export type LkReviewItem = {
  text: string
  priority: 'p0' | 'p1' | 'p2'
  done: boolean
  proof?: string
  addedCycle: number
  closedCycle?: number
}
export type LkReviewCycle = {
  cycle: number
  score?: number
  open?: number
  verdict?: 'ship' | 'iterate' | 'stop'
  notes?: string
  at: number
}
export type LkSubject = {
  name: string
  kind: LkReviewKind
  doneBy: 'score' | 'items'
  target?: number
  maxCycles: number
  cycles: LkReviewCycle[]
  items: LkReviewItem[]
  status: 'active' | 'ship' | 'stop'
  updatedAt: number
}

export type LkDecisionFormat = 'jsonl' | 'markdown' | 'brain-md' | 'journal-md'
export type LkDecisionTarget = {
  file: string
  abs: string
  format: LkDecisionFormat
  exists: boolean
  source: string
  note?: string
}
export type LkDecisionEntry = {
  date: string
  decision: string
  why: string
  tags: string[]
  id?: string
  by?: 'user' | 'claude'
}
export type LkProposed = { text: string; why: string; tags: string[] }
export type LkWatchConfig = { watch: boolean; watchModel: string; watchMaxPerHour: number; watchMinChars: number }

declare module 'claude-code' {
  interface PluginState {
    loopkeeper: {
      // ---- stage (stage.ts) ------------------------------------------------------------
      // stage: the stages in use (a preset's or the config file's), in order
      stageStages: LkStage[]
      // stage: the id of the stage the session is in. Read by gates and routing.
      stageCurrent: string
      // stage: ids of gate stages the user approved
      stageApproved: string[]
      // stage: ids of requiresAgent stages a completed matching Agent call satisfied since they were last entered
      stageVerified: string[]
      // stage: every stage change, oldest first, capped at 100
      stageHistory: LkTransition[]
      // stage: whether tool-call heuristics may move the stage
      stageAuto: boolean
      // stage: whether the stage band above the prompt is drawn
      stageBand: boolean
      // stage: the time the band's elapsed counter reads, ticked every 30 seconds
      stageNow: number
      // stage: the session's working directory, the key for the saved stage
      stageCwd: string
      // stage: 'file' when a loopkeeper.json set the pipeline section, else 'default'
      stageSource: string
      // stage: the stage list in use: 'default', 'gsd', a preset the file defines, or 'file'
      stagePreset: string
      // stage: the current stage is past the plan stage and a validate-plan gate, if any, is approved. Read by gates.
      stagePlanDone: boolean
      // stage: the current stage is ship and its gate is approved, or no ship stage is gated. Read by gates.
      stageShipOpen: boolean
      // stage: the task's size, '' until set_stage or /lk size records it
      stageSize: '' | 'small' | 'large'
      // stage: the last plan validator's verdict for this task, or null. Also written by the review_cycle wrapper.
      stageVerdict: LkVerdict | null
      // stage: 'auto' lets a consistent verdict open the plan gate; 'ask' leaves it to the user (one mode for all of loopkeeper)
      stageApproval: 'auto' | 'ask'
      // stage: the user's prompt asked to approve the plan themselves, so the plan gate waits
      stageHoldPlan: boolean
      // stage: set once a held prompt's task is sized; sizing the next task spends the hold
      stageHoldBound: boolean
      // stage: a validator that completed just before a requiresAgent stage: that stage's id, or ''
      stageCarry: string
      // stage: who that validator was (subagent_type: description)
      stageCarryBy: string
      // stage: stage ids whose approval or verifier mark a small task's waiver placed
      stageWaived: string[]
      // stage: distinct files edited (main loop and subagents) since the plan stage was last entered
      stageFilesTouched: string[]
      // stage: how many files a small task may touch before it is pushed back to Plan
      stageSmallMax: number
      // stage: globs for plan material, never counted by the growth guard or the gates
      stagePlanPaths: string[]
      // stage: the file count the plan said it touches (set_stage files), or null
      stagePlanFiles: number | null
      // stage: the approved file budget (planned files plus planSlack), 0 for none. Read by gates.
      stageBudget: number
      // stage: the file budget's numbers from the changeControl section, read at session start and /lk reload
      stageLimits: LkStageLimits
      // stage: what the band says when Claude Code is older than the minimum version, '' otherwise
      stageVersionNote: string
      // stage: CLAUDE_MODS_DISABLE names loopkeeper (or all), so the growth guard is off
      stageDisabled: boolean
      // stage: pipeline.continueOnApprove: a user's approval submits a prompt so the model carries on (ADR 0012)
      stageContinueOnApprove: boolean
      // stage: a main turn is running (set on turn.start, cleared on a main turn.complete)
      stageTurnRunning: boolean
      // stage: an approval made during a running turn: the stage after it and the prompt to submit at turn end
      stageContinuePending: { stage: string; text: string } | null
      // stage: the ticket of the continue prompt sent or on its way (live), freed on the next main turn.start or when
      // it is given up; seq counts the tickets, so an old timer or retry knows it was overtaken
      stageContinueSent: { seq: number; live: boolean }
      // stage: session.start's isInteractive (true when absent); false with no app surface attached either, the
      // session never continues after an approval and logs no next-step line
      stageInteractive: boolean
      // stage: the other mods' commands the hub links to, as `$.command.list()` reported them when /lk last opened it
      stageHubCommands: { name: string; plugin?: string }[]
      // stage: pipeline.nextHint: the next-step line, a notice line in the chat after each answer (dim; Claude does
      // not read it)
      stageNextHint: boolean
      // stage: the "ctrl+x tab to focus the panel" toast showed this session (written by all six concern files)
      stageFocusHinted: boolean

      // ---- gates (gates.ts) ------------------------------------------------------------
      // gates: /lk gates on|off, for this session
      gateEnabled: boolean
      // gates: whether the gates band is drawn
      gateBand: boolean
      // gates: CLAUDE_MODS_DISABLE names loopkeeper (or all), so no gate is enforced (ADR 0009)
      gateDisabled: boolean
      // gates: the merged changeControl section, null until loaded
      gateConfig: LkGateConfig | null
      // gates: for each config key (protected rules as "protected:<glob>"), the layer that set it
      gateSources: Record<string, string>
      // gates: config files read
      gateConfigFiles: string[]
      // gates: problems met reading the config
      gateConfigErrors: string[]
      // gates: the main-loop turn in flight
      gateTurnId: string
      // gates: distinct files touched this turn
      gateTurnFiles: string[]
      // gates: extra files the user allowed this turn ("Allow 1 more")
      gateTurnExtra: number
      // gates: "Allow rest of turn"
      gateTurnUnlimited: boolean
      // gates: a rule denied or asked this turn, so the band turns red
      gateTurnFired: boolean
      // gates: every file touched this session (for the add-all rule)
      gateSessionFiles: string[]
      // gates: a plan was approved this session
      gatePlanOk: boolean
      // gates: who approved it
      gatePlanBy: string
      // gates: /lk gates ship ok for this session
      gateShipOk: boolean
      // gates: protected paths allowed for the rest of the session
      gateGrants: string[]
      // gates: the last 20 decisions
      gateLog: LkGateLogRow[]
      // gates: the session's raise of the files-per-turn limit ("Raise to N for this session"), 0 for none
      gateSessionRaise: number

      // ---- files (files.ts) ------------------------------------------------------------
      // files: what Claude touched this session (oldest first, at most 200)
      filesTouched: LkTouchEntry[]
      // files: calls in flight and the last thing Claude did
      filesActivity: LkFilesLive
      // files: git branch and changed paths, null outside a repository or before the first refresh
      filesGit: LkFilesGit | null
      // files: root, expanded folders, toggles and the filter
      filesView: LkFilesView
      // files: folder listings by absolute path, loaded when a folder opens, dropped on Refresh
      filesListing: Record<string, LkFolderListing>

      // ---- routing (routing.ts) --------------------------------------------------------
      // routing: GSD mode (/lk on|off)
      routeMode: boolean
      // routing: the GSD loop switch (/lk loop on|off)
      routeLoop: boolean
      // routing: whether the routing band is drawn
      routeBand: boolean
      // routing: recorded routing decisions, newest last
      routeDecisions: LkRouteDecision[]
      // routing: spawns routed, by role
      routeCounts: Record<string, number>
      // routing: how many spawns got a routed model
      routeRouted: number
      // routing: the routing table after defaults, config files and session overrides
      routeConfig: LkRoutingConfig | null
      // routing: CLAUDE_MODS_DISABLE names loopkeeper (or all), so spawns are not routed (ADR 0009)
      routeDisabled: boolean

      // ---- review (review.ts) ----------------------------------------------------------
      // review: every subject under review, by name. Written by review_cycle and review_item; the stage wrapper reads it.
      reviewSubjects: Record<string, LkSubject>
      // review: the working directory, for the per-project store keys
      reviewCwd: string
      // review: whether the review band is drawn
      reviewBand: boolean
      // review: whether the rules block asks the model to report passes
      reviewContext: boolean
      // review: defaults set with /reviews target and /reviews max
      reviewDefaults: { target?: number; maxCycles?: number }

      // ---- decisions (decisions.ts) ----------------------------------------------------
      // decisions: decisions recorded this session
      decisionCount: number
      // decisions: whether the decisions band is drawn
      decisionBand: boolean
      // decisions: where decisions go, null until detected
      decisionTarget: LkDecisionTarget | null
      // decisions: the last entries of the log, for the pane
      decisionEntries: LkDecisionEntry[]
      // decisions: entries in the whole log and those dated today
      decisionStats: { total: number; today: number }
      // decisions: the working directory, for the per-project store keys
      decisionCwd: string
      // decisions: the watch settings (off by default)
      decisionWatch: LkWatchConfig
      // decisions: major decisions the watch found, waiting for Record or Skip (at most 5)
      decisionPending: LkProposed[]
      // decisions: decisions recorded during the current turn
      decisionTurnRecorded: string[]
      // decisions: the current turn's prompt, used when the transcript has none
      decisionTurnPrompt: string
      // decisions: learned preferences for this project, oldest first (at most 40)
      decisionPrefs: string[]
      // decisions: badges by normalised decision text, oldest first
      decisionKinds: [string, 'major' | 'minor' | 'you'][]
      // decisions: watch problems already logged this session, so each kind is logged once
      decisionLogged: string[]
    }
  }
}
