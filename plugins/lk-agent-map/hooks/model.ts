// Pure data functions for agent-map. Nothing here touches `$`: register.ts
// reads and writes $.state and hands these functions plain values.
import type { AgentRecord, AgentStatus, CapConfig, CapCounters, CapKind, CapSource, CapSources, LogEntry, PendingCall, PriceRow, TodoProgress, TokenCounts, WaitingCall } from '../types'
import { costUsd } from './prices'

export const MAIN = 'main'
export const MAX_PENDING = 32
export const MAX_MESSAGES = 20
export const ACTIVITY_INPUT = 40
export const MAX_WAITING = 8

export type Agents = Record<string, AgentRecord>

/** Reads a string field from an event, trying each name in turn. */
export function str(e: unknown, ...names: string[]): string | undefined {
  if (!e || typeof e !== 'object') return undefined
  const o = e as Record<string, unknown>
  for (const n of names) {
    const v = o[n]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export function zeroTokens(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
}

export function totalTokens(t: TokenCounts | undefined): number {
  if (!t) return 0
  return num(t.input) + num(t.output) + num(t.cacheRead) + num(t.cacheCreate)
}

/** Token counts from an API usage object (turn.step result.usage, turn.complete e.usage). */
export function tokensOf(usage: unknown): TokenCounts {
  const u = (usage && typeof usage === 'object' ? usage : {}) as Record<string, unknown>
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheCreate: num(u.cache_creation_input_tokens),
  }
}

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: num(a.input) + b.input,
    output: num(a.output) + b.output,
    cacheRead: num(a.cacheRead) + b.cacheRead,
    cacheCreate: num(a.cacheCreate) + b.cacheCreate,
  }
}

export function blankAgent(id: string, now: number): AgentRecord {
  const isMain = id === MAIN
  return {
    id,
    name: isMain ? 'orchestrator' : 'agent',
    description: isMain ? 'main' : '',
    prompt: '',
    model: '',
    parent: isMain ? '' : MAIN,
    isTeammate: false,
    isFork: false,
    isBackground: false,
    isSpawned: isMain,
    startedAt: now,
    runStartedAt: now,
    status: 'running',
    requests: 0,
    toolCalls: 0,
    toolsByName: {},
    lastTool: '',
    activity: '',
    lastActiveAt: now,
    waiting: [],
    stuckNotified: false,
    muted: false,
    tokens: zeroTokens(),
    messages: [],
    effort: '',
    lastRequestTokens: 0,
    todo: null,
    costUsd: null,
  }
}

/** Returns a copy of `agents` with `id` changed by `fn`, creating the record when missing. */
export function withAgent(agents: Agents, id: string, now: number, fn: (a: AgentRecord) => AgentRecord): Agents {
  const prev = agents[id] ?? blankAgent(id, now)
  return { ...agents, [id]: fn(prev) }
}

export function withOrder(order: string[], id: string): string[] {
  return order.includes(id) ? order : [...order, id]
}

// ---- Agent tool calls and spawns ----

/** What a model's Agent tool.call says about the agent about to start. */
export function pendingOf(e: unknown, now: number): PendingCall {
  const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
  return {
    toolUseId: str(o, 'tool_use_id', 'toolUseId') ?? '',
    caller: str(o, 'agentId') ?? MAIN,
    description: str(o, 'description') ?? '',
    subagentType: str(o, 'subagent_type', 'subagentType') ?? '',
    model: str(o, 'model') ?? '',
    prompt: str(o, 'prompt') ?? '',
    isBackground: o.run_in_background === true,
    at: now,
  }
}

export function addPending(list: PendingCall[], p: PendingCall): PendingCall[] {
  return [...list, p].slice(-MAX_PENDING)
}

/**
 * Finds the Agent call a spawn belongs to: by tool_use_id, then by
 * description, then the oldest still waiting. Returns it and the rest.
 */
export function takePending(list: PendingCall[], spawn: unknown): { match?: PendingCall; rest: PendingCall[] } {
  const toolUseId = str(spawn, 'tool_use_id', 'toolUseId')
  const description = str(spawn, 'description')
  let i = toolUseId ? list.findIndex(p => p.toolUseId === toolUseId) : -1
  if (i < 0 && description) i = list.findIndex(p => p.description === description)
  if (i < 0 && !toolUseId && list.length > 0) i = 0
  if (i < 0) return { rest: list }
  return { match: list[i], rest: list.filter((_, j) => j !== i) }
}

export type SpawnFacts = {
  id: string
  parent: string
  name: string
  description: string
  prompt: string
  model: string
  isTeammate: boolean
  isFork: boolean
  isBackground: boolean
  /** The spawn's effort, when the event carries one (not a documented field: read defensively). */
  effort: string
}

/**
 * Merges what agent.spawn's input (e), its result (r) and the matching Agent
 * tool.call (p) say. The caller of the Agent tool is the parent.
 */
export function spawnFacts(e: unknown, r: unknown, p: PendingCall | undefined): SpawnFacts {
  const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
  const toolUseId = str(o, 'tool_use_id', 'toolUseId')
  const id =
    str(r, 'agentId') ??
    str(o, 'agentId', 'id') ??
    (toolUseId ? 'tool:' + toolUseId : 'agent:' + (str(o, 'description') ?? 'unknown'))
  return {
    id,
    parent: str(o, 'parentAgentId') ?? p?.caller ?? MAIN,
    name:
      str(o, 'subagentType', 'subagent_type', 'agentType', 'type') ??
      (p?.subagentType || undefined) ??
      (o.isTeammate === true ? 'teammate' : 'general-purpose'),
    description: str(o, 'description', 'name') ?? p?.description ?? '',
    prompt: str(o, 'prompt') ?? p?.prompt ?? '',
    model: str(r, 'model') ?? str(o, 'model') ?? (p?.model || undefined) ?? str(o, 'parentModel') ?? '',
    isTeammate: o.isTeammate === true,
    isFork: o.fork === true,
    isBackground: o.background === true || o.run_in_background === true || p?.isBackground === true,
    effort: effortOf(o.effort),
  }
}

export function applySpawn(a: AgentRecord, f: SpawnFacts, now: number): AgentRecord {
  return {
    ...a,
    name: f.name || a.name,
    description: f.description || a.description,
    prompt: f.prompt || a.prompt,
    model: f.model || a.model,
    parent: f.parent === f.id ? MAIN : f.parent,
    isTeammate: f.isTeammate || a.isTeammate,
    isFork: f.isFork || a.isFork,
    isBackground: f.isBackground,
    // A request's effort (turn.step) stands over the spawn's
    effort: a.effort || f.effort || '',
    isSpawned: true,
    // Keep the earlier start when a tool call or step arrived before the spawn resolved
    startedAt: a.isSpawned || a.requests > 0 || a.toolCalls > 0 ? a.startedAt : now,
    runStartedAt: a.isSpawned || a.requests > 0 || a.toolCalls > 0 ? a.runStartedAt : now,
    status: 'running',
    endedAt: undefined,
    lastActiveAt: now,
  }
}

// ---- Activity inside a loop ----

const INPUT_KEYS = ['command', 'file_path', 'pattern', 'description', 'url', 'query', 'path', 'skill', 'task_id', 'prompt']

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** `Bash: npm test`: the tool and the first 40 characters of the input that says most about the call. */
export function activityOf(tool: string, e: unknown): string {
  const name = tool || 'tool'
  const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
  const input = (o.input && typeof o.input === 'object' ? o.input : o) as Record<string, unknown>
  const raw = str(input, ...INPUT_KEYS)
  const text = raw ? Array.from(oneLine(raw)).slice(0, ACTIVITY_INPUT).join('') : ''
  return text ? name + ': ' + text : name
}

export function applyToolCall(a: AgentRecord, tool: string, activity?: string, now?: number): AgentRecord {
  const name = tool || 'tool'
  return {
    ...a,
    toolCalls: a.toolCalls + 1,
    toolsByName: { ...a.toolsByName, [name]: (a.toolsByName[name] ?? 0) + 1 },
    lastTool: name,
    activity: activity ?? name,
    lastActiveAt: now ?? a.lastActiveAt,
    stuckNotified: false,
  }
}

/** The last thing an agent's own transcript shows, for an agent no tool.call was seen from. */
export function activityOfMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; text?: unknown; toolUses?: unknown }
    const uses = Array.isArray(m?.toolUses) ? (m.toolUses as { tool?: unknown; input?: unknown }[]) : []
    const last = uses[uses.length - 1]
    if (last && typeof last.tool === 'string') return activityOf(last.tool, { input: last.input })
    if (m?.role === 'assistant' && typeof m.text === 'string' && m.text.trim())
      return 'said: ' + Array.from(oneLine(m.text)).slice(0, ACTIVITY_INPUT).join('')
  }
  return ''
}

// ---- Permission verdicts ----

export function addWaiting(a: AgentRecord, w: WaitingCall): AgentRecord {
  if (a.waiting.some(x => x.toolUseId === w.toolUseId)) return a
  return { ...a, waiting: [...a.waiting, w].slice(-MAX_WAITING) }
}

export function clearWaiting(agents: Agents, toolUseId: string): Agents {
  let out = agents
  for (const a of Object.values(agents)) {
    if (!a.waiting?.some(w => w.toolUseId === toolUseId)) continue
    out = { ...out, [a.id]: { ...a, waiting: a.waiting.filter(w => w.toolUseId !== toolUseId) } }
  }
  return out
}

// ---- Stop and mute ----

export function markStopped(a: AgentRecord, by: string, now: number): AgentRecord {
  if (a.status === 'stopped') return a
  const ran = a.status === 'running'
  return {
    ...a,
    status: 'stopped',
    stoppedBy: by,
    waiting: [],
    endedAt: ran ? now : (a.endedAt ?? now),
    durationMs: ran ? (a.durationMs ?? 0) + Math.max(0, now - a.runStartedAt) : a.durationMs,
  }
}

export function markMuted(a: AgentRecord): AgentRecord {
  return { ...a, muted: true }
}

export const MUTE_REASON =
  'The person muted this agent from the agent map. Make no more tool calls: return your result now with what you have.'

// ---- Idle alert ----

/** How long a running agent has gone without a tool call or a model request. */
export function idleMs(a: AgentRecord, now: number): number {
  if (a.status !== 'running' || a.id === MAIN) return 0
  return Math.max(0, now - (a.lastActiveAt ?? a.runStartedAt))
}

export function isStuck(a: AgentRecord, now: number, stuckAfterMs: number): boolean {
  return stuckAfterMs > 0 && a.isSpawned && (a.waiting?.length ?? 0) === 0 && !a.muted && idleMs(a, now) >= stuckAfterMs
}

// ---- Reconcile with $.agent.list() ----

export type ListedAgent = { id: string; description?: string; type?: string; status?: string; parentId?: string; name?: string }

export function statusOfListed(s: string | undefined): AgentStatus {
  if (s === 'running' || s === 'pending' || !s) return 'running'
  if (s === 'completed' || s === 'done') return 'done'
  if (s === 'killed' || s === 'stopped') return 'stopped'
  if (s === 'failed' || s === 'error') return 'failed'
  return 'aborted'
}

/** True when making `parent` the parent of `id` closes a loop. */
export function makesCycle(agents: Agents, id: string, parent: string): boolean {
  const seen = new Set<string>()
  let p: string | undefined = parent
  while (p && p !== MAIN) {
    if (p === id || seen.has(p)) return true
    seen.add(p)
    p = agents[p]?.parent
  }
  return false
}

/**
 * Merges the engine's own list of agents into the map: agents the spawn hook
 * missed (forks, teammates, workflow agents, ones that started before a
 * reload) appear, parents fill in, and finished ones end. A parent that would
 * close a loop is left at main.
 */
export function reconcile(agents: Agents, order: string[], listed: readonly ListedAgent[], now: number): { agents: Agents; order: string[]; added: string[] } {
  let out = agents
  let nextOrder = order
  const added: string[] = []
  for (const l of listed) {
    if (!l || typeof l.id !== 'string' || !l.id || l.id === MAIN) continue
    const status = statusOfListed(l.status)
    const prev = out[l.id]
    const parentId = l.parentId && l.parentId !== l.id ? l.parentId : MAIN
    if (!prev || !prev.isSpawned) {
      const base = prev ?? blankAgent(l.id, now)
      const parent = makesCycle(out, l.id, parentId) ? MAIN : parentId
      let rec: AgentRecord = {
        ...base,
        name: l.type || base.name,
        description: l.description || l.name || base.description,
        parent,
        isTeammate: l.type === 'teammate' || base.isTeammate,
        isSpawned: true,
      }
      if (status !== 'running') rec = status === 'stopped' ? markStopped(rec, 'engine', now) : { ...rec, status, endedAt: now, durationMs: Math.max(0, now - rec.runStartedAt) }
      out = { ...out, [l.id]: rec }
      nextOrder = withOrder(nextOrder, l.id)
      added.push(l.id)
      continue
    }
    let rec = prev
    if ((rec.parent === MAIN || !rec.parent) && parentId !== MAIN && !makesCycle(out, l.id, parentId)) rec = { ...rec, parent: parentId }
    if (rec.status === 'running' && status !== 'running') {
      rec = status === 'stopped' ? markStopped(rec, rec.stoppedBy ?? 'engine', now) : { ...rec, status, endedAt: now, waiting: [], durationMs: (rec.durationMs ?? 0) + Math.max(0, now - rec.runStartedAt) }
    }
    if (rec !== prev) out = { ...out, [l.id]: rec }
  }
  return { agents: out, order: nextOrder, added }
}

/** A finished agent that makes a request again (a resumed run) is running again. */
export function resume(a: AgentRecord, now: number): AgentRecord {
  if (a.status === 'running' || a.id === MAIN) return a
  return { ...a, status: 'running', endedAt: undefined, runStartedAt: now }
}

export type StepOptions = {
  /** turn.step's e.effort, as effortOf() reads it. */
  effort?: string
  /** The price table the request's cost is figured with (hooks/prices.ts PRICES and the config's overrides). */
  prices?: readonly PriceRow[]
}

/**
 * One model request: tokens and cost add up, the model it actually ran on replaces the spawn's,
 * its effort replaces the spawn's, and its input side (input + cache read + cache write) is
 * kept as the agent's latest context size.
 */
export function applyStep(a: AgentRecord, usage: unknown, model: string | undefined, now?: number, opts: StepOptions = {}): AgentRecord {
  const u = usage && typeof usage === 'object' ? (usage as Record<string, unknown>) : undefined
  const answered = u && typeof u.model === 'string' && u.model ? (u.model as string) : undefined
  const ranOn = answered ?? (model || a.model || '')
  const t = u ? tokensOf(u) : undefined
  const cost = t ? costUsd(t, ranOn, opts.prices) : null
  return {
    ...a,
    requests: a.requests + 1,
    tokens: t ? addTokens(a.tokens, t) : a.tokens,
    model: ranOn,
    lastActiveAt: now ?? a.lastActiveAt,
    stuckNotified: false,
    effort: opts.effort || a.effort || '',
    lastRequestTokens: t ? t.input + t.cacheRead + t.cacheCreate : (a.lastRequestTokens ?? 0),
    costUsd: cost === null ? (a.costUsd ?? null) : (a.costUsd ?? 0) + cost,
  }
}

/** An effort as the card shows it: a level (`low` … `max`) as given, an integer budget as digits, else ''. */
export function effortOf(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return String(Math.round(v))
  if (typeof v === 'string') return Array.from(oneLine(v)).slice(0, 12).join('')
  return ''
}

/**
 * The progress a TodoWrite call's list shows: completed items over all items, and the
 * in_progress item's activeForm (else its content). Reads `todos` on the event or its `input`.
 * undefined when the call carries no list; null for an empty list.
 */
export function todoOf(e: unknown): TodoProgress | null | undefined {
  const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
  const input = (o.input && typeof o.input === 'object' ? o.input : {}) as Record<string, unknown>
  const list = Array.isArray(o.todos) ? o.todos : Array.isArray(input.todos) ? input.todos : undefined
  if (!list) return undefined
  const items = list.filter(x => x && typeof x === 'object') as Record<string, unknown>[]
  if (items.length === 0) return null
  let done = 0
  let current = ''
  for (const it of items) {
    if (it.status === 'completed') done++
    else if (it.status === 'in_progress' && !current) current = oneLine(str(it, 'activeForm') ?? str(it, 'content') ?? '')
  }
  return { done, total: items.length, current: Array.from(current).slice(0, 80).join('') }
}

export function statusOfComplete(e: unknown): AgentStatus {
  const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
  if (o.isAborted === true || o.reason === 'aborted') return 'aborted'
  if (o.reason === 'error' || o.reason === 'refusal') return 'failed'
  return 'done'
}

export function applyComplete(a: AgentRecord, e: unknown, now: number, status: AgentStatus, prices?: readonly PriceRow[]): AgentRecord {
  const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
  const runMs = typeof o.durationMs === 'number' && o.durationMs >= 0 ? o.durationMs : Math.max(0, now - a.runStartedAt)
  // turn.step already summed this run's tokens; use the turn's totals only when no step was seen
  const fromTurn = a.requests === 0 && o.usage ? tokensOf(o.usage) : undefined
  const tokens = fromTurn ? addTokens(a.tokens, fromTurn) : a.tokens
  const model = a.model || str(o.usage, 'model') || ''
  const turnCost = fromTurn ? costUsd(fromTurn, model, prices) : null
  if (turnCost !== null) a = { ...a, costUsd: (a.costUsd ?? 0) + turnCost }
  if (a.status !== 'running') {
    // A second turn.complete for a finished run (or a .catch after a recorded end): keep the totals.
    // A stop recorded from the pane stands over the abort the engine reports for it.
    const keep = status === 'done' || a.status === 'stopped'
    return { ...a, status: keep ? a.status : status, tokens, model }
  }
  return {
    ...a,
    waiting: [],
    status,
    endedAt: now,
    durationMs: (a.durationMs ?? 0) + runMs,
    tokens,
    model,
  }
}

export function markFailed(a: AgentRecord, now: number): AgentRecord {
  if (a.status === 'stopped') return a
  return {
    ...a,
    waiting: [],
    status: 'failed',
    endedAt: a.endedAt ?? now,
    durationMs: a.durationMs ?? Math.max(0, now - a.runStartedAt),
  }
}

// ---- Messages ----

/** Resolves a message address (an agent id, an Agent({ name }), or { agentId }) to a known agent id. */
export function resolveAddress(agents: Agents, to: unknown): string | undefined {
  let key: string | undefined
  if (typeof to === 'string') key = to
  else if (to && typeof to === 'object') key = str(to, 'agentId', 'id', 'name', 'to')
  if (!key) return undefined
  if (key === MAIN) return MAIN
  if (agents[key]) return key
  const bare = key.replace(/^agent:/, '')
  if (agents[bare]) return bare
  const byName = Object.values(agents).find(a => a.isSpawned && (a.description === key || a.name === key))
  return byName?.id
}

export function addEdge(agents: Agents, from: string, to: string, now: number): Agents {
  let out = agents
  if (out[from]) out = { ...out, [from]: { ...out[from], messages: [...out[from].messages, { to, at: now }].slice(-MAX_MESSAGES) } }
  if (out[to]) out = { ...out, [to]: { ...out[to], messages: [...out[to].messages, { from, at: now }].slice(-MAX_MESSAGES) } }
  return out
}

// ---- Housekeeping ----

export function isFinished(a: AgentRecord): boolean {
  return a.id !== MAIN && a.status !== 'running'
}

/** Drops finished agents; running ones stay, and an orphan draws at the top level. */
export function clearFinished(agents: Agents, order: string[]): { agents: Agents; order: string[]; removed: number } {
  const keep: Agents = {}
  let removed = 0
  for (const [id, a] of Object.entries(agents)) {
    if (a.isSpawned && isFinished(a)) removed++
    else keep[id] = a
  }
  return { agents: keep, order: order.filter(id => keep[id] !== undefined), removed }
}

export type Counts = { running: number; done: number; failed: number; aborted: number; stopped: number; tokens: number; spawned: number }

export function countsOf(agents: Agents): Counts {
  const c: Counts = { running: 0, done: 0, failed: 0, aborted: 0, stopped: 0, tokens: 0, spawned: 0 }
  for (const a of Object.values(agents)) {
    if (a.id === MAIN || !a.isSpawned) continue
    c.spawned++
    if (a.status in c) c[a.status]++
    c.tokens += totalTokens(a.tokens)
  }
  return c
}

export function anyRunning(agents: Agents): boolean {
  return Object.values(agents).some(a => a.id !== MAIN && a.isSpawned && a.status === 'running')
}


// ---- Spawn caps (0.3.0) ----

export const DEFAULT_CAPS: CapConfig = {
  maxConcurrent: 4,
  maxPerTurn: 8,
  maxPerSession: 40,
  warnAt: 0.75,
  maxReturnedTokens: 150_000,
  waitGraceMs: 4000,
}

export function zeroCounters(): CapCounters {
  return { turn: 0, session: 0, deniedThisTurn: false, warnedThisTurn: false, overrideTurn: false, returnedTotal: 0, returnedWarned: false }
}

/** The counters a new main-loop turn starts with: session totals stay. */
export function newTurn(c: CapCounters): CapCounters {
  return { ...c, turn: 0, deniedThisTurn: false, warnedThisTurn: false, overrideTurn: false }
}

const CAP_FIELDS = ['maxConcurrent', 'maxPerTurn', 'maxPerSession', 'maxReturnedTokens', 'waitGraceMs'] as const

/** The valid cap fields of `over` (a parsed config file, the plugin's settings or the store's overrides). */
export function capFields(over: unknown): Partial<CapConfig> {
  if (!over || typeof over !== 'object') return {}
  const o = over as Record<string, unknown>
  const out: Partial<CapConfig> = {}
  for (const k of CAP_FIELDS) {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.floor(v)
  }
  const w = o.warnAt
  if (typeof w === 'number' && Number.isFinite(w) && w > 0 && w <= 1) out.warnAt = w
  return out
}

/** Lays the valid fields of `over` (a parsed config file or the store's overrides) on top of `base`. */
export function mergeCaps(base: CapConfig, over: unknown): CapConfig {
  if (!over || typeof over !== 'object') return base
  return { ...base, ...capFields(over) }
}

/** Every cap from the defaults. */
export const DEFAULT_SOURCES: CapSources = {
  maxConcurrent: 'default',
  maxPerTurn: 'default',
  maxPerSession: 'default',
  warnAt: 'default',
  maxReturnedTokens: 'default',
  waitGraceMs: 'default',
}

/** The caps after each layer in turn (later wins), and the layer each value came from. */
export function layerCaps(layers: readonly { source: CapSource; over: unknown }[]): { caps: CapConfig; sources: CapSources } {
  let caps: CapConfig = { ...DEFAULT_CAPS }
  const sources: CapSources = { ...DEFAULT_SOURCES }
  for (const l of layers) {
    const f = capFields(l.over)
    caps = { ...caps, ...f }
    for (const k of Object.keys(f) as (keyof CapConfig)[]) sources[k] = l.source
  }
  return { caps, sources }
}

// ---- The caps in the plugin's settings (0.6.2) ----

/** The plugin's `userConfig` fields for the caps; warnAtPercent is warnAt × 100. */
export const SETTING_FIELDS = ['maxConcurrent', 'maxPerTurn', 'maxPerSession', 'warnAtPercent', 'maxReturnedTokens'] as const
export type SettingField = (typeof SETTING_FIELDS)[number]

/** A `/config` row of this plugin's cap settings: `lk-agent-map.<field>`, or `lk-agent-map@<marketplace>.<field>`. */
export const SETTING_KEY = /^lk-agent-map(@[^.]*)?\.(maxConcurrent|maxPerTurn|maxPerSession|warnAtPercent|maxReturnedTokens)$/

/** Why a value doesn't fit a cap setting, or undefined when it does. */
export function settingProblem(field: string, value: unknown): string | undefined {
  if (field === 'warnAtPercent') {
    return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 100 ? undefined : 'agent-map: warnAtPercent takes a number from 1 to 100'
  }
  if (!(SETTING_FIELDS as readonly string[]).includes(field)) return undefined
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? undefined : 'agent-map: ' + field + ' takes a whole number, 0 or more (0 means no cap)'
}

/**
 * The settings' values by field: this plugin's `/config` rows when listed, else the values
 * `register(on, options)` got.
 */
export function settingValues(rows: unknown, options: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (options && typeof options === 'object') {
    const o = options as Record<string, unknown>
    for (const f of SETTING_FIELDS) if (f in o) out[f] = o[f]
  }
  if (Array.isArray(rows)) {
    for (const r of rows) {
      const m = r && typeof r === 'object' ? SETTING_KEY.exec(String((r as { key?: unknown }).key)) : null
      if (m) out[m[2]] = (r as { value?: unknown }).value
    }
  }
  return out
}

/** The caps the settings set: valid values that differ from the defaults (options arrive with the defaults filled in). */
export function settingsCaps(values: Record<string, unknown>): Partial<CapConfig> {
  const out: Partial<CapConfig> = {}
  for (const f of SETTING_FIELDS) {
    const v = values[f]
    if (v === undefined || settingProblem(f, v) !== undefined) continue
    const key: keyof CapConfig = f === 'warnAtPercent' ? 'warnAt' : f
    const n = f === 'warnAtPercent' ? (v as number) / 100 : (v as number)
    if (n !== DEFAULT_CAPS[key]) out[key] = n
  }
  return out
}

/** Parses a config file's text; anything that isn't a JSON object is ignored. */
export function parseCapFile(text: unknown): unknown {
  if (typeof text !== 'string' || !text.trim()) return undefined
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined
  } catch {
    return undefined
  }
}

export const CAP_NAMES: Record<CapKind, string> = {
  concurrent: 'concurrency cap',
  turn: 'per-turn spawn cap',
  session: 'per-session spawn cap',
}

const CAP_MAX: Record<CapKind, keyof CapConfig> = { concurrent: 'maxConcurrent', turn: 'maxPerTurn', session: 'maxPerSession' }

export type CapUse = { kind: CapKind; n: number; max: number }

/** Running subagents (forks and teammates included). */
export function runningCount(agents: Agents): number {
  let n = 0
  for (const a of Object.values(agents)) if (a.id !== MAIN && a.isSpawned && a.status === 'running') n++
  return n
}

/** Where each cap stands before a spawn: running agents (plus spawns in flight), this turn's spawns, the session's. */
export function capUses(running: number, c: CapCounters, caps: CapConfig): CapUse[] {
  return [
    { kind: 'concurrent', n: running, max: caps.maxConcurrent },
    { kind: 'turn', n: c.turn, max: caps.maxPerTurn },
    { kind: 'session', n: c.session, max: caps.maxPerSession },
  ]
}

/** The first cap one more spawn would go past; a turn-exempt spawn (fork, teammate) skips the per-turn cap. */
export function capBreach(uses: CapUse[], countsTurn = true): CapUse | undefined {
  return uses.find(u => u.max > 0 && u.n >= u.max && (countsTurn || u.kind !== 'turn'))
}

/** The first cap at or past warnAt once this spawn is counted. */
export function capNear(uses: CapUse[], warnAt: number, countsTurn = true): CapUse | undefined {
  return uses
    .filter(u => countsTurn || u.kind !== 'turn')
    .map(u => ({ ...u, n: u.n + 1 }))
    .find(u => u.max > 0 && u.n / u.max >= warnAt)
}

/** True while a cap stands at or past warnAt (for the band's color). */
export function nearAnyCap(uses: CapUse[], warnAt: number): boolean {
  return uses.some(u => u.max > 0 && u.n / u.max >= warnAt)
}

export function denyText(u: CapUse): string {
  return (
    'agent-map: ' + CAP_NAMES[u.kind] + ' reached (' + u.n + '/' + u.max + '). Wait for running subagents to return, or batch the work into fewer agents. ' +
    'The user can raise it with /agent-map cap ' + u.kind + ' <n>.'
  )
}

export function nearText(u: CapUse): string {
  const what = u.kind === 'concurrent' ? 'running' : u.kind === 'turn' ? 'spawned this turn' : 'spawned this session'
  return 'agents ' + u.n + '/' + u.max + ' ' + what + ', near the ' + CAP_NAMES[u.kind]
}

export const OVERRIDE_RE = /\[cap-override:\s*([^\]]*)\]/i

/** The reason of a `[cap-override: <reason>]` marker in any of the texts, if there is one. */
export function overrideReason(...texts: unknown[]): string | undefined {
  for (const t of texts) {
    if (typeof t !== 'string') continue
    const m = OVERRIDE_RE.exec(t)
    if (m) return m[1].replace(/\s+/g, ' ').trim() || 'no reason given'
  }
  return undefined
}

export function stripOverride(s: string): string {
  return s.replace(new RegExp(OVERRIDE_RE.source, 'gi'), '').replace(/\s{2,}/g, ' ').trim()
}

export const ASK_ALLOW_ONE = 'Allow this one'
export const ASK_ALLOW_TURN = 'Allow the rest of the turn'
export const ASK_DENY = 'Deny'

export function askText(reason: string): string {
  return 'agent-map: ' + reason + '. Allow one more agent beyond the cap?'
}

export type CapCommandKind = CapKind | 'returned' | 'warn' | 'grace'
export type CapCommand = { kind: CapCommandKind; value: number } | { error: string }

const CAP_KEY: Record<string, keyof CapConfig> = {
  concurrent: 'maxConcurrent',
  turn: 'maxPerTurn',
  session: 'maxPerSession',
  returned: 'maxReturnedTokens',
  warn: 'warnAt',
  grace: 'waitGraceMs',
}

export const CAP_USAGE =
  'Usage: /agent-map cap [concurrent <n> | turn <n> | session <n> | returned <k> | warn <0.1-1> | grace <ms> | reset [<kind>]] (0 turns a cap off)'

const isCapWord = (kind: string | undefined): kind is string => !!kind && Object.prototype.hasOwnProperty.call(CAP_KEY, kind)

/** `/agent-map cap concurrent 6`, `cap returned 200` (thousands of tokens) or `cap returned 200k`, `cap warn 0.8`. */
export function parseCapCommand(args: readonly string[]): CapCommand {
  const kind = args[0]
  const raw = (args[1] ?? '').toLowerCase()
  if (!isCapWord(kind) || !raw) return { error: CAP_USAGE }
  const m = /^(\d+(?:\.\d+)?)(k)?$/.exec(raw)
  if (!m) return { error: CAP_USAGE }
  let value = Number(m[1])
  if (kind === 'warn') {
    if (!(value > 0 && value <= 1)) return { error: 'warn takes a share between 0.1 and 1, such as 0.75' }
    return { kind: 'warn', value }
  }
  if (kind === 'returned') value = m[2] || value < 1000 ? value * 1000 : value
  return { kind: kind as CapKind | 'returned' | 'grace', value: Math.floor(value) }
}

export function capKeyOf(kind: CapKind | 'returned' | 'warn' | 'grace'): keyof CapConfig {
  return CAP_KEY[kind]
}

/** `/agent-map cap reset [kind]`: the saved override to clear, every one without a kind. */
export function parseCapReset(args: readonly string[]): { kind?: CapCommandKind; key?: keyof CapConfig } | { error: string } {
  const kind = args[1]
  if (kind === undefined) return {}
  if (!isCapWord(kind) || args.length > 2) return { error: CAP_USAGE }
  return { kind: kind as CapCommandKind, key: CAP_KEY[kind] }
}

export function capMaxOf(caps: CapConfig, kind: CapKind): number {
  return caps[CAP_MAX[kind]]
}

// ---- Context cost of results (0.3.0) ----

/** Tokens a text costs, estimated as characters / 4. */
export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0
}

/** The text of a tool result as the model reads it: core's `text`, else the result itself. */
export function resultText(r: unknown): string {
  if (!r || typeof r !== 'object') return typeof r === 'string' ? r : ''
  const o = r as Record<string, unknown>
  if (o.deny) return ''
  if (typeof o.text === 'string') return o.text
  const res = o.result
  if (typeof res === 'string') return res
  if (res === undefined || res === null) return ''
  if (typeof res === 'object') {
    const content = (res as Record<string, unknown>).content
    if (Array.isArray(content)) {
      const joined = content
        .map(b => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
        .join('')
      if (joined) return joined
    }
  }
  try {
    return JSON.stringify(res)
  } catch {
    return ''
  }
}

export function addReturned(a: AgentRecord, tokens: number): AgentRecord {
  return { ...a, returnedTokens: (a.returnedTokens ?? 0) + tokens }
}

// ---- Lifecycle log (0.3.0) ----

export const MAX_LOG = 200

export function addLog(list: readonly LogEntry[], entry: LogEntry): LogEntry[] {
  return [...list, entry].slice(-MAX_LOG)
}
