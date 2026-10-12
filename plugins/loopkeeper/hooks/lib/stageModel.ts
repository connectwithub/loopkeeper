// Stage concern, pure: the stage list and its presets, the move rules, the tool-call heuristics, sizing and the
// growth guard, the plan verdict, the file budget and the band's text. Ported from pipeline-stage's pipeline.ts.
// Nothing here touches $, so tests call it directly.

import { DEFAULT_PLAN_PATHS } from './config.ts'
import { CONFIG_FILE, MIN_VERSION, PLUGIN, storeKey, versionAtLeast } from './names.ts'
import { blocking, findSubject, lastCycle, nameOf, reached } from './reviewModel.ts'
import type { LkSubject } from '../../types/index.d.ts'

export { DEFAULT_PLAN_PATHS }

// requiresAgent: a regex (case-insensitive) an Agent call's subagent_type or description must match,
// and that call must complete while the stage machine is in the stage, before it may move forward past it
export type Stage = { id: string; label: string; gate?: boolean; requiresAgent?: string }
export type By = 'tool' | 'command' | 'auto' | 'resume'
// An entry with an event is a note, not a move: 'ship-attempt' is a shipping command met by a ship gate,
// 'verified' is a verifier agent that satisfied the stage's requiresAgent, 'approved' a gate opened without
// the user's /lk approve (a small task's waiver or a validator's verdict). None counts as entering the stage.
export type Transition = { stage: string; at: number; by: By; note?: string; event?: 'ship-attempt' | 'verified' | 'approved' }
// The task's size: '' until Claude or the user sizes it
export type Size = '' | 'small' | 'large'
// Whether a plan validator's verdict may open the plan gate by itself ('auto') or the user approves plans ('ask')
export type Approval = 'auto' | 'ask'
// What a plan validator found, recorded through set_stage {stage:'validate-plan', verdict}
export type Verdict = { ok: boolean; by: string; at: number }
// The pipeline section of the config files, as the stage machine reads it
export type Config = {
  stages: Stage[]
  auto: boolean
  source: 'file' | 'default'
  error?: string
  // whether the section gave an explicit, valid "stages" list
  hasStages?: boolean
  // presets the section defines, by name
  presets?: Record<string, Stage[]>
  // the plan-gate approval mode the section sets, if any
  approval?: Approval
  // how many files a small task may touch, if the section sets it (1–20)
  smallMaxFiles?: number
  // whether a user's approval submits a prompt that carries the task on, if the section sets it
  continueOnApprove?: boolean
  // whether the next-step line shows, a notice line in the chat after each answer (dim; Claude does not read it), if
  // the section sets it
  nextHint?: boolean
}
// What a project keeps in $.store between sessions
export type Saved = {
  stage: string
  at: number
  approved: string[]
  verified: string[]
  size: Size
  planVerdict: Verdict | null
  waived: string[]
  filesTouched: string[]
  // the file count the plan said it touches, or null
  planFiles: number | null
  // the approved file budget, 0 for none
  budget: number
}
// The numbers the file budget is made of, from the changeControl section
export type Limits = { base: number; slack: number; autoMax: number }

export const SMALL_MAX_DEFAULT = 3
export const SMALL_MAX_LIMIT = 20
export const DEFAULT_LIMITS: Limits = { base: 10, slack: 10, autoMax: 40 }

export const DEFAULT_STAGES: Stage[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'build', label: 'Build' },
  { id: 'qa', label: 'QA' },
  { id: 'ship', label: 'Ship' },
]

// The task loop: plan, the user approves it, execute through subagents, a verifier checks it, tests, ship on a yes
export const GSD_STAGES: Stage[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'validate-plan', label: 'Validate plan', gate: true, requiresAgent: 'valid|review|verif|critic|audit|plan' },
  { id: 'execute', label: 'Execute' },
  { id: 'validate', label: 'Validate', requiresAgent: 'verif|valid|review|critic|audit|test|qa' },
  { id: 'qa', label: 'QA' },
  { id: 'ship', label: 'Ship', gate: true },
]

export const BUILTIN_PRESETS: Record<string, Stage[]> = { default: DEFAULT_STAGES, gsd: GSD_STAGES }

// Where the stage list comes from when it is not a preset: the pipeline section of loopkeeper.json
export const CONFIG_LABEL = CONFIG_FILE
const SECTION = 'the pipeline section of ' + CONFIG_FILE
export const HISTORY_CAP = 100
export const FILES_CAP = 200
const ID = /^[A-Za-z0-9_-]{1,40}$/

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function defaultConfig(error?: string): Config {
  const config: Config = { stages: DEFAULT_STAGES.map(s => ({ ...s })), auto: true, source: 'default', hasStages: false }
  if (error) config.error = error
  return config
}

function cloneStages(list: readonly Stage[]): Stage[] {
  return list.map(s => ({ ...s }))
}

// A requiresAgent value that compiles as a regex, or nothing
function agentPattern(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 200) return undefined
  try {
    new RegExp(raw, 'i')
    return raw
  } catch {
    return undefined
  }
}

// The valid stages of a list; invalid or duplicate ids are dropped
export function parseStages(list: unknown): Stage[] {
  if (!Array.isArray(list)) return []
  const stages: Stage[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const s = item as { id?: unknown; label?: unknown; gate?: unknown; requiresAgent?: unknown }
    const id = typeof s.id === 'string' ? s.id.trim() : ''
    if (!ID.test(id) || seen.has(id)) continue
    seen.add(id)
    const label = typeof s.label === 'string' && s.label.trim() ? s.label.trim().slice(0, 40) : id
    const stage: Stage = { id, label }
    if (s.gate === true) stage.gate = true
    const agent = agentPattern(s.requiresAgent)
    if (agent) stage.requiresAgent = agent
    stages.push(stage)
  }
  return stages
}

// Read a pipeline section (an object); anything malformed falls back to the default stages with a reason
export function parsePipeline(raw: unknown): Config {
  if (!raw || typeof raw !== 'object') return defaultConfig(SECTION + ' is not an object')
  const obj = raw as {
    stages?: unknown
    auto?: unknown
    presets?: unknown
    approval?: unknown
    smallMaxFiles?: unknown
    continueOnApprove?: unknown
    nextHint?: unknown
  }
  const extras: Pick<Config, 'approval' | 'smallMaxFiles' | 'continueOnApprove' | 'nextHint'> = {}
  if (obj.approval === 'auto' || obj.approval === 'ask') extras.approval = obj.approval
  const max = smallMaxOf(obj.smallMaxFiles)
  if (max !== undefined) extras.smallMaxFiles = max
  if (typeof obj.continueOnApprove === 'boolean') extras.continueOnApprove = obj.continueOnApprove
  if (typeof obj.nextHint === 'boolean') extras.nextHint = obj.nextHint
  // auto counts as a setting too: a section that only switches the heuristics off is valid
  const hasExtras = Object.keys(extras).length > 0 || typeof obj.auto === 'boolean'
  const presets: Record<string, Stage[]> = {}
  if (isObj(obj.presets)) {
    for (const [name, value] of Object.entries(obj.presets)) {
      if (!ID.test(name) || !value || typeof value !== 'object') continue
      const list = parseStages((value as { stages?: unknown }).stages)
      if (list.length > 0) presets[name] = list
    }
  }
  const hasPresets = Object.keys(presets).length > 0
  const auto = obj.auto !== false
  if (!Array.isArray(obj.stages) || obj.stages.length === 0) {
    if ((hasPresets || hasExtras) && obj.stages === undefined) {
      const config: Config = { stages: cloneStages(DEFAULT_STAGES), auto, source: 'file', hasStages: false, ...extras }
      if (hasPresets) config.presets = presets
      return config
    }
    const fallback: Config = { ...defaultConfig(SECTION + ' has no "stages" list'), ...extras }
    if (hasPresets) fallback.presets = presets
    return fallback
  }
  const stages = parseStages(obj.stages)
  if (stages.length === 0) return { ...defaultConfig(SECTION + ' has no valid stages'), ...extras }
  const config: Config = { stages, auto, source: 'file', hasStages: true, ...extras }
  if (hasPresets) config.presets = presets
  return config
}

// Parse the text of a pipeline section (as JSON); used by tests and for a section given on its own
export function parseConfig(text: string | null | undefined): Config {
  if (typeof text !== 'string' || text.trim() === '') return defaultConfig()
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return defaultConfig(SECTION + ' is not valid JSON')
  }
  return parsePipeline(raw)
}

// The pipeline section of the two config files (each parsed as a whole object): the project's keys over the
// user's, presets merged by name. No section in either file gives the default stages, with no error.
export function pipelineFromLayers(user: unknown, project: unknown): Config {
  const section = (layer: unknown): Record<string, unknown> | undefined =>
    isObj(layer) && isObj(layer.pipeline) ? layer.pipeline : undefined
  const u = section(user)
  const p = section(project)
  if (!u && !p) return defaultConfig()
  const merged: Record<string, unknown> = { ...(u ?? {}), ...(p ?? {}) }
  if (isObj(u?.presets) && isObj(p?.presets)) merged.presets = { ...u.presets, ...p.presets }
  return parsePipeline(merged)
}

// A planPaths list (changeControl.planPaths): non-empty glob strings (at most 100), or nothing (the defaults apply)
export function planPathsOf(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length > 100) return undefined
  if (!raw.every(g => typeof g === 'string' && g.trim() !== '')) return undefined
  return raw.map(g => String(g).trim())
}

// The file budget's numbers from the changeControl section: whole numbers, the base at least 1
export function limitsOf(cc: { maxFilesPerTurn?: unknown; planSlack?: unknown; autoBudgetMax?: unknown } | null | undefined): Limits {
  const whole = (v: unknown, min: number, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.floor(v) : fallback
  return {
    base: whole(cc?.maxFilesPerTurn, 1, DEFAULT_LIMITS.base),
    slack: whole(cc?.planSlack, 0, DEFAULT_LIMITS.slack),
    autoMax: whole(cc?.autoBudgetMax, 0, DEFAULT_LIMITS.autoMax),
  }
}

// A small glob, as the gates read it: `**` spans folders, `*` and `?` stay inside one name,
// and a glob with no `/` matches a file's name at any depth
export function globMatches(glob: string, path: string): boolean {
  const g = glob.replace(/^\.\//, '').replace(/^\/+/, '')
  let out = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i] ?? ''
    if (c === '*' && g[i + 1] === '*') {
      if ((i === 0 || g[i - 1] === '/') && g[i + 2] === '/') {
        out += '(?:.*/)?'
        i += 2
      } else {
        out += '.*'
        i += 1
      }
    } else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  const re = new RegExp(g.includes('/') ? '^' + out + '$' : '^(?:.*/)?' + out + '$')
  return re.test(path.replace(/^\/+/, ''))
}

// Claude Code's per-user temp root, where the session scratchpad lives (macOS resolves /tmp to /private/tmp)
const PLAN_TEMP = /^\/(?:private\/)?tmp\/claude-[^/]+\/./

// Whether a path is plan material: under the scratchpad (/tmp/claude-<uid>/...), or inside the project and
// matching one of the planPaths globs. Matched against the normalized path.
export function isPlanMaterial(path: string, cwd: string, globs: readonly string[] = DEFAULT_PLAN_PATHS): boolean {
  if (typeof path !== 'string' || path === '') return false
  const p = normalizePath(path, cwd || '/__project__')
  if (p.startsWith('/')) return PLAN_TEMP.test(p)
  return globs.some(g => globMatches(g, p))
}

// The /lk status line for plan material
export function planMaterialLine(globs: readonly string[]): string {
  return 'Plan material: ' + globs.join(', ') + ' + scratchpad'
}

// A small-task file limit from the config or the command: a whole number from 1 to 20, or nothing
export function smallMaxOf(raw: unknown): number | undefined {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > SMALL_MAX_LIMIT) return undefined
  return n
}

// The approval mode in force: the one saved for the project by /lk approval, else the config's, else auto
export function approvalOf(saved: unknown, config: Config | undefined): Approval {
  if (saved === 'auto' || saved === 'ask') return saved
  return config?.approval ?? 'auto'
}

// The stages of a preset by name: the config's own presets first, then the built-in ones
export function presetStages(config: Config | undefined, name: string): Stage[] | undefined {
  const own = config?.presets?.[name]
  if (own && own.length > 0) return cloneStages(own)
  const builtin = Object.prototype.hasOwnProperty.call(BUILTIN_PRESETS, name) ? BUILTIN_PRESETS[name] : undefined
  return builtin ? cloneStages(builtin) : undefined
}

export function presetNames(config: Config | undefined): string[] {
  return [...new Set([...Object.keys(BUILTIN_PRESETS), ...Object.keys(config?.presets ?? {})])]
}

// Which stages a session starts with: a preset chosen in this project before, else the config's
// explicit stages, else the default preset
export function chooseStages(config: Config, savedPreset: unknown): { stages: Stage[]; preset: string } {
  if (typeof savedPreset === 'string' && savedPreset !== '') {
    const list = presetStages(config, savedPreset)
    if (list) return { stages: list, preset: savedPreset }
  }
  if (config.source === 'file' && config.hasStages !== false) return { stages: cloneStages(config.stages), preset: 'file' }
  return { stages: cloneStages(DEFAULT_STAGES), preset: 'default' }
}

export function indexOf(stages: readonly Stage[], id: string): number {
  return stages.findIndex(s => s.id === id)
}

// Find a stage by id or label, ignoring case
export function findStage(stages: readonly Stage[], name: string): Stage | undefined {
  const n = String(name ?? '').trim().toLowerCase()
  if (!n) return undefined
  return stages.find(s => s.id.toLowerCase() === n) ?? stages.find(s => s.label.toLowerCase() === n)
}

export function labelOf(stages: readonly Stage[], id: string): string {
  return stages.find(s => s.id === id)?.label ?? id
}

// The first unapproved gate a move from `from` to `to` would cross, if any.
// A gate at index k blocks a move from i to j when i <= k < j: you may enter a gate stage, not leave it forward.
export function blockingGate(stages: readonly Stage[], approved: readonly string[], from: string, to: string): Stage | undefined {
  const i = Math.max(0, indexOf(stages, from))
  const j = indexOf(stages, to)
  if (j <= i) return undefined
  for (let k = i; k < j; k++) {
    const s = stages[k]
    if (s && s.gate === true && !approved.includes(s.id)) return s
  }
  return undefined
}

// The first stage needing a verifier agent that a forward move from `from` to `to` would leave unsatisfied.
// Like a gate, the requirement holds a move out of the stage (or across it), never into it.
export function blockingAgent(stages: readonly Stage[], verified: readonly string[], from: string, to: string): Stage | undefined {
  const i = Math.max(0, indexOf(stages, from))
  const j = indexOf(stages, to)
  if (j <= i) return undefined
  for (let k = i; k < j; k++) {
    const s = stages[k]
    if (s && s.requiresAgent && !verified.includes(s.id)) return s
  }
  return undefined
}

export const VERIFIER_HINT =
  "spawn a verifier subagent (a reviewer, validator or critic with fresh context) to check the work against the plan's Done-when, then try again"

export function agentMessage(stage: Stage, target: Stage): string {
  return (
    'The ' + stage.label + ' stage needs a verifier before the pipeline can move on to ' + target.label +
    ': ' + VERIFIER_HINT + '. Its subagent_type or description must match /' + stage.requiresAgent + '/i.'
  )
}

export type MoveCheck =
  | { ok: true; stage: Stage }
  | { ok: false; reason: 'unknown' | 'same' | 'gate' | 'agent'; message: string; gate?: Stage }

export function validIds(stages: readonly Stage[]): string {
  return stages.map(s => s.id).join(', ')
}

export function checkMove(
  stages: readonly Stage[],
  approved: readonly string[],
  from: string,
  target: string,
  verified: readonly string[] = [],
): MoveCheck {
  const stage = findStage(stages, target)
  if (!stage) {
    return { ok: false, reason: 'unknown', message: 'Unknown stage "' + target + '". Valid stage ids: ' + validIds(stages) + '.' }
  }
  if (stage.id === from) return { ok: false, reason: 'same', message: 'Already in ' + stage.label + '.' }
  const gate = blockingGate(stages, approved, from, stage.id)
  const needs = blockingAgent(stages, verified, from, stage.id)
  // whichever comes first along the way is what holds the move
  if (gate && (!needs || indexOf(stages, gate.id) <= indexOf(stages, needs.id))) {
    return {
      ok: false,
      reason: 'gate',
      gate,
      message:
        'The ' + gate.label + ' gate is not approved, so the pipeline cannot move past ' + gate.label +
        ' to ' + stage.label + '. Ask the user to review and run `/lk approve`, then try again' +
        (roleOf(gate) === 'validate-plan'
          ? "; or, if a validator subagent found the plan consistent, record it with set_stage {stage:'validate-plan', verdict:'consistent'}."
          : '.'),
    }
  }
  if (needs) return { ok: false, reason: 'agent', gate: needs, message: agentMessage(needs, stage) }
  return { ok: true, stage }
}

// The neighbour of the current stage, for next/back
export function neighbour(stages: readonly Stage[], current: string, step: 1 | -1): Stage | undefined {
  const i = indexOf(stages, current)
  return stages[(i < 0 ? 0 : i) + step]
}

// The gate /lk approve opens from the stage before it: the adjacent next stage when it has a gate (approved or not)
// and the current stage holds no unapproved gate of its own; undefined otherwise, and never a gate two stages ahead
export function gateAhead(stages: readonly Stage[], current: string, approved: readonly string[]): Stage | undefined {
  const i = indexOf(stages, current)
  const cur = stages[i]
  if (!cur || (cur.gate === true && !approved.includes(cur.id))) return undefined
  const next = stages[i + 1]
  return next?.gate === true ? next : undefined
}

const TEST_RUNNER =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bvitest\b|\bjest\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\bplaywright\b|\bclaude\s+plugin\s+(?:test|validate)\b/
const SHIP = /\bgit\s+commit\b|\bgit\s+push\b|\bgh\s+pr\s+create\b/
const QA_AGENT = /verif|valid|critic|review|test|audit|qa/i
export const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

// The role a tool call suggests, or nothing. `currentRole` is the current stage's role (for the Edit rule).
// An edit of plan material (judged against `cwd` and `planPaths`) suggests nothing: writing the plan is not building.
export function heuristicTarget(
  call: { tool?: unknown; command?: unknown; subagent_type?: unknown; description?: unknown; file_path?: unknown; notebook_path?: unknown },
  currentRole: string | undefined,
  cwd = '',
  planPaths: readonly string[] = DEFAULT_PLAN_PATHS,
): string | undefined {
  const tool = typeof call.tool === 'string' ? call.tool : ''
  if (tool === 'EnterPlanMode') return 'plan'
  if (tool === 'ExitPlanMode') return 'build'
  if (EDIT_TOOLS.includes(tool)) {
    const path = editPath(call)
    if (path !== undefined && isPlanMaterial(path, cwd, planPaths)) return undefined
    return currentRole === 'plan' || currentRole === 'validate-plan' ? 'build' : undefined
  }
  if (tool === 'Bash') {
    const cmd = typeof call.command === 'string' ? call.command : ''
    if (SHIP.test(cmd)) return 'ship'
    if (TEST_RUNNER.test(cmd)) return 'qa'
    return undefined
  }
  if (tool === 'Agent' || tool === 'Task') {
    return QA_AGENT.test(agentText(call)) ? 'qa' : undefined
  }
  return undefined
}

// The text an Agent call is matched on: its subagent_type and description
export function agentText(call: { subagent_type?: unknown; description?: unknown }): string {
  return [call.subagent_type, call.description].filter(v => typeof v === 'string').join(' ')
}

// Whether an Agent call satisfies a stage's requiresAgent
export function agentMatches(stage: Stage | undefined, call: { subagent_type?: unknown; description?: unknown }): boolean {
  if (!stage?.requiresAgent) return false
  try {
    return new RegExp(stage.requiresAgent, 'i').test(agentText(call))
  } catch {
    return false
  }
}

// Where a tool call would move the stage machine, resolved against the actual stages.
// `shipAttempt` means a shipping command met a gated ship stage: record it, do not move.
export function autoTarget(
  stages: readonly Stage[],
  call: Record<string, unknown>,
  current: string,
  cwd = '',
  planPaths: readonly string[] = DEFAULT_PLAN_PATHS,
): { stage?: Stage; shipAttempt?: Stage } {
  const role = heuristicTarget(call, roleOf(stages.find(s => s.id === current)), cwd, planPaths)
  if (!role) return {}
  const tool = typeof call.tool === 'string' ? call.tool : ''
  if (role === 'build' && tool === 'ExitPlanMode') {
    return { stage: stageForRole(stages, 'validate-plan') ?? stageForRole(stages, 'build') }
  }
  if (role === 'qa' && (tool === 'Agent' || tool === 'Task')) {
    // a validator spawned while planning checks the plan: it stays put (set_stage validate-plan counts it)
    const curRole = roleOf(stages.find(s => s.id === current))
    if ((curRole === 'plan' || curRole === 'validate-plan') && stageForRole(stages, 'validate-plan')) return {}
    return { stage: stageForRole(stages, 'validate') ?? stageForRole(stages, 'qa') }
  }
  if (role === 'ship') {
    const ship = stageForRole(stages, 'ship')
    if (ship?.gate === true) return { shipAttempt: ship }
    return { stage: ship }
  }
  return { stage: stageForRole(stages, role) }
}

const ROLES: Record<string, string> = {
  plan: 'plan',
  'validate-plan': 'validate-plan',
  build: 'build',
  execute: 'build',
  validate: 'validate',
  qa: 'qa',
  ship: 'ship',
}

// The role (plan, validate-plan, build, validate, qa, ship) a stage plays, by id or label.
// execute counts as build; a label's spaces count as dashes ("Validate plan").
export function roleOf(stage: Stage | undefined): string | undefined {
  if (!stage) return undefined
  for (const name of [stage.id, stage.label]) {
    const key = name.trim().toLowerCase().replace(/\s+/g, '-')
    if (Object.prototype.hasOwnProperty.call(ROLES, key)) return ROLES[key]
  }
  return undefined
}

export function stageForRole(stages: readonly Stage[], role: string): Stage | undefined {
  return stages.find(s => roleOf(s) === role)
}

// planDone: the current stage is past the plan stage (or there is none), and a validate-plan gate, if any, is approved
export function planDone(stages: readonly Stage[], current: string, approved: readonly string[]): boolean {
  const ci = indexOf(stages, current)
  if (ci < 0) return false
  const plan = stageForRole(stages, 'plan')
  if (plan && ci <= indexOf(stages, plan.id)) return false
  const check = stageForRole(stages, 'validate-plan')
  if (check && check.gate === true) {
    if (!approved.includes(check.id)) return false
    if (ci < indexOf(stages, check.id)) return false
  }
  return true
}

// shipOpen: the current stage is ship and its gate is approved, or no ship stage is gated
export function shipOpen(stages: readonly Stage[], current: string, approved: readonly string[]): boolean {
  const ship = stageForRole(stages, 'ship')
  if (!ship || ship.gate !== true) return true
  return current === ship.id && approved.includes(ship.id)
}

// When the current stage was last entered, from the history
export function enteredAt(history: readonly Transition[], stage: string): Transition | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i]
    if (t && t.stage === stage && t.event === undefined) return t
  }
  return undefined
}

export function elapsed(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return '<1m'
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  if (h < 24) return h + 'h ' + (m % 60) + 'm'
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h'
}

export function clock(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

// ---- The band ------------------------------------------------------------------------------

// A tone the kit draws (its TONES), or none for the default text color
export type SegTone = 'info' | 'ok' | 'warn' | 'danger' | 'muted'
// One run of band text with its style
export type Seg = { text: string; tone?: SegTone; bold?: boolean }

export const BAND_LABEL = 'stage '

type BandInput = {
  stages: readonly Stage[]
  current: string
  approved: readonly string[]
  history: readonly Transition[]
  now: number
  auto: boolean
  verified?: readonly string[]
  // the task's size: ' · small' is appended when it is small
  size?: Size
  // the approved file budget in force: ' · budget N' when above 0
  budget?: number
  // what the band must say in warning tone: an old Claude Code, enforcement switched off
  warnings?: readonly string[]
  // cut every label but the current one to this many characters
  labelMax?: number
}

function shorten(label: string, max: number | undefined): string {
  if (max === undefined || label.length <= max) return label
  if (max <= 0) return ''
  return max === 1 ? label.slice(0, 1) : label.slice(0, max - 1) + '…'
}

// The band grammar of the other concerns: the label bold in the default color, the stepper toned per segment, and
// the quiet right side (time in the stage, size, budget, manual) in the muted tone; only warnings stand out.
export function bandSegments(input: BandInput): Seg[] {
  const { stages, current, approved, history, now, auto } = input
  const verified = input.verified ?? []
  const ci = Math.max(0, indexOf(stages, current))
  const segs: Seg[] = [{ text: BAND_LABEL, bold: true }]
  stages.forEach((s, i) => {
    if (i > 0) segs.push({ text: ' ─ ', tone: 'muted' })
    const short = i === ci ? s.label : shorten(s.label, input.labelMax)
    const name = short ? ' ' + short : ''
    if (i < ci) segs.push({ text: '✓' + name, tone: 'ok' })
    else if (i === ci) segs.push({ text: '● ' + s.label, tone: 'info', bold: true })
    else segs.push({ text: '○' + name, tone: 'muted' })
    if (s.gate === true) {
      segs.push({ text: ' ⚑', tone: approved.includes(s.id) ? 'ok' : 'warn' })
    }
    if (s.requiresAgent) {
      segs.push({ text: ' ⇄', tone: verified.includes(s.id) ? 'ok' : 'muted' })
    }
  })
  const since = enteredAt(history, current)
  const label = labelOf(stages, stages[ci]?.id ?? current)
  segs.push({ text: ' · in ' + label + (since ? ' ' + elapsed(now - since.at) : ''), tone: 'muted' })
  if (input.size === 'small') segs.push({ text: ' · small', tone: 'muted' })
  if (typeof input.budget === 'number' && input.budget > 0) segs.push({ text: ' · budget ' + input.budget, tone: 'muted' })
  if (!auto) segs.push({ text: ' · manual', tone: 'muted' })
  for (const w of input.warnings ?? []) if (w) segs.push({ text: ' · ' + w, tone: 'warn', bold: true })
  return segs
}

// The band at its fullest that fits `columns`: whole labels, then shorter labels, then glyphs only, then cut with …
export function fitBand(input: BandInput, columns: number): Seg[] {
  const max = Math.max(8, Math.floor(columns))
  for (const labelMax of [undefined, 6, 4, 0]) {
    const segs = bandSegments({ ...input, labelMax })
    if (plainOf(segs).length <= max) return segs
  }
  return fitSegments(bandSegments({ ...input, labelMax: 0 }), columns)
}

export function plainOf(segs: readonly Seg[]): string {
  return segs.map(s => s.text).join('')
}

// Cut segments to fit `columns` cells, ending with … when cut
export function fitSegments(segs: readonly Seg[], columns: number): Seg[] {
  const max = Math.max(8, Math.floor(columns))
  if (plainOf(segs).length <= max) return segs.slice()
  const out: Seg[] = []
  let used = 0
  for (const s of segs) {
    const room = max - 1 - used
    if (room <= 0) break
    if (s.text.length <= room) {
      out.push(s)
      used += s.text.length
    } else {
      out.push({ ...s, text: s.text.slice(0, room) })
      used += room
      break
    }
  }
  out.push({ text: '…', tone: 'muted' })
  return out
}

// ---- What a project keeps in the store -----------------------------------------------------

export function savedOf(raw: unknown): Saved | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as {
    stage?: unknown
    at?: unknown
    approved?: unknown
    verified?: unknown
    size?: unknown
    planVerdict?: unknown
    waived?: unknown
    filesTouched?: unknown
    planFiles?: unknown
    budget?: unknown
  }
  if (typeof r.stage !== 'string') return undefined
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : [])
  const files = planFilesOf(r.planFiles)
  return {
    stage: r.stage,
    at: typeof r.at === 'number' ? r.at : 0,
    approved: strings(r.approved),
    verified: strings(r.verified),
    size: r.size === 'small' || r.size === 'large' ? r.size : '',
    planVerdict: verdictOf(r.planVerdict),
    waived: strings(r.waived),
    filesTouched: strings(r.filesTouched).slice(0, FILES_CAP),
    planFiles: files.ok ? files.value : null,
    budget: typeof r.budget === 'number' && Number.isInteger(r.budget) && r.budget > 0 ? r.budget : 0,
  }
}

export function verdictOf(raw: unknown): Verdict | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as { ok?: unknown; by?: unknown; at?: unknown }
  if (typeof v.ok !== 'boolean') return null
  return { ok: v.ok, by: typeof v.by === 'string' ? v.by : '', at: typeof v.at === 'number' ? v.at : 0 }
}

// Store keys: loopkeeper:stage:<old key>
export const BAND_KEY = storeKey('stage', 'band')
export function approvalKey(cwd: string): string {
  return storeKey('stage', 'approval:' + (cwd || '(unknown)'))
}
export function projectKey(cwd: string): string {
  return storeKey('stage', 'project:' + (cwd || '(unknown)'))
}
// Where the preset chosen in a project is kept
export function presetKey(cwd: string): string {
  return storeKey('stage', 'preset:' + (cwd || '(unknown)'))
}

export function capHistory(history: readonly Transition[]): Transition[] {
  return history.length > HISTORY_CAP ? history.slice(history.length - HISTORY_CAP) : history.slice()
}

// ---- Task size, the growth guard and the plan verdict -----------------------------------------

// What a user prompt says when it wants to approve the plan itself
export const HOLD_PATTERN =
  /\bwait for (?:my |your |the |an? )?(?:approval|ok|okay|go[- ]ahead)\b|\bask (?:me )?(?:first|before)\b|\b(?:let me|i(?:['’]ll| will| want to| would like to| need to| wanna)) (?:approve|review|check|see) (?:the|my|your|this) plan\b|\b(?:approve|review) (?:the|my) plan (?:first|before)\b|\bcheck with me\b|\bconfirm (?:with me )?before\b|\bdon['’]?t (?:start|proceed|execute) until\b|\bplan only\b|\bjust (?:the )?plan\b/i

export function wantsHold(text: unknown): boolean {
  return typeof text === 'string' && HOLD_PATTERN.test(text)
}

// The file path an Edit, Write, MultiEdit or NotebookEdit call writes, or nothing
export function editPath(input: unknown): string | undefined {
  const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const v = typeof i.file_path === 'string' && i.file_path !== '' ? i.file_path : i.notebook_path
  return typeof v === 'string' && v !== '' ? v : undefined
}

// A path relative to the project when it is inside it, else absolute, with . and .. resolved
export function normalizePath(path: string, cwd: string): string {
  const root = cwd.replace(/\/+$/, '')
  const abs = path.startsWith('/') ? path : root + '/' + path
  const parts: string[] = []
  for (const p of abs.split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  const full = '/' + parts.join('/')
  if (root !== '' && full.startsWith(root + '/')) return full.slice(root.length + 1)
  return full
}

// Whether a small task's next edit of `path` goes past its file limit
export function outgrows(size: Size, touched: readonly string[], path: string, max: number): boolean {
  return size === 'small' && !touched.includes(path) && touched.length >= max
}

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return n + 'th'
  return n + (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
}

export function outgrowMessage(path: string, max: number): string {
  return (
    PLUGIN + ': this task was sized small but would now touch a ' + ordinal(max + 1) + ' file (' + path +
    '); a small task is at most ' + max + ' file' + (max === 1 ? '' : 's') +
    ". Call set_stage {stage:'plan', size:'large'} and run the loop (plan → validate plan → execute), " +
    'or the user can run /lk size large or /lk small-max <n>.'
  )
}

export function smallReply(stageLabel: string, max: number): string {
  return (
    'Small task: the plan gate and the verifier are waived; in ' + stageLabel + '. A small task may touch at most ' +
    max + ' file' + (max === 1 ? '' : 's') + '; past that it is pushed back to Plan.'
  )
}

export function smallHeldReply(stageLabel: string): string {
  return (
    'Small task, but this prompt asked to wait for approval: the verifier is waived and the pipeline waits in ' +
    stageLabel + '. Ask the user to run /lk approve.'
  )
}

export const SIZE_REMINDER = 'Size the task: call set_stage again with size small or large.'

export const LARGE_REPLY =
  "Sized large: write the plan (Goal, Steps, Done-when, files to touch), have a validator subagent check it, then call set_stage {stage:'validate-plan', verdict:'consistent'|'issues'}."

// What sizing a task large answers: the loop, then what approving the plan will do to the file budget.
// `asked` is true when Claude sized it (set_stage), so it is told how to pass the count.
export function largeReply(planFiles: number | null, limits: Limits, asked: boolean): string {
  if (planFiles !== null) {
    return (
      LARGE_REPLY + ' The plan touches ' + planFiles + ' file' + (planFiles === 1 ? '' : 's') +
      ': approving it approves a file budget of ' + (planFiles + limits.slack) + ' files a turn.'
    )
  }
  if (!asked) return LARGE_REPLY
  return (
    LARGE_REPLY + ' Pass `files` (how many files the plan touches) with size large to have a file budget approved with' +
    ' the plan; without one the limit stays ' + limits.base + '.'
  )
}

// What set_stage answers to a verdict on the plan. `budget` is the sentence on the file budget, if any.
export function verdictReply(input: {
  ok: boolean
  validated: boolean
  who: string
  approval: Approval
  hold: boolean
  opened: boolean
  budget?: string
}): string {
  if (!input.ok) return 'Recorded: the plan has issues. Fix the plan (set_stage plan with a note) and validate again.'
  if (!input.validated) {
    return (
      'Recorded: plan consistent, but no validator subagent has completed since Plan began. Spawn one whose type or ' +
      'description matches /valid|review|verif|critic|audit|plan/i, then call set_stage validate-plan with the verdict ' +
      'again, or ask the user to run /lk approve.'
    )
  }
  if (input.opened) {
    return (
      'Plan validated by ' + input.who + '; the Validate plan gate is open (approval mode auto). Continue with set_stage execute.' +
      (input.budget ? ' ' + input.budget : '')
    )
  }
  const why = input.hold ? 'this prompt asked to wait' : 'approval mode ask'
  return (
    'Recorded: plan consistent (validated by ' + input.who + '). The user approves plans themselves here (' + why +
    '): ask them to run /lk approve.'
  )
}

// The status lines on size, approval and the verdict
export function sizeLine(size: Size, touched: number, max: number): string {
  if (size === 'small') return 'Size: small (' + touched + '/' + max + ' files)'
  return 'Size: ' + (size === 'large' ? 'large' : 'unsized')
}

export function approvalLine(approval: Approval, hold: boolean): string {
  return 'Plan approval: ' + (hold ? 'held by this prompt' : approval)
}

export function verdictLine(v: Verdict | null): string {
  if (!v) return 'Plan verdict: none'
  return 'Plan verdict: ' + (v.ok ? 'consistent by ' + (v.by || 'an agent') + ' at ' + clock(v.at) : 'issues')
}

// Who a 'verified' history entry for a stage names, newest first
export function verifiedBy(history: readonly Transition[], stage: string): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i]
    if (t && t.stage === stage && t.event === 'verified') return (t.note ?? '').replace(/^verified by /, '') || 'an agent'
  }
  return 'an agent'
}

// ---- The file budget (ADR 0011) -------------------------------------------------------------

export const PLAN_FILES_MAX = 10_000

// The `files` set_stage takes: a whole number from 1, or nothing. A bad value is refused, never guessed.
export function planFilesOf(raw: unknown): { ok: true; value: number | null } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > PLAN_FILES_MAX) return { ok: false }
  return { ok: true, value: n }
}

// The budget approving a plan of `planFiles` files gives: the planned count plus the slack
export function budgetFor(planFiles: number, limits: Limits): number {
  return planFiles + limits.slack
}

// What the approval message says about the budget
export function budgetSentence(planFiles: number | null, limits: Limits): string {
  if (planFiles === null) return 'No file budget was set, so the limit stays ' + limits.base + '.'
  return 'File budget: ' + budgetFor(planFiles, limits) + ' files a turn (' + planFiles + ' planned + ' + limits.slack + ').'
}

// What a validator's verdict says when the budget is too large for it to approve
export function budgetWaitSentence(planFiles: number, limits: Limits): string {
  return (
    'The file budget (' + planFiles + ' planned files) is over ' + limits.autoMax +
    ', the most a validator may approve, so it waits for the user: ask them to run /lk approve. Until then the limit stays ' +
    limits.base + '.'
  )
}

// The status line on the budget
export function budgetLine(planFiles: number | null, budget: number, waits: boolean, limits: Limits): string {
  if (budget > 0) {
    return 'File budget: ' + budget + ' files a turn' + (planFiles !== null ? ' (' + planFiles + ' planned + ' + (budget - planFiles) + ')' : '')
  }
  if (planFiles !== null) {
    return 'File budget: ' + planFiles + ' planned, ' + (waits ? 'waiting for /lk approve' : 'approved with the plan') +
      ' (until then ' + limits.base + ')'
  }
  return 'File budget: none (limit ' + limits.base + ')'
}

type BudgetState = {
  stages: readonly Stage[]
  current: string
  approved: readonly string[]
  size: Size
  planFiles: number | null
  budget: number
}

// A planned budget waits for the user: the task is large and gave a count, none is approved yet, and the plan
// itself is done (its gate approved, or there is no plan gate and the stage machine moved on from Plan)
export function budgetWaits(s: BudgetState): boolean {
  return s.size === 'large' && s.planFiles !== null && s.budget === 0 && planDone(s.stages, s.current, s.approved)
}

export type BandButton = { kind: 'plan' | 'budget'; label: string }

// The band's approve button: while the plan gate waits for the user (approval mode ask, or a prompt that asked to
// wait), "Approve plan · N files"; once the gate is open but a large budget still waits, "Approve budget · N files"
export function bandButton(s: BudgetState & { approval: Approval; hold: boolean }): BandButton | null {
  const cur = s.stages.find(x => x.id === s.current)
  if (cur && roleOf(cur) === 'validate-plan' && cur.gate === true && !s.approved.includes(cur.id) && (s.approval === 'ask' || s.hold)) {
    return { kind: 'plan', label: s.planFiles !== null ? 'Approve plan · ' + s.planFiles + ' files' : 'Approve plan' }
  }
  if (budgetWaits(s) && s.planFiles !== null) return { kind: 'budget', label: 'Approve budget · ' + s.planFiles + ' files' }
  return null
}

// ---- The next step ------------------------------------------------------------------------------------------------
// What comes next, as the next-step line (a notice line in the chat after each answer), the hub, the Stage pane and
// /lk status say it

export type NextState = BudgetState & {
  approval: Approval
  hold: boolean
  verified: readonly string[]
  waived: readonly string[]
  // /lk gates ship ok for this session
  shipOk: boolean
  // the gates' shipGate: off, nothing holds shipping and Ship reads as any other stage
  shipGate: boolean
}

// The next stage's gate that /lk approve can open now, from the stage before it (gateAhead), as the next-step sentence
// offers it: not yet approved, and not a Ship gate that holds nothing (the gates' shipGate off, or ship ok on)
export function approveAhead(s: NextState): Stage | undefined {
  const cur = s.stages[Math.max(0, indexOf(s.stages, s.current))]
  const ahead = cur ? gateAhead(s.stages, cur.id, s.approved) : undefined
  if (!ahead || s.approved.includes(ahead.id)) return undefined
  if (roleOf(ahead) === 'ship' && (!s.shipGate || s.shipOk)) return undefined
  return ahead
}

// The next-step sentence, decided on the current stage (a gate holds the move out of its own stage; /lk approve
// approves the current stage's gate or, from the stage before a gate, opens the next one: see approveAhead). The first
// case that applies wins; a gate on the last stage holds no move, so there the last-stage case wins over it. A small
// task names the plan gate it waived.
export function nextStep(s: NextState): string {
  const i = Math.max(0, indexOf(s.stages, s.current))
  const cur = s.stages[i]
  const after = s.stages[i + 1]
  const role = roleOf(cur)
  const gateWaits = cur?.gate === true && !s.approved.includes(cur.id)
  let text: string
  if (bandButton(s) !== null) text = 'Waiting for you: /lk approve (or a in /lk).'
  else if (gateWaits && role === 'validate-plan' && s.approval === 'auto' && !s.hold) {
    text = "A plan validator's consistent verdict opens the gate, or /lk approve."
  } else if (gateWaits && role !== 'ship' && after) text = 'Waiting for you: /lk approve.'
  else if (cur && after && blockingAgent(s.stages, s.verified, cur.id, after.id)) text = 'A verifier subagent checks the work first.'
  else if (role === 'ship' && s.shipGate && !s.shipOk && !shipOpen(s.stages, s.current, s.approved)) {
    text = '/lk approve when you want Claude to commit, push or open a PR.'
  } else if (!after) text = 'Last stage: ask Claude to commit, push or open a PR; /lk reset starts the next task.'
  else {
    const how = approveAhead(s) ? '/lk approve opens ' + after.label + ' now.' : '/lk next.'
    text = 'Next: ' + after.label + '. Claude moves on when it starts that work, or ' + how
  }
  // the waiver approved the gate (a hold keeps it waiting; `waived` also lists a verifier the task waived)
  const gate = stageForRole(s.stages, 'validate-plan')
  if (s.size === 'small' && gate?.gate === true && !s.hold && s.waived.includes(gate.id) && s.approved.includes(gate.id)) {
    text += ' Small task: the ' + gate.label + ' gate is waived.'
  }
  return text
}

// ---- Plan review passes (the review_cycle wrapper) --------------------------------------------
// The done rule of a review subject is review-loop's own, imported from reviewModel.ts: findSubject (exact name, then
// case-insensitive), lastCycle, blocking (open p0/p1 items) and reached (a last cycle exists, no open p0/p1, and the
// last verdict is not iterate or stop; score kinds: the last score is at the target). nameOf reads a subject name the
// way the review_cycle tool does (one line, trimmed, capped).

export type PlanSubject = LkSubject
export { blocking, findSubject, lastCycle, reached }

export const subjectName = (v: unknown): string => nameOf(v)

// Whether the named subject is a plan review that is done: the stage records a consistent verdict for it
export function planPassConsistent(subjects: Record<string, LkSubject>, name: unknown): boolean {
  const s = findSubject(subjects, subjectName(name))
  return s !== undefined && s.kind === 'plan' && reached(s)
}

// Whether a pass changed the subject at all: a refused pass (past maxCycles, shipped, stopped, bad input) records nothing
export function passRecorded(before: PlanSubject | undefined, after: PlanSubject | undefined): boolean {
  if (after === undefined) return false
  return JSON.stringify(before ?? null) !== JSON.stringify(after)
}

// A plan pass records a verdict only up to the plan gate: never one that would move the stage machine back to it
export function planPassApplies(stages: readonly Stage[], current: string): boolean {
  const gate = stageForRole(stages, 'validate-plan')
  if (!gate) return false
  return indexOf(stages, current) <= indexOf(stages, gate.id)
}

// ---- Minimum version (ADR 0007) and the kill switch (ADR 0009) ----------------------------------

// What the band says when Claude Code is older than the minimum: '' for a new enough, unknown or dev build
export function versionNote(v: { version?: unknown; base?: unknown } | null | undefined, min: string = MIN_VERSION): string {
  const pick = (x: unknown): string => (typeof x === 'string' ? x.trim() : '')
  const raw = pick(v?.base) || pick(v?.version)
  if (raw === '' || /dev/i.test(raw)) return ''
  const m = /^\d+\.\d+\.\d+/.exec(raw)
  if (!m) return ''
  return versionAtLeast(m[0], min) ? '' : 'needs Claude Code ' + min + '+, found ' + m[0]
}

// CLAUDE_MODS_DISABLE: a comma list; 'all' or 'loopkeeper' turns the enforcing hooks off
export function killSwitchOn(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  return raw
    .split(',')
    .map(v => v.trim())
    .some(v => v === 'all' || v === PLUGIN)
}

export const DISABLED_NOTE = 'growth guard off (CLAUDE_MODS_DISABLE)'
