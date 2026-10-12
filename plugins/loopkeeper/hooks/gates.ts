// Gates concern, ported from change-control's register.ts. The rules that hold Claude's hand at the tool call:
//
//   1. Bounded blast radius: a files-per-turn limit per main-loop turn. The limit is the `/lk gates max <n>` session
//      override when set, otherwise the largest of the base (changeControl.maxFilesPerTurn), the approved plan's file
//      budget (stageBudget, written by the stage) and the session raise ("Raise to N for this session").
//   2. Protected paths: globs that are denied, or asked about once per path per session.
//   3. A plan before edits (requirePlan): the stage's stagePlanDone, ExitPlanMode, or `/lk gates plan ok`. Plan
//      material (the scratchpad under /tmp/claude-*, and changeControl.planPaths) is exempt from this gate and rule 1.
//   4. A ship gate: commits, pushes, PRs, releases and publishes wait for the stage's stageShipOpen or
//      `/lk gates ship ok` (ADR 0004: the stage is always there, so there is no one-question fallback).
//   5. A merge gate: merges and pushes to the default branch wait for green CI and a yes; `git commit --amend` on
//      shared branches and (opt-in) `git add -A` / `git add .` are refused.
//
// Every verdict is given at tool.check, after the settings rules and the hooks beneath, so a call they already refuse
// is never asked about twice. A hook that throws fails closed. CLAUDE_MODS_DISABLE=loopkeeper (or all) turns the gates
// off; the band says so and /lk gates still answers.
//
// The Files pane lives in files.ts. The seam: Bash writes that pass the gates are recorded here into filesTouched and
// filesActivity.last (the atoms the pane reads), because only the gates parse Bash for the files it writes.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import {
  bandModel,
  bashTargets,
  checkLayer,
  contextText,
  describeRules,
  editPath,
  failClosedReason,
  filesOptions,
  gitActions,
  GATES_CMD,
  isPlanMaterial,
  limitOf,
  limitSource,
  matchProtected,
  mergeHitsDefault,
  mergeLayers,
  MOD,
  normalizePath,
  noteBashWrites,
  parsePorcelain,
  planPathsText,
  PROJECT_LABEL,
  pushHitsDefault,
  raiseTo,
  sectionLayer,
  shipCommands,
  summarizeChecks,
  USAGE,
  USER_LABEL,
} from './lib/gateRules.ts'
import type { GitAction, Layer } from './lib/gateRules.ts'
import { TONES, makeKit, shortPath } from './lib/kit.ts'
import type { Elements, Kit, Tone } from './lib/kit.ts'
import { joinText, projectConfigPath, storeKey, subOf, userConfigPath } from './lib/names.ts'
import { HUB_ID, HUB_ROWS, PANES } from './lib/panes.ts'
import { bare, cdTargets, prNumber, resolveDir } from './lib/shell.ts'
import { DEFAULT_STAGES, killSwitchOn, stageForRole } from './lib/stageModel.ts'
import type { Stage } from './lib/stageModel.ts'
import type { LkFilesLive, LkGateConfig, LkGateLogRow, LkTouchEntry } from '../types/index.d.ts'

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
// Declared by stage.ts too, with the same defaults: one value (ADR 0004).
const stageCurrent = atom({ plugin: 'loopkeeper', key: 'stageCurrent' } as const, 'plan')
const stagePlanDone = atom({ plugin: 'loopkeeper', key: 'stagePlanDone' } as const, false)
const stageShipOpen = atom({ plugin: 'loopkeeper', key: 'stageShipOpen' } as const, true)
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
// Decisions read and change these synchronously; every change is mirrored to $.state.

type Mem = {
  turnId: string
  turnFiles: Set<string>
  turnExtra: number
  turnUnlimited: boolean
  turnFired: boolean
  sessionFiles: Set<string>
  grants: Set<string>
  aborting: string
}

const fresh = (): Mem => ({
  turnId: '',
  turnFiles: new Set(),
  turnExtra: 0,
  turnUnlimited: false,
  turnFired: false,
  sessionFiles: new Set(),
  grants: new Set(),
  aborting: '',
})

let mem: Mem = fresh()
let hydrated = false
let killed: boolean | null = null

type CheckResult = { decision: 'allow' | 'ask' | 'deny'; reason?: string; rule?: string }
type LkNext = (e: any) => Promise<{ text?: string } | undefined>

// ---- Fail closed, and the kill switch (both borrowed from scope-guard) ---------------------------------------

async function failClosed($: EngineInterface, e: unknown, next: { error?: { kind?: string; message?: string } }): Promise<CheckResult> {
  return { decision: 'deny', reason: failClosedReason(next.error?.kind ?? 'throw', String(next.error?.message ?? '')) }
}

/** The same refusal for an error caught inside a gating hook. */
function refused(err: unknown): CheckResult {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  return { decision: 'deny', reason: failClosedReason('throw', text) }
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

/** The files-per-turn limit before this turn's extras; a session override (`/lk gates max`) wins over the rest. */
async function limitNow($: EngineInterface, config: LkGateConfig): Promise<Limit> {
  const sources = await read($, gateSources)
  const parts = {
    max: sources.maxFilesPerTurn === 'session' ? config.maxFilesPerTurn : null,
    base: config.maxFilesPerTurn,
    budget: await read($, stageBudget),
    raise: await read($, gateSessionRaise),
  }
  return { limit: limitOf(parts), source: limitSource(parts), base: parts.base, budget: parts.budget, raise: parts.raise, slack: config.planSlack }
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
    grants: new Set(await read($, gateGrants)),
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

async function persistSession($: EngineInterface): Promise<void> {
  await update($, gateSessionFiles, () => [...mem.sessionFiles])
  await update($, gateGrants, () => [...mem.grants])
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

async function isInteractive($: EngineInterface): Promise<boolean> {
  try {
    return (await $.session.surfaces()).length > 0
  } catch {
    return false
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

async function decideEdit($: EngineInterface, below: CheckResult, paths: string[], tool: string, agentId?: unknown): Promise<CheckResult> {
  if (paths.length === 0) return below
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
    return {
      decision: 'deny',
      reason:
        `${MOD}: edits are refused until a plan is approved in this session (requirePlan is on). ` +
        'Do not try another tool to make this change. Present a short plan (Goal, Steps, Done-when, and the files you will touch)' +
        how,
    }
  }

  // 2. Protected paths
  for (const p of rel) {
    const rule = matchProtected(config.protected, p)
    if (!rule) continue
    if (rule.action === 'deny') {
      await fire($, { rule: 'protected', target: p, outcome: 'denied', detail: `matches ${rule.glob} (deny)` })
      return {
        decision: 'deny',
        reason: `${MOD}: ${p} is a protected path (rule "${rule.glob}": deny). Do not edit it or reach it another way. Ask the user to make this change themselves or to change the rule.`,
      }
    }
    if (mem.grants.has(p)) continue
    const answer = await ask($, `${MOD}: ${p} is protected (rule "${rule.glob}"). Allow this ${tool} edit?`, ASK_PROTECTED)
    mem.turnFired = true
    if (answer === 'Allow for session') {
      mem.grants.add(p)
      await update($, gateGrants, () => [...mem.grants])
      await record($, { rule: 'protected', target: p, outcome: 'allowed', detail: `${rule.glob}: allowed for session` })
      continue
    }
    if (answer === 'Allow once') {
      await record($, { rule: 'protected', target: p, outcome: 'allowed', detail: `${rule.glob}: allowed once` })
      continue
    }
    const why = answer === null ? 'nobody could be asked or the question was dismissed' : 'the user chose Deny'
    await fire($, { rule: 'protected', target: p, outcome: 'denied', detail: `${rule.glob}: ${why}` })
    return {
      decision: 'deny',
      reason: `${MOD}: the edit to protected path ${p} (rule "${rule.glob}") was refused: ${why}. Do not work around it; ask the user how to proceed.`,
    }
  }

  if (planExempt) await record($, { rule: 'plan', target: rel.join(', '), outcome: 'allowed', detail: 'plan material' })

  // 3. Files per turn. A subagent's edits are not counted unless countSubagents is on (orchestrated builders write
  // many files in one main turn); rules 1 and 2 still applied. Plan material never counts.
  if (work.length === 0 || (typeof agentId === 'string' && agentId !== '' && !config.countSubagents)) {
    for (const p of rel) mem.sessionFiles.add(p)
    await update($, gateSessionFiles, () => [...mem.sessionFiles])
    return below
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
    const interactive = await isInteractive($)
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
    } else {
      const why = !interactive ? 'no one to ask (non-interactive session)' : answer === 'Stop' ? 'the user chose Stop' : 'the question was dismissed'
      await fire($, { rule: 'files', target: added.join(', '), outcome: 'denied', detail: `past ${n} files: ${why}` })
      scheduleAbort($)
      return {
        decision: 'deny',
        reason: [
          `${MOD} stopped this edit: this turn already touched ${n} files (${before.join(', ')}) and ${added.join(', ')} would exceed the limit of ${lim.limit} files per turn (${why}).`,
          'Stop editing now. Summarise what changed so far, list the files you still intend to touch and why, and ask the user before continuing.',
        ].join('\n'),
      }
    }
  }
  for (const p of added) mem.turnFiles.add(p)
  for (const p of rel) mem.sessionFiles.add(p)
  await persistTurn($)
  await update($, gateSessionFiles, () => [...mem.sessionFiles])
  return below
}

// ---- Bash: the ship gate ---------------------------------------------------------------------------------------

async function shipOk($: EngineInterface): Promise<boolean> {
  if (await read($, gateShipOk)) return true
  const saved: unknown = await $.store.get(await sessionKey($, 'shipOk')).catch(() => undefined)
  if (saved !== true) return false
  await update($, gateShipOk, () => true)
  return true
}

/** ADR 0004: shipping waits for the stage's stageShipOpen or /lk gates ship ok; there is no fallback question. */
async function shipGate($: EngineInterface, config: LkGateConfig, shell: string): Promise<CheckResult | null> {
  if (!config.shipGate) return null
  const hits = shipCommands(shell)
  if (hits.length === 0) return null
  const what = hits.join(', ')
  if (await shipOk($)) return null
  if ((await read($, stageShipOpen)) === true) return null
  const stage = await read($, stageCurrent)
  const stages = await stagesNow($)
  const here = stages.find(s => s.id === stage)
  const where = here ? here.label || here.id : stage !== '' ? stage : 'an unknown stage'
  await fire($, { rule: 'ship', target: what, outcome: 'denied', detail: `pipeline at ${where}` })
  // /lk approve opens a gated ship stage from it or the stage before; with none gated, only ship ok opens shipping
  const gate = gatedStage(stages, 'ship')
  const how = gate
    ? `run /lk approve at ${approveFrom(gate)} (it opens the ${gate.label} gate; a waiting file budget comes first), or ${GATES_CMD} ship ok.`
    : `run ${GATES_CMD} ship ok.`
  return {
    decision: 'deny',
    reason: `${MOD}: shipping is gated (${what}). The pipeline is at ${where}. Ask the user to review the work and ${how}`,
  }
}

// ---- Bash: merge gate, amend, add-all --------------------------------------------------------------------------

async function gitGate($: EngineInterface, config: LkGateConfig, actions: GitAction[], shell: string, command: string): Promise<CheckResult | null> {
  if (actions.length === 0) return null
  const dir = await runDir($, command)
  const branches = await gitBranches($, dir)

  for (const a of actions) {
    if (a.kind === 'amend' && config.blockAmend) {
      const shared = branches.defaults.includes(branches.current) || (await headIsPushed($, dir))
      if (shared) {
        await fire($, { rule: 'amend', target: branches.current || '(unknown branch)', outcome: 'denied', detail: 'git commit --amend on a shared branch' })
        return {
          decision: 'deny',
          reason: `${MOD}: \`git commit --amend\` is refused on ${branches.current || 'this branch'}: the commit is already shared (default branch, or already pushed). Make a new commit instead.`,
        }
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
        return {
          decision: 'deny',
          reason: `${MOD}: \`git add ${a.args.join(' ')}\` is refused: it would stage files this session did not touch: ${list}. Stage the files you changed by name.`,
        }
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
        return {
          decision: 'deny',
          reason: `${MOD}: held the merge of PR #${pr}: CI is not green (${parts.join('; ')}). Wait for the checks or fix them, then ask the user before merging.`,
        }
      }
    }
  }

  const answer = await ask($, `Merge now? (${MOD}: ${what})`, ASK_MERGE)
  mem.turnFired = true
  await update($, gateTurnFired, () => true)
  if (answer === 'Merge') {
    await record($, { rule: 'merge', target: what, outcome: 'allowed', detail: 'the user chose Merge' })
    return null
  }
  const why = answer === null ? 'nobody could be asked or the question was dismissed' : 'the user chose Cancel'
  await fire($, { rule: 'merge', target: what, outcome: 'denied', detail: why })
  return {
    decision: 'deny',
    reason: `${MOD}: the ${what} was held: ${why}. Do not retry it another way; ask the user when to merge.`,
  }
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
    `Files per turn: ${lim.limit} (${limitWhy(lim, await read($, stagePlanFiles))})`,
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

/**
 * The pane: the nav bar, a hero (shield, GATES, on or off and the files this turn, where the limit comes from),
 * tiles, then cards for the rules, the protected paths, this turn's files and the decisions. Long values wrap; only
 * the labels beside them keep their width.
 */
function gatesPane(kit: Kit, ui: Elements, nav: unknown, v: GatesView, buttons: unknown): unknown {
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
  const on = v.state === 'on'

  const hero = kit.card({
    children: [
      box({ flexDirection: 'row', columnGap: 1 }, [
        keep(kit.icon('shield', on ? 'ok' : 'danger')),
        box({ flexDirection: 'column', flexShrink: 1 }, [
          kit.text('GATES', { bold: true, color: on ? TONES.ok.fg : TONES.danger.fg, wrap: 'truncate' }),
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

  return kit.page([nav, hero, kit.tiles(v.tiles), rules, guarded, turn, decisions, buttons])
}

// ---- /lk gates …, and the shared /lk words ---------------------------------------------------------------------

async function setBand($: EngineInterface, on: boolean): Promise<boolean> {
  await update($, gateBand, () => on)
  try {
    await $.store.set(BAND_KEY, on)
    return true
  } catch {
    return false
  }
}

/** /lk gates <words>: the answer, or null for a word another concern owns (`files`, the Files pane's). */
async function gatesCommand($: EngineInterface, rest: string[]): Promise<{ text?: string } | null> {
  const verb = (rest[0] ?? '').toLowerCase()
  const value = (rest[1] ?? '').toLowerCase()
  const toggle = (rest[2] ?? '').toLowerCase()

  if (verb === '') {
    await $.ui.open({ id: PANE_ID, title: 'Gates', focus: true, closeOnEscape: true })
    return { text: await statusLine($) }
  }
  if (verb === 'files') return null
  if (verb === 'text') return { text: (await statusLines($)).join('\n') }
  if (verb === 'off') {
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
    await setOverride($, { maxFilesPerTurn: n })
    await loadConfig($)
    return { text: `maxFilesPerTurn is ${n} for this session.` }
  }
  if (verb === 'plan') {
    if (value === 'required' && (toggle === 'on' || toggle === 'off')) {
      await setOverride($, { requirePlan: toggle === 'on' })
      await loadConfig($)
      return { text: `requirePlan is ${toggle} for this session${toggle === 'on' ? ': edits wait for an approved plan' : ''}.` }
    }
    if (value === 'paths') {
      const config = await ensureConfig($)
      return { text: planPathsText(config.planPaths, (await read($, gateSources)).planPaths ?? 'default') }
    }
    if (value !== 'ok') return { text: `usage: ${GATES_CMD} plan ok | plan required on|off | plan paths` }
    await update($, gatePlanOk, () => true)
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
      await setOverride($, { shipGate: toggle === 'on' })
      await loadConfig($)
      return { text: `shipGate is ${toggle} for this session.` }
    }
    if (value !== 'ok') return { text: `usage: ${GATES_CMD} ship ok | ship gate on|off` }
    await $.store.set(await sessionKey($, 'shipOk'), true)
    await update($, gateShipOk, () => true)
    return { text: 'shipping approved for this session: commits, pushes and publishes may go ahead (the merge gate still applies).' }
  }
  if (verb === 'band') {
    if (value !== 'on' && value !== 'off') return { text: `usage: ${GATES_CMD} band on|off` }
    const saved = await setBand($, value === 'on')
    return { text: `gates band ${value}${saved ? ' (saved for future sessions)' : ' (this session only)'}.` }
  }
  return { text: USAGE }
}

/** `/lk band [concerns] on|off`: the gates line, or '' when the words name other concerns only. */
async function bandShared($: EngineInterface, rest: string[]): Promise<string> {
  const words = rest.map(w => w.toLowerCase())
  const named = words.filter(w => CONCERN_WORDS.includes(w))
  if (named.length > 0 && !named.includes('gates')) return ''
  const word = words.find(w => w === 'on' || w === 'off')
  if (!word) return `The gates band is ${(await read($, gateBand)) ? 'on' : 'off'}. Usage: /lk band [gates] on|off`
  const saved = await setBand($, word === 'on')
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
async function gsdPlan($: EngineInterface, on: boolean): Promise<string> {
  await setOverride($, { requirePlan: on })
  await loadConfig($)
  return `gates: plan required ${on ? 'on' : 'off'} (GSD loop)`
}

/** At session start: a session that starts with GSD mode and its loop on requires a plan, as /lk on would have set. */
async function matchGsd($: EngineInterface): Promise<void> {
  if (!(await read($, routeMode)) || !(await read($, routeLoop))) return
  if ((await readOverride($))?.requirePlan === true) return
  await gsdPlan($, true)
}

async function lk($: EngineInterface, e: { args?: unknown }, next: LkNext): Promise<{ text?: string } | undefined> {
  const args = typeof e?.args === 'string' ? e.args : ''
  const { sub, rest } = subOf(args)
  const shared = async (mine: () => Promise<string>) => {
    const r = await next(e)
    let line = ''
    try {
      line = await mine()
    } catch {
      line = `${MOD}: the gates could not answer "${sub}".`
    }
    return { ...(r ?? {}), text: joinText(line, r?.text) }
  }
  if (sub === 'status') return shared(() => statusLine($))
  // /lk text: routing owns the word and answers last; the gates' one-liner and their details go after the stage's
  if (sub === 'text') return shared(async () => joinText(await statusLine($), ...(await statusLines($)).slice(1)))
  if (sub === 'reload') return shared(() => reloadShared($))
  if (sub === 'band') return shared(() => bandShared($, rest))
  if (sub === 'on' || sub === 'off') {
    // as gsd-orchestrator did: only a change of the mode sets plan required, and only while the loop is on
    const was = await read($, routeMode)
    return shared(async () => (was !== (sub === 'on') && (await read($, routeLoop)) ? gsdPlan($, sub === 'on') : ''))
  }
  if (sub === 'loop') {
    const word = (rest[0] ?? '').toLowerCase()
    return shared(async () => ((word === 'on' || word === 'off') && (await read($, routeMode)) ? gsdPlan($, word === 'on') : ''))
  }
  if (sub === 'gates') {
    const own = await gatesCommand($, rest)
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
    if (e.tool_use_id === undefined || (await isKilled($))) return next(e)
    const below = await next(e)
    if (below.decision === 'deny' || !(await read($, gateEnabled))) return below
    const path = editPath(e.input)
    if (path === undefined) return below
    // Failing closed inside the hook too: the stage's guard above reads a plain deny, not a failed frame.
    try {
      return await decideEdit($, below, [path], e.tool, (e as any).agentId)
    } catch (err) {
      return refused(err)
    }
  }).catch(failClosed)

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const command = (typeof e.input === 'object' && e.input !== null ? (e.input as Record<string, unknown>) : {}).command
    if (e.tool_use_id === undefined || typeof command !== 'string' || (await isKilled($))) return next(e)
    const below = await next(e)
    if (below.decision === 'deny' || !(await read($, gateEnabled))) return below
    const config = await ensureConfig($)
    const shell = bare(command)
    const shipped = await shipGate($, config, shell)
    if (shipped !== null) return shipped
    const held = await gitGate($, config, gitActions(shell), shell, command)
    if (held !== null) return held
    // absolute against where the command runs; decideEdit then places them against the project root
    const dir = await runDir($, command)
    const targets = bashTargets(command, dir).map(t => absoluteIn(t, dir))
    const verdict = await decideEdit($, below, targets, 'Bash', (e as any).agentId)
    if (verdict.decision !== 'deny' && targets.length > 0) await recordBashWrites($, targets, dir)
    return verdict
  }).catch(failClosed)

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

  on('command.run', { command: 'lk' }, async ($, e, next) => lk($, e as { args?: unknown }, next as LkNext)).catch(lkFailed)
  on('command.run', { command: 'loopkeeper' }, async ($, e, next) => lk($, e as { args?: unknown }, next as LkNext)).catch(lkFailed)

  // The band, one kit line: `gates  ● 3/10 files  ● plan ok  ● merge gate  ● ship held   budget 23`.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const props = (e.props ?? {}) as { hasSurvey?: boolean }
    if (props.hasSurvey === true || !(await read($, gateBand))) return next(e)
    const model = await bandNow($)
    const { Box } = $.ui.resolve(e)
    const kit = makeKit($.ui.resolve(e) as unknown as Elements, e.surface)
    const mine = kit.line('gates', model.chips, model.right) as ReturnType<typeof Box>
    const theirs = await next(e)
    if (theirs === null || theirs === undefined) return mine
    return Box({ flexDirection: 'column', children: [mine, theirs] })
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
    ) as never
  })
}
