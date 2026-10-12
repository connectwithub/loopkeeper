// Stage concern: the stage machine, ported from pipeline-stage's register.ts onto lib/stageModel.ts.
// Owns the stage words of /lk (a stage id or label, next, back, approve, waive, reset, preset, size, small-max,
// approval, auto, stage, which opens the stepper pane, help, and /lk alone, which opens the hub) and its own line of the
// shared words (status, reload, band, on, off, loop); set_stage; the tool-call heuristics; the growth guard; the hold
// pattern; the 30 s tick; the file budget approved with the plan; the band's first line; the hub's frame and its
// Stage row; and the review_cycle wrapper that records a consistent plan verdict. Every $ call lives in this file; lib/stageModel.ts is pure. Atoms use string literal keys, so another
// concern that declares the same key reads the same value (gates read stagePlanDone, stageShipOpen and stageBudget).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { mergeConfig, parseConfigText } from './lib/config.ts'
import { mergeLayers } from './lib/gateRules.ts'
import { TONES, makeKit } from './lib/kit.ts'
import type { Elements, Tone } from './lib/kit.ts'
import { PLUGIN, TOOL, TOOL_FULL, joinText, projectConfigPath, subOf, userConfigPath } from './lib/names.ts'
import { HUB_ID, HUB_ROWS, PANES } from './lib/panes.ts'
import {
  BAND_KEY,
  CONFIG_LABEL,
  DEFAULT_LIMITS,
  DEFAULT_PLAN_PATHS,
  DEFAULT_STAGES,
  DISABLED_NOTE,
  FILES_CAP,
  SIZE_REMINDER,
  SMALL_MAX_DEFAULT,
  VERIFIER_HINT,
  agentMatches,
  agentText,
  approvalKey,
  approvalLine,
  approvalOf,
  approveAhead,
  autoTarget,
  bandButton,
  budgetFor,
  budgetLine,
  budgetSentence,
  budgetWaitSentence,
  budgetWaits,
  capHistory,
  checkMove,
  chooseStages,
  clock,
  editPath,
  elapsed,
  enteredAt,
  findStage,
  findSubject,
  fitBand,
  gateAhead,
  indexOf,
  isPlanMaterial,
  killSwitchOn,
  labelOf,
  largeReply,
  limitsOf,
  neighbour,
  nextStep,
  normalizePath,
  outgrowMessage,
  outgrows,
  passRecorded,
  pipelineFromLayers,
  planDone,
  planFilesOf,
  planMaterialLine,
  planPassApplies,
  planPassConsistent,
  planPathsOf,
  presetKey,
  presetNames,
  presetStages,
  projectKey,
  roleOf,
  savedOf,
  shipOpen,
  sizeLine,
  smallHeldReply,
  smallMaxOf,
  smallReply,
  stageForRole,
  subjectName,
  validIds,
  verdictLine,
  verdictReply,
  verifiedBy,
  versionNote,
  wantsHold,
} from './lib/stageModel.ts'
import type { Approval, By, Config, Limits, Size, Stage, Transition, Verdict } from './lib/stageModel.ts'
import type { LkGateConfig, LkSubject } from '../types/index.d.ts'

// ---- State: everything a drawing reads lives in $.state, so it survives a hot reload ---------------------------

const stageStages = atom({ plugin: 'loopkeeper', key: 'stageStages' } as const, DEFAULT_STAGES.map(s => ({ ...s })) as Stage[])
const stageCurrent = atom({ plugin: 'loopkeeper', key: 'stageCurrent' } as const, 'plan')
const stageApproved = atom({ plugin: 'loopkeeper', key: 'stageApproved' } as const, [] as string[])
const stageHistory = atom({ plugin: 'loopkeeper', key: 'stageHistory' } as const, [] as Transition[])
const stageAuto = atom({ plugin: 'loopkeeper', key: 'stageAuto' } as const, true)
const stageBand = atom({ plugin: 'loopkeeper', key: 'stageBand' } as const, true)
const stageNow = atom({ plugin: 'loopkeeper', key: 'stageNow' } as const, 0)
const stageCwd = atom({ plugin: 'loopkeeper', key: 'stageCwd' } as const, '')
const stageSource = atom({ plugin: 'loopkeeper', key: 'stageSource' } as const, 'default')
// stage ids whose requiresAgent a completed matching Agent call met since the stage was last entered
const stageVerified = atom({ plugin: 'loopkeeper', key: 'stageVerified' } as const, [] as string[])
const stagePreset = atom({ plugin: 'loopkeeper', key: 'stagePreset' } as const, 'default')
// Read by the gates: written whenever the stage, the stages or the approvals change
const stagePlanDone = atom({ plugin: 'loopkeeper', key: 'stagePlanDone' } as const, false)
const stageShipOpen = atom({ plugin: 'loopkeeper', key: 'stageShipOpen' } as const, true)
const stageSize = atom({ plugin: 'loopkeeper', key: 'stageSize' } as const, '' as Size)
const stageVerdict = atom({ plugin: 'loopkeeper', key: 'stageVerdict' } as const, null as Verdict | null)
const stageApproval = atom({ plugin: 'loopkeeper', key: 'stageApproval' } as const, 'auto' as Approval)
const stageHoldPlan = atom({ plugin: 'loopkeeper', key: 'stageHoldPlan' } as const, false)
// true once a held prompt's task was sized: sizing the next task spends the hold
const stageHoldBound = atom({ plugin: 'loopkeeper', key: 'stageHoldBound' } as const, false)
// a validator that completed in the stage before a requiresAgent stage: that stage's id, and who it was
const stageCarry = atom({ plugin: 'loopkeeper', key: 'stageCarry' } as const, '')
const stageCarryBy = atom({ plugin: 'loopkeeper', key: 'stageCarryBy' } as const, '')
const stageWaived = atom({ plugin: 'loopkeeper', key: 'stageWaived' } as const, [] as string[])
const stageFilesTouched = atom({ plugin: 'loopkeeper', key: 'stageFilesTouched' } as const, [] as string[])
const stageSmallMax = atom({ plugin: 'loopkeeper', key: 'stageSmallMax' } as const, SMALL_MAX_DEFAULT)
// changeControl.planPaths (one plan-material list for all of loopkeeper); the scratchpad always counts
const stagePlanPaths = atom({ plugin: 'loopkeeper', key: 'stagePlanPaths' } as const, [...DEFAULT_PLAN_PATHS] as string[])
// The file budget (ADR 0011): the planned count set_stage gave, and the budget approved with the plan
const stagePlanFiles = atom({ plugin: 'loopkeeper', key: 'stagePlanFiles' } as const, null as number | null)
const stageBudget = atom({ plugin: 'loopkeeper', key: 'stageBudget' } as const, 0)
const stageLimits = atom({ plugin: 'loopkeeper', key: 'stageLimits' } as const, { ...DEFAULT_LIMITS } as Limits)
// ADR 0007 and ADR 0009: what the band says in warning tone
const stageVersionNote = atom({ plugin: 'loopkeeper', key: 'stageVersionNote' } as const, '')
const stageDisabled = atom({ plugin: 'loopkeeper', key: 'stageDisabled' } as const, false)
// ADR 0012: continue after approval. The config switch, whether a main turn runs, the approval a running turn
// holds back until it completes, whether a continue prompt is sent or on its way (until the next main turn.start),
// and whether the session is interactive (session.start)
const stageContinueOnApprove = atom({ plugin: 'loopkeeper', key: 'stageContinueOnApprove' } as const, true)
const stageTurnRunning = atom({ plugin: 'loopkeeper', key: 'stageTurnRunning' } as const, false)
const stageContinuePending = atom(
  { plugin: 'loopkeeper', key: 'stageContinuePending' } as const,
  null as { stage: string; text: string } | null,
)
type ContinueSent = { seq: number; live: boolean }
const stageContinueSent = atom({ plugin: 'loopkeeper', key: 'stageContinueSent' } as const, { seq: 0, live: false } as ContinueSent)
const stageInteractive = atom({ plugin: 'loopkeeper', key: 'stageInteractive' } as const, false)
// pipeline.nextHint: the next-step line, a notice line in the chat after each answer (dim; Claude does not read it)
const stageNextHint = atom({ plugin: 'loopkeeper', key: 'stageNextHint' } as const, true)
// the "ctrl+x tab to focus the panel" toast showed this session (one atom for all six concern files)
const stageFocusHinted = atom({ plugin: 'loopkeeper', key: 'stageFocusHinted' } as const, false)
// The other mods' commands the hub links to, read from $.command.list() by /lk (a drawing may not write state)
const stageHubCommands = atom({ plugin: 'loopkeeper', key: 'stageHubCommands' } as const, [] as { name: string; plugin?: string }[])
// Written by other concerns, read here: review's subjects (the review_cycle wrapper) and routing's GSD switches
const reviewSubjects = atom({ plugin: 'loopkeeper', key: 'reviewSubjects' } as const, {} as Record<string, LkSubject>)
const routeMode = atom({ plugin: 'loopkeeper', key: 'routeMode' } as const, false)
const routeLoop = atom({ plugin: 'loopkeeper', key: 'routeLoop' } as const, true)
// the gates' /lk gates ship ok for this session and their merged config (shipGate), read by the next-step sentence
const gateShipOk = atom({ plugin: 'loopkeeper', key: 'gateShipOk' } as const, false)
const gateConfig = atom({ plugin: 'loopkeeper', key: 'gateConfig' } as const, null as LkGateConfig | null)

const PANE_ID = 'loopkeeper-stage'
const TICK_MS = 30_000
// How long after /lk approve answered its continue prompt is submitted (ADR 0012)
const CONTINUE_DELAY_MS = 100
// The waits before each new try of a refused continue prompt
const CONTINUE_RETRY_MS = [100, 500, 2_000]
const GUARDED_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const CONCERN_WORDS = ['stage', 'gates', 'files', 'routing', 'review', 'decisions']

// ---- The hub and the nav bar --------------------------------------------------------------------------------------
// HUB_ID, HUB_ROWS and PANES (every loopkeeper pane in wiring order) come from lib/panes.ts.
// The other mods the hub links to, each only while $.command.list() reports its command from one of its `plugins`; a
// press runs the command with `args` (off the terminal) or puts `text` in the composer. `plugins` lists the lk- name
// first and the old name after it, so the hub still links while either is installed during the switch.
const HUB_MODS = [
  { key: 'mod-agents', hotkey: 'm', label: 'Agents', command: 'agent-map', args: 'cards', plugins: ['lk-agent-map', 'agent-map'], text: '/agent-map cards' },
  { key: 'mod-budget', hotkey: 'u', label: 'Budget', command: 'budget', args: '', plugins: ['lk-token-budget', 'token-budget'], text: '/budget' },
  { key: 'mod-handoff', hotkey: 'h', label: 'Handoff', command: 'handoff', args: 'show', plugins: ['lk-handoff-guard', 'handoff-guard'], text: '/handoff show' },
  { key: 'mod-attention', hotkey: 't', label: 'Attention', command: 'attention', args: '', plugins: ['lk-attention', 'attention'], text: '/attention' },
  { key: 'mod-where', hotkey: 'w', label: 'Where', command: 'where', args: '', plugins: ['lk-where-am-i', 'where-am-i'], text: '/where' },
  { key: 'mod-prs', hotkey: 'p', label: 'PRs', command: 'pr', args: '', plugins: ['lk-pr-watch', 'pr-watch'], text: '/pr' },
  { key: 'mod-secrets', hotkey: 's', label: 'Secrets', command: 'secret-guard', args: '', plugins: ['lk-secret-guard', 'secret-guard'], text: '/secret-guard' },
] as const
const KEYS_TEXT =
  'loopkeeper keys: /lk opens the hub, /lk stage the Stage pane. In any loopkeeper pane, 0-6 switch panels: ' +
  PANES.map(p => p.hotkey + ' ' + p.label).join(', ') +
  '. In the hub: ' +
  HUB_MODS.map(m => m.hotkey + ' ' + m.label).join(', ') +
  ' open the other mods (those installed); a approves while a gate or budget waits, or opens the next stage\'s gate; ' +
  'o fills /lk on or /lk off; ' +
  'c closes. ctrl+x tab focuses the band, or a panel that opened without the focus. The Files pane\'s name filter ' +
  'takes every key while it has the focus, so there digits switch panels only once the focus leaves it.'

// Dedupes the "auto move held at a gate" toast; losing it on reload is harmless
let lastHeld = ''
// Growth-guard checks run one at a time, so parallel edits count against one list
let guardChain: Promise<unknown> = Promise.resolve()
// The path the growth guard reserved for a call, by tool_use_id, until the call's tool.call hook settles it.
const reservedFor = new Map<string, string>()
// The 30 s tick of the band's elapsed counter; a new session start replaces it
let ticker: { cancel: () => void } | null = null

const TOOL_DESCRIPTION = [
  "Record which stage of the project's pipeline this session is in (shown to the user above the prompt).",
  'Call it whenever your work moves between stages: planning (reading, designing, writing a plan),',
  'building/implementing (editing code), testing/QA/verifying (running tests, validating, reviewing),',
  'and shipping/committing (git commit, push, opening a PR).',
  'Pass `stage` as one of the stage ids and a one-line `note` saying what you are about to do.',
  'Some stages are gates: moving past an unapproved gate is refused, and you must then ask the user',
  'to review and run `/lk approve` before trying again. Never try to work around a gate.',
  'Some stages need a verifier (marked ⇄): before moving past one, ' + VERIFIER_HINT + '.',
  'At the start of each task call it with stage plan and `size`: small (one clear change in at most 3 files; the plan gate',
  'and the verifier are waived and the pipeline goes straight to execute) or large (the full loop).',
  'With size large also pass `files`, how many files the plan touches: approving the plan approves a file budget of that',
  'many files plus a margin, so the gates do not ask on every turn.',
  'Once a plan validator subagent has checked a large plan, record its result with stage validate-plan and `verdict`',
  'consistent or issues; consistent opens the plan gate by itself unless the user approves plans.',
].join(' ')

const USAGE =
  'Usage: /lk [stage | help | <stage-id> | next | back | approve | status | preset <name> | size small|large | ' +
  'small-max <n> | approval auto|ask | waive | reset | reload | auto on|off | band [stage] on|off]. With no argument it ' +
  'opens the loopkeeper hub; /lk stage opens the Stage pane and /lk help lists the keys (a custom stage named stage ' +
  'or help is reached with next, back or set_stage).'

// changed: the approval approved something new (a gate or a waiting budget); budgetOnly: only a budget was approved
type MoveOutcome = { ok: boolean; text: string; reason?: string; changed?: boolean; budgetOnly?: true }

// ---- Small helpers that take $ -----------------------------------------------------------------------------------

async function safeNow($: EngineInterface): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return 0
  }
}

function toast($: EngineInterface, text: string): void {
  try {
    const p = $.ui.toast(text) as unknown
    if (p && typeof (p as Promise<unknown>).catch === 'function') (p as Promise<unknown>).catch(() => undefined)
  } catch {
    // display only
  }
}

// A notice line in the chat (dim; Claude does not read it), never throwing
function logNotice($: EngineInterface, text: string): void {
  try {
    const r: unknown = $.ui.log(text)
    if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(undefined, () => {})
  } catch {
    // display only
  }
}

// A person at the prompt, or an app surface attached. The desktop app may host Claude Code through the SDK, where
// session.start says isInteractive false yet the session draws on the desktop; a plain -p run has no surface.
async function live($: EngineInterface): Promise<boolean> {
  try {
    return (await read($, stageInteractive)) || (await $.session.surfaces()).length > 0
  } catch {
    return false
  }
}

/** Both config files: the pipeline section as the stage machine reads it, and the changeControl section. Local on
 *  purpose: $ is never passed across an import. A missing or broken file gives the defaults. */
async function readConfig($: EngineInterface, cwd: string): Promise<{ pipeline: Config; cc: unknown }> {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  const textOf = async (path: string): Promise<string | null> => {
    try {
      return (await $.fs.exists(path)) ? String(await $.fs.read(path)) : null
    } catch {
      return null
    }
  }
  const user = parseConfigText(home ? await textOf(userConfigPath(home)) : null, 'user config').value
  const project = parseConfigText(cwd ? await textOf(projectConfigPath(cwd)) : null, 'project config').value
  return { pipeline: pipelineFromLayers(user, project), cc: mergeConfig(user, project).config.changeControl }
}

// What a project keeps between sessions: the task's state, never the history
async function persist($: EngineInterface): Promise<void> {
  try {
    const stage = await read($, stageCurrent)
    const since = enteredAt(await read($, stageHistory), stage)
    await $.store.set(projectKey(await read($, stageCwd)), {
      stage,
      at: since?.at ?? 0,
      approved: [...(await read($, stageApproved))],
      verified: [...(await read($, stageVerified))],
      size: await read($, stageSize),
      planVerdict: await read($, stageVerdict),
      waived: [...(await read($, stageWaived))],
      filesTouched: [...(await read($, stageFilesTouched))],
      planFiles: await read($, stagePlanFiles),
      budget: await read($, stageBudget),
    })
  } catch {
    // the store can be unavailable; the session keeps working from $.state
  }
}

// Write the derived atoms the gates read: stagePlanDone and stageShipOpen
async function derive($: EngineInterface): Promise<void> {
  const list = await read($, stageStages)
  const cur = await read($, stageCurrent)
  const ok = await read($, stageApproved)
  await update($, stagePlanDone, () => planDone(list, cur, ok))
  await update($, stageShipOpen, () => shipOpen(list, cur, ok))
}

// Put a stage list in place, keeping the current stage when it still exists
async function applyStages($: EngineInterface, list: Stage[], name: string, note?: string): Promise<void> {
  await update($, stageStages, () => list)
  await update($, stagePreset, () => name)
  const ids = list.map(s => s.id)
  const gates = list.filter(s => s.gate === true).map(s => s.id)
  await update($, stageApproved, a => a.filter(id => gates.includes(id)))
  await update($, stageVerified, v => v.filter(id => ids.includes(id)))
  const first = list[0]?.id ?? 'plan'
  if (!ids.includes(await read($, stageCurrent))) {
    await update($, stageCurrent, () => first)
    if (note) {
      const at = await safeNow($)
      await update($, stageHistory, h => capHistory([...h, { stage: first, at, by: 'command' as By, note }]))
    }
  }
  await derive($)
}

async function storeGet($: EngineInterface, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch {
    return undefined
  }
}

async function storeSet($: EngineInterface, key: string, value: unknown): Promise<boolean> {
  try {
    await $.store.set(key, value)
    return true
  } catch {
    return false
  }
}

async function applyConfig($: EngineInterface, config: Config, cc: unknown): Promise<void> {
  const dir = await read($, stageCwd)
  const section = (cc ?? {}) as { planPaths?: unknown; maxFilesPerTurn?: unknown; planSlack?: unknown; autoBudgetMax?: unknown }
  await update($, stageAuto, () => config.auto)
  await update($, stageSource, () => config.source)
  await update($, stageSmallMax, () => config.smallMaxFiles ?? SMALL_MAX_DEFAULT)
  await update($, stageContinueOnApprove, () => config.continueOnApprove !== false)
  await update($, stageNextHint, () => config.nextHint !== false)
  await update($, stagePlanPaths, () => [...(planPathsOf(section.planPaths) ?? DEFAULT_PLAN_PATHS)])
  await update($, stageLimits, () => limitsOf(section))
  const mode = approvalOf(await storeGet($, approvalKey(dir)), config)
  await update($, stageApproval, () => mode)
  const chosen = chooseStages(config, await storeGet($, presetKey(dir)))
  await applyStages($, chosen.stages, chosen.preset)
}

// The per-task state a new task, a reset or a fresh session starts without. The file budget goes with the plan.
async function clearTask($: EngineInterface): Promise<void> {
  await update($, stageSize, () => '' as Size)
  await update($, stageVerdict, () => null)
  await update($, stageWaived, () => [])
  await update($, stageFilesTouched, () => [])
  await clearBudget($)
}

async function clearBudget($: EngineInterface): Promise<void> {
  await update($, stagePlanFiles, () => null)
  await update($, stageBudget, () => 0)
}

// The session's project root (where it started, or where /cd or a worktree move took it; a shell `cd` does not move
// it), '' when it cannot be read. Plan paths, the store keys and the config resolve against it.
async function sessionRoot($: EngineInterface): Promise<string> {
  try {
    return String((await $.session.root()) ?? '')
  } catch {
    return ''
  }
}

// The project root at use, falling back to the one init read. Path decisions (guardEdit, autoTarget) use it; the
// store keys and the config stay on stageCwd, the root init read, so the pipeline's state is never written under
// another project's key after a /cd. The next init (session start, /clear, /resume) moves them.
async function rootDir($: EngineInterface): Promise<string> {
  return (await sessionRoot($)) || (await read($, stageCwd))
}

// Read the config and, unless this is a hot reload with state already in place, resume the project's stage
async function init($: EngineInterface): Promise<void> {
  let dir = await sessionRoot($)
  if (!dir) {
    try {
      dir = String((await $.session.cwd()) ?? '')
    } catch {
      dir = ''
    }
  }
  await update($, stageCwd, () => dir)
  const { pipeline: config, cc } = await readConfig($, dir)
  await applyConfig($, config, cc)
  const at = await safeNow($)
  await update($, stageNow, () => at)
  const shown = await storeGet($, BAND_KEY)
  await update($, stageBand, () => shown !== false)
  // ADR 0007: an old Claude Code is named on the band; an unknown or dev build is not
  let note = ''
  try {
    note = versionNote((await $.session.version()) as { version?: unknown; base?: unknown })
  } catch {
    note = ''
  }
  await update($, stageVersionNote, () => note)
  // ADR 0009: CLAUDE_MODS_DISABLE=loopkeeper turns the growth guard off
  const disabled = killSwitchOn(await $.env.get('CLAUDE_MODS_DISABLE').catch(() => undefined))
  await update($, stageDisabled, () => disabled)
  if ((await read($, stageHistory)).length > 0) {
    await derive($)
    return
  }
  const saved = savedOf(await storeGet($, projectKey(dir)))
  const list = await read($, stageStages)
  if (saved && indexOf(list, saved.stage) >= 0) {
    const gates = list.filter(s => s.gate === true).map(s => s.id)
    const ids = list.map(s => s.id)
    await update($, stageCurrent, () => saved.stage)
    await update($, stageApproved, () => saved.approved.filter(id => gates.includes(id)))
    await update($, stageVerified, () => saved.verified.filter(id => ids.includes(id)))
    await update($, stageSize, () => saved.size)
    await update($, stageVerdict, () => saved.planVerdict)
    await update($, stageWaived, () => saved.waived.filter(id => ids.includes(id)))
    await update($, stageFilesTouched, () => saved.filesTouched)
    await update($, stagePlanFiles, () => saved.planFiles)
    await update($, stageBudget, () => saved.budget)
    await update($, stageHistory, () => [{ stage: saved.stage, at, by: 'resume' as By, note: 'resumed from the last session' }])
  } else {
    const first = list[0]?.id ?? 'plan'
    await update($, stageCurrent, () => first)
    await update($, stageApproved, () => [])
    await update($, stageVerified, () => [])
    await clearTask($)
    await update($, stageHistory, () => [{ stage: first, at, by: 'auto' as By, note: 'session start' }])
  }
  await update($, stageCarry, () => '')
  await update($, stageCarryBy, () => '')
  await derive($)
  if (config.error) {
    try {
      $.ui.log(PLUGIN + ': ' + config.error + '; using the default stages')
    } catch {
      // nothing to do
    }
  }
}

async function moveTo($: EngineInterface, target: string, by: By, note?: string): Promise<MoveOutcome> {
  const list = await read($, stageStages)
  const from = await read($, stageCurrent)
  const check = checkMove(list, await read($, stageApproved), from, target, await read($, stageVerified))
  if (!check.ok) return { ok: false, text: check.message, reason: check.reason }
  const at = await safeNow($)
  const entry: Transition = { stage: check.stage.id, at, by }
  const trimmed = typeof note === 'string' ? note.trim().slice(0, 200) : ''
  if (trimmed) entry.note = trimmed
  const id = check.stage.id
  const forwardByOne = indexOf(list, id) === indexOf(list, from) + 1
  const carried = await read($, stageCarry)
  const carriedBy = await read($, stageCarryBy)
  await update($, stageCurrent, () => id)
  // a verifier counts per visit: entering a stage again needs a fresh one, except a small task's waiver the first time
  if ((await read($, stageWaived)).includes(id)) await update($, stageWaived, w => w.filter(x => x !== id))
  else await update($, stageVerified, v => v.filter(x => x !== id))
  await update($, stageHistory, h => capHistory([...h, entry]))
  // a validator that completed in the stage just before this one counts here
  if (carried === id && forwardByOne && check.stage.requiresAgent && !(await read($, stageVerified)).includes(id)) {
    await update($, stageVerified, v => [...v, id])
    const by2 = 'verified by ' + (carriedBy || 'an agent')
    await update($, stageHistory, h => capHistory([...h, { stage: id, at, by: 'auto' as By, note: by2, event: 'verified' as const }]))
  }
  await update($, stageCarry, () => '')
  await update($, stageCarryBy, () => '')
  // back to Plan: a new plan, so the plan's approval and its file budget go
  if (roleOf(check.stage) === 'plan') {
    await update($, stageWaived, () => [])
    await update($, stageFilesTouched, () => [])
    await clearBudget($)
  }
  await update($, stageNow, () => at)
  await derive($)
  await persist($)
  return { ok: true, text: 'Moved from ' + labelOf(list, from) + ' to ' + check.stage.label + '.' }
}

// The state the file budget is judged on
async function budgetState($: EngineInterface) {
  return {
    stages: await read($, stageStages),
    current: await read($, stageCurrent),
    approved: await read($, stageApproved),
    size: await read($, stageSize),
    planFiles: await read($, stagePlanFiles),
    budget: await read($, stageBudget),
  }
}

// The state the next step is decided on
async function nextState($: EngineInterface) {
  return {
    ...(await budgetState($)),
    approval: await read($, stageApproval),
    hold: await read($, stageHoldPlan),
    verified: await read($, stageVerified),
    waived: await read($, stageWaived),
    shipOk: await read($, gateShipOk),
    shipGate: ((await read($, gateConfig)) ?? mergeLayers([]).config).shipGate,
  }
}

// The next-step sentence (lib/stageModel.ts nextStep) for the state now
async function nextSentence($: EngineInterface): Promise<string> {
  return nextStep(await nextState($))
}

// The notice line in the chat after a main turn's answer (dim; Claude does not read it): `loopkeeper · <Stage> (<n>
// of <m>) · ` and the next-step sentence. Only in a live session (see live) with the kill switch off and
// pipeline.nextHint on, and only while a task is in play (sized, or the stage past the first); '' otherwise.
async function nextLine($: EngineInterface): Promise<string> {
  if (!(await read($, stageNextHint)) || (await read($, stageDisabled)) || !(await live($))) return ''
  const list = await read($, stageStages)
  const i = Math.max(0, indexOf(list, await read($, stageCurrent)))
  if ((await read($, stageSize)) === '' && i === 0) return ''
  return 'loopkeeper · ' + (list[i]?.label ?? '') + ' (' + (i + 1) + ' of ' + list.length + ') · ' + (await nextSentence($))
}

// Approve the planned file budget with the plan. `who` is 'validator' for a verdict in auto mode, which may approve
// at most autoBudgetMax planned files; the user approves any count. Returns the sentence the approval states.
async function approveBudget($: EngineInterface, who: 'validator' | 'user'): Promise<string> {
  const limits = await read($, stageLimits)
  const files = await read($, stagePlanFiles)
  if (files === null) return budgetSentence(null, limits)
  if (who === 'validator' && files > limits.autoMax) return budgetWaitSentence(files, limits)
  await update($, stageBudget, () => budgetFor(files, limits))
  await persist($)
  return budgetSentence(files, limits)
}

// The band's "Approve budget" button and /lk approve once the plan gate is open but a large budget still waits
async function approveWaitingBudget($: EngineInterface): Promise<MoveOutcome> {
  if (!budgetWaits(await budgetState($))) return { ok: false, text: 'No file budget is waiting for approval.' }
  return { ok: true, text: 'Approved the file budget. ' + (await approveBudget($, 'user')), changed: true, budgetOnly: true }
}

// A preset with no plan gate (the default): leaving Plan forward through set_stage or an auto move (never ExitPlanMode)
// in approval mode auto with no hold approves a waiting budget the way a validator's verdict would, up to
// autoBudgetMax planned files. Returns the sentence the approval states, '' when nothing waited.
async function budgetOnLeavingPlan($: EngineInterface, from: string): Promise<string> {
  const list = await read($, stageStages)
  if (stageForRole(list, 'validate-plan')?.gate === true) return ''
  const plan = stageForRole(list, 'plan')
  if (!plan || from !== plan.id || (await read($, stageCurrent)) === plan.id) return ''
  if ((await read($, stageApproval)) !== 'auto' || (await read($, stageHoldPlan))) return ''
  if (!budgetWaits(await budgetState($))) return ''
  return approveBudget($, 'validator')
}

// Size the task (Claude through set_stage, or the user through /lk size). It starts a new task in the plan stage: the
// last task's approvals, verifier marks, verdict and file budget go. Small waives the plan gate and the verifiers and
// moves on to the build stage; large records the size and, from set_stage, the planned file count.
async function sizeTask($: EngineInterface, want: 'small' | 'large', by: By, note?: string, files: number | null = null): Promise<MoveOutcome> {
  const list = await read($, stageStages)
  const plan = stageForRole(list, 'plan')
  let head = ''
  if (plan && (await read($, stageCurrent)) !== plan.id) {
    const moved = await moveTo($, plan.id, by, note)
    if (!moved.ok) return moved
    head = moved.text + ' '
  }
  await update($, stageApproved, () => [])
  await update($, stageVerified, () => [])
  await clearTask($)
  // a hold the user's prompt asked for binds to this task; one an earlier task already used is spent
  if (await read($, stageHoldPlan)) {
    if (await read($, stageHoldBound)) {
      await update($, stageHoldPlan, () => false)
      await update($, stageHoldBound, () => false)
    } else await update($, stageHoldBound, () => true)
  }
  await update($, stageSize, () => want)
  if (want === 'large') {
    // re-planning before approval replaces the count
    await update($, stagePlanFiles, () => files)
    await derive($)
    await persist($)
    return { ok: true, text: head + largeReply(files, await read($, stageLimits), by === 'tool') }
  }
  const at = await safeNow($)
  const gate = stageForRole(list, 'validate-plan')
  const check = stageForRole(list, 'validate')
  const build = stageForRole(list, 'build')
  const hold = await read($, stageHoldPlan)
  const marks: string[] = []
  const notes: Transition[] = []
  if (gate?.requiresAgent) marks.push(gate.id)
  if (check?.requiresAgent) {
    marks.push(check.id)
    notes.push({ stage: check.id, at, by: 'auto', note: 'small task: verifier waived', event: 'verified' })
  }
  await update($, stageVerified, v => [...v.filter(x => !marks.includes(x)), ...marks])
  const opened = gate?.gate === true && !hold
  if (opened && gate) {
    await update($, stageApproved, a => (a.includes(gate.id) ? a : [...a, gate.id]))
    notes.unshift({ stage: gate.id, at, by: 'auto', note: 'small task: plan gate waived', event: 'approved' })
  }
  await update($, stageWaived, () => [...new Set([...marks, ...(opened && gate ? [gate.id] : [])])])
  await update($, stageHistory, h => capHistory([...h, ...notes]))
  await derive($)
  await persist($)
  if (gate?.gate === true && hold) {
    const moved = await moveTo($, gate.id, by, 'small task')
    if (!moved.ok) return { ok: false, text: head + moved.text, reason: moved.reason }
    return { ok: true, text: head + smallHeldReply(gate.label) }
  }
  if (build) {
    const moved = await moveTo($, build.id, by, 'small task')
    if (!moved.ok) return { ok: false, text: head + moved.text, reason: moved.reason }
  }
  const cur = await read($, stageCurrent)
  return { ok: true, text: head + smallReply(labelOf(list, cur), await read($, stageSmallMax)) }
}

// Record a plan validator's verdict; consistent opens the plan gate when a validator completed, the mode is auto and
// the user's prompt did not ask to wait. Opening the gate approves the planned file budget, up to autoBudgetMax.
async function recordVerdict($: EngineInterface, ok: boolean, by: By, note?: string): Promise<MoveOutcome> {
  const list = await read($, stageStages)
  const gate = stageForRole(list, 'validate-plan')
  if (!gate) return { ok: false, text: 'This pipeline has no validate-plan stage, so there is no plan verdict to record.' }
  let head = ''
  if ((await read($, stageCurrent)) !== gate.id) {
    const moved = await moveTo($, gate.id, by, note)
    if (!moved.ok) return moved
    head = moved.text + ' '
  }
  const at = await safeNow($)
  const validated = gate.requiresAgent ? (await read($, stageVerified)).includes(gate.id) : true
  const who = validated ? verifiedBy(await read($, stageHistory), gate.id) : 'no validator'
  await update($, stageVerdict, () => ({ ok, by: who, at }))
  const mode = await read($, stageApproval)
  const hold = await read($, stageHoldPlan)
  let opened = false
  let budget: string | undefined
  if (ok && validated && mode === 'auto' && !hold && gate.gate === true) {
    opened = true
    if (!(await read($, stageApproved)).includes(gate.id)) {
      await update($, stageApproved, a => [...a, gate.id])
      const entry: Transition = { stage: gate.id, at, by: 'auto', note: 'plan validated by ' + who + ': gate opened', event: 'approved' }
      await update($, stageHistory, h => capHistory([...h, entry]))
      await derive($)
      toast($, 'Plan validated; gate opened automatically')
    }
    budget = await approveBudget($, 'validator')
  }
  await persist($)
  return { ok: true, text: head + verdictReply({ ok, validated, who, approval: mode, hold, opened, budget }) }
}

// A small task that would touch one file more than it may: refused, and the stage machine goes back to Plan with the
// waiver undone, so stagePlanDone stays false until a real plan is validated
async function pushBack($: EngineInterface): Promise<void> {
  const list = await read($, stageStages)
  const undo = await read($, stageWaived)
  await update($, stageApproved, a => a.filter(id => !undo.includes(id)))
  await update($, stageVerified, v => v.filter(id => !undo.includes(id)))
  await update($, stageSize, () => '' as Size)
  const plan = stageForRole(list, 'plan')
  if (plan && (await read($, stageCurrent)) !== plan.id) await moveTo($, plan.id, 'auto', 'outgrew small')
  await update($, stageWaived, () => [])
  await update($, stageFilesTouched, () => [])
  await clearBudget($)
  await derive($)
  await persist($)
  toast($, PLUGIN + ': the small task outgrew its file limit; back to Plan')
}

// What the guard decided for one edit: the refusal, or the new path it reserved in the touched list (released again
// when a hook or rule beneath refuses the edit).
type Guarded = { held?: { decision: 'deny'; reason: string }; reserved?: string }

async function guardEdit($: EngineInterface, input: unknown): Promise<Guarded> {
  const raw = editPath(input)
  if (raw === undefined) return {}
  const dir = await rootDir($)
  const path = normalizePath(raw, dir)
  // plan material (the plan page, notes) is never counted and never refused
  if (isPlanMaterial(path, dir, await read($, stagePlanPaths))) return {}
  const touched = await read($, stageFilesTouched)
  const max = await read($, stageSmallMax)
  if (outgrows(await read($, stageSize), touched, path, max)) {
    await pushBack($)
    return { held: { decision: 'deny', reason: outgrowMessage(path, max) } }
  }
  if (!touched.includes(path) && touched.length < FILES_CAP) {
    await update($, stageFilesTouched, f => (f.includes(path) ? f : [...f, path]))
    await persist($)
    return { reserved: path }
  }
  return {}
}

async function releaseEdit($: EngineInterface, path: string): Promise<void> {
  await update($, stageFilesTouched, f => f.filter(p => p !== path))
  await persist($)
}

async function step($: EngineInterface, dir: 1 | -1): Promise<MoveOutcome> {
  const target = neighbour(await read($, stageStages), await read($, stageCurrent), dir)
  if (!target) return { ok: false, text: dir === 1 ? 'Already at the last stage.' : 'Already at the first stage.' }
  return moveTo($, target.id, 'command')
}

// /lk approve: the current stage's gate. Approving the plan gate approves the planned file budget with it (any count:
// the user approves it). With the gate already open, or at another stage's gate, a large budget still waiting is
// approved first. From the stage before a gate (no gate of its own waiting), it opens the next stage's gate and moves
// into it (openGateAhead); never a gate two stages ahead.
async function approveGate($: EngineInterface): Promise<MoveOutcome> {
  const list = await read($, stageStages)
  const stage = list[indexOf(list, await read($, stageCurrent))]
  if (!stage) return { ok: false, text: 'No current stage.' }
  const isPlanGate = roleOf(stage) === 'validate-plan'
  if (isPlanGate && stage.gate === true) {
    await update($, stageHoldPlan, () => false)
    await update($, stageHoldBound, () => false)
  }
  if (stage.gate !== true || (await read($, stageApproved)).includes(stage.id)) {
    if (budgetWaits(await budgetState($))) return approveWaitingBudget($)
    const ahead = gateAhead(list, stage.id, await read($, stageApproved))
    if (ahead) return openGateAhead($, stage, ahead)
    if (stage.gate !== true) return { ok: false, text: stage.label + ' has no gate to approve.' }
    return { ok: true, text: 'The ' + stage.label + ' gate is already approved.' }
  }
  // any other gate waits behind a planned budget, as on the band and the hub's `a`: this approval is the budget's, the
  // next one the gate's
  if (!isPlanGate && budgetWaits(await budgetState($))) return approveWaitingBudget($)
  await update($, stageApproved, a => [...a, stage.id])
  // the user's approval vouches for the stage's verifier too
  if (stage.requiresAgent && !(await read($, stageVerified)).includes(stage.id)) {
    await update($, stageVerified, v => [...v, stage.id])
  }
  await derive($)
  await persist($)
  const text = 'Approved the ' + stage.label + ' gate; the pipeline may now move past it.'
  return { ok: true, text: isPlanGate ? text + ' ' + (await approveBudget($, 'user')) : text, changed: true }
}

// /lk approve from the stage before a gate. The user's approval vouches for the current stage's verifier, so the move
// passes; entering a stage clears its verifier mark, so the next stage's gate and verifier marks go on after the move.
// A gate already approved (after /lk back) is moved into without approving it again. The plan gate clears the hold
// and approves the planned file budget, as /lk approve at Validate plan does.
async function openGateAhead($: EngineInterface, stage: Stage, next: Stage): Promise<MoveOutcome> {
  const list = await read($, stageStages)
  const already = (await read($, stageApproved)).includes(next.id)
  const vouch = Boolean(stage.requiresAgent) && !(await read($, stageVerified)).includes(stage.id)
  if (vouch) await update($, stageVerified, v => [...v, stage.id])
  const moved = await moveTo($, next.id, 'command', 'approved by the user')
  if (!moved.ok) {
    if (vouch) await update($, stageVerified, v => v.filter(id => id !== stage.id))
    return moved
  }
  if (!already) await update($, stageApproved, a => (a.includes(next.id) ? a : [...a, next.id]))
  if (next.requiresAgent) await update($, stageVerified, v => (v.includes(next.id) ? v : [...v, next.id]))
  const isPlanGate = roleOf(next) === 'validate-plan'
  if (isPlanGate) {
    await update($, stageHoldPlan, () => false)
    await update($, stageHoldBound, () => false)
  }
  await derive($)
  await persist($)
  const after = neighbour(list, next.id, 1)
  const opened = 'Approved the ' + next.label + ' gate and moved to ' + next.label
  const text = already
    ? 'Moved to ' + next.label + '; its gate was already approved.'
    : roleOf(next) === 'ship'
      ? opened + ': Claude may commit, push or open a PR.'
      : opened + (after ? '; Claude may start ' + after.label + '.' : '.')
  return { ok: true, text: isPlanGate ? text + ' ' + (await approveBudget($, 'user')) : text, changed: true }
}

async function resetPipeline($: EngineInterface): Promise<MoveOutcome> {
  const list = await read($, stageStages)
  const first = list[0]?.id ?? 'plan'
  const at = await safeNow($)
  await update($, stageCurrent, () => first)
  await update($, stageApproved, () => [])
  await update($, stageVerified, () => [])
  await clearTask($)
  await update($, stageHoldPlan, () => false)
  await update($, stageHoldBound, () => false)
  await update($, stageCarry, () => '')
  await update($, stageCarryBy, () => '')
  await update($, stageHistory, () => [{ stage: first, at, by: 'command' as By, note: 'reset' }])
  await update($, stageNow, () => at)
  await derive($)
  await persist($)
  return { ok: true, text: 'Pipeline reset to ' + labelOf(list, first) + '; gate approvals cleared.' }
}

async function reloadConfig($: EngineInterface): Promise<MoveOutcome> {
  const { pipeline: config, cc } = await readConfig($, await read($, stageCwd))
  await applyConfig($, config, cc)
  await persist($)
  const list = await read($, stageStages)
  const name = await read($, stagePreset)
  const where =
    name !== 'file' && name !== 'default'
      ? 'preset ' + name
      : config.source === 'file' && name === 'file'
        ? CONFIG_LABEL
        : 'the default stages'
  const warn = config.error ? ' (' + config.error + ')' : ''
  return { ok: true, text: 'Loaded ' + list.length + ' stages from ' + where + warn + ': ' + validIds(list) + '.' }
}

async function choosePreset($: EngineInterface, name: string): Promise<MoveOutcome> {
  const dir = await read($, stageCwd)
  const { pipeline: config } = await readConfig($, dir)
  const known = presetNames(config)
  if (!name) {
    return { ok: true, text: 'Preset: ' + (await read($, stagePreset)) + '. Presets: ' + known.join(', ') + (config.hasStages ? ', file' : '') + '.' }
  }
  let list: Stage[] | undefined
  let saved = name
  if (name === 'file') {
    if (config.source !== 'file' || config.hasStages === false) return { ok: false, text: CONFIG_LABEL + ' has no stages list to use.' }
    list = config.stages
    saved = ''
  } else {
    list = presetStages(config, name)
  }
  if (!list) return { ok: false, text: 'Unknown preset "' + name + '". Presets: ' + known.join(', ') + '.' }
  await applyStages($, list, name, 'preset ' + name)
  await storeSet($, presetKey(dir), saved)
  await persist($)
  return { ok: true, text: 'Pipeline preset ' + name + ': ' + list.map(s => s.label).join(' → ') + '. Saved for this project.' }
}

// The stage's part of /lk status: where the stage machine is and what holds the next move
async function statusText($: EngineInterface): Promise<string> {
  const list = await read($, stageStages)
  const cur = await read($, stageCurrent)
  const ok = await read($, stageApproved)
  const done = await read($, stageVerified)
  const state = await budgetState($)
  const lines = [
    'stage ● ' + labelOf(list, cur) + ' (' + (Math.max(0, indexOf(list, cur)) + 1) + ' of ' + list.length + ') · preset ' +
      (await read($, stagePreset)) + ' · auto ' + ((await read($, stageAuto)) ? 'on' : 'off'),
  ]
  const gates = list.filter(s => s.gate === true)
  lines.push('Gates: ' + (gates.length === 0 ? 'none' : gates.map(g => g.label + (ok.includes(g.id) ? ' approved' : ' pending')).join(', ')))
  const needs = list.filter(s => s.requiresAgent)
  if (needs.length > 0) lines.push('Verifier: ' + needs.map(s => s.label + (done.includes(s.id) ? ' satisfied' : ' needed')).join(', '))
  lines.push(sizeLine(state.size, (await read($, stageFilesTouched)).length, await read($, stageSmallMax)))
  if (stageForRole(list, 'validate-plan')) lines.push(planMaterialLine(await read($, stagePlanPaths)))
  lines.push(approvalLine(await read($, stageApproval), await read($, stageHoldPlan)))
  lines.push('Continue after approval: ' + ((await read($, stageContinueOnApprove)) ? 'on' : 'off'))
  lines.push(verdictLine(await read($, stageVerdict)))
  lines.push(budgetLine(state.planFiles, state.budget, budgetWaits(state), await read($, stageLimits)))
  // the next-step sentence, under a Next: label of its own unless it starts with one
  const sentence = await nextSentence($)
  lines.push(sentence.startsWith('Next: ') ? sentence : 'Next: ' + sentence)
  lines.push('planDone ' + (await read($, stagePlanDone)) + ' · shipOpen ' + (await read($, stageShipOpen)))
  const version = await read($, stageVersionNote)
  if (version) lines.push('Warning: loopkeeper ' + version + '.')
  if (await read($, stageDisabled)) lines.push('Warning: ' + DISABLED_NOTE + '; edits are not counted against a small task.')
  return lines.join('\n')
}

// The user vouches for the current stage's verifier requirement
async function waive($: EngineInterface): Promise<MoveOutcome> {
  const list = await read($, stageStages)
  const stage = list[indexOf(list, await read($, stageCurrent))]
  if (!stage?.requiresAgent) return { ok: false, text: (stage?.label ?? 'This stage') + ' needs no verifier.' }
  await update($, stageVerified, v => (v.includes(stage.id) ? v : [...v, stage.id]))
  await persist($)
  return { ok: true, text: 'Marked the ' + stage.label + ' verifier as satisfied by the user.' }
}

// A completed Agent call that matches the current stage's requiresAgent satisfies it
async function noteAgent($: EngineInterface, call: Record<string, unknown>): Promise<void> {
  const list = await read($, stageStages)
  const ci = indexOf(list, await read($, stageCurrent))
  const stage = list[ci]
  if (!stage) return
  const who = [call.subagent_type, call.description].filter(v => typeof v === 'string').join(': ').slice(0, 120)
  if (!agentMatches(stage, call)) {
    // lenient carry: a validator done in the stage just before a requiresAgent stage counts when it is entered
    const following = list[ci + 1]
    if (following && agentMatches(following, call)) {
      await update($, stageCarry, () => following.id)
      await update($, stageCarryBy, () => who)
    }
    return
  }
  if ((await read($, stageVerified)).includes(stage.id)) return
  await update($, stageVerified, v => [...v, stage.id])
  const at = await safeNow($)
  const entry: Transition = { stage: stage.id, at, by: 'auto', note: 'verified by ' + (who || 'an agent'), event: 'verified' }
  await update($, stageHistory, h => capHistory([...h, entry]))
  await persist($)
}

// A press that did nothing says why in a toast
function tell($: EngineInterface, outcome: MoveOutcome): void {
  if (!outcome.ok) toast($, outcome.text)
}

// ---- ADR 0012: continue after approval ----------------------------------------------------------------------------

// The prompt goes only from a live session (see live), with the config switch on and the kill switch off
async function mayContinue($: EngineInterface): Promise<boolean> {
  return (await read($, stageContinueOnApprove)) && !(await read($, stageDisabled)) && (await live($))
}

// One continue prompt per main turn: a send claims a ticket (its seq) while none is live, and the next main
// turn.start ends it. A timer or a retry goes only while its own ticket is still the live one, so a second approval
// before the next turn, or a retry that a whole turn overtook, sends nothing.
async function claimContinue($: EngineInterface): Promise<number | null> {
  let claimed = false
  const now = await update($, stageContinueSent, cur => {
    claimed = !cur.live
    return claimed ? { seq: cur.seq + 1, live: true } : cur
  })
  return claimed ? now.seq : null
}

async function isLive($: EngineInterface, seq: number): Promise<boolean> {
  const cur = await read($, stageContinueSent)
  return cur.live && cur.seq === seq
}

// A ticket given up (or dropped) frees the next turn's prompt, unless a later one took its place
async function releaseContinue($: EngineInterface, seq: number): Promise<void> {
  try {
    await update($, stageContinueSent, cur => (cur.seq === seq ? { seq, live: false } : cur))
  } catch {
    // the next turn.start frees it
  }
}

// Framed as the plugin's message (no asUser). A refused submit (the host refuses one while a command is still
// answering) is tried again after 100 ms, 500 ms and 2 s, each time only while the conditions still hold and no main
// turn has started; then it is given up silently: the approval stands.
function submitContinue($: EngineInterface, text: string, seq: number, retry = 0): void {
  const again = (): void => {
    const ms = CONTINUE_RETRY_MS[retry]
    if (ms === undefined) return void releaseContinue($, seq)
    try {
      $.clock.after(ms, () => void sendIfLive($, text, seq, retry + 1))
    } catch {
      void releaseContinue($, seq)
    }
  }
  try {
    const p = $.prompt.submit({ text }) as unknown
    // a hook that drops the prompt starts no turn, so its ticket is freed here
    const dropped = (r: unknown): void => {
      if (r !== null && typeof r === 'object' && 'drop' in r) void releaseContinue($, seq)
    }
    if (p && typeof (p as Promise<unknown>).then === 'function') (p as Promise<unknown>).then(dropped, again)
  } catch {
    again()
  }
}

// A send from a timer (a retry, or /lk approve's): only while the conditions still hold, no main turn runs and no
// main turn started since the ticket was claimed
async function sendIfLive($: EngineInterface, text: string, seq: number, retry: number): Promise<void> {
  try {
    if (!(await isLive($, seq)) || !(await mayContinue($)) || (await read($, stageTurnRunning))) return releaseContinue($, seq)
  } catch {
    return releaseContinue($, seq)
  }
  submitContinue($, text, seq, retry)
}

// After a user's approval that changed something, submit one prompt so the model carries on. Idle, it goes at once,
// unless a continue prompt is already on its way; during a main turn it waits for that turn's end (turn.complete),
// where a later approval replaces it, and a budget-only approval is not kept.
// `fromCommand`: the host refuses a submit from a command.run hook (it would wait on the turn the hook holds), so
// /lk approve submits from a timer just after the command has answered.
async function continueAfter($: EngineInterface, outcome: MoveOutcome, said: string, fromCommand = false): Promise<void> {
  try {
    if (!outcome.ok || outcome.changed !== true || !(await mayContinue($))) return
    const text = said + ' ' + outcome.text + ' Carry on with the task from where you stopped.'
    if (!(await read($, stageTurnRunning))) {
      const seq = await claimContinue($)
      if (seq === null) return
      if (!fromCommand) submitContinue($, text, seq)
      else {
        try {
          $.clock.after(CONTINUE_DELAY_MS, () => void sendIfLive($, text, seq, 0))
        } catch {
          void releaseContinue($, seq)
        }
      }
      return
    }
    if (outcome.budgetOnly) return
    const stage = await read($, stageCurrent)
    await update($, stageContinuePending, () => ({ stage, text }))
  } catch {
    // the approval stands without the prompt
  }
}

async function closePane($: EngineInterface): Promise<void> {
  try {
    await $.ui.close({ id: PANE_ID })
  } catch {
    // already closed
  }
}

// ---- The hub and the nav bar: switching panes ---------------------------------------------------------------------

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

// The other mods' commands $.command.list() reports, matched on name and plugin ('name@marketplace' counts), kept for
// the hub to draw with the plugin they came from, the lk- one when both are listed. A list that cannot be read leaves
// the last one.
async function readHubCommands($: EngineInterface): Promise<void> {
  try {
    const listed = await $.command.list()
    const from = (c: { plugin?: string }, plugin: string) => c.plugin === plugin || (c.plugin ?? '').startsWith(plugin + '@')
    const found = HUB_MODS.flatMap(m => {
      const plugin = m.plugins.find(p => listed.some(c => c.name === m.command && from(c, p)))
      return plugin ? [{ name: m.command, plugin }] : []
    })
    await update($, stageHubCommands, () => found)
  } catch {
    // the hub keeps what it drew
  }
}

// An other-mods press: with an empty composer, close the hub and put the command there for Enter; a draft is kept
async function offerMod($: EngineInterface, mod: (typeof HUB_MODS)[number]): Promise<void> {
  let draft = ''
  try {
    draft = String((await $.prompt.read()).text ?? '')
  } catch {
    draft = ''
  }
  if (draft.trim() !== '') {
    toast($, 'Type ' + mod.text + ' to open ' + mod.label)
    return
  }
  try {
    await $.ui.close({ id: HUB_ID })
  } catch {
    // already closed
  }
  let filled = false
  try {
    filled = (await $.prompt.fill({ text: mod.text, mode: 'replace' })).isFilled === true
  } catch {
    filled = false
  }
  toast($, filled ? 'Press Enter to open ' + mod.label : 'Type ' + mod.text + ' to open ' + mod.label)
}

// An other-mods press off the terminal (the desktop app): close the hub and run the mod's command, which opens its
// own pane. The terminal, or a run that is refused, falls back to offerMod: a pane a queued plugin command opens is
// not one the person asked for, and on a narrow terminal it would wait undrawn.
async function openMod($: EngineInterface, mod: (typeof HUB_MODS)[number], surface: unknown): Promise<void> {
  if (typeof surface === 'string' && surface !== 'terminal') {
    try {
      await $.ui.close({ id: HUB_ID })
    } catch {
      // already closed
    }
    try {
      await $.command.run({ command: mod.command, args: mod.args })
      return
    } catch {
      // not run: fill or toast instead
    }
  }
  await offerMod($, mod)
}

// The hub's o: the /lk words that switch GSD mode go in an empty prompt box, as the routing pane's Toggle mode does;
// a draft is kept and the toast says what to type
async function offerGsd($: EngineInterface, active: boolean): Promise<void> {
  const text = '/lk ' + (active ? 'on' : 'off')
  let draft = ''
  try {
    draft = String((await $.prompt.read()).text ?? '')
  } catch {
    draft = ''
  }
  if (draft.trim() !== '') {
    toast($, 'Type ' + text + ' to turn GSD mode ' + (active ? 'on' : 'off'))
    return
  }
  let filled = false
  try {
    filled = (await $.prompt.fill({ text, mode: 'replace' })).isFilled === true
  } catch {
    filled = false
  }
  toast($, filled ? 'Press Enter to run ' + text : 'Run ' + text)
}

// Auto-move from a tool call: main loop only, forward only, never across an unapproved gate
async function autoMove($: EngineInterface, call: Record<string, unknown>): Promise<void> {
  const list = await read($, stageStages)
  const cur = await read($, stageCurrent)
  const { stage: target, shipAttempt } = autoTarget(list, call, cur, await rootDir($), await read($, stagePlanPaths))
  const tool = typeof call.tool === 'string' ? call.tool : 'tool'
  if (shipAttempt) {
    // a gated ship stage is entered by a decision, never by a commit; the attempt is noted
    const at = await safeNow($)
    const open = cur === shipAttempt.id && (await read($, stageApproved)).includes(shipAttempt.id)
    const note = (open ? 'shipped' : 'ship attempted, held by the ' + shipAttempt.label + ' gate') + ': from ' + tool
    const entry: Transition = { stage: shipAttempt.id, at, by: 'auto', note, event: 'ship-attempt' }
    await update($, stageHistory, h => capHistory([...h, entry]))
    return
  }
  if (!(await read($, stageAuto))) return
  if (!target || indexOf(list, target.id) <= indexOf(list, cur)) return
  const result = await moveTo($, target.id, 'auto', 'from ' + tool)
  // ExitPlanMode is an auto move too, but its plan waits for the user: the band's button approves its budget
  if (result.ok && tool !== 'ExitPlanMode') await budgetOnLeavingPlan($, cur)
  if (!result.ok && (result.reason === 'gate' || result.reason === 'agent') && lastHeld !== cur + '>' + target.id) {
    lastHeld = cur + '>' + target.id
    toast(
      $,
      result.reason === 'gate'
        ? 'Pipeline held at a gate: run /lk approve to let it move to ' + target.label
        : 'Pipeline held: a verifier subagent must finish before it moves to ' + target.label,
    )
  }
}

// ADR 0004: the stage's part of GSD mode. /lk on switches to the gsd preset and /lk off back to default, each only
// while the GSD loop is on; /lk loop on|off does the same while GSD mode is on. Exactly what gsd-orchestrator sent.
async function gsdPreset($: EngineInterface, active: boolean): Promise<string> {
  const want = active ? 'gsd' : 'default'
  if ((await read($, stagePreset)) === want) return 'stage ● preset ' + want + ' (already in use)'
  return (await choosePreset($, want)).text
}

// ---- /lk ---------------------------------------------------------------------------------------------------------

// Words other concerns own: never read as a stage id, even when a config names a stage so
const OTHER_WORDS = ['gates', 'files', 'routes', 'route', 'explain', 'text', 'loop']

// The words the stage owns. Undefined when the word is not the stage's, so the chain moves on.
// `fromPerson`: the run came from the person (no origin, or composer, bridge or sdk); only they approve a gate.
async function ownCommand($: EngineInterface, args: string, fromPerson: boolean): Promise<{ text?: string } | undefined> {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const verb = (words[0] ?? '').toLowerCase()
  const arg = (words[1] ?? '').toLowerCase()
  // /lk alone opens the hub, /lk stage the Stage pane; both words come before a stage id, so they shadow one
  if (!verb) {
    await readHubCommands($)
    return (await switchTo($, '', HUB_ID, 'loopkeeper')) ? {} : { text: 'Could not open the loopkeeper hub.' }
  }
  if (verb === 'stage') {
    await readHubCommands($)
    return (await switchTo($, '', PANE_ID, 'Stage')) ? {} : { text: 'Could not open the Stage pane.' }
  }
  if (verb === 'help') return { text: KEYS_TEXT }
  if (verb === 'next') return { text: (await step($, 1)).text }
  if (verb === 'back') return { text: (await step($, -1)).text }
  if (verb === 'approve') {
    if (!fromPerson) return { text: 'Only the person can approve a gate.' }
    const outcome = await approveGate($)
    await continueAfter($, outcome, 'The user ran /lk approve.', true)
    return { text: outcome.text }
  }
  if (verb === 'reset') return { text: (await resetPipeline($)).text }
  if (verb === 'preset') return { text: (await choosePreset($, arg)).text }
  if (verb === 'waive') return { text: (await waive($)).text }
  if (verb === 'size') {
    if (arg !== 'small' && arg !== 'large') return { text: 'Usage: /lk size small|large' }
    return { text: (await sizeTask($, arg, 'command')).text }
  }
  if (verb === 'small-max') {
    if (!arg) return { text: 'A small task may touch at most ' + (await read($, stageSmallMax)) + ' files. Usage: /lk small-max <1-20>' }
    const n = smallMaxOf(arg)
    if (n === undefined) return { text: 'Usage: /lk small-max <n>, a whole number from 1 to 20.' }
    await update($, stageSmallMax, () => n)
    return { text: 'A small task may now touch at most ' + n + ' file' + (n === 1 ? '' : 's') + ' (this session).' }
  }
  if (verb === 'approval') {
    if (!arg) return { text: approvalLine(await read($, stageApproval), await read($, stageHoldPlan)) + '. Usage: /lk approval auto|ask' }
    if (arg !== 'auto' && arg !== 'ask') return { text: 'Usage: /lk approval auto|ask' }
    await update($, stageApproval, () => arg)
    // ADR 0005: one approval mode for all of loopkeeper, kept per project
    await storeSet($, approvalKey(await read($, stageCwd)), arg)
    return {
      text:
        arg === 'auto'
          ? "Plan approval: auto. A validator's consistent verdict opens the plan gate. Saved for this project."
          : 'Plan approval: ask. The user approves every plan with /lk approve. Saved for this project.',
    }
  }
  if (verb === 'auto') {
    if (arg !== 'on' && arg !== 'off') return { text: 'Usage: /lk auto on|off' }
    await update($, stageAuto, () => arg === 'on')
    return { text: 'Automatic stage moves are ' + arg + '.' }
  }
  if (OTHER_WORDS.includes(verb)) return undefined
  if (findStage(await read($, stageStages), verb)) return { text: (await moveTo($, verb, 'command', words.slice(1).join(' '))).text }
  return undefined
}

// /lk band [stage|gates|…] on|off: no concern named means every band, so the stage acts too
async function bandWord($: EngineInterface, rest: string[]): Promise<string> {
  const words = rest.map(w => w.toLowerCase())
  const named = words.filter(w => CONCERN_WORDS.includes(w))
  if (named.length > 0 && !named.includes('stage')) return ''
  const word = words.find(w => w === 'on' || w === 'off')
  if (!word) return 'The stage band is ' + ((await read($, stageBand)) ? 'on' : 'off') + '. Usage: /lk band [stage] on|off'
  await update($, stageBand, () => word === 'on')
  const saved = await storeSet($, BAND_KEY, word === 'on')
  return 'The stage band is ' + word + '.' + (saved ? '' : ' (this session only)')
}

type LkNext = (e: any) => Promise<{ text?: string } | undefined>

// Shared words (status, text, reload, band, on, off, loop) let the concerns after this one answer, then put the stage's
// line first; a stage word is answered here; anything else goes on down the chain.
async function lk($: EngineInterface, e: { args?: unknown; origin?: unknown }, next: LkNext): Promise<{ text?: string } | undefined> {
  const args = typeof e?.args === 'string' ? e.args : ''
  const origin = e?.origin as { kind?: unknown } | undefined
  const fromPerson = !origin || origin.kind === 'composer' || origin.kind === 'bridge' || origin.kind === 'sdk'
  const { sub, rest } = subOf(args)
  const shared = async (mine: () => Promise<string>) => {
    const r = await next(e)
    let line = ''
    try {
      line = await mine()
    } catch {
      line = PLUGIN + ': the stage could not answer "' + sub + '".'
    }
    return { ...(r ?? {}), text: joinText(line, r?.text) }
  }
  if (sub === 'status') return shared(() => statusText($))
  // /lk text: routing owns the word and answers last; the stage's part goes first
  if (sub === 'text') return shared(() => statusText($))
  if (sub === 'reload') return shared(async () => (await reloadConfig($)).text)
  if (sub === 'band') return shared(() => bandWord($, rest))
  if (sub === 'on' || sub === 'off') {
    // as gsd-orchestrator did: only a change of the mode switches the preset, and only while the loop is on
    const was = await read($, routeMode)
    return shared(async () => (was !== (sub === 'on') && (await read($, routeLoop)) ? gsdPreset($, sub === 'on') : ''))
  }
  if (sub === 'loop') {
    const word = (rest[0] ?? '').toLowerCase()
    return shared(async () => ((word === 'on' || word === 'off') && (await read($, routeMode)) ? gsdPreset($, word === 'on') : ''))
  }
  let own: { text?: string } | undefined
  try {
    own = await ownCommand($, args, fromPerson)
  } catch {
    return { text: 'The stage command failed. ' + USAGE }
  }
  return own ?? next(e)
}

async function tick($: EngineInterface): Promise<void> {
  try {
    const t = await $.clock.now()
    await update($, stageNow, () => t)
  } catch {
    // the next tick tries again
  }
}

// ---- Wiring ------------------------------------------------------------------------------------------------------

export function wireStage(on: On): void {
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    try {
      // ADR 0012: a person at the prompt, or an app surface attached (see live), lets an approval carry the task on
      const interactive = (e as { isInteractive?: unknown }).isInteractive !== false
      await update($, stageInteractive, () => interactive)
      await update($, stageTurnRunning, () => false)
      await update($, stageContinuePending, () => null)
      await update($, stageContinueSent, cur => ({ seq: cur.seq, live: false }))
    } catch {
      // the defaults stand
    }
    try {
      await init($)
    } catch {
      // never block the session
    }
    try {
      ticker?.cancel()
    } catch {
      // a timer of an earlier session
    }
    try {
      ticker = $.clock.every(TICK_MS, () => tick($))
    } catch {
      ticker = null
    }
    try {
      await $.tool.register({
        name: TOOL.setStage,
        description: TOOL_DESCRIPTION,
        isDeferred: false,
        inputSchema: {
          type: 'object',
          properties: {
            stage: { type: 'string', description: 'The stage id to move to, such as plan, build, qa or ship' },
            note: { type: 'string', description: 'One line on what you are about to do in this stage' },
            size: {
              type: 'string',
              enum: ['small', 'large'],
              description: 'With stage plan: the task size. small = one clear change in at most 3 files; else large',
            },
            files: {
              type: 'number',
              description: 'With stage plan and size large: how many files the plan touches; approving the plan approves a file budget from it',
            },
            verdict: {
              type: 'string',
              enum: ['consistent', 'issues'],
              description: 'With stage validate-plan: what the plan validator subagent found',
            },
          },
          required: ['stage'],
        },
      })
    } catch {
      // the tool is optional; the heuristics and the command still work
    }
    for (const name of ['lk', 'loopkeeper']) {
      try {
        await $.command.register({
          name,
          description: 'loopkeeper: stage, gates, routing, review loops and decisions',
          argumentHint: '[stage | help | status | <stage> | next | back | approve | size small|large | preset <name> | approval auto|ask | gates … | routes | on | off | reload | band]',
          immediate: true,
        })
      } catch {
        // a taken name leaves the hooks running without the command
      }
    }
    const r = await next(e)
    // ADR 0004: a session that starts with GSD mode and the loop on starts in the gsd preset. Read after the other
    // concerns' session start, so routing has loaded its stored switches.
    try {
      if ((await read($, routeMode)) && (await read($, routeLoop)) && (await read($, stagePreset)) !== 'gsd') await choosePreset($, 'gsd')
    } catch {
      // the stages stay as they are
    }
    return r
  })

  // /clear, /resume and /branch reset $.state without a new session.start
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try {
      await init($)
    } catch {
      // nothing to do
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Claude's own tool: answered here, never passed on
  on('tool.call', { tool: 'mcp__loopkeeper__set_stage' }, async ($, e) => {
    const call = e as unknown as { stage?: unknown; note?: unknown; size?: unknown; verdict?: unknown; files?: unknown }
    const target = typeof call.stage === 'string' ? call.stage : ''
    const note = typeof call.note === 'string' ? call.note : undefined
    const list = await read($, stageStages)
    if (!target) return { deny: 'Pass `stage`, one of: ' + validIds(list) + '.' }
    if (call.size !== undefined && call.size !== 'small' && call.size !== 'large') return { deny: 'Pass `size` as small or large.' }
    if (call.verdict !== undefined && call.verdict !== 'consistent' && call.verdict !== 'issues') {
      return { deny: 'Pass `verdict` as consistent or issues.' }
    }
    const files = planFilesOf(call.files)
    if (!files.ok) return { deny: 'Pass `files` as a whole number from 1: how many files the plan touches.' }
    const role = roleOf(findStage(list, target))
    const counted = role === 'plan' && call.size === 'large'
    const unused = files.value !== null && !counted ? ' `files` counts only with stage plan and size large; it was not recorded.' : ''
    if (role === 'plan' && (call.size === 'small' || call.size === 'large')) {
      const sized = await sizeTask($, call.size, 'tool', note, counted ? files.value : null)
      if (sized.ok) lastHeld = ''
      return sized.ok ? { result: sized.text + unused } : { deny: sized.text }
    }
    if (role === 'validate-plan' && (call.verdict === 'consistent' || call.verdict === 'issues')) {
      const judged = await recordVerdict($, call.verdict === 'consistent', 'tool', note)
      if (judged.ok) lastHeld = ''
      return judged.ok ? { result: judged.text + unused } : { deny: judged.text }
    }
    const remind = role === 'plan' && stageForRole(list, 'validate-plan')?.gate === true ? ' ' + SIZE_REMINDER : ''
    const from = await read($, stageCurrent)
    const outcome = await moveTo($, target, 'tool', note)
    if (outcome.ok) {
      lastHeld = ''
      const budget = await budgetOnLeavingPlan($, from)
      return { result: outcome.text + (budget ? ' ' + budget : '') + ' Stage ids: ' + validIds(list) + '.' + remind + unused }
    }
    if (outcome.reason === 'same') return { result: outcome.text + remind + unused }
    return { deny: outcome.text }
  }).catch(async ($, e, next) => ({ deny: PLUGIN + ' could not record the stage (' + next.error.kind + '). Try again.' }))

  // The review_cycle wrapper, outermost: let the review concern answer, then read its atom (never the result text).
  // A plan pass that was recorded and is done by review-loop's own rule records the consistent verdict the way
  // set_stage {stage:'validate-plan', verdict:'consistent'} does: the gate opens in auto mode, with the file budget.
  on('tool.call', { tool: 'mcp__loopkeeper__review_cycle' }, async ($, e, next) => {
    const name = subjectName((e as unknown as { subject?: unknown }).subject)
    let before: LkSubject | undefined
    try {
      const found = findSubject(await read($, reviewSubjects), name)
      before = found === undefined ? undefined : (JSON.parse(JSON.stringify(found)) as LkSubject)
    } catch {
      before = undefined
    }
    const answer = await next(e)
    try {
      const subjects = await read($, reviewSubjects)
      const denied = (answer as { deny?: unknown } | undefined)?.deny !== undefined
      if (
        !denied &&
        passRecorded(before, findSubject(subjects, name)) &&
        planPassConsistent(subjects, name) &&
        planPassApplies(await read($, stageStages), await read($, stageCurrent))
      ) {
        const judged = await recordVerdict($, true, 'tool', 'plan review: ' + name)
        if (judged.ok) lastHeld = ''
        const res = (answer ?? {}) as { result?: unknown }
        if (typeof res.result === 'string') return { ...res, result: res.result + '\n\n' + PLUGIN + ' stage: ' + judged.text } as typeof answer
      }
    } catch {
      // the wrapper only adds the verdict; the tool's own answer stands
    }
    return answer
  }).catch(($, e, next) => next(e))

  // Heuristics: observe every other tool call in the main loop. An Agent call is also watched to its end: when next(e)
  // resolves without a refusal, it may satisfy the current stage's requiresAgent.
  on('tool.call', async ($, e, next) => {
    const call = e as unknown as Record<string, unknown>
    const mine = call.tool !== TOOL_FULL.setStage && !call.agentId
    if (mine) {
      try {
        await autoMove($, call)
      } catch {
        // a heuristic never gets in the tool's way
      }
    }
    const r = await next(e)
    if (mine && (call.tool === 'Agent' || call.tool === 'Task')) {
      const res = (r ?? {}) as { deny?: unknown; isError?: unknown }
      if (res.deny === undefined && res.isError !== true) {
        try {
          await noteAgent($, call)
        } catch {
          // the agent's result stands either way
        }
      }
    }
    return r
  }).catch(($, e, next) => next(e))

  // The user's prompt may ask to approve the plan itself: observed, never changed. Only a prompt the person sent
  // (typed, through the bridge, or the SDK host's own) can set the hold; a plugin's, a peer's or a notification never does.
  // The person's prompt with no turnId was typed while the session was idle: a main turn still marked running (its
  // turn.complete never came) is cleared first, with the approval it held back.
  on('prompt.submit', async ($, e, next) => {
    try {
      const origin = (e as { origin?: { kind?: unknown } }).origin
      const fromPerson = !origin || origin.kind === 'composer' || origin.kind === 'bridge' || origin.kind === 'sdk'
      if (fromPerson && !(e as { turnId?: unknown }).turnId && (await read($, stageTurnRunning))) {
        await update($, stageTurnRunning, () => false)
        await update($, stageContinuePending, () => null)
      }
      if (fromPerson && wantsHold((e as { text?: unknown }).text)) {
        await update($, stageHoldPlan, () => true)
        await update($, stageHoldBound, () => false)
        toast($, PLUGIN + ': plan approval will wait for you (asked in the prompt)')
      }
    } catch {
      // the prompt goes on either way
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ADR 0012: whether a main turn runs. A subagent's run raises no turn.start; its turn.complete carries an agentId.
  on('turn.start', {}, async ($, e, next) => {
    try {
      await update($, stageTurnRunning, () => true)
      await update($, stageContinueSent, cur => ({ seq: cur.seq, live: false }))
    } catch {
      // the turn goes on either way
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The main turn's end (any reason, 'aborted' too) clears running and submits an approval it held back, if the
  // stage is still the one the approval left and the conditions still hold. An interrupted turn drops it unsent:
  // the person stopped the model, so it does not carry on by itself. An answered main turn first gets the next-step
  // line, so it comes before the continue prompt. The answer's text goes on unchanged.
  on('turn.complete', {}, async ($, e, next) => {
    const r = await next(e)
    if ((e as { agentId?: unknown }).agentId) return r
    const ended = e as { isAborted?: unknown; reason?: unknown }
    const aborted = ended.isAborted === true || ended.reason === 'aborted'
    // answered: not an interrupt, a refusal or an API error
    const answered = !aborted && !['refusal', 'error'].includes(String(ended.reason))
    // The next-step line after an answered main turn: a notice in the chat (dim; Claude does not read it)
    if (answered) {
      try {
        const line = await nextLine($)
        if (line) logNotice($, line)
      } catch {
        // the answer stands as it is
      }
    }
    try {
      await update($, stageTurnRunning, () => false)
      const pending = await read($, stageContinuePending)
      if (pending) {
        await update($, stageContinuePending, () => null)
        if (!aborted && (await read($, stageCurrent)) === pending.stage && (await mayContinue($))) {
          const seq = await claimContinue($)
          if (seq !== null) submitContinue($, pending.text, seq)
        }
      }
    } catch {
      // the turn's answer stands
    }
    return r
  }).catch(($, e, next) => next(e))

  // The growth guard: a small task may touch only so many files, in the main loop and subagents alike.
  // CLAUDE_MODS_DISABLE=loopkeeper turns it off (ADR 0009); the band says so.
  // It judges before the hooks beneath, so the gates never count (or ask about) a file it refuses; a path it reserved
  // is released when the call is refused (the tool.call hook below), so a refused file is not one the task touched.
  on('tool.check', { tool: GUARDED_TOOLS }, async ($, e, next) => {
    if (e.tool_use_id === undefined || (await read($, stageDisabled))) return next(e)
    const run = guardChain.then(() => guardEdit($, e.input))
    guardChain = run.catch(() => undefined)
    let judged: Guarded = {}
    try {
      judged = await run
    } catch {
      // the guard never gets in the way of an edit it could not judge
    }
    if (judged.held) return { decision: 'deny', reason: judged.held.reason }
    if (judged.reserved !== undefined) reservedFor.set(e.tool_use_id, judged.reserved)
    return next(e)
  }).catch(($, e, next) => (next.called ? { decision: 'ask' } : next(e)))

  on('tool.call', { tool: GUARDED_TOOLS }, async ($, e, next) => {
    const r = await next(e)
    const path = e.tool_use_id === undefined ? undefined : reservedFor.get(e.tool_use_id)
    if (e.tool_use_id !== undefined) reservedFor.delete(e.tool_use_id)
    if (path !== undefined && (r as { deny?: unknown } | null)?.deny !== undefined) {
      const undo = guardChain.then(() => releaseEdit($, path))
      guardChain = undo.catch(() => undefined)
      try {
        await undo
      } catch {
        // the refusal stands either way
      }
    }
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'lk' }, async ($, e, next) => lk($, e as { args?: unknown; origin?: unknown }, next as LkNext)).catch(async ($, e, next) => {
    const r = next.called ? ((await next(e)) as { text?: string } | undefined) : undefined
    return { ...(r ?? {}), text: joinText(PLUGIN + ': the stage command failed. ' + USAGE, r?.text) }
  })
  on('command.run', { command: 'loopkeeper' }, async ($, e, next) => lk($, e as { args?: unknown; origin?: unknown }, next as LkNext)).catch(async ($, e, next) => {
    const r = next.called ? ((await next(e)) as { text?: string } | undefined) : undefined
    return { ...(r ?? {}), text: joinText(PLUGIN + ': the stage command failed. ' + USAGE, r?.text) }
  })

  // The band's first line: the stepper and its marks, the time in the stage, the size, the file budget in force and
  // any warning. Under it, while the plan or its file budget waits for the user, the approve button.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const props = (e.props ?? {}) as { hasSurvey?: boolean; bodyColumns?: number }
    if (props.hasSurvey === true || !(await read($, stageBand))) return next(e)
    const els = $.ui.resolve(e) as unknown as Elements
    const k = makeKit(els, e.surface)
    const state = await budgetState($)
    const warnings = [await read($, stageVersionNote), (await read($, stageDisabled)) ? DISABLED_NOTE : ''].filter(Boolean)
    const segs = fitBand(
      {
        stages: state.stages,
        current: state.current,
        approved: state.approved,
        history: await read($, stageHistory),
        now: await read($, stageNow),
        auto: await read($, stageAuto),
        verified: await read($, stageVerified),
        size: state.size,
        budget: state.budget,
        warnings,
      },
      typeof props.bodyColumns === 'number' && props.bodyColumns > 0 ? props.bodyColumns : 80,
    )
    const line = els.Box({
      key: 'stage-band',
      flexDirection: 'row',
      height: 1,
      children: segs.map(s => k.text(s.text, { color: s.tone ? TONES[s.tone].fg : undefined, bold: s.bold === true ? true : undefined, wrap: 'truncate' })),
    })
    const button = bandButton({ ...state, approval: await read($, stageApproval), hold: await read($, stageHoldPlan) })
    const mine = button
      ? els.Box({
          flexDirection: 'column',
          children: [
            line,
            k.buttons([
              {
                key: 'stage-approve',
                label: button.label,
                plain: true,
                onPress: async () => {
                  const outcome = button.kind === 'plan' ? await approveGate($) : await approveWaitingBudget($)
                  tell($, outcome)
                  await continueAfter($, outcome, 'The user pressed ' + button.label + '.')
                },
              },
            ]),
          ],
        })
      : line
    const theirs = await next(e)
    if (!theirs) return mine as never
    return els.Box({ flexDirection: 'column', children: [mine, theirs] }) as never
  })

  // The Stage pane (/lk stage, or 1 in any loopkeeper pane), drawn with the kit: hero, stepper and bar, tiles, gates, history, buttons
  on('ui.render', { component: 'Pane', requestId: 'loopkeeper-stage' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const els = $.ui.resolve(e) as unknown as Elements
    const k = makeKit(els, e.surface)
    const state = await budgetState($)
    const list: readonly Stage[] = state.stages
    const cur = state.current
    const ok = state.approved
    const hist = await read($, stageHistory)
    const t = await read($, stageNow)
    const chosen = await read($, stagePreset)
    const from = await read($, stageSource)
    const done = await read($, stageVerified)
    const waivedIds = await read($, stageWaived)
    const files = (await read($, stageFilesTouched)).length
    const max = await read($, stageSmallMax)
    const mode = await read($, stageApproval)
    const held = await read($, stageHoldPlan)
    const verdict = await read($, stageVerdict)
    const limits = await read($, stageLimits)
    const ci = Math.max(0, indexOf(list, cur))
    const label = labelOf(list, cur)
    const waiting = (s: Stage | undefined) => s?.gate === true && !ok.includes(s.id)
    const warnings = [await read($, stageVersionNote), (await read($, stageDisabled)) ? DISABLED_NOTE : ''].filter(Boolean)

    const latest = hist[hist.length - 1]
    const hero = k.hero({
      kicker: 'stage',
      title: label,
      sub: [
        (chosen === 'file' ? CONFIG_LABEL : 'preset ' + chosen) + (from === 'file' && chosen !== 'file' ? ' · ' + CONFIG_LABEL : ''),
        'auto ' + ((await read($, stageAuto)) ? 'on' : 'off'),
        latest?.note ?? '',
        ...warnings,
      ]
        .filter(Boolean)
        .join(' · '),
      tone: warnings.length > 0 || waiting(list[ci]) ? 'warn' : 'info',
    })
    // the next-step sentence, its own line under the hero
    const nextText = els.Box({ key: 'next-step', flexDirection: 'column', children: [k.text(await nextSentence($), { wrap: 'wrap' })] })

    // ✓ Plan ─ ● Execute ⚑ ─ ○ QA ─ ○ Ship ⚑, then a bar of the stages done
    const steps = els.Text({
      wrap: 'wrap',
      children: list.flatMap((s, i) => {
        const text = (i < ci ? '✓ ' : i === ci ? '● ' : '○ ') + s.label + (s.gate === true ? ' ⚑' : '') + (s.requiresAgent ? ' ⇄' : '')
        const tone: Tone = i === ci ? (waiting(s) ? 'warn' : 'info') : i < ci ? 'ok' : 'muted'
        const chip = k.text(text, { color: TONES[tone].fg, bold: i === ci ? true : undefined })
        return i === 0 ? [chip] : [' ─ ', chip]
      }),
    })
    const stepper = k.row({ key: 'stepper', left: [steps] })
    const since = enteredAt(hist, cur)
    const ratio = list.length > 0 ? ci / list.length : 0
    const where = since ? 'in ' + label + ' for ' + elapsed(t - since.at) : ''
    // kit v3: a full-width kit.progress Svg where the surface draws Svg, the time under it; the terminal keeps the text bar
    const progress =
      e.surface !== 'terminal' && typeof els.Svg === 'function'
        ? k.stack([k.progress(ratio, { tone: 'ok' }), where ? k.row({ key: 'progress', left: [], right: where }) : null])
        : k.row({ key: 'progress', left: [k.bar(ratio, { width: 20, tone: 'ok' })], right: where })

    const sz = state.size
    const tiles = k.tiles([
      { label: 'Stage', value: ci + 1 + ' of ' + list.length, tone: 'info' },
      { label: 'Size', value: sz === 'small' ? 'small ' + files + '/' + max : sz === 'large' ? 'large' : '—', tone: sz ? undefined : 'muted' },
      { label: 'Approval', value: held ? 'held' : mode, tone: held || mode === 'ask' ? 'warn' : undefined },
      { label: 'Verdict', value: verdict ? (verdict.ok ? 'ok' : 'issues') : '—', tone: verdict ? (verdict.ok ? 'ok' : 'danger') : 'muted' },
      {
        label: 'File budget',
        value: state.budget > 0 ? state.budget + ' a turn' : state.planFiles !== null ? state.planFiles + ' planned' : 'base ' + limits.base,
        tone: state.budget > 0 ? 'info' : budgetWaits(state) ? 'warn' : 'muted',
      },
    ])

    // One row per gate (approved by the user, open by itself, or waiting) and per verifier stage
    const gates = list.filter(s => s.gate === true)
    const gateRows: unknown[] = []
    list.forEach((s, i) => {
      if (s.gate === true) {
        const isOk = ok.includes(s.id)
        const self = waivedIds.includes(s.id) || hist.some(h => h.stage === s.id && h.event === 'approved')
        const word = isOk ? (self ? 'open' : 'approved') : 'waiting'
        const tone: Tone = isOk ? (self ? 'info' : 'ok') : i <= ci ? 'warn' : 'muted'
        gateRows.push(
          k.row({
            key: 'gate-' + s.id,
            left: ['⚑ ' + s.label],
            right: !isOk && i === ci ? ['press a to approve', k.badge(word, tone)] : [k.badge(word, tone)],
          }),
        )
      }
      if (s.requiresAgent) {
        const isDone = done.includes(s.id)
        gateRows.push(
          k.row({
            key: 'verifier-' + s.id,
            left: ['⇄ ' + s.label + ' verifier'],
            right: isDone ? [verifiedBy(hist, s.id).slice(0, 48), k.badge('verified', 'ok')] : [k.badge('needed', i <= ci ? 'warn' : 'muted')],
          }),
        )
      }
    })
    if (gateRows.length === 0) gateRows.push(k.text('No gates', { color: TONES.muted.fg }))
    const gatesHead = k.section('Gates', gates.length > 0 ? gates.filter(s => ok.includes(s.id)).length + ' of ' + gates.length + ' open' : '')

    // The last 8 entries, newest first: time, what happened, stage · by · note
    const recent = hist.slice(-8).reverse()
    const event = (h: Transition): [string, Tone] =>
      h.event === 'verified'
        ? ['verified', 'ok']
        : h.event === 'approved'
          ? ['gate open', 'ok']
          : h.event === 'ship-attempt'
            ? ['ship', 'warn']
            : h.by === 'resume'
              ? ['resume', 'muted']
              : ['moved', 'info']
    const historyRows =
      recent.length === 0
        ? [k.text('nothing yet', { color: TONES.muted.fg })]
        : recent.map((h, i) => {
            const [word, tone] = event(h)
            return k.row({
              key: 'history-' + i,
              left: [
                k.text(clock(h.at), { color: TONES.muted.fg }),
                k.badge(word, tone),
                labelOf(list, h.stage) + ' · ' + h.by + (h.note ? ' · ' + h.note : ''),
              ],
            })
          })

    const buttons = k.buttons([
      { key: 'back', label: 'Back', hotkey: 'b', plain: true, onPress: async () => tell($, await step($, -1)) },
      { key: 'next', label: 'Next', hotkey: 'n', plain: true, onPress: async () => tell($, await step($, 1)) },
      {
        key: 'approve',
        label: 'Approve gate',
        hotkey: 'a',
        plain: true,
        onPress: async () => {
          const outcome = await approveGate($)
          tell($, outcome)
          await continueAfter($, outcome, 'The user pressed Approve gate.')
        },
      },
      { key: 'reset', label: 'Reset', hotkey: 'r', plain: true, onPress: async () => tell($, await resetPipeline($)) },
      { key: 'close', label: 'Close', hotkey: 'c', plain: true, onPress: async () => closePane($) },
    ])
    return k.page([
      k.nav(navItems($, PANE_ID), 'stage'),
      k.stack([hero, nextText]),
      k.stack([stepper, progress]),
      tiles,
      k.stack([gatesHead, ...gateRows]),
      k.stack([k.section('History · ' + hist.length), ...historyRows]),
      buttons,
    ]) as never
  })

  // The other mods' commands are read again whenever the hub opens without /lk: here for an open from a hook (another
  // plugin's); a Button's onPress runs beneath every hook, so its open skips this plugin's own ui.open hooks ...
  on('ui.open', {}, async ($, e, next) => {
    if ((e as { id?: unknown }).id === HUB_ID) await readHubCommands($)
    return next(e)
  })

  // ... and here for a press that opens it: the Hub item of a loopkeeper pane's nav bar.
  on('ui.press', { plugin: PLUGIN, element: ['hub'] }, async ($, e, next) => {
    await readHubCommands($)
    return next(e)
  })

  // The hub (/lk alone): the frame around the concerns' rows, outermost of the hub chain since the stage is wired
  // first. The hero, the Panels header and the Stage row; then each later concern's row (next); then the other mods
  // and the actions. The rows show with the band off or the kill switch on; a failure draws what the chain drew.
  on('ui.render', { component: 'Pane', requestId: HUB_ID }, async ($, e, next) => {
    if (e.requestId !== HUB_ID) return next(e)
    let asked = false
    let theirs: unknown = null
    try {
      const els = $.ui.resolve(e) as unknown as Elements
      const k = makeKit(els, e.surface)
      const state = await budgetState($)
      const list: readonly Stage[] = state.stages
      const ci = Math.max(0, indexOf(list, state.current))
      const cur = list[ci]
      const chosen = await read($, stagePreset)
      const approval = await read($, stageApproval)
      const gsd = await read($, routeMode)
      const warnings = [await read($, stageVersionNote), (await read($, stageDisabled)) ? DISABLED_NOTE : ''].filter(Boolean)
      // something waits for the user: the current stage's gate, or the band's plan or budget approval
      const button = bandButton({ ...state, approval, hold: await read($, stageHoldPlan) })
      const waits = button !== null || (cur?.gate === true && !state.approved.includes(cur.id))
      // while a task is in play (sized, or past the first stage), `a` also opens the next stage's gate from the stage
      // before it, as the next-step sentence offers; nothing waits for the user there, so the hero's tone stays
      const ahead = (state.size !== '' || ci > 0) && approveAhead(await nextState($)) !== undefined
      const hero = k.hero({
        kicker: 'LOOPKEEPER',
        icon: '⚑',
        title: labelOf(list, state.current) + ' · ' + (ci + 1) + ' of ' + list.length,
        sub: [chosen === 'file' ? CONFIG_LABEL : 'preset ' + chosen, 'approval ' + approval, 'GSD ' + (gsd ? 'on' : 'off'), ...warnings].join(' · '),
        tone: warnings.length > 0 || waits ? 'warn' : 'info',
      })
      // the next-step sentence, its own line under the hero
      const nextText = els.Box({ key: 'next-step', flexDirection: 'column', children: [k.text(await nextSentence($), { wrap: 'wrap' })] })
      // the band line's words without its label, quiet
      const band = fitBand(
        {
          stages: list,
          current: state.current,
          approved: state.approved,
          history: await read($, stageHistory),
          now: await read($, stageNow),
          auto: await read($, stageAuto),
          verified: await read($, stageVerified),
          size: state.size,
          budget: state.budget,
        },
        400,
      )
      const words = band.slice(1).map(s => s.text).join('').trim()
      const stageRow = k.row({
        key: 'hub-stage',
        left: [
          els.Button({
            key: 'panel-stage',
            label: 'Stage',
            hotkey: '1',
            plain: true,
            onPress: async (press?: { surface?: unknown }) => {
              if (!(await switchTo($, HUB_ID, PANE_ID, 'Stage', press?.surface))) toast($, 'Could not open the Stage pane.')
            },
          }),
          k.text(words, { color: TONES.muted.fg, wrap: 'truncate' }),
        ],
      })
      asked = true
      theirs = await next(e)
      const listed = await read($, stageHubCommands)
      const mods = HUB_MODS.filter(m => listed.some(c => c.name === m.command && (m.plugins as readonly string[]).includes(c.plugin ?? '')))
      const approveLabel = button ? button.label : 'Approve gate'
      const actions = [
        {
          key: 'hub-approve',
          label: approveLabel,
          hotkey: 'a',
          // the band button's path, so a changed approval continues the task (ADR 0012)
          onPress: async () => {
            const outcome = button?.kind === 'budget' ? await approveWaitingBudget($) : await approveGate($)
            tell($, outcome)
            await continueAfter($, outcome, 'The user pressed ' + approveLabel + '.')
          },
        },
        { key: 'hub-gsd', label: gsd ? 'GSD off' : 'GSD on', hotkey: 'o', onPress: () => offerGsd($, !gsd) },
        {
          key: 'hub-close',
          label: 'Close',
          hotkey: 'c',
          onPress: async () => {
            try {
              await $.ui.close({ id: HUB_ID })
            } catch {
              // already closed
            }
          },
        },
      ].filter(b => b.key !== 'hub-approve' || waits || ahead)
      // kit 3.1: the sections one row apart (page); each section tight inside. The mods and actions are
      // plain kit buttons (`m: Agents`), so a wrapped row keeps the kit's gaps.
      const modButtons = mods.map(m => ({
        key: m.key,
        label: m.label,
        hotkey: m.hotkey,
        plain: true,
        onPress: (press?: unknown) => openMod($, m, (press as { surface?: unknown } | undefined)?.surface),
      }))
      return k.page([
        k.stack([hero, nextText]),
        k.stack([k.header('Panels'), stageRow, theirs]),
        mods.length > 0 ? k.stack([k.header('Other mods'), k.buttons(modButtons)]) : null,
        k.buttons(actions.map(b => ({ ...b, plain: true }))),
      ]) as never
    } catch {
      return (asked ? theirs : await next(e)) as never
    }
  })
}
