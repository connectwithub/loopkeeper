// Gates concern, ported from change-control's register.ts. The rules that hold Claude's hand at the tool call:
//
//   1. Bounded blast radius: a files-per-turn limit per main-loop turn. The limit is the `/lk gates max <n>` session
//      override when set, otherwise the largest of the base (changeControl.maxFilesPerTurn), the approved plan's file
//      budget (stageBudget, written by the stage) and the session raise ("Raise to N for this session").
//   2. Protected paths: globs that are denied, or need the user's yes once per path per session (the terminal asks;
//      elsewhere a request card asks: Allow this file, Allow all of <glob> for this session, Deny).
//   3. A plan before edits (requirePlan): the stage's stagePlanDone, ExitPlanMode, or `/lk gates plan ok`. Plan
//      material (the scratchpad under /tmp/claude-*, and changeControl.planPaths) is exempt from this gate and rule 1.
//   4. A ship gate: commits, pushes, PRs, releases and publishes wait for the stage's stageShipOpen or
//      `/lk gates ship ok` (ADR 0004: the stage is always there, so there is no one-question fallback).
//   5. A merge gate: merges and pushes to the default branch wait for green CI and a yes. The user's Ship approval
//      (or `/lk gates ship ok` or `merge ok`) is that yes for the next one; otherwise the terminal asks, and elsewhere
//      a request card. `git commit --amend` on shared branches and (opt-in) `git add -A` / `git add .` are refused.
//
// Every verdict is given at tool.check, after the settings rules and the hooks beneath, so a call they already refuse
// is never asked about twice. A question is put only in the terminal: off it (the desktop app, mobile, VS Code) a
// dialog from a permission check is never answered, so the refusal raises a request (gateRequests): a card above the
// prompt on the desktop, a row in the Gates pane everywhere. The ship gate raises one on every surface. The stage
// answers it (a press, /lk approve) and carries on; its answers reach the gates through the grant atoms, read on
// every check. A one-time yes (the merge credit, a ship once-grant) is spent last, only by a call every rule let
// through. A hook that throws fails closed. CLAUDE_MODS_DISABLE=loopkeeper (or all) turns the gates off; the band says
// so and /lk gates still answers.
//
// The Files pane lives in files.ts. The seam: Bash writes that pass the gates are recorded here into filesTouched and
// filesActivity.last (the atoms the pane reads), because only the gates parse Bash for the files it writes.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import {
  addRequest,
  bandModel,
  bashTargets,
  checkLayer,
  contextText,
  describeRules,
  editPath,
  failClosedReason,
  filesHeld,
  filesOptions,
  gitActions,
  GATES_CMD,
  globGranted,
  isPlanMaterial,
  limitOf,
  limitSource,
  liveRequests,
  matchProtected,
  mergeHeld,
  mergeHitsDefault,
  mergeLayers,
  MOD,
  normalizePath,
  noteBashWrites,
  parsePorcelain,
  planPathsText,
  PROJECT_LABEL,
  protectedHeld,
  pushHitsDefault,
  raiseTo,
  requestCard,
  requestChoices,
  requestKey,
  RUN_AGAIN,
  sectionLayer,
  shipCommands,
  shipHeld,
  spentHeld,
  summarizeChecks,
  USAGE,
  USER_LABEL,
  waitPlace,
} from './lib/gateRules.ts'
import type { GitAction, Layer, WaitPlace } from './lib/gateRules.ts'
import { TONES, makeKit, shortPath } from './lib/kit.ts'
import type { Elements, Kit, Tone } from './lib/kit.ts'
import { joinText, projectConfigPath, storeKey, subOf, userConfigPath } from './lib/names.ts'
import { HUB_ID, HUB_ROWS, PANES } from './lib/panes.ts'
import { bare, cdTargets, prNumber, resolveDir } from './lib/shell.ts'
import { DEFAULT_STAGES, killSwitchOn, stageForRole } from './lib/stageModel.ts'
import type { Stage } from './lib/stageModel.ts'
import type { LkFilesLive, LkGateConfig, LkGateLogRow, LkGateRequest, LkNext, LkTouchEntry } from '../types/index.d.ts'

const PANE_ID = 'loopkeeper-gates'
const CONTEXT_BLOCK = 'changeControl'
const LOG_KEEP = 20
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const ABORT_DELAY_MS = 250
const CONCERN_WORDS = ['stage', 'gates', 'files', 'routing', 'review', 'decisions']

const ASK_PROTECTED = ['Allow once', 'Allow for session', 'Deny'] as const
const ASK_MERGE = ['Merge', 'Cancel'] as const

const BAND_KEY = storeKey('gates', 'band')

// ---- State held by the host (survives a hot reload; read by the band and the pane) ---------------------------

const gateEnabled = atom({ plugin: 'loopkeeper', key: 'gateEnabled' } as const, true)
const gateBand = atom({ plugin: 'loopkeeper', key: 'gateBand' } as const, true)
const gateDisabled = atom({ plugin: 'loopkeeper', key: 'gateDisabled' } as const, false)
const gateConfig = atom({ plugin: 'loopkeeper', key: 'gateConfig' } as const, null as LkGateConfig | null)
const gateSources = atom({ plugin: 'loopkeeper', key: 'gateSources' } as const, {} as Record<string, string>)
const gateConfigFiles = atom({ plugin: 'loopkeeper', key: 'gateConfigFiles' } as const, [] as string[])
const gateConfigErrors = atom({ plugin: 'loopkeeper', key: 'gateConfigErrors' } as const, [] as string[])
const gateTurnId = atom({ plugin: 'loopkeeper', key: 'gateTurnId' } as const, '')
const gateTurnFiles = atom({ plugin: 'loopkeeper', key: 'gateTurnFiles' } as const, [] as string[])
const gateTurnExtra = atom({ plugin: 'loopkeeper', key: 'gateTurnExtra' } as const, 0)
const gateTurnUnlimited = atom({ plugin: 'loopkeeper', key: 'gateTurnUnlimited' } as const, false)
const gateTurnFired = atom({ plugin: 'loopkeeper', key: 'gateTurnFired' } as const, false)
const gateSessionFiles = atom({ plugin: 'loopkeeper', key: 'gateSessionFiles' } as const, [] as string[])
const gatePlanOk = atom({ plugin: 'loopkeeper', key: 'gatePlanOk' } as const, false)
const gatePlanBy = atom({ plugin: 'loopkeeper', key: 'gatePlanBy' } as const, '')
const gateShipOk = atom({ plugin: 'loopkeeper', key: 'gateShipOk' } as const, false)
const gateGrants = atom({ plugin: 'loopkeeper', key: 'gateGrants' } as const, [] as string[])
const gateLog = atom({ plugin: 'loopkeeper', key: 'gateLog' } as const, [] as LkGateLogRow[])
const gateSessionRaise = atom({ plugin: 'loopkeeper', key: 'gateSessionRaise' } as const, 0)
// The user's yes for the next push or merge to the default branch, spent by it: the Ship approval (stage.ts sets it
// and clears it on leaving the ship stage), /lk gates ship ok or /lk gates merge ok.
const gateMergeCredit = atom({ plugin: 'loopkeeper', key: 'gateMergeCredit' } as const, false)
// Requests: refusals waiting for the user's answer (a card, the Gates pane, /lk approve). Raised here; answered by the
// stage, which writes the grants below and removes the request. Grants are read from these atoms on every check.
const gateRequests = atom({ plugin: 'loopkeeper', key: 'gateRequests' } as const, [] as LkGateRequest[])
const gateRequestSeq = atom({ plugin: 'loopkeeper', key: 'gateRequestSeq' } as const, 0)
const gateTurnSeq = atom({ plugin: 'loopkeeper', key: 'gateTurnSeq' } as const, 0)
const gateGlobGrants = atom({ plugin: 'loopkeeper', key: 'gateGlobGrants' } as const, [] as string[])
const gateMergeSession = atom({ plugin: 'loopkeeper', key: 'gateMergeSession' } as const, false)
const gateShipOnce = atom({ plugin: 'loopkeeper', key: 'gateShipOnce' } as const, [] as string[])
// The person's last /lk gates allow|ship ok|merge ok|plan ok|max: the stage's /lk handler submits its text (ADR 0012)
const gateAnswered = atom({ plugin: 'loopkeeper', key: 'gateAnswered' } as const, { seq: 0, text: '' } as { seq: number; text: string })
// Declared by stage.ts too, with the same defaults: one value (ADR 0004).
const stageCurrent = atom({ plugin: 'loopkeeper', key: 'stageCurrent' } as const, 'plan')
const stagePlanDone = atom({ plugin: 'loopkeeper', key: 'stagePlanDone' } as const, false)
const stageShipOpen = atom({ plugin: 'loopkeeper', key: 'stageShipOpen' } as const, true)
const stageShipUsed = atom({ plugin: 'loopkeeper', key: 'stageShipUsed' } as const, false)
const stageBudget = atom({ plugin: 'loopkeeper', key: 'stageBudget' } as const, 0)
const stagePlanFiles = atom({ plugin: 'loopkeeper', key: 'stagePlanFiles' } as const, null as number | null)
// the pipeline's stages: which ones are gated, and their labels for the deny texts
const stageStages = atom({ plugin: 'loopkeeper', key: 'stageStages' } as const, DEFAULT_STAGES.map(s => ({ ...s })) as Stage[])
// Declared by routing.ts and stage.ts too: GSD mode and its loop switch.
const routeMode = atom({ plugin: 'loopkeeper', key: 'routeMode' } as const, false)
const routeLoop = atom({ plugin: 'loopkeeper', key: 'routeLoop' } as const, true)
// The Files pane's atoms (files.ts reads them); the gates write Bash writes into them.
const filesTouched = atom({ plugin: 'loopkeeper', key: 'filesTouched' } as const, [] as LkTouchEntry[])
const filesActivity = atom({ plugin: 'loopkeeper', key: 'filesActivity' } as const, { live: [], last: '' } as LkFilesLive)

// ---- The module's own copy, so parallel tool.check calls count against one Set -------------------------------
// Decisions read and change these synchronously; every change is mirrored to $.state. Grants are not here: the stage
// writes them too, so they are read from their atoms on every check and added with update().

type Mem = {
  turnId: string
  turnFiles: Set<string>
  turnExtra: number
  turnUnlimited: boolean
  turnFired: boolean
  sessionFiles: Set<string>
  aborting: string
}

const fresh = (): Mem => ({
  turnId: '',
  turnFiles: new Set(),
  turnExtra: 0,
  turnUnlimited: false,
  turnFired: false,
  sessionFiles: new Set(),
  aborting: '',
})

let mem: Mem = fresh()
let hydrated = false
let killed: boolean | null = null

type CheckResult = { decision: 'allow' | 'ask' | 'deny'; reason?: string; rule?: string }

// ---- Fail closed, and the kill switch (both borrowed from scope-guard) ---------------------------------------

/** The same refusal's reason for an error caught inside a gating hook. */
function refusedReason(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  return failClosedReason('throw', text)
}

/** CLAUDE_MODS_DISABLE names loopkeeper (or all): read once, kept for the module's life and in gateDisabled. */
async function isKilled($: EngineInterface): Promise<boolean> {
  if (killed !== null) return killed
  let raw: unknown = ''
  try {
    raw = await $.env.get('CLAUDE_MODS_DISABLE')
  } catch {
    raw = ''
  }
  killed = killSwitchOn(raw)
  if (killed) await update($, gateDisabled, () => true).catch(() => undefined)
  return killed
}

// ---- Paths and stage names ------------------------------------------------------------------------------------

/**
 * The project root: where the session started, or where /cd or a worktree move took it. A shell `cd` does not move
 * it, so the project config, protected globs and plan paths keep matching the same files after one. Falls back to
 * the session's folder.
 */
async function projectRoot($: EngineInterface): Promise<string> {
  try {
    const root = await $.session.root()
    if (typeof root === 'string' && root !== '') return root
  } catch {
    // the session's folder below
  }
  return $.session.cwd()
}

/** A path made absolute against the folder a command ran in. */
function absoluteIn(path: string, dir: string): string {
  return path.startsWith('/') ? path : `${dir.replace(/\/+$/, '')}/${path}`
}

async function stagesNow($: EngineInterface): Promise<Stage[]> {
  const list = await read($, stageStages)
  return Array.isArray(list) ? list : DEFAULT_STAGES
}

/** The gated stage of a role and the stage before it, by label; undefined when no stage of that role is gated. */
function gatedStage(stages: readonly Stage[], role: string): { label: string; before?: string } | undefined {
  const gate = stageForRole(stages, role)
  if (!gate || gate.gate !== true) return undefined
  const i = stages.findIndex(s => s.id === gate.id)
  const prev = i > 0 ? stages[i - 1] : undefined
  return { label: gate.label || gate.id, before: prev ? prev.label || prev.id : undefined }
}

/** Where /lk approve opens a gate: the stage before it or the gated stage itself ("QA or Ship"). */
function approveFrom(g: { label: string; before?: string }): string {
  return g.before !== undefined ? `${g.before} or ${g.label}` : g.label
}

// ---- Config: defaults → ~/.claude/loopkeeper.json → <root>/.claude/loopkeeper.json → this session's overrides -----

async function ensureConfig($: EngineInterface): Promise<LkGateConfig> {
  const cached = await read($, gateConfig)
  if (cached !== null) return cached
  return loadConfig($)
}

async function loadConfig($: EngineInterface): Promise<LkGateConfig> {
  const home = ((await $.env.get('HOME').catch(() => undefined)) ?? '').replace(/\/+$/, '')
  const root = (await projectRoot($)).replace(/\/+$/, '')
  const candidates: Array<{ path: string; label: string }> = []
  if (home !== '') candidates.push({ path: userConfigPath(home), label: USER_LABEL })
  const project = projectConfigPath(root)
  if (!candidates.some(c => c.path === project)) candidates.push({ path: project, label: PROJECT_LABEL })

  const layers: Array<{ label: string; layer: Layer }> = []
  const files: string[] = []
  const errors: string[] = []
  for (const c of candidates) {
    const exists = await $.fs.exists(c.path).catch(() => false)
    if (!exists) continue
    try {
      const parsed = sectionLayer(String(await $.fs.read(c.path)))
      layers.push({ label: c.label, layer: parsed.layer })
      files.push(c.path)
      errors.push(...parsed.errors.map(x => `${c.label}: ${x}`))
    } catch {
      errors.push(`${c.label} is unreadable or not a JSON object`)
    }
  }
  const override = await readOverride($)
  if (override !== null) layers.push({ label: 'session', layer: override })

  const { config, sources } = mergeLayers(layers)
  await update($, gateConfig, () => config)
  await update($, gateSources, () => sources)
  await update($, gateConfigFiles, () => files)
  await update($, gateConfigErrors, () => errors)
  if (errors.length > 0) $.ui.toast(`config: ${errors.join('; ')}`)
  $.ui.invalidate('prompt.context')
  return config
}

async function sessionKey($: EngineInterface, prefix: string): Promise<string> {
  const id = await $.session.id().catch(() => '')
  return storeKey('gates', `${prefix}:${typeof id === 'string' && id !== '' ? id : 'unknown'}`)
}

async function readOverride($: EngineInterface): Promise<Layer | null> {
  const raw: unknown = await $.store.get(await sessionKey($, 'overrides')).catch(() => undefined)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  return checkLayer(raw as Record<string, unknown>).layer
}

async function setOverride($: EngineInterface, patch: Layer): Promise<void> {
  const key = await sessionKey($, 'overrides')
  const prev = (await readOverride($)) ?? {}
  await $.store.set(key, { ...prev, ...patch })
}

// ---- The limit in force (ADR 0011) ---------------------------------------------------------------------------

type Limit = { limit: number; source: 'max' | 'budget' | 'raise' | 'base'; base: number; budget: number; raise: number; slack: number }

/** The files-per-turn limit before this turn's extras; a session override (`/lk gates max`) wins over the rest, except
 *  a session raise above it (the request card's "Raise to <n>", which cannot rewrite the override). */
async function limitNow($: EngineInterface, config: LkGateConfig): Promise<Limit> {
  const sources = await read($, gateSources)
  const raise = await read($, gateSessionRaise)
  const max = sources.maxFilesPerTurn === 'session' ? config.maxFilesPerTurn : null
  // only the raise beats the override: the base and the plan budget never do, so the raise stands in for it
  const raised = max !== null && raise > max
  const parts = {
    max: raised ? raise : max,
    base: config.maxFilesPerTurn,
    budget: await read($, stageBudget),
    raise,
  }
  return { limit: limitOf(parts), source: raised ? 'raise' : limitSource(parts), base: parts.base, budget: parts.budget, raise: parts.raise, slack: config.planSlack }
}

// ---- Memory and the log --------------------------------------------------------------------------------------

async function hydrate($: EngineInterface): Promise<void> {
  if (hydrated) return
  hydrated = true
  mem = {
    turnId: await read($, gateTurnId),
    turnFiles: new Set(await read($, gateTurnFiles)),
    turnExtra: await read($, gateTurnExtra),
    turnUnlimited: await read($, gateTurnUnlimited),
    turnFired: await read($, gateTurnFired),
    sessionFiles: new Set(await read($, gateSessionFiles)),
    aborting: '',
  }
}

async function persistTurn($: EngineInterface): Promise<void> {
  await update($, gateTurnId, () => mem.turnId)
  await update($, gateTurnFiles, () => [...mem.turnFiles])
  await update($, gateTurnExtra, () => mem.turnExtra)
  await update($, gateTurnUnlimited, () => mem.turnUnlimited)
  await update($, gateTurnFired, () => mem.turnFired)
}

// A new conversation (/clear, /resume, /branch): the session's grants and requests start over
async function persistSession($: EngineInterface): Promise<void> {
  await update($, gateSessionFiles, () => [...mem.sessionFiles])
  await update($, gateGrants, () => [])
  await update($, gateGlobGrants, () => [])
  await update($, gateMergeSession, () => false)
  await update($, gateShipOnce, () => [])
  await update($, gateRequests, () => [])
  await update($, gatePlanOk, () => false)
  await update($, gatePlanBy, () => '')
  await update($, gateLog, () => [])
}

async function record($: EngineInterface, row: Omit<LkGateLogRow, 'at'>): Promise<void> {
  const full: LkGateLogRow = { at: Date.now(), ...row }
  await update($, gateLog, rows => [...rows, full].slice(-LOG_KEEP))
}

async function fire($: EngineInterface, row: Omit<LkGateLogRow, 'at'>): Promise<void> {
  mem.turnFired = true
  await update($, gateTurnFired, () => true)
  await record($, row)
}

// ---- Asking -------------------------------------------------------------------------------------------------

/**
 * Where a question could reach the user: 'terminal' under the REPL; 'app' when only other surfaces draw the session
 * (the desktop app, mobile, VS Code), where $.ui.ask from a permission check never resolves to an option; 'none' in a
 * plain -p run.
 */
async function askPlace($: EngineInterface): Promise<'terminal' | 'app' | 'none'> {
  try {
    const surfaces = await $.session.surfaces()
    return surfaces.includes('terminal') ? 'terminal' : surfaces.length > 0 ? 'app' : 'none'
  } catch {
    return 'none'
  }
}

/** Whether the gates may put a question: only in the terminal. */
async function isInteractive($: EngineInterface): Promise<boolean> {
  return (await askPlace($)) === 'terminal'
}

/** Where a refusal's request waits for the user (lib/gateRules.ts waitPlace): the card, the Gates pane, or nowhere. */
async function gatePlace($: EngineInterface): Promise<WaitPlace> {
  try {
    return waitPlace(await $.session.surfaces())
  } catch {
    return 'none'
  }
}

/**
 * Raise a request the user answers with a press or /lk approve: newest last, one per kind and target, in the main turn
 * running now. A failure leaves the refusal standing without its card.
 */
async function raiseGateRequest($: EngineInterface, req: Omit<LkGateRequest, 'id' | 'turn' | 'time'>): Promise<void> {
  try {
    const seq = await update($, gateRequestSeq, n => n + 1)
    const turn = await read($, gateTurnSeq)
    const time = Date.now()
    const full: LkGateRequest = { ...req, id: `r${seq}`, turn, time }
    await update($, gateRequests, list => addRequest(list, full))
  } catch {
    // the refusal stands; /lk gates still lets the user answer
  }
}

/** A main turn starts: count it, and let requests raised REQUEST_TURNS main turns ago or earlier expire. */
async function startRequestTurn($: EngineInterface): Promise<void> {
  const turn = await update($, gateTurnSeq, n => n + 1)
  const list = await read($, gateRequests)
  if (liveRequests(list, turn).length !== list.length) await update($, gateRequests, l => liveRequests(l, turn))
}

/** Drop the requests a grant or a pass now covers. */
async function dropGateRequests($: EngineInterface, covered: (r: LkGateRequest) => boolean): Promise<void> {
  try {
    const list = await read($, gateRequests)
    if (list.some(covered)) await update($, gateRequests, l => l.filter(r => !covered(r)))
  } catch {
    // a stale card answers nothing; the stage says so
  }
}

/** The label picked, or null when nobody could be asked, the question was dismissed, or the answer is not an option. */
async function ask($: EngineInterface, question: string, options: readonly string[]): Promise<string | null> {
  if (!(await isInteractive($))) return null
  try {
    const answer = await $.ui.ask(question, options)
    return options.includes(answer) ? answer : null
  } catch {
    return null
  }
}

// After a deny, Claude tends to try another tool; ending the turn is what makes it stop.
// The abort waits so the refusal lands in the transcript first (as scope-guard does).
function scheduleAbort($: EngineInterface): void {
  const running = mem.turnId
  if (running === '' || mem.aborting === running) return
  mem.aborting = running
  $.clock.after(ABORT_DELAY_MS, () => {
    void $.turn.abort({ turnId: running }).catch(() => undefined)
  })
}

// ---- Edits: plan gate, protected paths, files per turn -------------------------------------------------------

async function planSatisfied($: EngineInterface): Promise<boolean> {
  if (await read($, gatePlanOk)) return true
  return (await read($, stagePlanDone)) === true
}

// `reserved` collects the paths this call newly counted against the turn, so a Bash call a later check refuses can
// release them (releaseTurnFiles).
async function decideEdit($: EngineInterface, paths: string[], tool: string, agentId?: unknown, reserved?: string[]): Promise<string | null> {
  if (paths.length === 0) return null
  await hydrate($)
  const config = await ensureConfig($)
  // against the project root, so a shell `cd` does not change which rules a file meets
  const root = await projectRoot($)
  const rel = [...new Set(paths.map(p => normalizePath(p, root)))]
  // Plan material (the scratchpad, planPaths): exempt from the plan gate and the per-turn count
  const plan = new Set(rel.filter(p => isPlanMaterial(p, root, config.planPaths)))
  const work = rel.filter(p => !plan.has(p))

  // 1. Plan gate
  const gateClosed = config.requirePlan && !(await planSatisfied($))
  const planExempt = gateClosed && work.length === 0
  if (gateClosed && work.length > 0) {
    await fire($, { rule: 'plan', target: work.join(', '), outcome: 'denied', detail: `${tool} before a plan was approved` })
    const stages = await stagesNow($)
    const gate = gatedStage(stages, 'validate-plan')
    const planStage = stageForRole(stages, 'plan')
    // true at every stage: /lk approve opens a gated plan stage from that stage or the one before it; with no plan
    // gate, moving past the plan stage is what opens edits
    const how = gate
      ? ` and ask the user to approve it: /lk approve opens the pipeline's ${gate.label} gate (from ${approveFrom(gate)}), ` +
        `or ${GATES_CMD} plan ok allows edits for this session without it.`
      : `, then move the pipeline ${planStage ? `past ${planStage.label || planStage.id}` : 'on'} with set_stage, or ask the user for ${GATES_CMD} plan ok.`
    return `${MOD}: edits are refused until a plan is approved in this session (requirePlan is on). ` +
        'Do not try another tool to make this change. Present a short plan (Goal, Steps, Done-when, and the files you will touch)' +
        how
  }

  // 2. Protected paths. The grants are read from their atoms each time: the stage writes them when the user answers.
  const asks = rel.some(p => matchProtected(config.protected, p)?.action === 'ask')
  const grants = asks ? await read($, gateGrants) : []
  const globGrants = asks ? await read($, gateGlobGrants) : []
  for (const p of rel) {
    const rule = matchProtected(config.protected, p)
    if (!rule) continue
    if (rule.action === 'deny') {
      await fire($, { rule: 'protected', target: p, outcome: 'denied', detail: `matches ${rule.glob} (deny)` })
      return `${MOD}: ${p} is a protected path (rule "${rule.glob}": deny). Do not edit it or reach it another way. Ask the user to make this change themselves or to change the rule.`
    }
    if (grants.includes(p) || globGranted(config.protected, globGrants, p)) {
      await dropGateRequests($, r => r.kind === 'protected' && r.target === p)
      continue
    }
    // off the terminal nobody can be asked: a request waits for the user's answer (the card, the Gates pane, or
    // /lk approve); a -p run names the command
    const place = await gatePlace($)
    if (place !== 'terminal') {
      await fire($, { rule: 'protected', target: p, outcome: 'denied', detail: `${rule.glob}: needs the user's yes (no terminal to ask)` })
      await raiseGateRequest($, { kind: 'protected', target: p, glob: rule.glob, what: p })
      return protectedHeld(p, rule.glob, place)
    }
    const answer = await ask($, `${MOD}: ${p} is protected (rule "${rule.glob}"). Allow this ${tool} edit?`, ASK_PROTECTED)
    mem.turnFired = true
    if (answer === 'Allow for session') {
      await update($, gateGrants, list => (list.includes(p) ? list : [...list, p]))
      await record($, { rule: 'protected', target: p, outcome: 'allowed', detail: `${rule.glob}: allowed for session` })
      continue
    }
    if (answer === 'Allow once') {
      await record($, { rule: 'protected', target: p, outcome: 'allowed', detail: `${rule.glob}: allowed once` })
      continue
    }
    const why = answer === null ? 'the question was dismissed' : 'the user chose Deny'
    await fire($, { rule: 'protected', target: p, outcome: 'denied', detail: `${rule.glob}: ${why}` })
    return `${MOD}: the edit to protected path ${p} (rule "${rule.glob}") was refused: ${why}. Do not work around it; ask the user how to proceed.`
  }

  if (planExempt) await record($, { rule: 'plan', target: rel.join(', '), outcome: 'allowed', detail: 'plan material' })

  // 3. Files per turn. A subagent's edits are not counted unless countSubagents is on (orchestrated builders write
  // many files in one main turn); rules 1 and 2 still applied. Plan material never counts.
  if (work.length === 0 || (typeof agentId === 'string' && agentId !== '' && !config.countSubagents)) {
    for (const p of rel) mem.sessionFiles.add(p)
    await update($, gateSessionFiles, () => [...mem.sessionFiles])
    return null
  }
  const lim = await limitNow($, config)
  // Checked and reserved synchronously so parallel calls count against one Set.
  let added = work.filter(p => !mem.turnFiles.has(p))
  const limit = () => (mem.turnUnlimited ? Infinity : lim.limit + mem.turnExtra)
  if (added.length > 0 && mem.turnFiles.size + added.length > limit()) {
    const before = [...mem.turnFiles]
    const n = before.length
    // the figure is computed once, so the label and what choosing it does match
    const figure = raiseTo(lim.limit, lim.slack)
    const options = filesOptions(figure)
    const place = await askPlace($)
    const interactive = place === 'terminal'
    let answer: string | null = null
    if (interactive) answer = await ask($, `${MOD}: this turn already touched ${n} files. Allow more?`, options)
    mem.turnFired = true
    added = work.filter(p => !mem.turnFiles.has(p))
    if (answer === options[0]) {
      mem.turnExtra += Math.max(1, mem.turnFiles.size + added.length - limit())
      await record($, { rule: 'files', target: added.join(', '), outcome: 'allowed', detail: `past ${n} files: allowed 1 more` })
    } else if (answer === options[1]) {
      mem.turnUnlimited = true
      await record($, { rule: 'files', target: added.join(', '), outcome: 'allowed', detail: `past ${n} files: allowed for the rest of the turn` })
    } else if (answer === options[2]) {
      await update($, gateSessionRaise, r => Math.max(r, figure))
      // a session max wins over the raise; raising it too keeps the label true
      if (lim.source === 'max') {
        await setOverride($, { maxFilesPerTurn: Math.min(1000, figure) })
        await loadConfig($)
      }
      const over = mem.turnFiles.size + added.length - (figure + mem.turnExtra)
      if (over > 0) mem.turnExtra += over
      $.ui.invalidate('prompt.context')
      await record($, { rule: 'files', target: added.join(', '), outcome: 'allowed', detail: `past ${n} files: raised to ${figure} for this session` })
    } else if (place === 'app') {
      // off the terminal nobody can be asked: a request offers the session raise (the turn ends, so a per-turn
      // answer would do nothing)
      await fire($, { rule: 'files', target: added.join(', '), outcome: 'denied', detail: `past ${n} files: needs the user's yes (no terminal to ask)` })
      await raiseGateRequest($, { kind: 'files', target: 'files', what: `more than ${lim.limit} files this turn`, raise: figure })
      scheduleAbort($)
      return filesHeld(n, before, added, lim.limit, (await gatePlace($)) === 'card' ? 'card' : 'pane')
    } else {
      const why = !interactive ? 'no one to ask (non-interactive session)' : answer === 'Stop' ? 'the user chose Stop' : 'the question was dismissed'
      await fire($, { rule: 'files', target: added.join(', '), outcome: 'denied', detail: `past ${n} files: ${why}` })
      scheduleAbort($)
      return [
          `${MOD} stopped this edit: this turn already touched ${n} files (${before.join(', ')}) and ${added.join(', ')} would exceed the limit of ${lim.limit} files per turn (${why}).`,
          'Stop editing now. Summarise what changed so far, list the files you still intend to touch and why, and ask the user before continuing.',
        ].join('\n')
    }
  }
  for (const p of added) mem.turnFiles.add(p)
  if (reserved) reserved.push(...added)
  for (const p of rel) mem.sessionFiles.add(p)
  await persistTurn($)
  await update($, gateSessionFiles, () => [...mem.sessionFiles])
  return null
}

/** Release the paths decideEdit counted for a call a later check refused: that call touched nothing. */
async function releaseTurnFiles($: EngineInterface, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  for (const p of paths) mem.turnFiles.delete(p)
  await persistTurn($)
}

// ---- Bash: the ship gate ---------------------------------------------------------------------------------------

async function shipOk($: EngineInterface): Promise<boolean> {
  if (await read($, gateShipOk)) return true
  const saved: unknown = await $.store.get(await sessionKey($, 'shipOk')).catch(() => undefined)
  if (saved !== true) return false
  await update($, gateShipOk, () => true)
  return true
}

// The one-time yes a Bash call passed on, spent last (spendOnce) once every check on the call passed: `ship` the
// command names a ship once-grant covered, `merge` the merge label the merge credit covered, `covered` the merge label
// the once-grant covered too.
type Spend = { ship: string[]; merge: string; covered: string }

/**
 * ADR 0004: shipping waits for the stage's stageShipOpen or /lk gates ship ok; there is no fallback question. A held
 * call raises a request on every surface (the terminal draws the card too); "Allow this … once" lets one call of those
 * command names through.
 */
async function shipGate($: EngineInterface, config: LkGateConfig, shell: string, spend: Spend): Promise<string | null> {
  if (!config.shipGate) return null
  const hits = shipCommands(shell)
  if (hits.length === 0) return null
  const what = hits.join(', ')
  if (await shipOk($)) return null
  if ((await read($, stageShipOpen)) === true) {
    const ship = stageForRole(await stagesNow($), 'ship')
    if (ship && ship.gate === true && (await read($, stageCurrent)) === ship.id) spend.shipStage = true
    return null
  }
  const once = await read($, gateShipOnce)
  if (once.length > 0 && hits.every(h => once.includes(h))) {
    spend.ship = hits
    return null
  }
  const stage = await read($, stageCurrent)
  const stages = await stagesNow($)
  const here = stages.find(s => s.id === stage)
  const where = here ? here.label || here.id : stage !== '' ? stage : 'an unknown stage'
  await fire($, { rule: 'ship', target: what, outcome: 'denied', detail: `pipeline at ${where}` })
  await raiseGateRequest($, { kind: 'ship', target: what, what })
  const place = await gatePlace($)
  return shipHeld(what, where, place === 'terminal' ? 'card' : place)
}

// ---- Bash: merge gate, amend, add-all --------------------------------------------------------------------------

async function gitGate($: EngineInterface, config: LkGateConfig, actions: GitAction[], shell: string, command: string, spend: Spend): Promise<string | null> {
  if (actions.length === 0) return null
  const dir = await runDir($, command)
  const branches = await gitBranches($, dir)

  for (const a of actions) {
    if (a.kind === 'amend' && config.blockAmend) {
      const shared = branches.defaults.includes(branches.current) || (await headIsPushed($, dir))
      if (shared) {
        await fire($, { rule: 'amend', target: branches.current || '(unknown branch)', outcome: 'denied', detail: 'git commit --amend on a shared branch' })
        return `${MOD}: \`git commit --amend\` is refused on ${branches.current || 'this branch'}: the commit is already shared (default branch, or already pushed). Make a new commit instead.`
      }
    }
    if (a.kind === 'add-all' && config.blockAddAll) {
      const status = await $.process.run(['git', 'status', '--porcelain'], { cwd: dir, timeoutMs: 15_000 }).catch(() => null)
      const changed = status !== null && status.exitCode === 0 ? parsePorcelain(status.stdout) : null
      // porcelain paths are relative to the repository's top level; the session's files to the project root
      const top = changed !== null && changed.length > 0 ? await repoTop($, dir) : dir
      const root = await projectRoot($)
      const untouched = changed === null ? null : changed.filter(p => !mem.sessionFiles.has(normalizePath(`${top}/${p}`, root)))
      if (untouched === null || untouched.length > 0) {
        const list = untouched === null ? '(git status could not be read)' : untouched.slice(0, 15).join(', ') + (untouched.length > 15 ? `, and ${untouched.length - 15} more` : '')
        await fire($, { rule: 'add-all', target: a.args.join(' '), outcome: 'denied', detail: `untouched: ${list}` })
        return `${MOD}: \`git add ${a.args.join(' ')}\` is refused: it would stage files this session did not touch: ${list}. Stage the files you changed by name.`
      }
    }
  }

  if (!config.mergeGate) return null
  const merges = actions.filter(
    a =>
      a.kind === 'gh-merge' ||
      (a.kind === 'git-merge' && mergeHitsDefault(a.args, branches.current, branches.defaults)) ||
      (a.kind === 'git-push' && pushHitsDefault(a.args, branches.current, branches.defaults)),
  )
  if (merges.length === 0) return null
  const what = merges.some(m => m.kind === 'gh-merge')
    ? `gh pr merge${prNumber(shell) ? ' ' + prNumber(shell) : ''}`
    : merges[0]?.kind === 'git-push'
      ? 'push to the default branch'
      : 'merge with the default branch'

  if (config.requireGreenCi && merges.some(m => m.kind === 'gh-merge')) {
    const pr = await openPr($, dir, prNumber(shell))
    if (pr !== null) {
      const res = await $.process.run(['gh', 'pr', 'checks', String(pr), '--json', 'name,bucket'], { cwd: dir, timeoutMs: 20_000 }).catch(() => null)
      // gh exits non-zero while checks fail or run; the JSON is still on stdout.
      const sum = summarizeChecks(res?.stdout?.trim() ? res.stdout : '[]')
      if (sum.failing.length > 0 || sum.pending.length > 0) {
        const parts = [
          sum.failing.length > 0 ? `failing: ${sum.failing.join(', ')}` : '',
          sum.pending.length > 0 ? `pending: ${sum.pending.join(', ')}` : '',
        ].filter(x => x !== '')
        await fire($, { rule: 'merge', target: `PR #${pr}`, outcome: 'denied', detail: parts.join('; ') })
        return `${MOD}: held the merge of PR #${pr}: CI is not green (${parts.join('; ')}). Wait for the checks or fix them, then ask the user before merging.`
      }
    }
  }

  // pushes and merges allowed for the session (the card's second answer)
  if ((await read($, gateMergeSession)) === true) {
    await record($, { rule: 'merge', target: what, outcome: 'allowed', detail: 'allowed for this session' })
    await dropGateRequests($, r => r.kind === 'merge')
    return null
  }
  // a ship once-grant this call passed the ship gate on covers its merge gate too: one press is enough
  if (spend.ship.length > 0) {
    spend.covered = what
    return null
  }
  // the user's yes given ahead: the Ship approval, /lk gates ship ok or /lk gates merge ok covers this one call. It is
  // spent last (spendOnce), only when every other check on the call passed.
  if ((await read($, gateMergeCredit)) === true) {
    spend.merge = what
    return null
  }
  const place = await gatePlace($)
  if (place !== 'terminal') {
    await fire($, { rule: 'merge', target: what, outcome: 'denied', detail: "needs the user's yes (no terminal to ask)" })
    await raiseGateRequest($, { kind: 'merge', target: what, what })
    return mergeHeld(what, place)
  }
  const answer = await ask($, `Merge now? (${MOD}: ${what})`, ASK_MERGE)
  mem.turnFired = true
  await update($, gateTurnFired, () => true)
  if (answer === 'Merge') {
    await record($, { rule: 'merge', target: what, outcome: 'allowed', detail: 'the user chose Merge' })
    return null
  }
  const why = answer === null ? 'the question was dismissed' : 'the user chose Cancel'
  await fire($, { rule: 'merge', target: what, outcome: 'denied', detail: why })
  return `${MOD}: the ${what} was held: ${why}. Do not retry it another way; ask the user when to merge.`
}

/**
 * Spends the one-time yes the call passed on, as the very last step: the ship once-grant (which covered the merge gate
 * too) or the merge credit. One update reads and clears each, so two calls in parallel cannot both pass on it. The
 * refusal when another call spent it first, else null.
 */
async function spendOnce($: EngineInterface, spend: Spend): Promise<string | null> {
  if (spend.ship.length > 0) {
    let had = false
    await update($, gateShipOnce, once => {
      had = spend.ship.every(h => once.includes(h))
      return had ? [] : once
    })
    const what = spend.ship.join(', ')
    if (!had) {
      await fire($, { rule: 'ship', target: what, outcome: 'denied', detail: 'the once-grant was spent by another call' })
      await raiseGateRequest($, { kind: 'ship', target: what, what })
      return spentHeld(what)
    }
    await record($, { rule: 'ship', target: what, outcome: 'allowed', detail: 'allowed once by the user' })
    if (spend.covered !== '') await record($, { rule: 'merge', target: spend.covered, outcome: 'allowed', detail: 'covered by the ship once-grant' })
    await dropGateRequests($, r => r.kind === 'ship' || (spend.covered !== '' && r.kind === 'merge'))
    await markShipUsed($, spend)
    return null
  }
  if (spend.merge === '') {
    await markShipUsed($, spend)
    return null
  }
  let had = false
  await update($, gateMergeCredit, credit => {
    had = credit === true
    return false
  })
  if (!had) {
    await fire($, { rule: 'merge', target: spend.merge, outcome: 'denied', detail: 'the credit was spent by another call' })
    await raiseGateRequest($, { kind: 'merge', target: spend.merge, what: spend.merge })
    return spentHeld(spend.merge)
  }
  await record($, { rule: 'merge', target: spend.merge, outcome: 'allowed', detail: 'covered by the Ship approval or /lk gates merge ok' })
  await dropGateRequests($, r => r.kind === 'merge')
  await markShipUsed($, spend)
  return null
}

/** A call that passed on the Ship approval and went through: the stage ends the approval at the person's next message. */
async function markShipUsed($: EngineInterface, spend: Spend): Promise<void> {
  if (spend.shipStage) await update($, stageShipUsed, () => true)
}

async function gitBranches($: EngineInterface, dir: string): Promise<{ current: string; defaults: string[] }> {
  const cur = await $.process.run(['git', 'branch', '--show-current'], { cwd: dir, timeoutMs: 10_000 }).catch(() => null)
  const head = await $.process.run(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: dir, timeoutMs: 10_000 }).catch(() => null)
  const current = cur !== null && cur.exitCode === 0 ? cur.stdout.trim() : ''
  const defaults = ['main', 'master']
  const remote = head !== null && head.exitCode === 0 ? head.stdout.trim().replace(/^[^/]+\//, '') : ''
  if (remote !== '' && !defaults.includes(remote)) defaults.unshift(remote)
  return { current, defaults }
}

/** The repository's top level as git sees it from dir; dir itself when git cannot say. */
async function repoTop($: EngineInterface, dir: string): Promise<string> {
  const r = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 10_000 }).catch(() => null)
  const top = r !== null && r.exitCode === 0 ? r.stdout.trim() : ''
  return top.startsWith('/') ? top : dir
}

async function headIsPushed($: EngineInterface, dir: string): Promise<boolean> {
  const r = await $.process.run(['git', 'merge-base', '--is-ancestor', 'HEAD', '@{u}'], { cwd: dir, timeoutMs: 10_000 }).catch(() => null)
  return r !== null && r.exitCode === 0
}

async function openPr($: EngineInterface, dir: string, number: string | undefined): Promise<number | null> {
  const args = ['gh', 'pr', 'view', ...(number ? [number] : []), '--json', 'number,state']
  const r = await $.process.run(args, { cwd: dir, timeoutMs: 20_000 }).catch(() => null)
  if (r === null || r.exitCode !== 0) return null
  try {
    const o = JSON.parse(r.stdout) as { number?: unknown; state?: unknown }
    return typeof o.number === 'number' && o.state === 'OPEN' ? o.number : null
  } catch {
    return null
  }
}

// Where the command really runs: the session's folder, moved by any leading `cd` (borrowed; see the notice in lib/shell.ts).
async function runDir($: EngineInterface, command: string): Promise<string> {
  let dir = await $.session.cwd()
  const targets = cdTargets(command)
  if (targets.length === 0) return dir
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  for (const t of targets) {
    const nextDir = resolveDir(dir, t, home)
    if (nextDir === null) break
    dir = nextDir
  }
  return dir
}

/**
 * A Bash call through every rule: the ship gate, the git rules and the merge gate, then the files it writes. A
 * one-time yes it passed on is spent last, only when every other check passed (2.5); the files counted for a call
 * that is then refused are released, and its writes are recorded only once it passes.
 */
async function decideBash($: EngineInterface, command: string, agentId: unknown): Promise<string | null> {
  const config = await ensureConfig($)
  const shell = bare(command)
  const spend: Spend = { ship: [], merge: '', covered: '', shipStage: false }
  let why = await shipGate($, config, shell, spend)
  if (why === null) why = await gitGate($, config, gitActions(shell), shell, command, spend)
  if (why !== null) return why
  // absolute against where the command runs; decideEdit then places them against the project root
  const dir = await runDir($, command)
  const targets = bashTargets(command, dir).map(t => absoluteIn(t, dir))
  const reserved: string[] = []
  why = await decideEdit($, targets, 'Bash', agentId, reserved)
  if (why !== null) return why
  why = await spendOnce($, spend)
  if (why !== null) {
    await releaseTurnFiles($, reserved)
    return why
  }
  if (targets.length > 0) await recordBashWrites($, targets, dir)
  return null
}

// ---- The Files pane seam: Bash writes the gates let through ------------------------------------------------------

/** Files a Bash command writes (bashTargets), into filesTouched and filesActivity.last, as change-control did. */
async function recordBashWrites($: EngineInterface, targets: string[], runCwd: string): Promise<void> {
  try {
    const cwd = (await $.session.cwd()).replace(/\/+$/, '') || '/'
    const root = runCwd.replace(/\/+$/, '')
    const paths = [...new Set(targets.map(t => normalizePath(t.startsWith('/') ? t : `${root}/${t}`, cwd)))]
      .filter(p => p !== '' && p !== cwd)
      .slice(0, 20)
    if (paths.length === 0) return
    // tool.check runs before the command: a path not there yet is one the command creates
    const existed = await Promise.all(paths.map(p => $.fs.exists(p.startsWith('/') ? p : `${cwd}/${p}`).catch(() => true)))
    const at = Date.now()
    let last = ''
    await update($, filesTouched, list => {
      const r = noteBashWrites(list, paths.map((path, i) => ({ path, created: existed[i] !== true })), at)
      last = r.last
      return r.touched
    })
    if (last !== '') await update($, filesActivity, a => ({ live: a.live, last }))
  } catch {
    // The verdict stands; the pane misses these files.
  }
}

// ---- The pane, /lk gates text and the /lk status line ------------------------------------------------------------

function clock(at: number): string {
  try {
    return new Date(at).toISOString().slice(11, 19)
  } catch {
    return '--:--:--'
  }
}

function limitWhy(l: Limit, planFiles: number | null): string {
  if (l.source === 'max') return `${GATES_CMD} max, for this session`
  if (l.source === 'budget') return `the approved plan's budget: ${planFiles !== null ? `${planFiles} planned + ${l.slack}` : `${l.budget}`}`
  if (l.source === 'raise') return 'raised for this session'
  return `the base, maxFilesPerTurn${l.budget > 0 ? `; plan budget ${l.budget}` : ''}${l.raise > 0 ? `; session raise ${l.raise}` : ''}`
}

async function statusLines($: EngineInterface): Promise<string[]> {
  const config = await ensureConfig($)
  const sources = await read($, gateSources)
  const files = await read($, gateConfigFiles)
  const errors = await read($, gateConfigErrors)
  const turn = await read($, gateTurnFiles)
  const extra = await read($, gateTurnExtra)
  const unlimited = await read($, gateTurnUnlimited)
  const planOk = await read($, gatePlanOk)
  const planBy = await read($, gatePlanBy)
  const planDone = (await read($, stagePlanDone)) === true
  const shipOpen = (await read($, stageShipOpen)) === true
  const stage = await read($, stageCurrent)
  const okShip = await shipOk($)
  const log = (await read($, gateLog)).slice().reverse()
  const enabled = await read($, gateEnabled)
  const lim = await limitNow($, config)
  const limit = unlimited ? '∞' : String(lim.limit + extra)
  const planFilesNow = await read($, stagePlanFiles)
  return [
    (await isKilled($))
      ? `Status: OFF (CLAUDE_MODS_DISABLE names ${MOD}, so no rule is enforced; unset it and start a new session to turn the gates on)`
      : enabled
        ? 'Status: ON'
        : `Status: OFF for this session (${GATES_CMD} on)`,
    `Config files: ${files.length > 0 ? files.join(', ') : 'none (defaults)'}`,
    ...errors.map(x => `Ignored: ${x}`),
    'Active rules [source]:',
    ...describeRules(config, sources).map(r => `  ${r}`),
    `Files per turn: ${lim.limit} (${limitWhy(lim, planFilesNow)})`,
    `Plan: ${planOk ? `approved (${planBy || 'yes'})` : planDone ? 'approved in the pipeline' : config.requirePlan ? 'not yet approved' : 'not required'}`,
    `Ship: ${
      !config.shipGate
        ? 'gate off'
        : okShip
          ? `open (${GATES_CMD} ship ok)`
          : shipOpen
            ? 'open (the pipeline allows shipping)'
            : `held (pipeline at ${stage !== '' ? stage : 'an unknown stage'})`
    }`,
    `Files touched this turn (${turn.length}/${limit}):`,
    ...(turn.length > 0 ? turn.map(f => `  ${f}`) : ['  none']),
    `Decisions (last ${LOG_KEEP}, newest first):`,
    ...(log.length > 0 ? log.map(r => `  ${clock(r.at)} ${r.rule} ${r.outcome} ${r.target} · ${r.detail}`) : ['  none yet']),
  ]
}

/** The gates' line in /lk status (and the answer to a bare /lk gates beside the pane). */
async function statusLine($: EngineInterface): Promise<string> {
  if (await isKilled($)) return `gates ● off · CLAUDE_MODS_DISABLE names ${MOD}, so no rule is enforced`
  if (!(await read($, gateEnabled))) return `gates ● off for this session · ${GATES_CMD} on to resume`
  const config = await ensureConfig($)
  const lim = await limitNow($, config)
  const count = (await read($, gateTurnFiles)).length
  const limit = (await read($, gateTurnUnlimited)) ? '∞' : String(lim.limit + (await read($, gateTurnExtra)))
  const planOk = (await read($, gatePlanOk)) || (await read($, stagePlanDone)) === true
  const plan = config.requirePlan ? (planOk ? 'plan ✓' : 'plan ✗') : 'plan –'
  const held = config.shipGate && !(await shipOk($)) && (await read($, stageShipOpen)) !== true
  const source = lim.source === 'base' ? '' : ` (${lim.source})`
  return `gates ● on · ${count}/${limit} files${source} · ${plan} · ship ${config.shipGate ? (held ? 'held' : 'open') : 'gate off'} · merge gate ${config.mergeGate ? 'on' : 'off'}`
}

/** The pane's model: the state statusLines prints, as data, with every path made short for display. */
type GatesView = {
  state: 'on' | 'off' | 'killed'
  title: string
  sub: string
  tiles: { label: string; value: string; tone: Tone }[]
  rules: { key: string; values: string[]; source: string }[]
  protected: { glob: string; action: 'ask' | 'deny'; source: string }[]
  configFiles: string[]
  errors: string[]
  turn: { name: string; folder: string }[]
  log: { time: string; outcome: 'allowed' | 'asked' | 'denied'; target: string; detail: string }[]
}

/** Rules whose allowed rows are the user's answer to a question (Allow once, Allow for session, Merge, …). */
const ASKED_RULES: ReadonlySet<string> = new Set(['protected', 'files', 'merge'])
/** Rules whose target is a list of paths. */
const PATH_RULES: ReadonlySet<string> = new Set(['protected', 'files', 'plan'])

function baseOf(path: string): string {
  const p = path.replace(/\/+$/, '')
  return p.slice(p.lastIndexOf('/') + 1) || p
}

async function gatesView($: EngineInterface): Promise<GatesView> {
  const config = await ensureConfig($)
  const sources = await read($, gateSources)
  // the turn's files are relative to the project root (decideEdit)
  const root = (await projectRoot($)).replace(/\/+$/, '')
  const home = String((await $.env.get('HOME').catch(() => undefined)) ?? '')
  const short = (p: string) => shortPath(p, root, home)
  const turn = await read($, gateTurnFiles)
  const extra = await read($, gateTurnExtra)
  const unlimited = await read($, gateTurnUnlimited)
  const fired = await read($, gateTurnFired)
  const stage = await read($, stageCurrent)
  const lim = await limitNow($, config)
  const max = lim.limit + extra
  const limit = unlimited ? '∞' : String(max)
  const killed = await isKilled($)
  const enabled = await read($, gateEnabled)

  const from = lim.source === 'base' ? 'the base limit, maxFilesPerTurn' : lim.source === 'max' ? `max override for this session (${GATES_CMD} max)` : limitWhy(lim, await read($, stagePlanFiles))
  const more = unlimited ? ' · no limit for the rest of this turn' : extra > 0 ? ` · ${extra} more allowed this turn` : ''
  const near = !unlimited && turn.length >= Math.max(1, max - 1)
  const planOk = (await read($, gatePlanOk)) || (await read($, stagePlanDone)) === true
  const shipHeld = !(await shipOk($)) && (await read($, stageShipOpen)) !== true

  // describeRules is the one list of rules; the pane draws protected paths and planPaths its own way
  const rules: GatesView['rules'] = []
  for (const row of describeRules(config, sources)) {
    if (row.startsWith('protected ')) continue
    const m = /^([^:]+): (.*) {2}\[([^\]]*)\]$/.exec(row)
    if (!m) continue
    const values = m[1] === 'planPaths' ? [...config.planPaths, '+ scratchpad'] : [m[2]]
    rules.push({ key: m[1], values, source: m[3] })
  }

  return {
    state: killed ? 'killed' : enabled ? 'on' : 'off',
    title: killed ? 'Off' : enabled ? `On · ${turn.length}/${limit} files this turn` : 'Off for this session',
    sub: killed
      ? `CLAUDE_MODS_DISABLE names ${MOD}, so no rule is enforced; unset it and start a new session to turn the gates on`
      : enabled
        ? from + more
        : `no rule is enforced; ${GATES_CMD} on turns them back on`,
    tiles: [
      { label: 'Files per turn', value: limit, tone: fired ? 'danger' : near ? 'warn' : 'ok' },
      planOk
        ? { label: 'Plan', value: 'approved', tone: 'ok' }
        : config.requirePlan
          ? { label: 'Plan', value: 'needed', tone: 'warn' }
          : { label: 'Plan', value: 'not required', tone: 'muted' },
      !config.shipGate
        ? { label: 'Ship', value: 'gate off', tone: 'muted' }
        : shipHeld
          ? { label: 'Ship', value: stage !== '' ? `held at ${stage}` : 'held', tone: 'warn' }
          : { label: 'Ship', value: 'open', tone: 'ok' },
      { label: 'Merge gate', value: config.mergeGate ? 'on' : 'off', tone: config.mergeGate ? 'info' : 'muted' },
    ],
    rules,
    protected: config.protected.map(r => ({ glob: r.glob, action: r.action, source: sources[`protected:${r.glob}`] ?? 'default' })),
    configFiles: (await read($, gateConfigFiles)).map(short),
    errors: await read($, gateConfigErrors),
    turn: turn.map(f => {
      const p = f.replace(/\/+$/, '')
      const i = p.lastIndexOf('/')
      return { name: baseOf(p), folder: i < 0 ? '' : short(i === 0 ? '/' : p.slice(0, i)) }
    }),
    log: (await read($, gateLog))
      .slice()
      .reverse()
      .map((r): GatesView['log'][number] => ({
        time: clock(r.at),
        outcome: r.outcome === 'denied' ? 'denied' : ASKED_RULES.has(r.rule) ? 'asked' : 'allowed',
        target: PATH_RULES.has(r.rule)
          ? r.target.split(', ').map(baseOf).join(', ')
          : r.target.replace(/(^|[\s,])(\/[^\s,]+)/g, (_m, pre: string, p: string) => pre + short(p)),
        detail: r.detail,
      })),
  }
}

const OUTCOME_TONE: Record<GatesView['log'][number]['outcome'], Tone> = { allowed: 'ok', asked: 'warn', denied: 'danger' }

// A press runs nothing here: the stage's ui.press hook answers the request before the press reaches this closure.
const pressedByStage = (): undefined => undefined

/** A request's answers as kit buttons, with no hotkeys (several cards and rows can be drawn at once). */
function requestButtons(kit: Kit, r: LkGateRequest): unknown {
  return kit.buttons(requestChoices(r).map(c => ({ key: requestKey(r.id, c.choice), label: c.label, plain: true, onPress: pressedByStage })))
}

/** The card above the prompt: the newest request, what waits and why, and its answers. */
function requestCardOf(kit: Kit, r: LkGateRequest, count: number): unknown {
  const card = requestCard(r)
  return kit.card({
    title: card.title,
    right: count > 1 ? `1 of ${count}` : undefined,
    tone: 'warn',
    children: [kit.text(card.head, { bold: true, wrap: 'wrap' }), kit.text(card.why, { color: TONES.muted.fg, wrap: 'wrap' }), requestButtons(kit, r)],
  })
}

/** The Gates pane's card of every waiting request, newest first, each with its answers. */
function requestsCardOf(kit: Kit, list: readonly LkGateRequest[]): unknown {
  if (list.length === 0) return null
  return kit.card({
    tone: 'warn',
    children: [
      kit.header('Waiting for you', String(list.length)),
      ...list
        .slice()
        .reverse()
        .map(r => {
          const card = requestCard(r)
          return kit.stack([
            kit.text(card.head, { bold: true, wrap: 'wrap' }),
            kit.text(`${card.title.replace(/^loopkeeper · /, '')} · ${card.why}`, { color: TONES.muted.fg, wrap: 'wrap' }),
            requestButtons(kit, r),
          ])
        }),
    ],
  })
}

/**
 * The pane: the nav bar, a hero (shield, GATES, on or off and the files this turn, where the limit comes from),
 * tiles, then cards for the rules, the protected paths, this turn's files and the decisions. Long values wrap; only
 * the labels beside them keep their width.
 */
function gatesPane(kit: Kit, ui: Elements, nav: unknown, v: GatesView, buttons: unknown, waiting: unknown = null): unknown {
  const quiet = TONES.muted.fg
  const box = (props: Record<string, unknown>, children: unknown[]): unknown =>
    ui.Box({ ...props, children: children.filter(c => c !== null && c !== undefined && c !== '') })
  const keep = (child: unknown): unknown => box({ flexShrink: 0 }, [child])
  // `center` lines the right side up with the middle of the row: rows that hold a pill (an Svg chip).
  const spread = (key: string, left: unknown[], right: unknown[], center = false): unknown => {
    const align = center ? { alignItems: 'center' } : {}
    return box({ key, flexDirection: 'row', justifyContent: 'space-between', columnGap: 1, ...align }, [
      box({ flexDirection: 'column', flexShrink: 1 }, left),
      box({ flexDirection: 'row', flexShrink: 0, columnGap: 1, ...align }, right),
    ])
  }
  const none = (s: string) => kit.text(s, { color: quiet, wrap: 'wrap' })
  const enforced = v.state === 'on'

  const hero = kit.card({
    children: [
      box({ flexDirection: 'row', columnGap: 1 }, [
        keep(kit.icon('shield', enforced ? 'ok' : 'danger')),
        box({ flexDirection: 'column', flexShrink: 1 }, [
          kit.text('GATES', { bold: true, color: enforced ? TONES.ok.fg : TONES.danger.fg, wrap: 'truncate' }),
          kit.text(v.title, { bold: true, wrap: 'wrap' }),
          kit.text(v.sub, { color: quiet, wrap: 'wrap' }),
        ]),
      ]),
    ],
  })

  const rules = kit.card({
    children: [
      kit.header('Rules', 'source'),
      ...v.rules.map(r =>
        spread(
          `rule-${r.key}`,
          r.values.length === 1
            ? [ui.Text({ wrap: 'wrap', children: [`${r.key}: `, kit.text(r.values[0], { bold: true })] })]
            : [kit.text(`${r.key}:`, { wrap: 'wrap' }), ...r.values.map(x => kit.text(`  ${x}`, { bold: true, wrap: 'wrap' }))],
          [kit.text(r.source, { color: quiet })],
        ),
      ),
      kit.text(`Config files: ${v.configFiles.length > 0 ? v.configFiles.join(' · ') : 'none (defaults)'}`, { color: quiet, wrap: 'wrap' }),
      ...v.errors.map(x => kit.text(`Ignored: ${x}`, { color: TONES.danger.fg, wrap: 'wrap' })),
    ],
  })

  const guarded = kit.card({
    children: [
      kit.header('Protected paths', String(v.protected.length)),
      ...(v.protected.length > 0
        ? v.protected.map(p =>
            spread(`protected-${p.glob}`, [kit.text(p.glob, { wrap: 'wrap' })], [
              kit.pill(p.action, p.action === 'deny' ? 'danger' : 'warn'),
              kit.text(p.source, { color: quiet }),
            ], true),
          )
        : [none('none')]),
    ],
  })

  const n = v.turn.length
  const turn = kit.card({
    children: [
      kit.header('This turn', `${n} file${n === 1 ? '' : 's'}`),
      ...(n > 0
        ? v.turn.map((f, i) =>
            box({ key: `turn-${i}`, flexDirection: 'row', columnGap: 1 }, [
              keep(kit.typeBadge(f.name) ?? kit.icon('file')),
              box({ flexShrink: 1 }, [
                ui.Text({
                  wrap: 'wrap',
                  children: [kit.text(f.name, { bold: true }), f.folder ? kit.text(`  ${f.folder}`, { color: quiet }) : ''].filter(Boolean),
                }),
              ]),
            ]),
          )
        : [none('no files yet')]),
    ],
  })

  const decisions = kit.card({
    children: [
      kit.header('Decisions', v.log.length > 0 ? `${v.log.length} · newest first` : ''),
      ...(v.log.length > 0
        ? v.log.map((r, i) =>
            box({ key: `decision-${i}`, flexDirection: 'row', alignItems: 'center', columnGap: 1 }, [
              keep(kit.text(r.time, { color: quiet })),
              keep(kit.pill(r.outcome, OUTCOME_TONE[r.outcome])),
              box({ flexShrink: 1 }, [ui.Text({ wrap: 'wrap', children: [kit.text(r.target, { bold: true }), ` · ${r.detail}`] })]),
            ]),
          )
        : [none('none yet')]),
    ],
  })

  return kit.page([nav, hero, waiting, kit.tiles(v.tiles), rules, guarded, turn, decisions, buttons].filter(c => c !== null && c !== undefined))
}

// ---- /lk gates …, and the shared /lk words ---------------------------------------------------------------------

async function setGatesBand($: EngineInterface, shown: boolean): Promise<boolean> {
  await update($, gateBand, () => shown)
  try {
    await $.store.set(BAND_KEY, shown)
    return true
  } catch {
    return false
  }
}

/**
 * /lk gates allow <path>: the user's yes for a protected path whose rule is ask, for the rest of the session (as Allow
 * for session is in the terminal). The path resolves against the project root, as decideEdit places it; a deny rule
 * cannot be granted. Alone, it lists the session's grants.
 */
async function allowPath($: EngineInterface, raw: string, fromPerson: boolean): Promise<{ text: string }> {
  await hydrate($)
  const usage = `usage: ${GATES_CMD} allow <path>`
  if (raw === '') {
    const grants = await read($, gateGrants)
    const globs = await read($, gateGlobGrants)
    const all = [...grants, ...globs.map(g => `all of ${g}`)]
    return { text: all.length > 0 ? `Protected paths allowed for this session: ${all.join(', ')}. ${usage}` : `No protected path is allowed for this session. ${usage}` }
  }
  if (!fromPerson) return { text: 'Only the user can allow a protected path.' }
  const config = await ensureConfig($)
  const root = await projectRoot($)
  const p = normalizePath(raw, root)
  const rule = matchProtected(config.protected, p)
  if (rule?.action === 'deny') return { text: `${p} matches rule "${rule.glob}": deny. A deny rule cannot be granted; change the rule to edit it.` }
  // added to what is there: a grant the stage wrote (a card's answer) is kept
  await update($, gateGrants, list => (list.includes(p) ? list : [...list, p]))
  await record($, { rule: 'protected', target: p, outcome: 'allowed', detail: `granted by ${GATES_CMD} allow` })
  await dropGateRequests($, r => r.kind === 'protected' && r.target === p)
  await answered($, `The user allowed ${p} for this session. ${RUN_AGAIN}`)
  return { text: rule ? `${p} is allowed for this session (rule "${rule.glob}": ask).` : `${p} is allowed for this session; no protected rule matches it now.` }
}

/** The person's answer through /lk gates: the stage's /lk handler reads it after the chain and carries on (ADR 0012). */
async function answered($: EngineInterface, text: string): Promise<void> {
  try {
    await update($, gateAnswered, a => ({ seq: a.seq + 1, text }))
  } catch {
    // the answer stands; the user types the next prompt
  }
}

/**
 * /lk gates <words>: the answer, or null for a word another concern owns (`files`, the Files pane's). `fromPerson`:
 * the run came from the person (no origin, or composer, bridge or sdk); only they open shipping, allow a merge or
 * grant a protected path.
 */
async function gatesCommand($: EngineInterface, rest: string[], fromPerson: boolean): Promise<{ text?: string } | null> {
  const verb = (rest[0] ?? '').toLowerCase()
  const value = (rest[1] ?? '').toLowerCase()
  const toggle = (rest[2] ?? '').toLowerCase()

  if (verb === '') {
    await $.ui.open({ id: PANE_ID, title: 'Gates', focus: true, closeOnEscape: true })
    return { text: await statusLine($) }
  }
  if (verb === 'files') return null
  if (verb === 'text') return { text: (await statusLines($)).join('\n') }
  // the words that loosen a gate are the user's, as the grants are; those that tighten one may come from anyone
  if (verb === 'off') {
    if (!fromPerson) return { text: 'Only the user can turn the gates off.' }
    await update($, gateEnabled, () => false)
    $.ui.invalidate('prompt.context')
    return { text: `gates off for this session: no rule is enforced. ${GATES_CMD} on to resume.` }
  }
  if (verb === 'on') {
    await update($, gateEnabled, () => true)
    $.ui.invalidate('prompt.context')
    if (await isKilled($)) return { text: `gates on for this session, but CLAUDE_MODS_DISABLE names ${MOD}, so no rule is enforced until it is unset.` }
    return { text: 'gates on: files per turn, protected paths, plan gate, ship gate and merge gate are enforced.' }
  }
  if (verb === 'reload') {
    const c = await loadConfig($)
    const files = await read($, gateConfigFiles)
    const errors = await read($, gateConfigErrors)
    return {
      text: [
        files.length > 0 ? `reloaded ${files.join(', ')}` : 'reloaded: no config files, defaults only',
        ...describeRules(c, await read($, gateSources)),
        ...errors.map(x => `ignored: ${x}`),
      ].join('\n'),
    }
  }
  if (verb === 'max') {
    const n = Number(rest[1])
    if (!Number.isInteger(n) || n < 1 || n > 1000) return { text: `usage: ${GATES_CMD} max <n> (a whole number from 1 to 1000)` }
    if (!fromPerson) return { text: 'Only the user can change the files-per-turn limit.' }
    await setOverride($, { maxFilesPerTurn: n })
    await loadConfig($)
    await dropGateRequests($, r => r.kind === 'files')
    await answered($, `The user set the files-per-turn limit to ${n} for this session. ${RUN_AGAIN}`)
    return { text: `maxFilesPerTurn is ${n} for this session.` }
  }
  if (verb === 'plan') {
    if (value === 'required' && (toggle === 'on' || toggle === 'off')) {
      if (toggle === 'off' && !fromPerson) return { text: 'Only the user can turn requirePlan off.' }
      await setOverride($, { requirePlan: toggle === 'on' })
      await loadConfig($)
      return { text: `requirePlan is ${toggle} for this session${toggle === 'on' ? ': edits wait for an approved plan' : ''}.` }
    }
    if (value === 'paths') {
      const config = await ensureConfig($)
      return { text: planPathsText(config.planPaths, (await read($, gateSources)).planPaths ?? 'default') }
    }
    if (value !== 'ok') return { text: `usage: ${GATES_CMD} plan ok | plan required on|off | plan paths` }
    if (!fromPerson) return { text: 'Only the user can approve the plan.' }
    await update($, gatePlanOk, () => true)
    await answered($, `The user approved the plan for this session: edits may go ahead. ${RUN_AGAIN}`)
    await update($, gatePlanBy, () => `${GATES_CMD} plan ok`)
    $.ui.invalidate('prompt.context')
    // the pipeline's plan gate is a separate approval: say so while it is still pending
    const gate = gatedStage(await stagesNow($), 'validate-plan')
    const pending = gate !== undefined && (await read($, stagePlanDone)) !== true && (await read($, stageCurrent)) !== ''
    const separate = pending && gate
      ? ` The pipeline's ${gate.label} gate is separate: moving past it still needs /lk approve ` +
        "(in approval mode auto, a plan validator's consistent verdict also opens it)."
      : ''
    return { text: 'plan approved for this session: edits may go ahead.' + separate }
  }
  if (verb === 'ship') {
    if (value === 'gate' && (toggle === 'on' || toggle === 'off')) {
      if (toggle === 'off' && !fromPerson) return { text: 'Only the user can turn the ship gate off.' }
      await setOverride($, { shipGate: toggle === 'on' })
      await loadConfig($)
      return { text: `shipGate is ${toggle} for this session.` }
    }
    if (value !== 'ok') return { text: `usage: ${GATES_CMD} ship ok | ship gate on|off` }
    if (!fromPerson) return { text: 'Only the user can approve shipping.' }
    await $.store.set(await sessionKey($, 'shipOk'), true)
    await update($, gateShipOk, () => true)
    // the no-pipeline form of the Ship approval: it covers the next push or merge to the default branch too
    await update($, gateMergeCredit, () => true)
    await dropGateRequests($, r => r.kind === 'ship' || r.kind === 'merge')
    await answered($, `The user opened shipping for this session, and the next push or merge to the default branch. ${RUN_AGAIN}`)
    return { text: 'shipping approved for this session: commits, pushes and publishes may go ahead, and the next push or merge to the default branch is covered.' }
  }
  if (verb === 'merge') {
    if (value !== 'ok') return { text: `usage: ${GATES_CMD} merge ok` }
    if (!fromPerson) return { text: 'Only the user can allow a push or merge to the default branch.' }
    await update($, gateMergeCredit, () => true)
    await dropGateRequests($, r => r.kind === 'merge')
    await answered($, `The user allowed the next push or merge to the default branch. ${RUN_AGAIN}`)
    return { text: 'The next push or merge to the default branch is allowed (once).' }
  }
  if (verb === 'allow') return allowPath($, rest.slice(1).join(' ').trim(), fromPerson)
  if (verb === 'band') {
    if (value !== 'on' && value !== 'off') return { text: `usage: ${GATES_CMD} band on|off` }
    const saved = await setGatesBand($, value === 'on')
    return { text: `gates band ${value}${saved ? ' (saved for future sessions)' : ' (this session only)'}.` }
  }
  return { text: USAGE }
}

/** `/lk band [concerns] on|off`: the gates line, or '' when the words name other concerns only. */
async function gatesBandLine($: EngineInterface, rest: string[]): Promise<string> {
  const words = rest.map(w => w.toLowerCase())
  const named = words.filter(w => CONCERN_WORDS.includes(w))
  if (named.length > 0 && !named.includes('gates')) return ''
  const word = words.find(w => w === 'on' || w === 'off')
  if (!word) {
    const shown = await read($, gateBand)
    return `The gates band is ${shown ? 'on' : 'off'}. Usage: /lk band [gates] on|off`
  }
  const saved = await setGatesBand($, word === 'on')
  return `The gates band is ${word}.${saved ? '' : ' (this session only)'}`
}

async function reloadShared($: EngineInterface): Promise<string> {
  await loadConfig($)
  const files = await read($, gateConfigFiles)
  const errors = await read($, gateConfigErrors)
  return joinText(
    files.length > 0 ? `gates: reloaded ${files.join(', ')}` : 'gates: reloaded, no config files, defaults only',
    ...errors.map(x => `gates: ignored: ${x}`),
  )
}

/** GSD mode's part in the gates: plan required on while GSD mode and its loop are on, off when either goes. */
async function gsdPlan($: EngineInterface, active: boolean): Promise<string> {
  await setOverride($, { requirePlan: active })
  await loadConfig($)
  return `gates: plan required ${active ? 'on' : 'off'} (GSD loop)`
}

/** At session start: a session that starts with GSD mode and its loop on requires a plan, as /lk on would have set. */
async function matchGsd($: EngineInterface): Promise<void> {
  if (!(await read($, routeMode)) || !(await read($, routeLoop))) return
  if ((await readOverride($))?.requirePlan === true) return
  await gsdPlan($, true)
}

// The gates' line for a /lk word other concerns also answer (status, text, reload, band, on, off, loop)
async function gatesSharedLine($: EngineInterface, sub: string, rest: string[], was: unknown): Promise<string> {
  if (sub === 'status') {
    const status = await statusLine($)
    return status
  }
  if (sub === 'text') {
    const status = await statusLine($)
    const lines = await statusLines($)
    return joinText(status, ...lines.slice(1))
  }
  if (sub === 'reload') {
    const reloaded = await reloadShared($)
    return reloaded
  }
  if (sub === 'band') {
    const band = await gatesBandLine($, rest)
    return band
  }
  if (sub === 'on' || sub === 'off') {
    const loopOn = await read($, routeLoop)
    if (was === (sub === 'on') || !loopOn) return ''
    const plan = await gsdPlan($, sub === 'on')
    return plan
  }
  const word = (rest[0] ?? '').toLowerCase()
  if (word !== 'on' && word !== 'off') return ''
  const modeOn = await read($, routeMode)
  if (!modeOn) return ''
  const plan = await gsdPlan($, word === 'on')
  return plan
}

async function lk($: EngineInterface, e: { args?: unknown; origin?: unknown }, next: LkNext): Promise<{ text?: string } | undefined> {
  const args = typeof e?.args === 'string' ? e.args : ''
  // as the stage's lk() reads it: only the person opens shipping, allows a merge or grants a protected path
  const origin = e?.origin as { kind?: unknown } | undefined
  const fromPerson = !origin || origin.kind === 'composer' || origin.kind === 'bridge' || origin.kind === 'sdk'
  const { sub, rest } = subOf(args)
  // Words other concerns also answer: the gates add their line to theirs. /lk text: routing owns the word and answers
  // last; the gates' one-liner and their details go after the stage's. The mode is read before the chain runs, as
  // gsd-orchestrator did: only a change of the mode sets plan required, and only while the loop is on.
  if (sub === 'status' || sub === 'text' || sub === 'reload' || sub === 'band' || sub === 'on' || sub === 'off' || sub === 'loop') {
    const was = await read($, routeMode)
    const r = await next(e)
    let line = ''
    try {
      line = await gatesSharedLine($, sub, rest, was)
    } catch {
      line = `${MOD}: the gates could not answer "${sub}".`
    }
    return { ...(r ?? {}), text: joinText(line, r?.text) }
  }
  if (sub === 'gates') {
    const own = await gatesCommand($, rest, fromPerson)
    return own === null ? next(e) : own
  }
  return next(e)
}

async function lkFailed($: EngineInterface, e: unknown, next: any): Promise<{ text?: string }> {
  const r = next.called ? ((await next(e)) as { text?: string } | undefined) : undefined
  const why = `${next.error?.kind ?? 'throw'}: ${String(next.error?.message ?? '').slice(0, 120)}`
  return { ...(r ?? {}), text: joinText(`${MOD}: the gates command failed (${why}).`, r?.text) }
}

// ---- The band's model, the hub row and the nav bar ---------------------------------------------------------------

/** The band line's chips and right side, from the state now (the band and the hub row draw the same words). */
async function bandNow($: EngineInterface): Promise<ReturnType<typeof bandModel>> {
  const config = (await read($, gateConfig)) ?? mergeLayers([]).config
  const lim = await limitNow($, config)
  return bandModel({
    enabled: await read($, gateEnabled),
    disabled: await read($, gateDisabled),
    count: (await read($, gateTurnFiles)).length,
    max: lim.limit + (await read($, gateTurnExtra)),
    unlimited: await read($, gateTurnUnlimited),
    requirePlan: config.requirePlan,
    planOk: (await read($, gatePlanOk)) || (await read($, stagePlanDone)) === true,
    mergeGate: config.mergeGate,
    fired: await read($, gateTurnFired),
    shipGate: config.shipGate,
    shipHeld: !(await read($, gateShipOk)) && (await read($, stageShipOpen)) !== true,
    source: lim.source,
    limit: lim.limit,
  })
}

/** The hub row's words: the band line without its label (`on · 0/10 files · ship open`), and `band off` when hidden. */
async function hubWords($: EngineInterface): Promise<string> {
  const model = await bandNow($)
  const off = (await read($, gateDisabled)) || !(await read($, gateEnabled))
  const words = [...(off ? [] : ['on']), ...model.chips.map(c => c.text), ...(model.right ? [model.right] : [])]
  if (!(await read($, gateBand))) words.push('band off')
  return words.join(' · ')
}

// HUB_ID, HUB_ROWS and PANES (every loopkeeper pane in wiring order) come from lib/panes.ts.

function toast($: EngineInterface, text: string): void {
  try {
    const p = $.ui.toast(text) as unknown
    if (p && typeof (p as Promise<unknown>).catch === 'function') (p as Promise<unknown>).catch(() => undefined)
  } catch {
    // display only
  }
}

// the "ctrl+x tab to focus the panel" toast showed this session (stage.ts's atom, shared by all six concern files)
const stageFocusHinted = atom({ plugin: 'loopkeeper', key: 'stageFocusHinted' } as const, false)

// Switch panes: close `fromId` first ('' closes nothing), since a focus request is refused while the person holds a
// pane, then open `toId` with the focus. The composer keeps the focus while it holds a draft: then a toast says how to
// reach the pane, once a session and only in the terminal (the press's `surface`; with no press, a session whose every
// surface is the terminal). False when the pane could not be opened.
async function switchTo($: EngineInterface, fromId: string, toId: string, title: string, surface?: unknown): Promise<boolean> {
  if (fromId) {
    try {
      await $.ui.close({ id: fromId })
    } catch {
      // already closed
    }
  }
  try {
    await $.ui.open({ id: toId, title, focus: true, closeOnEscape: true, ...(toId === HUB_ID ? { rows: HUB_ROWS } : {}) })
  } catch {
    return false
  }
  try {
    const pane = (await $.ui.panes()).find(p => p.id === toId)
    if (pane && !pane.isFocused && !(await read($, stageFocusHinted))) {
      const terminal = typeof surface === 'string' ? surface === 'terminal' : (await $.session.surfaces()).every(s => s === 'terminal')
      if (terminal) {
        await update($, stageFocusHinted, () => true)
        toast($, 'ctrl+x tab to focus the panel')
      }
    }
  } catch {
    // no list: no hint
  }
  return true
}

// The nav bar's items: every loopkeeper pane, a press switching from `fromId` to it
function navItems($: EngineInterface, fromId: string) {
  return PANES.map(p => ({
    key: p.key,
    label: p.label,
    hotkey: p.hotkey,
    onPress: async (e?: { surface?: unknown }) => {
      if (!(await switchTo($, fromId, p.id, p.title, e?.surface))) toast($, 'Could not open the ' + p.label + ' pane.')
    },
  }))
}

// ---- Wiring ----------------------------------------------------------------------------------------------------

export function wireGates(on: On): void {
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    try {
      const off = await isKilled($)
      await update($, gateDisabled, () => off)
      await hydrate($)
      await loadConfig($)
      const saved: unknown = await $.store.get(BAND_KEY).catch(() => undefined)
      await update($, gateBand, () => saved !== false)
    } catch {
      // Loaded again lazily on the first guarded call.
    }
    const r = await next(e)
    // Read after the other concerns' session start, so routing has loaded its stored switches.
    try {
      await matchGsd($)
    } catch {
      // The plan requirement stays as the config says.
    }
    return r
  })

  // /clear, /resume and /branch reset $.state and start a new conversation: start over.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try {
      mem = fresh()
      hydrated = true
      await persistTurn($)
      await persistSession($)
      await loadConfig($)
    } catch {
      // Loaded again lazily.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', {}, async ($, e, next) => {
    const r = await next(e)
    const agent = (e as unknown as { agentId?: unknown }).agentId
    if (typeof agent === 'string' && agent !== '') return r
    try {
      await hydrate($)
      mem.turnId = typeof e.turnId === 'string' ? e.turnId : ''
      mem.turnFiles = new Set()
      mem.turnExtra = 0
      mem.turnUnlimited = false
      mem.turnFired = false
      await persistTurn($)
      await startRequestTurn($)
    } catch {
      // The count starts over on the next turn.
    }
    return r
  })

  // A plan Claude presented through ExitPlanMode and the user accepted satisfies the plan gate. The stage moves on
  // from the same call in its own tool.call hook; this only records the gates' own approval.
  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const r = await next(e)
    const res = (r ?? {}) as unknown as { deny?: unknown; isError?: unknown }
    if (res.deny === undefined && res.isError !== true) {
      try {
        await update($, gatePlanOk, () => true)
        await update($, gatePlanBy, () => 'ExitPlanMode')
        $.ui.invalidate('prompt.context')
      } catch {
        // The plan tool's own result stands; the gate stays closed until /lk gates plan ok.
      }
    }
    return r
  }).catch(($, e, next) => next(e))

  on('tool.check', { tool: EDIT_TOOLS }, async ($, e, next) => {
    if (e.tool_use_id === undefined || (await isKilled($)) || !(await read($, gateEnabled))) return next(e)
    const path = editPath(e.input)
    if (path === undefined) return next(e)
    // The rules beneath answer first: a call they deny is neither asked about nor counted.
    const below = await $.tool.check({ tool: e.tool, input: e.input })
    if (below.decision === 'deny') return next(e)
    // Failing closed inside the hook too: the stage's guard above reads a plain deny, not a failed frame.
    let why: string | null = null
    try {
      why = await decideEdit($, [path], e.tool, e.agentId)
    } catch (err) {
      return { decision: 'deny', reason: refusedReason(err) }
    }
    if (why !== null) return { decision: 'deny', reason: why }
    return next(e)
  }).catch(($, e, next) => {
    const error = next.error
    return { decision: 'deny', reason: failClosedReason(error?.kind ?? 'throw', String(error?.message ?? '')) }
  })

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const command = (typeof e.input === 'object' && e.input !== null ? (e.input as Record<string, unknown>) : {}).command
    if (e.tool_use_id === undefined || typeof command !== 'string' || (await isKilled($)) || !(await read($, gateEnabled))) return next(e)
    const below = await $.tool.check({ tool: e.tool, input: e.input })
    if (below.decision === 'deny') return next(e)
    let why: string | null = null
    try {
      why = await decideBash($, command, e.agentId)
    } catch (err) {
      return { decision: 'deny', reason: refusedReason(err) }
    }
    if (why !== null) return { decision: 'deny', reason: why }
    return next(e)
  }).catch(($, e, next) => {
    const error = next.error
    return { decision: 'deny', reason: failClosedReason(error?.kind ?? 'throw', String(error?.message ?? '')) }
  })

  // The rules block: what the gates enforce this session, with the limit in force.
  on('prompt.context', {}, async ($, e, next) => {
    const below = await next(e)
    try {
      if (await isKilled($)) return below
      const others = below.blocks.filter(b => b.name !== CONTEXT_BLOCK)
      if (!(await read($, gateEnabled))) return { ...below, blocks: others }
      const config = await ensureConfig($)
      const lim = await limitNow($, config)
      return { ...below, blocks: [...others, { name: CONTEXT_BLOCK, text: contextText(config, lim.limit) }] }
    } catch {
      return below
    }
  })

  on('command.run', { command: 'lk' }, async ($, e, next) => lk($, e, next)).catch(($, e, next) => lkFailed($, e, next))
  on('command.run', { command: 'loopkeeper' }, async ($, e, next) => lk($, e, next)).catch(($, e, next) => lkFailed($, e, next))

  // The band, one kit line: `gates  ● 3/10 files  ● plan ok  ● merge gate  ● ship held   budget 23`. Under it, the
  // newest request's card, drawn with the band off too; its presses are the stage's (a ui.press hook in stage.ts).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const props = (e.props ?? {}) as { hasSurvey?: boolean }
    if (props.hasSurvey === true) return next(e)
    const shown = await read($, gateBand)
    const requests = await read($, gateRequests)
    const newest = requests[requests.length - 1]
    if (!shown && !newest) return next(e)
    const { Box } = $.ui.resolve(e)
    const kit = makeKit($.ui.resolve(e) as unknown as Elements, e.surface)
    const parts: unknown[] = []
    if (shown) {
      const model = await bandNow($)
      parts.push(kit.line('gates', model.chips, model.right))
    }
    if (newest) parts.push(requestCardOf(kit, newest, requests.length))
    const theirs = await next(e)
    const all = theirs === null || theirs === undefined ? parts : [...parts, theirs]
    if (all.length === 1) return all[0] as ReturnType<typeof Box>
    return Box({ flexDirection: 'column', children: all as ReturnType<typeof Box>[] })
  })

  // The hub's Gates row, above the later concerns' rows (next): `2: Gates` and the band's words, quiet. It shows
  // with the band off or the kill switch on; a failure draws what the chain drew.
  on('ui.render', { component: 'Pane', requestId: HUB_ID }, async ($, e, next) => {
    let asked = false
    let theirs: unknown = null
    try {
      const ui = $.ui.resolve(e) as unknown as Elements
      const kit = makeKit(ui, e.surface)
      const row = kit.row({
        key: 'hub-gates',
        left: [
          ui.Button({
            key: 'panel-gates',
            label: 'Gates',
            hotkey: '2',
            plain: true,
            onPress: async (press?: { surface?: unknown }) => {
              if (!(await switchTo($, HUB_ID, PANE_ID, 'Gates', press?.surface))) toast($, 'Could not open the Gates pane.')
            },
          }),
          kit.text(await hubWords($), { color: TONES.muted.fg, wrap: 'truncate' }),
        ],
      })
      asked = true
      theirs = await next(e)
      return (theirs === null || theirs === undefined ? row : kit.stack([row, theirs])) as never
    } catch {
      return (asked ? theirs : await next(e)) as never
    }
  })

  // The status pane (/lk gates): the nav bar, then gatesView drawn with the kit (gatesPane), Reset turn and Close.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const ui = $.ui.resolve(e) as unknown as Elements
    const kit = makeKit(ui, e.surface)
    return gatesPane(
      kit,
      ui,
      kit.nav(navItems($, PANE_ID), 'gates'),
      await gatesView($),
      kit.buttons([
        {
          key: 'gates-reset',
          label: 'Reset turn',
          hotkey: 'r',
          plain: true,
          onPress: async () => {
            mem.turnFiles = new Set()
            mem.turnExtra = 0
            mem.turnUnlimited = false
            mem.turnFired = false
            await persistTurn($)
          },
        },
        {
          key: 'gates-close',
          label: 'Close',
          hotkey: 'c',
          plain: true,
          onPress: async () => {
            await $.ui.close({ id: PANE_ID })
          },
        },
      ]),
      requestsCardOf(kit, liveRequests(await read($, gateRequests), await read($, gateTurnSeq))),
    ) as never
  })
}
