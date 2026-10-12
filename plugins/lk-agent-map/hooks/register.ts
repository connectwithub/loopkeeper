// agent-map: a live map of the session's subagents and how they connect,
// and (0.3.0) a deck that caps how many agents a session spawns, tracks what
// their results cost the main context, and logs each agent's lifecycle.
//
// agent.spawn refuses a spawn past a cap (concurrent, per turn, per session)
// unless the person allows it from a `[cap-override: <reason>]` ask.
//
// Every hook here observes and passes its event on, with two exceptions the
// person asks for: the pane's Stop button (TaskStop, on a confirmed second
// press) and, when TaskStop can't stop an agent, the mute that refuses that
// agent's further tool calls. The data a drawing
// depends on lives in $.state (it survives a hot reload); the band's on/off
// switch is also kept in $.store so it lasts between sessions.
//
// 0.4.0: the pane opens on the Agents cards (hooks/pane.ts, drawn with the kit):
// session tiles (cost, tokens, time), one card per agent with its role doodle, model and
// effort, TodoWrite progress, ctx %, tokens, cost and elapsed time, and the planned spawns.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentRecord, CapConfig, CapCounters, CapSources, LogEntry, LogKind, PaneView, PendingCall, PriceRow } from '../types'
import {
  ASK_ALLOW_ONE,
  ASK_ALLOW_TURN,
  ASK_DENY,
  CAP_USAGE,
  DEFAULT_CAPS,
  DEFAULT_SOURCES,
  MAIN,
  SETTING_KEY,
  addLog,
  addReturned,
  askText,
  capBreach,
  capKeyOf,
  capMaxOf,
  capNear,
  capUses,
  denyText,
  estimateTokens,
  layerCaps,
  mergeCaps,
  nearText,
  newTurn,
  overrideReason,
  parseCapCommand,
  parseCapFile,
  parseCapReset,
  resultText,
  runningCount,
  settingProblem,
  settingValues,
  settingsCaps,
  stripOverride,
  totalTokens,
  zeroCounters,
  MUTE_REASON,
  activityOf,
  activityOfMessages,
  effortOf,
  todoOf,
  addEdge,
  addWaiting,
  addPending,
  anyRunning,
  applyComplete,
  applySpawn,
  applyStep,
  applyToolCall,
  clearFinished,
  clearWaiting,
  isStuck,
  idleMs,
  markFailed,
  markMuted,
  markStopped,
  reconcile,
  pendingOf,
  resolveAddress,
  resume,
  spawnFacts,
  statusOfComplete,
  str,
  takePending,
  withAgent,
  withOrder,
} from './model'
import type { Agents, CapCommandKind, ListedAgent } from './model'
import {
  DEFAULT_STUCK_MS,
  bandOf,
  buildRows,
  cardsText,
  cut,
  fmtElapsed,
  fmtIdle,
  fmtTokens,
  elapsedOf,
  labelOf,
  logRows,
  logText,
  returnedNear,
  returnedNote,
  teamRows,
  teamText,
  treeText,
} from './format'
import type { Row } from './format'
import { TONES, makeKit } from './kit'
import type { Elements } from './kit'
import { DEFAULT_WINDOW, capsTree, cardsTree, headerTree, mainRow } from './pane'
import { PRICES, mergePrices } from './prices'

const PANE = 'agent-map'
const TITLE = 'Agent map'
const COMMAND = 'agent-map'
const BAND_KEY = 'band'

const agentsAtom = atom({ plugin: 'lk-agent-map', key: 'agents' } as const, {} as Record<string, AgentRecord>)
const orderAtom = atom({ plugin: 'lk-agent-map', key: 'order' } as const, [] as string[])
const pendingAtom = atom({ plugin: 'lk-agent-map', key: 'pending' } as const, [] as PendingCall[])
const expandedAtom = atom({ plugin: 'lk-agent-map', key: 'expanded' } as const, [] as string[])
const nowAtom = atom({ plugin: 'lk-agent-map', key: 'now' } as const, 0)
const bandAtom = atom({ plugin: 'lk-agent-map', key: 'band' } as const, true)
const everAtom = atom({ plugin: 'lk-agent-map', key: 'everSpawned' } as const, false)
const armedAtom = atom({ plugin: 'lk-agent-map', key: 'armed' } as const, null as string | null)
const capsAtom = atom({ plugin: 'lk-agent-map', key: 'caps' } as const, DEFAULT_CAPS as CapConfig)
const capSourcesAtom = atom({ plugin: 'lk-agent-map', key: 'capSources' } as const, DEFAULT_SOURCES as CapSources)
const countersAtom = atom({ plugin: 'lk-agent-map', key: 'counters' } as const, zeroCounters() as CapCounters)
const logAtom = atom({ plugin: 'lk-agent-map', key: 'log' } as const, [] as LogEntry[])
const viewAtom = atom({ plugin: 'lk-agent-map', key: 'view' } as const, null as PaneView | null)
const showLogAtom = atom({ plugin: 'lk-agent-map', key: 'showLog' } as const, false)
const collapsedAtom = atom({ plugin: 'lk-agent-map', key: 'collapsed' } as const, false)
const windowAtom = atom({ plugin: 'lk-agent-map', key: 'window' } as const, DEFAULT_WINDOW)
const pricesAtom = atom({ plugin: 'lk-agent-map', key: 'prices' } as const, PRICES as PriceRow[])

const CAPS_KEY = 'caps'
// 0.5.0 reads the chosen view from a new key, so everyone lands on cards once; later choices are kept
const VIEW_KEY = 'view2'
const CAP_FILE = '.claude/agent-map.json'
const VIEWS: readonly PaneView[] = ['tree', 'cards', 'team']

/** How long an armed Stop button waits for its second press. */
export const ARM_MS = 5000
/** Room the pane keeps on a running row for its Stop button. */
const STOP_RESERVE = 16
/** An agent's own transcript is read for its last activity at most this often. */
const PEEK_MS = 10_000
const STOPPED_BY_YOU = 'you (agent map)'

type Config = { stuckAfterMs: number }
export function parseConfig(options: unknown): Config {
  const o = (options && typeof options === 'object' ? options : {}) as Record<string, unknown>
  const v = o.stuckAfterMs
  const stuckAfterMs = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : DEFAULT_STUCK_MS
  return { stuckAfterMs }
}
let cfg: Config = parseConfig(undefined)
// The values register(on, options) got: the cap settings when $.config.list() can't be read.
let regOptions: unknown

// tool.check carries no loop id; the tool.call around it does, keyed by the call's id.
const callLoop = new Map<string, string>()
// TaskStop calls this mod raised itself, by task id: not counted as the main loop's tools.
const ownStops = new Set<string>()
// When each agent's transcript was last read for its activity.
const peekedAt = new Map<string, number>()
let armTimer: { cancel: () => void } | null = null
// Spawns the cap gate admitted that agent.spawn hasn't recorded yet, by tool_use_id: they count as running.
const inflight = new Set<string>()
// The cap note each admitted spawn logs with ("running 2/4 · turn 1/8 · session 1/40").
const spawnNotes = new Map<string, string>()
// Agent tool calls and the agents they started, both ways, so a result finds its agent whichever comes first.
const agentOfCall = new Map<string, string>()
const returnedOfCall = new Map<string, number>()
let spawnSeq = 0
// Permission asks not yet shown as waiting: an auto-approved ask resolves inside the grace and never flickers.
type PendingAsk = { loop: string; tool: string; timer: { cancel: () => void } | null }
const pendingAsks = new Map<string, PendingAsk>()
// Once classic.PermissionRequest has fired in this session, a dialog is the signal and the grace timer only stands by.
let dialogSignal = false
// The session's working directory, for <cwd>/.claude/agent-map.json
let sessionCwd: string | undefined
// The cap gate runs one spawn at a time, so parallel spawns can't all pass the same count.
let gateChain: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = gateChain.then(fn, fn)
  gateChain = run.catch(() => undefined)
  return run
}

// The one-second redraw timer. Timers stop when the module reloads, so this
// is module state on purpose: a fresh module starts its own when needed.
let ticker: { cancel: () => void } | null = null

type Api = Parameters<typeof read>[0]

async function nowOf($: Api): Promise<number> {
  try {
    const t = await $.clock.now()
    return typeof t === 'number' ? t : Date.now()
  } catch {
    return Date.now()
  }
}

async function tick($: Api): Promise<void> {
  try {
    const t = await $.clock.now()
    await update($, nowAtom, () => t)
    await reconcileList($)
    await alertStuck($, t)
    if (!anyRunning(await read($, agentsAtom)) && ticker) {
      ticker.cancel()
      ticker = null
    }
  } catch {
    // A failed tick waits for the next one
  }
}

/** Starts the redraw timer while anything runs, and stops it when nothing does. */
async function syncTicker($: Api): Promise<void> {
  try {
    const running = anyRunning(await read($, agentsAtom))
    if (running && !ticker) {
      ticker = $.clock.every(1000, () => {
        void tick($)
      })
    } else if (!running && ticker) {
      ticker.cancel()
      ticker = null
    }
  } catch {
    ticker = null
  }
}

/** Toasts once per stall for each running agent idle past stuckAfterMs. */
async function alertStuck($: Api, now: number): Promise<void> {
  if (cfg.stuckAfterMs <= 0) return
  const agents = await read($, agentsAtom)
  const stuck = Object.values(agents).filter(a => a.id !== MAIN && !a.stuckNotified && isStuck(a, now, cfg.stuckAfterMs))
  if (stuck.length === 0) return
  await update($, agentsAtom, (m: Agents) => {
    let out = m
    for (const a of stuck) if (out[a.id]) out = { ...out, [a.id]: { ...out[a.id], stuckNotified: true } }
    return out
  })
  for (const a of stuck) {
    await logEvent($, a.id, 'idle', 'no tool call or model request for ' + fmtIdle(idleMs(a, now))).catch(() => undefined)
    try {
      await $.ui.toast('Agent ' + cut(labelOf(a), 40) + ' has been idle ' + fmtIdle(idleMs(a, now)) + ': no tool call or model request')
    } catch {
      // The row still shows ⚠ idle
    }
  }
}

/**
 * Merges $.agent.list() into the map, when this build has it: agents the
 * spawn hook missed (forks, teammates, workflow agents) appear, parents and
 * end states fill in. An agent with no activity yet gets its transcript's tail.
 */
async function reconcileList($: Api): Promise<void> {
  let listed: unknown
  try {
    listed = await $.agent.list()
  } catch {
    // A build or host without the list: the spawn hook's map stands
    return
  }
  if (!Array.isArray(listed) || listed.length === 0) return
  const now = await nowOf($)
  const order = await read($, orderAtom)
  let added: string[] = []
  let nextOrder = order
  await update($, agentsAtom, (m: Agents) => {
    const r = reconcile(m, order, listed as ListedAgent[], now)
    added = r.added
    nextOrder = r.order
    return r.agents
  })
  if (nextOrder !== order) await update($, orderAtom, () => nextOrder)
  if (added.length > 0) {
    await openOnFirstSpawn($)
    await syncTicker($)
  }
  await peekActivity($, now)
}

/** The last activity of running agents no tool.call was seen from, from their own transcripts. */
async function peekActivity($: Api, now: number): Promise<void> {
  const agents = await read($, agentsAtom)
  for (const a of Object.values(agents)) {
    if (a.id === MAIN || !a.isSpawned || a.status !== 'running' || a.activity) continue
    if (now - (peekedAt.get(a.id) ?? -Infinity) < PEEK_MS) continue
    peekedAt.set(a.id, now)
    try {
      const activity = activityOfMessages(await $.session.messages({ agentId: a.id }))
      if (activity) await update($, agentsAtom, (m: Agents) => (m[a.id] && !m[a.id].activity ? { ...m, [a.id]: { ...m[a.id], activity } } : m))
    } catch {
      // A transcript this session can't read: the row shows no activity
    }
  }
}

async function changeAgent($: Api, id: string, fn: (a: AgentRecord, now: number) => AgentRecord): Promise<void> {
  const now = await nowOf($)
  await update($, agentsAtom, (m: Agents) => withAgent(m, id, now, a => fn(a, now)))
  await update($, nowAtom, () => now)
}

/** Shows ⏸ waiting for a pending ask now (its grace ran out, or a dialog opened for it). */
// An ask waits out its grace: when the grace runs out it shows ⏸ waiting, unless a dialog signal says it was approved.
function armGrace($: Api, toolUseId: string, grace: number): void {
  const p = pendingAsks.get(toolUseId)
  if (!p) return
  p.timer = $.clock.after(grace, () => {
    if (p.timer === null) return
    p.timer = null
    // With a dialog signal in this session, an ask the grace outlived without a dialog was approved: it runs
    if (dialogSignal) pendingAsks.delete(toolUseId)
    else void markWaiting($, toolUseId).catch(() => undefined)
  })
}

// The call a settings PreToolUse point saw is going to run: its pending ask is dropped and a shown ⏸ waiting clears.
async function clearApprovedWait($: Api, e: unknown): Promise<void> {
  let toolUseId = str(e, 'tool_use_id')
  if (!toolUseId) {
    const tool = str(e, 'tool_name', 'tool')
    for (const [k, p] of pendingAsks) if (p.tool === tool && p.loop === (str(e, 'agentId', 'agent_id') ?? MAIN)) toolUseId = k
  }
  if (!toolUseId) return
  const id = toolUseId
  cancelAsk(id)
  let waited: string[] = []
  await update($, agentsAtom, (m: Agents) => {
    waited = Object.values(m).filter(a => a.waiting?.some(w => w.toolUseId === id)).map(a => a.id)
    return clearWaiting(m, id)
  })
  for (const w of waited) await logEvent($, w, 'resumed', 'approved: ' + (str(e, 'tool', 'tool_name') ?? 'tool'))
}

async function markWaiting($: Api, toolUseId: string): Promise<void> {
  const p = pendingAsks.get(toolUseId)
  if (!p) return
  pendingAsks.delete(toolUseId)
  p.timer?.cancel()
  const a = (await read($, agentsAtom))[p.loop]
  if (p.loop !== MAIN && a && a.status !== 'running') return
  await changeAgent($, p.loop, (x, now) => addWaiting(x, { toolUseId, tool: p.tool, at: now }))
  await logEvent($, p.loop, 'waiting', p.tool)
}

function cancelAsk(toolUseId: string): void {
  const p = pendingAsks.get(toolUseId)
  if (!p) return
  p.timer?.cancel()
  pendingAsks.delete(toolUseId)
}

function cancelAsksOf(loop: string): void {
  for (const [k, p] of pendingAsks) if (p.loop === loop) cancelAsk(k)
}

/** Appends one lifecycle event of agent `id` to the log. */
async function logEvent($: Api, id: string, kind: LogKind, text: string, label?: string): Promise<void> {
  const now = await nowOf($)
  const agents = await read($, agentsAtom)
  const name = label ?? (id === MAIN ? 'main' : cut(labelOf(agents[id], id), 32))
  await update($, logAtom, (l: LogEntry[]) => addLog(l, { at: now, id, label: name, kind, text }))
}

async function readText($: Api, path: string): Promise<string | undefined> {
  try {
    const t = await $.fs.read(path)
    return typeof t === 'string' ? t : undefined
  } catch {
    return undefined
  }
}

/**
 * The caps: defaults, then the plugin's settings (its /config rows, read live), then
 * ~/.claude/agent-map.json, then <cwd>/.claude/agent-map.json, then what /agent-map cap saved.
 * The same files' `prices` objects lay over the price table by family.
 */
async function loadCaps($: Api): Promise<void> {
  let prices: PriceRow[] = PRICES.map(r => [...r] as PriceRow)
  let rows: unknown
  try {
    rows = await $.config.list()
  } catch {
    // No rows: the values register got stand
  }
  let home: string | undefined
  try {
    home = (await $.env.get('HOME')) || undefined
  } catch {
    home = undefined
  }
  const userFile = home ? parseCapFile(await readText($, home.replace(/\/+$/, '') + '/' + CAP_FILE)) : undefined
  const projectFile = parseCapFile(await readText($, sessionCwd ? sessionCwd.replace(/\/+$/, '') + '/' + CAP_FILE : CAP_FILE))
  for (const f of [userFile, projectFile]) {
    if (f && typeof f === 'object') prices = mergePrices(prices, (f as Record<string, unknown>).prices)
  }
  let saved: unknown
  try {
    saved = await $.store.get(CAPS_KEY)
  } catch {
    // No store: the files, settings and defaults stand
  }
  const { caps, sources } = layerCaps([
    { source: 'settings', over: settingsCaps(settingValues(rows, regOptions)) },
    { source: 'user file', over: userFile },
    { source: 'project file', over: projectFile },
    { source: 'saved (/agent-map cap)', over: saved },
  ])
  await update($, capsAtom, () => caps)
  await update($, capSourcesAtom, () => sources)
  await update($, pricesAtom, () => prices)
}

/** The session's context window, which the cards' ctx % divides by (a subagent's own isn't exposed). */
async function loadWindow($: Api): Promise<void> {
  try {
    const u = (await $.session.usage()) as { context?: { window?: unknown } } | undefined
    const w = u?.context?.window
    if (typeof w === 'number' && Number.isFinite(w) && w > 0) await update($, windowAtom, () => w)
  } catch {
    // Keep the 200k fallback
  }
}

/** Drops an Agent call that will never spawn (refused by the gate or the engine) from the planned list. */
async function dropPending($: Api, toolUseId: string | undefined): Promise<void> {
  if (!toolUseId) return
  await update($, pendingAtom, (l: PendingCall[]) => (l.some(p => p.toolUseId === toolUseId) ? l.filter(p => p.toolUseId !== toolUseId) : l))
}

async function loadView($: Api): Promise<void> {
  try {
    const v = await $.store.get(VIEW_KEY)
    if (typeof v === 'string' && (VIEWS as readonly string[]).includes(v)) await update($, viewAtom, () => v as PaneView)
  } catch {
    // Keep the default: cards in the pane, the tree in /agent-map text
  }
}

async function setView($: Api, v: PaneView): Promise<void> {
  await update($, viewAtom, () => v)
  try {
    await $.store.set(VIEW_KEY, v)
  } catch {
    // Kept for this session only
  }
}

/**
 * The cap check for one spawn. Returns a refusal, or null when the spawn may
 * start (it then counts as running until agent.spawn records it).
 */
async function gate($: Api, e: Record<string, unknown>, key: string): Promise<string | null> {
  const countsTurn = e.isTeammate !== true && e.fork !== true
  const caps = await read($, capsAtom)
  const counters = await read($, countersAtom)
  const agents = await read($, agentsAtom)
  const running = runningCount(agents) + inflight.size
  const uses = capUses(running, counters, caps)
  const label = cut(stripOverride(str(e, 'description', 'name') ?? 'agent'), 32) || 'agent'
  const breach = capBreach(uses, countsTurn)
  if (breach) {
    let allowed = counters.overrideTurn
    let why = ''
    if (allowed) {
      await logEvent($, key, 'override', 'past the ' + breach.kind + ' cap (' + breach.n + '/' + breach.max + '): allowed for the rest of the turn', label)
    } else {
      const reason = overrideReason(e.description, e.prompt)
      if (!reason) {
        why = ''
      } else {
        let answer: string | undefined
        try {
          answer = await $.ui.ask(askText(reason), [ASK_ALLOW_ONE, ASK_ALLOW_TURN, ASK_DENY])
        } catch {
          answer = undefined
        }
        if (answer === ASK_ALLOW_ONE || answer === ASK_ALLOW_TURN) {
          allowed = true
          if (answer === ASK_ALLOW_TURN) await update($, countersAtom, (c: CapCounters) => ({ ...c, overrideTurn: true }))
        } else {
          why = answer === undefined ? ' No one could be asked about the override.' : ' The user declined the override.'
        }
        await logEvent($, key, 'override', reason + ': ' + (answer === undefined ? 'no one to ask, denied' : answer), label)
      }
    }
    if (!allowed) {
      await update($, countersAtom, (c: CapCounters) => ({ ...c, deniedThisTurn: true }))
      await logEvent($, key, 'denied', breach.kind + ' cap ' + breach.n + '/' + breach.max, label)
      return denyText(breach) + why
    }
  }
  inflight.add(key)
  let after = counters
  await update($, countersAtom, (c: CapCounters) => {
    after = { ...c, turn: c.turn + (countsTurn ? 1 : 0), session: c.session + 1 }
    return after
  })
  spawnNotes.set(
    key,
    'running ' + (running + 1) + capOf(caps.maxConcurrent) + ' · turn ' + after.turn + capOf(caps.maxPerTurn) + ' · session ' + after.session + capOf(caps.maxPerSession) + (countsTurn ? '' : ' · not counted per turn'),
  )
  const near = capNear(uses, caps.warnAt, countsTurn)
  if (near && !after.warnedThisTurn) {
    await update($, countersAtom, (c: CapCounters) => ({ ...c, warnedThisTurn: true }))
    try {
      await $.ui.toast(nearText(near))
    } catch {
      // The band's chip says near cap anyway
    }
  }
  return null
}

const capOf = (max: number) => (max > 0 ? '/' + max : '')

/** A spawn that next() refused or that never started gives back what the gate counted. */
async function ungate($: Api, key: string, e: Record<string, unknown>): Promise<void> {
  const countsTurn = e.isTeammate !== true && e.fork !== true
  inflight.delete(key)
  spawnNotes.delete(key)
  await update($, countersAtom, (c: CapCounters) => ({ ...c, turn: Math.max(0, c.turn - (countsTurn ? 1 : 0)), session: Math.max(0, c.session - 1) }))
}

/** What an Agent tool call's result put into its caller's context (characters / 4). */
async function noteReturned($: Api, toolUseId: string, caller: string, tokens: number): Promise<void> {
  if (tokens <= 0) return
  const agentId = agentOfCall.get(toolUseId)
  if (agentId) {
    await changeAgent($, agentId, a => addReturned(a, tokens))
    await logEvent($, agentId, 'returned', fmtTokens(tokens) + ' tok to ' + (caller === MAIN ? 'main' : cut(labelOf((await read($, agentsAtom))[caller], caller), 24)))
  } else {
    returnedOfCall.set(toolUseId, (returnedOfCall.get(toolUseId) ?? 0) + tokens)
  }
  if (caller === MAIN) await addToMain($, tokens)
}

async function addToMain($: Api, tokens: number): Promise<void> {
  const caps = await read($, capsAtom)
  let after = await read($, countersAtom)
  await update($, countersAtom, (c: CapCounters) => {
    after = { ...c, returnedTotal: c.returnedTotal + tokens }
    return after
  })
  if (!after.returnedWarned && returnedNear(caps, after)) {
    await update($, countersAtom, (c: CapCounters) => ({ ...c, returnedWarned: true }))
    try {
      await $.ui.toast(
        'agent-map: subagent results have put ' + fmtTokens(after.returnedTotal) + ' tokens into the main context. Consider /compact, or a handoff to a fresh session.',
      )
    } catch {
      // The band's chip says near cap
    }
  }
}

async function loadBand($: Api): Promise<void> {
  try {
    const saved = await $.store.get(BAND_KEY)
    if (typeof saved === 'boolean') await update($, bandAtom, () => saved)
  } catch {
    // No store: keep the default
  }
}

async function openOnFirstSpawn($: Api): Promise<void> {
  if (await read($, everAtom)) return
  await update($, everAtom, () => true)
  try {
    const placed = await $.ui.open({ id: PANE, title: TITLE })
    if (!placed || placed.isPlaced !== true) await $.ui.toast('Subagents started: /agent-map shows the map')
  } catch {
    // A pane that can't open leaves the band and /agent-map text
  }
}

async function recordSpawn($: Api, e: unknown, r: unknown, threw = false, gateKey?: string): Promise<void> {
  if (r && typeof r === 'object' && (r as { deny?: unknown }).deny) return
  let match: PendingCall | undefined
  await update($, pendingAtom, (list: PendingCall[]) => {
    const taken = takePending(list, e)
    match = taken.match
    return taken.rest
  })
  const facts = spawnFacts(e, r, match)
  const toolUseId = str(e, 'tool_use_id')
  const key = gateKey ?? toolUseId ?? ''
  const early = toolUseId ? (returnedOfCall.get(toolUseId) ?? 0) : 0
  await changeAgent($, facts.id, (a, now) => {
    let x = threw ? markFailed(applySpawn(a, facts, now), now) : applySpawn(a, facts, now)
    if (early > 0) x = addReturned(x, early)
    return x
  })
  // Recorded: it counts through the map now, no longer as in flight
  inflight.delete(key)
  if (toolUseId) {
    agentOfCall.set(toolUseId, facts.id)
    returnedOfCall.delete(toolUseId)
  }
  const a = (await read($, agentsAtom))[facts.id]
  const note = spawnNotes.get(key)
  spawnNotes.delete(key)
  await logEvent($, facts.id, 'spawned', [a ? (a.name || 'agent') + ' ' + (a.model || '?') : '', note ?? '', threw ? 'failed to start' : ''].filter(Boolean).join(' · '))
  await update($, orderAtom, (o: string[]) => withOrder(o, facts.id))
  await openOnFirstSpawn($)
  await syncTicker($)
}

async function recordComplete($: Api, e: unknown, failed: boolean): Promise<void> {
  const id = str(e, 'agentId')
  cancelAsksOf(id ?? MAIN)
  if (!id) {
    const now = await nowOf($)
    await update($, nowAtom, () => now)
    return
  }
  const status = failed ? 'failed' : statusOfComplete(e)
  const wasRunning = (await read($, agentsAtom))[id]?.status === 'running'
  const prices = await read($, pricesAtom)
  await changeAgent($, id, (a, now) => (failed ? markFailed(a, now) : applyComplete(a, e, now, status, prices)))
  const a = (await read($, agentsAtom))[id]
  if (wasRunning && a && a.isSpawned && a.status !== 'running') {
    const ret = returnedNote(await read($, agentsAtom), a)
    const kind: LogKind = a.status === 'done' || a.status === 'failed' || a.status === 'aborted' ? a.status : 'stopped'
    await logEvent($, id, kind, 'in ' + fmtElapsed(elapsedOf(a, await nowOf($))) + ' · ' + fmtTokens(totalTokens(a.tokens)) + ' tok' + (ret ? ' · ' + ret : ''))
  }
  await syncTicker($)
}

async function recordMessage($: Api, fromRaw: unknown, toRaw: unknown): Promise<void> {
  const agents = await read($, agentsAtom)
  const from = resolveAddress(agents, fromRaw) ?? MAIN
  const to = resolveAddress(agents, toRaw)
  if (!to || to === from) return
  const isSub = (id: string) => id !== MAIN && agents[id]?.isSpawned === true
  if (!isSub(from) && !isSub(to)) return
  const now = await nowOf($)
  await update($, agentsAtom, (m: Agents) => addEdge(withAgent(m, MAIN, now, a => a), from, to, now))
}

async function clearFinishedAgents($: Api): Promise<number> {
  let removed = 0
  const order = await read($, orderAtom)
  let nextOrder = order
  await update($, agentsAtom, (m: Agents) => {
    const c = clearFinished(m, order)
    removed = c.removed
    nextOrder = c.order
    return c.agents
  })
  await update($, orderAtom, () => nextOrder)
  const agents = await read($, agentsAtom)
  await update($, expandedAtom, (x: string[]) => x.filter(id => agents[id] !== undefined))
  return removed
}

async function toggleExpanded($: Api, id: string): Promise<void> {
  await update($, expandedAtom, (x: string[]) => (x.includes(id) ? x.filter(y => y !== id) : [...x, id]))
}

async function setBand($: Api, value: boolean): Promise<void> {
  await update($, bandAtom, () => value)
  try {
    await $.store.set(BAND_KEY, value)
  } catch {
    // Kept for this session only
  }
}

async function mapText($: Api): Promise<string> {
  const agents = await read($, agentsAtom)
  const order = await read($, orderAtom)
  return treeText(agents, order, await nowOf($), undefined, cfg.stuckAfterMs)
}

/** First press arms the row's Stop button; a second press within ARM_MS stops the agent. */
async function pressStop($: Api, id: string): Promise<void> {
  const armed = await read($, armedAtom)
  if (armed === id) {
    armTimer?.cancel()
    armTimer = null
    await update($, armedAtom, () => null)
    await stopAgent($, id)
    return
  }
  await update($, armedAtom, () => id)
  armTimer?.cancel()
  armTimer = $.clock.after(ARM_MS, () => {
    armTimer = null
    void update($, armedAtom, (x: string | null) => (x === id ? null : x)).catch(() => undefined)
  })
}

/**
 * Stops a running agent with Claude Code's own TaskStop, raised with the
 * person's press as consent. When TaskStop can't (a foreground subagent, an
 * id it doesn't know), the agent is muted instead: its next tool calls are
 * refused with a reason that asks it to return its result now.
 */
async function stopAgent($: Api, id: string): Promise<void> {
  const a = (await read($, agentsAtom))[id]
  if (!a || a.status !== 'running') return
  // The consent reads to the engine as the person's words: the type and id, never a model-written description.
  const consent = 'The user pressed "Stop" on the ' + JSON.stringify(cut(a.name || 'agent', 30)) + ' agent ' + cut(id, 60) + ' in the agent map pane'
  ownStops.add(id)
  let r: { deny?: string; isError?: boolean; text?: unknown } | undefined
  try {
    r = (await $.tool.call({ tool: 'TaskStop', task_id: id, consent } as never)) as typeof r
  } catch (err) {
    r = { deny: String(err instanceof Error ? err.message : err) }
  } finally {
    ownStops.delete(id)
  }
  const why = r?.deny || (r?.isError ? String(r.text ?? '').replace(/\s+/g, ' ').trim() || 'the tool reported an error' : '')
  if (!why) {
    const was = (await read($, agentsAtom))[id]?.status
    await changeAgent($, id, (x, now) => markStopped(x, STOPPED_BY_YOU, now))
    // noteStop may have logged it already, from inside the TaskStop call
    if (was === 'running') await logEvent($, id, 'stopped', 'by ' + STOPPED_BY_YOU)
    await syncTicker($)
    return
  }
  await changeAgent($, id, x => markMuted(x))
  await logEvent($, id, 'muted', 'TaskStop refused: ' + cut(why, 60))
  try {
    await $.ui.toast('Could not stop ' + cut(labelOf(a), 40) + ' (' + cut(why, 80) + '). Muted it: its next tool calls are refused.')
  } catch {
    // The row shows ⊘ muted
  }
}

/** A TaskStop that went through: the agent it named is stopped, by whoever called it. */
async function noteStop($: Api, e: unknown, r: unknown, caller: string): Promise<void> {
  const res = (r && typeof r === 'object' ? r : {}) as { deny?: unknown; isError?: unknown }
  if (res.deny || res.isError) return
  const agents = await read($, agentsAtom)
  const target = resolveAddress(agents, str(e, 'task_id', 'shell_id'))
  if (!target || target === MAIN || agents[target]?.status !== 'running') return
  const by = ownStops.has(target) ? STOPPED_BY_YOU : caller === MAIN ? 'main' : labelOf(agents[caller], caller)
  await changeAgent($, target, (x, now) => markStopped(x, by, now))
  await logEvent($, target, 'stopped', 'by ' + by)
}

const USAGE = 'Usage: /agent-map [clear | band on | band off | text | cards | tree | team | view <cards|tree|team> | log | cap <kind> <n> | cap reset [kind]]'

function capsText(c: CapConfig, counters: CapCounters, running: number): string {
  const v = (n: number) => (n > 0 ? String(n) : 'off')
  return (
    'agent-map caps: concurrent ' + v(c.maxConcurrent) + ' (now ' + running + ') · turn ' + v(c.maxPerTurn) + ' (now ' + counters.turn + ') · session ' +
    v(c.maxPerSession) + ' (now ' + counters.session + ') · returned ' + (c.maxReturnedTokens > 0 ? fmtTokens(c.maxReturnedTokens) : 'off') +
    ' (now ' + fmtTokens(counters.returnedTotal) + ') · warn at ' + Math.round(c.warnAt * 100) + '% · waiting grace ' + c.waitGraceMs + ' ms'
  )
}

/** One cap's value as /agent-map cap says it: `90%`, `200k tok`, `1500 ms`, `6`; `off` for 0. */
function shownCap(caps: CapConfig, kind: CapCommandKind): string {
  if (kind === 'warn') return Math.round(caps.warnAt * 100) + '%'
  if (kind === 'grace') return caps.waitGraceMs === 0 ? '0 ms (waits show at once)' : caps.waitGraceMs + ' ms'
  const n = caps[capKeyOf(kind)]
  if (n === 0) return 'off'
  return kind === 'returned' ? fmtTokens(n) + ' tok' : String(n)
}

async function savedCaps($: Api): Promise<Record<string, unknown>> {
  try {
    const s = await $.store.get(CAPS_KEY)
    if (s && typeof s === 'object') return { ...(s as Record<string, unknown>) }
  } catch {
    // Start a fresh override set
  }
  return {}
}

/** `/agent-map cap reset [kind]`: drops that kind's saved override (every one without a kind) and loads the caps again. */
async function resetCap($: Api, args: string[]): Promise<string> {
  const r = parseCapReset(args)
  if ('error' in r) return r.error
  let saved = await savedCaps($)
  if (r.key) delete saved[r.key]
  else saved = {}
  try {
    await $.store.set(CAPS_KEY, saved)
  } catch {
    // Nothing saved to clear
  }
  await loadCaps($).catch(() => undefined)
  const caps = await read($, capsAtom)
  if (!r.kind || !r.key) return 'agent-map: saved caps cleared. ' + capsText(caps, await read($, countersAtom), runningCount(await read($, agentsAtom)))
  return 'agent-map: ' + r.kind + ' cap reset to ' + shownCap(caps, r.kind) + ' (' + (await read($, capSourcesAtom))[r.key] + ')'
}

async function setCap($: Api, args: string[]): Promise<string> {
  if (args.length === 0) return capsText(await read($, capsAtom), await read($, countersAtom), runningCount(await read($, agentsAtom)))
  if (args[0] === 'reset') return resetCap($, args)
  const cmd = parseCapCommand(args)
  if ('error' in cmd) return cmd.error
  const key = capKeyOf(cmd.kind)
  const saved = await savedCaps($)
  saved[key] = cmd.value
  try {
    await $.store.set(CAPS_KEY, saved)
  } catch {
    // Kept for this session only
  }
  await update($, capsAtom, (c: CapConfig) => mergeCaps(c, { [key]: cmd.value }))
  await update($, capSourcesAtom, (s: CapSources) => ({ ...s, [key]: 'saved (/agent-map cap)' }))
  return 'agent-map: ' + cmd.kind + ' cap set to ' + shownCap(await read($, capsAtom), cmd.kind)
}

async function viewText($: Api, view: PaneView): Promise<string> {
  const agents = await read($, agentsAtom)
  const order = await read($, orderAtom)
  const now = await nowOf($)
  if (view === 'cards') return cardsText(agents, order, now, undefined, cfg.stuckAfterMs)
  if (view === 'team') return teamText(agents, order, now, undefined, cfg.stuckAfterMs)
  return treeText(agents, order, now, undefined, cfg.stuckAfterMs)
}

export const register: Register = (on, options) => {
  cfg = parseConfig(options)
  regOptions = options

  on('session.start', async ($, e, next) => {
    sessionCwd = str(e, 'cwd') ?? sessionCwd
    await loadBand($)
    await loadCaps($).catch(() => undefined)
    await loadView($)
    await loadWindow($)
    await syncTicker($)
    try {
      await $.command.register({
        name: COMMAND,
        description: 'Open the agent deck: cards with cost, tokens, context and progress, the tree or team view, the lifecycle log, and spawn caps',
        argumentHint: '[cards | tree | team | log | text | clear | band on|off | cap <kind> <n> | cap reset [kind]]',
        immediate: true,
      })
    } catch {
      // The name is taken: the map still draws, without the command
    }
    return next(e)
  })

  // /clear, /resume and /branch reset $.state: load the band switch again
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    if (ticker) {
      ticker.cancel()
      ticker = null
    }
    armTimer?.cancel()
    armTimer = null
    peekedAt.clear()
    callLoop.clear()
    for (const k of Array.from(pendingAsks.keys())) cancelAsk(k)
    inflight.clear()
    spawnNotes.clear()
    agentOfCall.clear()
    returnedOfCall.clear()
    await loadBand($)
    await loadCaps($).catch(() => undefined)
    await loadView($)
    await loadWindow($)
    return next(e)
  })

  // A cap setting changed in /config: an out-of-range value is refused before it is written, and
  // the caps load again once it is. A guard that fails refuses rather than letting the value through.
  on('config.set', { key: SETTING_KEY }, async ($, e, next) => {
    const field = SETTING_KEY.exec(e.key)?.[2]
    const problem = field ? settingProblem(field, e.value) : undefined
    if (problem) return { deny: problem }
    const r = await next(e)
    await loadCaps($).catch(() => undefined)
    return r
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'agent-map could not check this value' }))

  // A settings file changed outside /config (the desktop's plugin settings may write it directly)
  on('classic.ConfigChange', async ($, e, next) => {
    const r = await next(e)
    await loadCaps($).catch(() => undefined)
    return r
  })

  on('tool.call', async ($, e, next) => {
    const id = str(e, 'agentId') ?? MAIN
    const tool = str(e, 'tool') ?? 'tool'
    const toolUseId = str(e, 'tool_use_id')
    try {
      // The mute: TaskStop couldn't stop this agent, so its tool calls end here
      if (id !== MAIN) {
        const a = (await read($, agentsAtom))[id]
        if (a?.muted && a.status === 'running') return { deny: MUTE_REASON }
      }
    } catch {
      // No map to read: let the call through
    }
    try {
      if (toolUseId) callLoop.set(toolUseId, id)
      const own = tool === 'TaskStop' && id === MAIN && ownStops.has(str(e, 'task_id') ?? '')
      if (!own) {
        if (tool === 'Agent' || tool === 'Task') {
          const now = await nowOf($)
          await update($, pendingAtom, (l: PendingCall[]) => addPending(l, pendingOf(e, now)))
        }
        const before = id === MAIN ? undefined : (await read($, agentsAtom))[id]
        const activity = activityOf(tool, e)
        // TodoWrite's list is the agent's progress: completed / all, and the item in progress
        const todo = tool === 'TodoWrite' ? todoOf(e) : undefined
        await changeAgent($, id, (a, now) => {
          const x = applyToolCall(a, tool, activity, now)
          return todo === undefined ? x : { ...x, todo }
        })
        if (before?.isSpawned && before.toolCalls === 0) await logEvent($, id, 'first-tool', activity)
      }
    } catch {
      // Observing only: never stand in the tool's way
    }
    let r: unknown
    try {
      r = await next(e)
      return r as Awaited<ReturnType<typeof next>>
    } finally {
      try {
        if (toolUseId) {
          callLoop.delete(toolUseId)
          // An ask the call outran (auto-approved within the grace) never shows
          cancelAsk(toolUseId)
          // The call ran (or was refused): it no longer waits on the person.
          // clearWaiting hands back the same map when nothing waited, so no redraw then.
          let waited: string[] = []
          await update($, agentsAtom, (m: Agents) => {
            waited = Object.values(m).filter(a => a.waiting?.some(w => w.toolUseId === toolUseId)).map(a => a.id)
            return clearWaiting(m, toolUseId)
          })
          for (const w of waited) await logEvent($, w, 'resumed', 'after ' + tool)
        }
        if ((tool === 'Agent' || tool === 'Task') && toolUseId && r) {
          const res = r as { deny?: unknown; isError?: unknown }
          // A refused call never spawns: it leaves the planned list
          if (res.deny || res.isError) await dropPending($, toolUseId)
          await noteReturned($, toolUseId, id, estimateTokens(resultText(r)))
        }
        if (tool === 'TaskStop') await noteStop($, e, r, id)
      } catch {
        // Best effort
      }
    }
  })

  // Permission verdicts: a call put to the person shows ⏸ waiting on its loop's row until it runs
  on('tool.check', async ($, e, next) => {
    try {
      const toolUseId = str(e, 'tool_use_id')
      const verdict = toolUseId ? await $.tool.check({ tool: e.tool, input: e.input }) : null
      if (toolUseId && verdict && verdict.decision === 'ask') {
        const id = callLoop.get(toolUseId) ?? str(e, 'agentId') ?? MAIN
        const tool = str(e, 'tool') ?? 'tool'
        const grace = (await read($, capsAtom)).waitGraceMs
        cancelAsk(toolUseId)
        pendingAsks.set(toolUseId, { loop: id, tool, timer: null })
        if (grace <= 0) await markWaiting($, toolUseId)
        else armGrace($, toolUseId, grace)
      }
    } catch {
      // Observing only
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const o = e as unknown as Record<string, unknown>
    const key = str(o, 'tool_use_id') ?? 'spawn:' + ++spawnSeq
    let refusal: string | null = null
    try {
      refusal = await serialized(() => gate($, o, key))
    } catch {
      // A gate that fails lets the spawn through
      refusal = null
    }
    if (refusal) {
      await dropPending($, str(o, 'tool_use_id')).catch(() => undefined)
      return { deny: refusal }
    }
    // The override marker is for the gate: the subagent gets its task without it
    let input = e
    if (overrideReason(o.description, o.prompt)) {
      input = { ...e, description: stripOverride(String(o.description ?? '')), prompt: stripOverride(String(o.prompt ?? '')) }
    }
    let r: Awaited<ReturnType<typeof next>> | undefined
    let threw = true
    try {
      r = await next(input)
      threw = false
      return r
    } finally {
      try {
        if (r && typeof r === 'object' && (r as { deny?: unknown }).deny) {
          await ungate($, key, o)
          await dropPending($, str(o, 'tool_use_id'))
        }
        // A spawn that throws still draws, as failed
        else await recordSpawn($, input, r, threw, key)
      } catch {
        // The spawn stands whatever the map does
      } finally {
        inflight.delete(key)
      }
    }
  })

  // A permission dialog is on screen: the matching pending ask shows ⏸ waiting at once
  on('classic.PermissionRequest', async ($, e, next) => {
    try {
      dialogSignal = true
      const loop = str(e, 'agent_id', 'agentId') ?? MAIN
      const tool = str(e, 'tool_name', 'tool')
      for (const [k, p] of pendingAsks) {
        if (p.loop === loop && (!tool || p.tool === tool)) {
          await markWaiting($, k)
          break
        }
      }
    } catch {
      // Observing only
    }
    return next(e)
  })

  // The settings PreToolUse point: a call that reaches it is going to run, so a
  // pending ask for it is dropped and a shown ⏸ waiting clears
  on('classic.PreToolUse', async ($, e, next) => {
    try {
      await clearApprovedWait($, e)
    } catch {
      // Observing only
    }
    return next(e)
  })

  // A new main-loop turn: the per-turn count, the warning and the override start over
  on('turn.start', async ($, e, next) => {
    try {
      if (!str(e, 'agentId')) await update($, countersAtom, (c: CapCounters) => newTurn(c))
    } catch {
      // Best effort
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    try {
      const id = str(e, 'agentId') ?? MAIN
      const usage = result && typeof result === 'object' ? (result as { usage?: unknown }).usage : undefined
      const known = id === MAIN || (await read($, agentsAtom))[id]?.isSpawned === true
      // e.effort is the request's effort as this hook received it (a mod above may have rewritten it)
      const step = { effort: effortOf((e as unknown as { effort?: unknown }).effort), prices: await read($, pricesAtom) }
      await changeAgent($, id, (a, now) => applyStep(resume(a, now), usage, str(e, 'model'), now, step))
      if (id !== MAIN) {
        // A loop no spawn announced: the engine's list may name it (a fork, a teammate)
        if (!known) await reconcileList($)
        await syncTicker($)
      }
    } catch {
      // Counting is best effort
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    try {
      await recordComplete($, e, false)
    } catch {
      // Best effort
    }
    return next(e)
  }).catch(async ($, e, next) => {
    try {
      await recordComplete($, e, true)
    } catch {
      // Best effort
    }
    return next.called ? { text: '' } : next(e)
  })

  on('session.send', async ($, e, next) => {
    try {
      const o = e as unknown as Record<string, unknown>
      await recordMessage($, str(o, 'agentId', 'from') ?? MAIN, o.to)
    } catch {
      // Best effort
    }
    return next(e)
  })

  on('session.receive', async ($, e, next) => {
    try {
      const o = e as unknown as Record<string, unknown>
      const origin = (o.origin && typeof o.origin === 'object' ? o.origin : {}) as Record<string, unknown>
      if (origin.kind === 'task-notification') {
        // A background agent's result reaches main as a task notification
        const task = (o.task && typeof o.task === 'object' ? o.task : origin.task && typeof origin.task === 'object' ? origin.task : {}) as Record<string, unknown>
        const agents = await read($, agentsAtom)
        const viaCall = str(task, 'toolUseId') ?? str(origin, 'toolUseId', 'tool_use_id')
        const id = resolveAddress(agents, str(task, 'id') ?? str(origin, 'agentId', 'taskId', 'id')) ?? (viaCall ? agentOfCall.get(viaCall) : undefined)
        const tokens = estimateTokens(typeof o.text === 'string' ? o.text : '')
        if (id && id !== MAIN && tokens > 0) {
          await changeAgent($, id, a => addReturned(a, tokens))
          await logEvent($, id, 'returned', fmtTokens(tokens) + ' tok to main (task notification)')
          await addToMain($, tokens)
        }
      } else {
        const from = str(o, 'from', 'agentId', 'sender') ?? str(origin, 'agentId', 'from', 'name')
        if (from) await recordMessage($, from, str(o, 'to') ?? MAIN)
      }
    } catch {
      // Best effort
    }
    return next(e)
  })

  on('command.run', { command: 'agent-map' }, async ($, e) => {
    const args = (str(e, 'args') ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    const verb = args[0] ?? ''
    await reconcileList($).catch(() => undefined)
    if (verb === '' || verb === 'open') {
      try {
        await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
      } catch {
        return { text: await mapText($) }
      }
      return {}
    }
    if (verb === 'clear') {
      const n = await clearFinishedAgents($)
      return { text: 'Cleared ' + n + ' finished agent' + (n === 1 ? '' : 's') }
    }
    if (verb === 'band') {
      const want = args[1]
      if (want !== 'on' && want !== 'off') return { text: USAGE }
      await setBand($, want === 'on')
      return { text: 'Agent band ' + want }
    }
    // Text prints the chosen view; with none chosen, the tree (the pane opens on the cards)
    if (verb === 'text') return { text: await viewText($, (await read($, viewAtom)) ?? 'tree') }
    const chosen = verb === 'view' ? (args[1] ?? '') : verb
    if (chosen === 'tree' || chosen === 'cards' || chosen === 'team') {
      const verb = chosen
      await setView($, verb)
      try {
        await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
      } catch {
        return { text: await viewText($, verb) }
      }
      return { text: 'Agent map: ' + verb + ' view' }
    }
    if (verb === 'log') return { text: logText(await read($, logAtom)) }
    if (verb === 'cap') return { text: await setCap($, args.slice(1)) }
    return { text: USAGE }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const props = (e.props ?? {}) as { hasSurvey?: boolean; bodyColumns?: number }
    if (props.hasSurvey) return next(e)
    if (!(await read($, everAtom)) || !(await read($, bandAtom))) return next(e)
    const counters = await read($, countersAtom)
    const band = bandOf(await read($, agentsAtom), { caps: await read($, capsAtom), counters })
    const { Box, Text } = $.ui.resolve(e)
    const k = makeKit($.ui.resolve(e) as unknown as Elements, e.surface)
    // One kit line: `agents  ● 3/4 running  ✓ 5 done  ✗ 1  ● ok` with the tokens on the right
    const chips = band.chips.map(c => k.text(c.text, { color: TONES[c.tone].fg, bold: c.tone !== 'muted', wrap: 'truncate' }))
    const mine = Box({
      key: 'agent-map-band',
      flexDirection: 'column',
      children: [k.line('agents', chips, band.right) as ReturnType<typeof Text>],
    })
    const theirs = await next(e)
    if (theirs && typeof theirs === 'object') return Box({ flexDirection: 'column', children: [mine, theirs] })
    return mine
  })

  on('ui.render', { component: 'Pane', requestId: 'agent-map' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const k = makeKit(ui as unknown as Elements, e.surface)
    const props = (e.props ?? {}) as { bodyColumns?: number }
    const columns = Math.max(20, props.bodyColumns ?? 80)
    const agents = await read($, agentsAtom)
    const order = await read($, orderAtom)
    const expanded = await read($, expandedAtom)
    const now = await read($, nowAtom)
    const armed = await read($, armedAtom)
    const view: PaneView = (await read($, viewAtom)) ?? 'cards'
    const showLog = await read($, showLogAtom)
    const collapsed = await read($, collapsedAtom)
    const treeOpts = { now, columns, expanded, stuckAfterMs: cfg.stuckAfterMs, reserve: STOP_RESERVE }
    const handlers = {
      toggle: (id: string) => toggleExpanded($, id),
      stop: (id: string) => pressStop($, id),
      collapse: () => update($, collapsedAtom, (x: boolean) => !x),
      view: (v: PaneView) => setView($, v),
    }

    const stopButton = (id: string) =>
      Button({
        key: 'stop-' + id,
        label: armed === id ? 'Confirm stop' : 'Stop',
        plain: true,
        onPress: () => pressStop($, id),
      })

    const rowOf = (r: Row, i: number) => {
      const parts = []
      if (r.prefix) parts.push(Text({ color: 'inactive', children: [r.prefix] }))
      if (r.kind === 'agent' && r.id) {
        const id = r.id
        parts.push(Text({ color: r.color ?? 'inactive', children: [(r.glyph ?? '') + ' '] }))
        parts.push(
          Button({
            key: 'row-' + id,
            label: r.body,
            plain: true,
            onPress: () => toggleExpanded($, id),
          }),
        )
        if (r.flag) parts.push(Text({ color: r.flagColor ?? 'inactive', wrap: 'truncate-end', children: [r.flag] }))
        if (r.canStop) {
          parts.push(Text({ children: ['  '] }))
          parts.push(stopButton(id))
        }
      } else if (r.kind === 'header' || r.kind === 'lane') {
        parts.push(Text({ bold: true, wrap: 'truncate-end', children: [r.body] }))
      } else {
        parts.push(Text({ color: 'inactive', wrap: 'truncate-end', children: [r.body] }))
      }
      return Box({ key: 'line-' + i, flexDirection: 'row', children: parts })
    }

    // The page: the header block (tiles, buttons and, in the cards view, the main loop's line), the
    // view's body, the caps, the log, the footer buttons, one row apart. Rows inside a block stay tight; the
    // tree views keep the main line on top of their tree.
    let head: unknown
    let body: unknown
    if (view === 'cards') {
      head = headerTree(k, agents, now, { view, collapsed, on: handlers, main: mainRow(k, agents, ui as unknown as Elements) })
      body = cardsTree(k, agents, order, now, {
        ui: ui as unknown as Elements,
        columns,
        window: await read($, windowAtom),
        pending: await read($, pendingAtom),
        expanded,
        collapsed,
        armed,
        stuckAfterMs: cfg.stuckAfterMs,
        on: handlers,
      })
    } else {
      head = headerTree(k, agents, now, { view, collapsed, on: handlers })
      const rows = buildRows(agents, order, treeOpts)
      if (view === 'team') {
        // One tight stack per top-level lane (team of main, teammates, unattached), one row apart; the
        // main line leads the first, and nested lanes stay in their top-level lane's stack
        const lanes: unknown[][] = [[rowOf(rows[0], 0)]]
        teamRows(agents, order, treeOpts).forEach((r, i) => {
          if (i > 0 && r.kind === 'lane' && !r.prefix) lanes.push([])
          lanes[lanes.length - 1].push(rowOf(r, i + 1))
        })
        body = k.list(lanes.map(l => k.stack(l)))
      } else body = k.stack(rows.map(rowOf))
    }
    const log = showLog ? k.stack(logRows(await read($, logAtom), columns).map((r, i) => rowOf(r, 10_000 + i))) : null
    const caps = capsTree(k, await read($, capsAtom), await read($, capSourcesAtom))

    return k.page([
      head,
      body,
      caps,
      log,
      k.buttons([
        { key: 'clear', label: 'Clear finished', onPress: () => clearFinishedAgents($) },
        { key: 'log', label: showLog ? 'Hide log' : 'Log', onPress: () => update($, showLogAtom, (x: boolean) => !x) },
        { key: 'close', label: 'Close', onPress: () => $.ui.close({ id: PANE }) },
      ]),
    ]) as never
  })
}
