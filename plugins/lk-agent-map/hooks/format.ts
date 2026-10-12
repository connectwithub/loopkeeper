// Pure text layout for agent-map: the tree rows the pane draws and the
// /agent-map text command prints, the band's one line, and the cards' critter avatar.
//
// Colors are theme keys (suggestion, success, error, claude, permission, inactive) that the host
// tunes for light and dark; Svg markup cannot read them, so the critter uses fixed hexes.
import type { AgentRecord, AgentStatus, CapConfig, CapCounters, LogEntry } from '../types'
import type { Tone } from './kit'
import { DEFAULT_CAPS, MAIN, capUses, countsOf, idleMs, isStuck, nearAnyCap, runningCount, totalTokens, zeroCounters } from './model'
import type { Agents, Counts } from './model'

export const LABEL_MAX = 24
export const PROMPT_EXCERPT = 200
/** The width /agent-map text lays out to. */
export const TEXT_COLUMNS = 120

export type RowKind = 'header' | 'agent' | 'activity' | 'msg' | 'detail' | 'empty' | 'lane' | 'log'

export type Row = {
  kind: RowKind
  /** The agent the row belongs to. */
  id?: string
  /** Tree drawing in front of the row: ├─, └─, │ and spaces. */
  prefix: string
  glyph?: string
  /** A theme key for the glyph. */
  color?: string
  dim?: boolean
  body: string
  /** A status note after the body, such as `⏸ waiting: Bash` or `⚠ idle 5m`. */
  flag?: string
  flagColor?: string
  /** The agent row of a running agent: the pane gives it a Stop button. */
  canStop?: boolean
}

export const FORK_MARK = '⑂'
export const TEAMMATE_MARK = '◇'
export const DEFAULT_STUCK_MS = 300_000

export function fmtTokens(n: number): string {
  const v = Math.max(0, Math.round(n || 0))
  if (v < 1000) return String(v)
  const k = Math.round(v / 1000)
  if (k < 1000) return k + 'k'
  return (v / 1e6).toFixed(1) + 'M'
}

const pad2 = (n: number) => (n < 10 ? '0' : '') + n

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor((ms || 0) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? h + ':' + pad2(m) + ':' + pad2(sec) : pad2(m) + ':' + pad2(sec)
}

export function shortModel(model: string): string {
  const m = (model || '').toLowerCase()
  for (const k of ['opus', 'sonnet', 'haiku', 'fable']) if (m.includes(k)) return k
  if (!m) return '?'
  return m.replace(/^claude-/, '').slice(0, 12)
}

export function elapsedOf(a: AgentRecord, now: number): number {
  if (a.status === 'running') return (a.durationMs ?? 0) + Math.max(0, now - a.runStartedAt)
  if (typeof a.durationMs === 'number') return a.durationMs
  return Math.max(0, (a.endedAt ?? now) - a.startedAt)
}

export function glyphOf(status: AgentStatus): { glyph: string; color?: string; dim?: boolean } {
  switch (status) {
    case 'running':
      return { glyph: '●', color: 'success' }
    case 'done':
      return { glyph: '✓', color: 'success' }
    case 'failed':
      return { glyph: '✗', color: 'error' }
    case 'stopped':
      return { glyph: '■', color: 'claude' }
    default:
      return { glyph: '○', color: 'inactive', dim: true }
  }
}

const oneLine = (s: string) => (s || '').replace(/\s+/g, ' ').trim()

export function labelOf(a: AgentRecord | undefined, fallback = ''): string {
  if (!a) return fallback
  return oneLine(a.description) || a.name || a.id
}

export function cut(s: string, n: number): string {
  const chars = Array.from(s)
  return chars.length <= n ? s : chars.slice(0, Math.max(0, n)).join('')
}

const len = (s: string) => Array.from(s).length

/** Breaks text into pieces of at most `width` characters, at spaces where it can. */
export function wrapText(s: string, width: number): string[] {
  const w = Math.max(8, width)
  const out: string[] = []
  let rest = oneLine(s)
  while (len(rest) > w) {
    const head = cut(rest, w)
    const sp = head.lastIndexOf(' ')
    const take = sp > w / 3 ? head.slice(0, sp) : head
    out.push(take)
    rest = rest.slice(take.length).trimStart()
  }
  if (rest || out.length === 0) out.push(rest)
  return out
}

export function markOf(a: AgentRecord): string {
  return (a.isFork ? FORK_MARK + ' ' : '') + (a.isTeammate ? TEAMMATE_MARK + ' ' : '')
}

export function fmtIdle(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m >= 60) return Math.floor(m / 60) + 'h' + (m % 60 ? (m % 60) + 'm' : '')
  if (m >= 1) return m + 'm'
  return Math.floor(ms / 1000) + 's'
}

/** The note on an agent's row: waiting on the person, idle too long, or muted. */
export function flagOf(a: AgentRecord, now: number, stuckAfterMs: number): { text: string; color?: string } | undefined {
  if (a.status !== 'running') return a.status === 'stopped' && a.stoppedBy ? { text: 'by ' + a.stoppedBy } : undefined
  if (a.waiting?.length) return { text: '⏸ waiting: ' + Array.from(new Set(a.waiting.map(w => w.tool))).join(', '), color: 'claude' }
  if (a.muted) return { text: '⊘ muted', color: 'permission' }
  if (isStuck(a, now, stuckAfterMs)) return { text: '⚠ idle ' + fmtIdle(idleMs(a, now)), color: 'error' }
  return undefined
}

/** The agent's line after its glyph, sized so prefix + glyph + line (+ reserved room) fits in `columns`. */
export function agentLine(a: AgentRecord, now: number, columns: number, prefixLen: number, note = ''): string {
  const fields = [
    a.name || 'agent',
    shortModel(a.model),
    fmtElapsed(elapsedOf(a, now)),
    a.toolCalls + ' tools',
    fmtTokens(totalTokens(a.tokens)) + ' tok',
    ...(note ? [note] : []),
  ].join('  ')
  const room = columns - prefixLen - 2 - 2 - len(fields)
  const labelMax = Math.max(4, Math.min(LABEL_MAX, room))
  const line = markOf(a) + cut(labelOf(a), labelMax).trimEnd() + '  ' + fields
  return cut(line, Math.max(4, columns - prefixLen - 2))
}

function messageRows(agents: Agents, a: AgentRecord, prefix: string, columns: number): Row[] {
  const byTarget = new Map<string, number>()
  for (const m of a.messages) if (m.to) byTarget.set(m.to, (byTarget.get(m.to) ?? 0) + 1)
  const rows: Row[] = []
  for (const [to, n] of byTarget) {
    const target = to === MAIN ? 'main' : labelOf(agents[to], to)
    const body = cut('→ msg to ' + cut(target, LABEL_MAX) + (n > 1 ? ' x' + n : ''), Math.max(4, columns - len(prefix)))
    rows.push({ kind: 'msg', id: a.id, prefix, dim: true, body })
  }
  return rows
}

function detailRows(agents: Agents, a: AgentRecord, prefix: string, now: number, columns: number): Row[] {
  return detailLines(agents, a, now, columns - len(prefix)).map(body => ({ kind: 'detail' as const, id: a.id, prefix, dim: true, body }))
}

/** An agent's details, wrapped to `columns`: description, prompt, tools, tokens, status and model. */
export function detailLines(agents: Agents, a: AgentRecord, now: number, columns: number): string[] {
  const width = Math.max(8, columns)
  const tools = Object.entries(a.toolsByName)
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => k + ' ' + v)
    .join(' · ')
  const t = a.tokens
  const parent = a.parent === MAIN || !a.parent ? 'main' : labelOf(agents[a.parent], a.parent)
  const flags = [
    a.isFork ? 'fork' : '',
    a.isTeammate ? 'teammate' : '',
    a.isBackground ? 'background' : '',
    a.muted ? 'muted' : '',
    a.stoppedBy ? 'stopped by ' + a.stoppedBy : '',
  ].filter(Boolean)
  const lines = [
    'description: ' + (oneLine(a.description) || '-'),
    'prompt: ' + (cut(oneLine(a.prompt), PROMPT_EXCERPT) || '-'),
    'tools: ' + (tools || 'none') + (a.lastTool ? ' (last ' + a.lastTool + ')' : ''),
    ...(a.activity ? ['last: ' + a.activity] : []),
    'tokens: in ' + fmtTokens(t.input) + ' · out ' + fmtTokens(t.output) + ' · cache read ' + fmtTokens(t.cacheRead) + ' · cache write ' + fmtTokens(t.cacheCreate),
    'status: ' + a.status + ' · ' + fmtElapsed(elapsedOf(a, now)) + ' · ' + a.requests + ' requests · from ' + parent + (flags.length ? ' · ' + flags.join(', ') : ''),
    'model: ' + (a.model || '?') + ((a.returnedTokens ?? 0) > 0 ? ' · ' + returnedNote(agents, a) : ''),
  ]
  return lines.flatMap(l => wrapText(l, width))
}

export type TreeOptions = {
  now: number
  columns: number
  expanded?: readonly string[]
  /** Idle threshold for the `⚠ idle` note; 0 turns it off. */
  stuckAfterMs?: number
  /** Columns kept free on a running agent's row (the pane's Stop button). */
  reserve?: number
}

/** The spawned agents to draw, in spawn order. */
export function visibleIds(agents: Agents, order: readonly string[]): string[] {
  const ids = order.filter(id => id !== MAIN && agents[id]?.isSpawned)
  for (const id of Object.keys(agents)) if (id !== MAIN && agents[id].isSpawned && !ids.includes(id)) ids.push(id)
  return ids
}

/** Every row of the map: the main loop's header, then the agents as a tree. */
export function buildRows(agents: Agents, order: readonly string[], opts: TreeOptions): Row[] {
  const { now, columns } = opts
  const expanded = new Set(opts.expanded ?? [])
  const stuckAfterMs = opts.stuckAfterMs ?? DEFAULT_STUCK_MS
  const reserve = Math.max(0, opts.reserve ?? 0)
  const agentRow = (id: string, lead: string): Row => {
    const a = agents[id]
    const g = glyphOf(a.status)
    const running = a.status === 'running'
    const flag = flagOf(a, now, stuckAfterMs)
    const flagText = flag ? '  ' + flag.text : ''
    const room = columns - (running ? reserve : 0)
    const body = agentLine(a, now, Math.max(len(lead) + 8, room - len(flagText)), len(lead), returnedNote(agents, a))
    const row: Row = { kind: 'agent', id, prefix: lead, glyph: g.glyph, color: g.color, dim: g.dim, body, canStop: running }
    if (flag) {
      row.flag = cut(flagText, Math.max(0, room - len(lead) - 2 - len(body)))
      if (flag.color) row.flagColor = flag.color
      if (!row.flag.trim()) delete row.flag
    }
    return row
  }
  const activityRow = (a: AgentRecord, prefix: string): Row[] =>
    a.status === 'running' && a.activity
      ? [{ kind: 'activity', id: a.id, prefix, dim: true, body: cut('⋯ ' + a.activity, Math.max(4, columns - len(prefix))) }]
      : []
  const main = agents[MAIN]
  const header =
    'main (orchestrator) · ' + fmtTokens(totalTokens(main?.tokens)) + ' tok · ' + (main?.toolCalls ?? 0) + ' tools'
  const mainWaits = main?.waiting?.length ? ' · ⏸ waiting: ' + Array.from(new Set(main.waiting.map(w => w.tool))).join(', ') : ''
  const rows: Row[] = [{ kind: 'header', id: MAIN, prefix: '', body: cut(header + mainWaits, Math.max(8, columns)) }]
  const ids = visibleIds(agents, order)
  const shown = new Set(ids)
  const parentOf = (id: string) => {
    const p = agents[id].parent
    return p && p !== id && shown.has(p) ? p : MAIN
  }
  if (main) rows.push(...messageRows(agents, main, ids.length ? '│   ' : '', columns))
  if (ids.length === 0) {
    rows.push({ kind: 'empty', prefix: '', dim: true, body: 'no subagents yet' })
    return rows
  }
  const placed = new Set<string>()
  const walk = (pid: string, prefix: string) => {
    const kids = ids.filter(id => !placed.has(id) && parentOf(id) === pid)
    kids.forEach(id => placed.add(id))
    kids.forEach((id, i) => {
      const a = agents[id]
      const last = i === kids.length - 1
      const lead = prefix + (last ? '└─ ' : '├─ ')
      const cont = prefix + (last ? '    ' : '│   ')
      rows.push(agentRow(id, lead))
      rows.push(...activityRow(a, cont))
      if (expanded.has(id)) rows.push(...detailRows(agents, a, cont + '  ', now, columns))
      rows.push(...messageRows(agents, a, cont, columns))
      walk(id, cont)
    })
  }
  walk(MAIN, '')
  // A parent cycle leaves agents unplaced: draw them at the top level
  for (const id of ids) {
    if (placed.has(id)) continue
    placed.add(id)
    rows.push(agentRow(id, '└─ '))
    rows.push(...activityRow(agents[id], '    '))
  }
  return rows
}

export function rowText(r: Row): string {
  return r.prefix + (r.glyph ? r.glyph + ' ' : '') + r.body + (r.flag ?? '')
}

export function treeText(agents: Agents, order: readonly string[], now: number, columns = TEXT_COLUMNS, stuckAfterMs = DEFAULT_STUCK_MS): string {
  return buildRows(agents, order, { now, columns, stuckAfterMs }).map(rowText).join('\n')
}

export type BandExtra = { caps?: CapConfig; counters?: CapCounters }

/** Where the caps stand: a spawn was denied this turn or a cap is reached, past warnAt, or neither. */
export type BandState = 'ok' | 'near cap' | 'at cap'

/** One chip of the band: its whole text (glyph included) and its tone. */
export type BandChip = { text: string; tone: Tone }

/** The theme key of each state, as the state chip draws it (near cap is 'claude', not the warning key). */
export const BAND_COLORS: Record<BandState, string> = { ok: 'success', 'near cap': 'claude', 'at cap': 'error' }
const BAND_TONES: Record<BandState, Tone> = { ok: 'ok', 'near cap': 'accent', 'at cap': 'danger' }

/** The band's chips: `● 3/4 running`, `✓ 5 done`, `✗ 1` and the `● ok` state chip; a zero count is muted. */
export function bandChips(c: Counts, state: BandState, caps: CapConfig = DEFAULT_CAPS): BandChip[] {
  const running = caps.maxConcurrent > 0 ? c.running + '/' + caps.maxConcurrent : String(c.running)
  return [
    { text: '● ' + running + ' running', tone: c.running > 0 ? 'info' : 'muted' },
    { text: '✓ ' + c.done + ' done', tone: c.done > 0 ? 'ok' : 'muted' },
    { text: '✗ ' + c.failed, tone: c.failed > 0 ? 'danger' : 'muted' },
    { text: '● ' + state, tone: BAND_TONES[state] },
  ]
}

/** The band's quiet right-hand side: aborted and stopped counts, tokens, and results returned to main. */
export function bandRight(c: Counts, extra: BandExtra = {}): string[] {
  const returned = extra.counters?.returnedTotal ?? 0
  const out: string[] = []
  if (c.aborted > 0) out.push('○ ' + c.aborted + ' aborted')
  if (c.stopped > 0) out.push('■ ' + c.stopped + ' stopped')
  out.push(fmtTokens(c.tokens) + ' tok')
  // Results under 1k tokens are noise next to a context window
  if (returned >= 1000) out.push('results ' + fmtTokens(returned) + ' → main')
  return out
}

/** The band as one line of text: `agents  ● 3/4 running  ✓ 5 done  ✗ 1  ● ok  412k tok · results 96k → main`. */
export function bandText(c: Counts, extra: BandExtra = {}, state: BandState = 'ok'): string {
  const chips = bandChips(c, state, extra.caps ?? DEFAULT_CAPS).map(x => x.text)
  return ['agents', ...chips, bandRight(c, extra).join(' · ')].join('  ')
}

/** True once the results returned to main pass warnAt of maxReturnedTokens. */
export function returnedNear(caps: CapConfig, counters: CapCounters): boolean {
  return caps.maxReturnedTokens > 0 && counters.returnedTotal >= caps.warnAt * caps.maxReturnedTokens
}

/** The cap state: at cap once a spawn was denied this turn or a cap is reached, near cap past warnAt, else ok. */
export function bandStateOf(extra: BandExtra = {}, near = false, at = false): BandState {
  if (extra.counters?.deniedThisTurn || at) return 'at cap'
  return near ? 'near cap' : 'ok'
}

/** The state's theme key. */
export function bandColor(state: BandState): string {
  return BAND_COLORS[state]
}

export type Band = { text: string; color: string; state: BandState; chips: BandChip[]; right: string[]; counts: Counts }

export function bandOf(agents: Agents, extra: BandExtra = {}): Band {
  const counts = countsOf(agents)
  const caps = extra.caps ?? DEFAULT_CAPS
  const counters = extra.counters ?? zeroCounters()
  const uses = capUses(runningCount(agents), counters, caps)
  const near = nearAnyCap(uses, caps.warnAt) || returnedNear(caps, counters)
  const at = uses.some(u => u.max > 0 && u.n >= u.max) || (caps.maxReturnedTokens > 0 && counters.returnedTotal >= caps.maxReturnedTokens)
  const state = bandStateOf(extra, near, at)
  return { text: bandText(counts, extra, state), color: bandColor(state), state, chips: bandChips(counts, state, caps), right: bandRight(counts, extra), counts }
}

// ---- Cards view (0.3.0) ----

export const CARD_LABEL = 32

const pad2c = (n: number) => (n < 10 ? '0' : '') + n

/** A wall-clock time in the runtime's local zone: `10:31`, or `10:31:05` with seconds. */
export function fmtClock(ms: number, seconds = false): string {
  const d = new Date(ms)
  const hm = pad2c(d.getHours()) + ':' + pad2c(d.getMinutes())
  return seconds ? hm + ':' + pad2c(d.getSeconds()) : hm
}

export function returnedNote(agents: Agents, a: AgentRecord): string {
  const n = a.returnedTokens ?? 0
  if (n <= 0) return ''
  const to = a.parent === MAIN || !a.parent ? 'main' : cut(labelOf(agents[a.parent], a.parent), 16)
  return '→ ' + fmtTokens(n) + ' to ' + to
}

/** Running agents first, then the ones waiting on the person, then the finished. */
export function cardOrder(agents: Agents, order: readonly string[]): string[] {
  const ids = visibleIds(agents, order)
  const rank = (a: AgentRecord) => (a.status !== 'running' ? 2 : a.waiting?.length ? 1 : 0)
  return ids
    .map((id, i) => ({ id, i, r: rank(agents[id]) }))
    .sort((x, y) => x.r - y.r || x.i - y.i)
    .map(x => x.id)
}

/** `spawned 10:31 → running 00:57 → ⏸ waiting (Bash) → done 10:38` */
export function lifecycleLine(a: AgentRecord, now: number, stuckAfterMs: number): string {
  const parts = ['spawned ' + fmtClock(a.startedAt), 'running ' + fmtElapsed(elapsedOf(a, now))]
  if (a.status === 'running') {
    if (a.waiting?.length) parts.push('⏸ waiting (' + Array.from(new Set(a.waiting.map(w => w.tool))).join(', ') + ')')
    else if (a.muted) parts.push('⊘ muted')
    else if (isStuck(a, now, stuckAfterMs)) parts.push('⚠ idle ' + fmtIdle(idleMs(a, now)))
  } else {
    parts.push(a.status + ' ' + fmtClock(a.endedAt ?? now) + (a.status === 'stopped' && a.stoppedBy ? ' by ' + a.stoppedBy : ''))
  }
  return parts.join(' → ')
}

export type Card = {
  id: string
  glyph: string
  color?: string
  /** label · type · model, with the fork or teammate mark in front. */
  title: string
  lifecycle: string
  stats: string
  parent: string
  canStop: boolean
}

/** One card's four lines, each cut to `width` (the inside of the card's border). */
export function cardOf(agents: Agents, a: AgentRecord, now: number, width: number, stuckAfterMs = DEFAULT_STUCK_MS): Card {
  const w = Math.max(8, width)
  const g = glyphOf(a.status)
  const title = markOf(a) + cut(labelOf(a), CARD_LABEL).trimEnd() + ' · ' + (a.name || 'agent') + ' · ' + shortModel(a.model)
  const stats = [
    a.toolCalls + ' tool' + (a.toolCalls === 1 ? '' : 's'),
    a.activity ? 'last ' + a.activity : '',
    fmtTokens(totalTokens(a.tokens)) + ' tok',
    returnedNote(agents, a),
  ]
    .filter(Boolean)
    .join(' · ')
  const parent = 'from ' + (a.parent === MAIN || !a.parent ? 'main' : labelOf(agents[a.parent], a.parent))
  const running = a.status === 'running'
  return {
    id: a.id,
    glyph: g.glyph,
    color: g.color,
    // Room for ' ' + glyph after the title
    title: cut(title, w - 2),
    lifecycle: cut(lifecycleLine(a, now, stuckAfterMs), w),
    stats: cut(stats, w),
    parent: cut(parent, running ? Math.max(4, w - 14) : w),
    canStop: running,
  }
}

export function cardsOf(agents: Agents, order: readonly string[], now: number, columns: number, stuckAfterMs = DEFAULT_STUCK_MS): Card[] {
  // A card's border and padding take 4 columns
  return cardOrder(agents, order).map(id => cardOf(agents, agents[id], now, columns - 4, stuckAfterMs))
}

/** The cards as text, each in a rounded border, for /agent-map text and tests. */
export function cardsText(agents: Agents, order: readonly string[], now: number, columns = TEXT_COLUMNS, stuckAfterMs = DEFAULT_STUCK_MS): string {
  const cards = cardsOf(agents, order, now, columns, stuckAfterMs)
  if (cards.length === 0) return 'no subagents yet'
  const inner = columns - 4
  const line = (s: string) => '│ ' + s + ' '.repeat(Math.max(0, inner - len(s))) + ' │'
  return cards
    .map(c =>
      [
        '╭' + '─'.repeat(columns - 2) + '╮',
        line(c.title + ' ' + c.glyph),
        line(c.lifecycle),
        line(c.stats),
        line(c.parent + (c.canStop ? '  [Stop]' : '')),
        '╰' + '─'.repeat(columns - 2) + '╯',
      ].join('\n'),
    )
    .join('\n')
}

// ---- Team view (0.3.0) ----

export function laneHeader(agents: Agents, ids: readonly string[], title: string): string {
  const n = { running: 0, done: 0, failed: 0, other: 0 }
  for (const id of ids) {
    const s = agents[id].status
    if (s === 'running') n.running++
    else if (s === 'done') n.done++
    else if (s === 'failed') n.failed++
    else n.other++
  }
  const parts = [n.running + ' running', n.done + ' done']
  if (n.failed) parts.push(n.failed + ' failed')
  if (n.other) parts.push(n.other + ' ended')
  return title + ': ' + parts.join(' · ')
}

/**
 * Agents grouped by parent into lanes: the main loop's children first, then
 * each agent's children in a lane indented under its parent's, and the
 * teammates (◇) in a lane of their own.
 */
export function teamRows(agents: Agents, order: readonly string[], opts: TreeOptions): Row[] {
  const { now, columns } = opts
  const stuckAfterMs = opts.stuckAfterMs ?? DEFAULT_STUCK_MS
  const reserve = Math.max(0, opts.reserve ?? 0)
  const ids = visibleIds(agents, order)
  const shown = new Set(ids)
  const parentOf = (id: string) => {
    const p = agents[id].parent
    return p && p !== id && shown.has(p) ? p : MAIN
  }
  const rows: Row[] = []
  if (ids.length === 0) return [{ kind: 'empty', prefix: '', dim: true, body: 'no subagents yet' }]
  const agentRow = (id: string, lead: string): Row => {
    const a = agents[id]
    const g = glyphOf(a.status)
    const running = a.status === 'running'
    const flag = flagOf(a, now, stuckAfterMs)
    const tail = flag ? '  ' + flag.text : ''
    const room = columns - (running ? reserve : 0)
    const body = agentLine(a, now, Math.max(len(lead) + 8, room - len(tail)), len(lead), returnedNote(agents, a))
    const row: Row = { kind: 'agent', id, prefix: lead, glyph: g.glyph, color: g.color, dim: g.dim, body, canStop: running }
    const t = cut(tail, Math.max(0, room - len(lead) - 2 - len(body)))
    if (t.trim()) {
      row.flag = t
      if (flag?.color) row.flagColor = flag.color
    }
    return row
  }
  const done = new Set<string>()
  const lane = (pid: string, depth: number, members: string[], title: string) => {
    if (members.length === 0) return
    const indent = '  '.repeat(depth)
    rows.push({ kind: 'lane', id: pid, prefix: indent, body: cut(laneHeader(agents, members, title), Math.max(4, columns - len(indent))) })
    for (const id of members) {
      done.add(id)
      rows.push(agentRow(id, indent + '  '))
    }
  }
  const walk = (pid: string, depth: number) => {
    const kids = ids.filter(id => !done.has(id) && !agents[id].isTeammate && parentOf(id) === pid)
    const title = 'team of ' + (pid === MAIN ? 'main' : cut(labelOf(agents[pid], pid), LABEL_MAX))
    lane(pid, depth, kids, title)
    for (const id of kids) walk(id, depth + 1)
  }
  walk(MAIN, 0)
  const mates = ids.filter(id => !done.has(id) && agents[id].isTeammate)
  lane('teammates', 0, mates, 'teammates')
  for (const id of mates) walk(id, 1)
  // A parent cycle leaves agents out: they get a lane of their own
  lane('other', 0, ids.filter(id => !done.has(id)), 'unattached')
  return rows
}

export function teamText(agents: Agents, order: readonly string[], now: number, columns = TEXT_COLUMNS, stuckAfterMs = DEFAULT_STUCK_MS): string {
  return teamRows(agents, order, { now, columns, stuckAfterMs }).map(rowText).join('\n')
}

// ---- Lifecycle log (0.3.0) ----

export const LOG_TEXT_LINES = 40
export const LOG_PANE_LINES = 12

export function logLine(e: LogEntry): string {
  return fmtClock(e.at, true) + ' ' + e.kind + ' ' + e.label + (e.text ? ' · ' + e.text : '')
}

export function logText(log: readonly LogEntry[], n = LOG_TEXT_LINES): string {
  if (log.length === 0) return 'agent-map log: no lifecycle events yet'
  return log.slice(-n).map(logLine).join('\n')
}

export function logRows(log: readonly LogEntry[], columns: number, n = LOG_PANE_LINES): Row[] {
  const rows: Row[] = [{ kind: 'lane', prefix: '', body: 'log (last ' + Math.min(n, log.length) + ')' }]
  if (log.length === 0) rows.push({ kind: 'log', prefix: '', dim: true, body: 'no lifecycle events yet' })
  for (const e of log.slice(-n)) rows.push({ kind: 'log', id: e.id, prefix: '', dim: true, body: cut(logLine(e), Math.max(4, columns)) })
  return rows
}

// ---- Card look (0.5.0): the effort word and the critter avatar ----

/** An effort as the card shows it: the word, its tone, and the critter's hat color. */
export type EffortLook = { word: string; tone: Tone; hat: string }

const EFFORTS: Record<string, EffortLook> = {
  low: { word: 'light', tone: 'ok', hat: '#22A35A' },
  medium: { word: 'medium', tone: 'info', hat: '#3B82F6' },
  high: { word: 'careful', tone: 'accent', hat: '#D9901A' },
  xhigh: { word: 'thorough', tone: 'accent', hat: '#E5484D' },
  max: { word: 'max', tone: 'danger', hat: '#E5484D' },
}
const NO_EFFORT: EffortLook = { word: '', tone: 'info', hat: '#64748B' }

/** low → light, medium → medium, high → careful, xhigh → thorough, max → max; anything else draws no word. */
export function effortLook(effort: string): EffortLook {
  return EFFORTS[String(effort || '').trim().toLowerCase()] ?? NO_EFFORT
}

/** The critter's state: a pennant while running, X eyes when failed, faded once finished. */
export type CritterState = 'running' | 'waiting' | 'done' | 'failed' | 'idle'

const CRITTER = { body: '#C96F4A', outline: '#8A4A32', eye: '#1A1A1A', crown: '#8B5CF6', stick: '#8A4A32', pennant: '#E5484D' }
export const CRITTER_SIZE = 44

// 12×12 cells. H = hat (or the main loop's crown), O = outline, B = body, E = eye, S = stick, P = pennant.
const HAT = ['...HHH......', '..HHHHH.....', '.HHHHHHH....']
const CROWN = ['.H..H..H....', '.HHHHHHH....', '.HHHHHHH....']
const BODY = [
  '.OOOOOOO....',
  'OBBBBBBBO...',
  'OBEBBBEBO...',
  'OBEBBBEBO...',
  'OBBBBBBBB...',
  'OBBBBBBBO...',
  '.OBBBBBO....',
  '.OO...OO....',
  '.OO...OO....',
]
const POLE = ['.........SPP', '.........SPP', '.........SP.', '.........S..', '.........S..', '.........S..', '.........S..', '.........S..']

const critterCache = new Map<string, string>()

/**
 * The critter avatar as an SVG document: a terracotta pixel creature with an effort-colored hat
 * (a violet crown for the main loop), a pennant on a stick while it runs, X eyes when it failed,
 * and 0.8 opacity once it is done, stopped or aborted.
 */
export function critterSvg(o: { main?: boolean; hat?: string; state?: CritterState; faded?: boolean; size?: number }): string {
  const main = o.main === true
  const hat = /^#[0-9a-f]{6}$/i.test(o.hat ?? '') ? (o.hat as string) : NO_EFFORT.hat
  const state: CritterState = o.state ?? 'idle'
  const faded = o.faded === true || state === 'done'
  const size = typeof o.size === 'number' && o.size >= 8 && o.size <= 256 ? Math.round(o.size) : CRITTER_SIZE
  const key = [main ? 'm' : 'a', hat, state, faded ? 'f' : '', size].join('|')
  const hit = critterCache.get(key)
  if (hit !== undefined) return hit
  const rows = [...(main ? CROWN : HAT), ...BODY]
  if (state === 'running') POLE.forEach((p, y) => (rows[y] = rows[y].slice(0, 9) + p.slice(9)))
  const fills: Record<string, string> = {
    H: main ? CRITTER.crown : hat,
    O: CRITTER.outline,
    B: CRITTER.body,
    E: state === 'failed' ? CRITTER.body : CRITTER.eye,
    S: CRITTER.stick,
    P: CRITTER.pennant,
  }
  let rects = ''
  rows.forEach((line, y) => {
    let x = 0
    while (x < 12) {
      const ch = line[x] ?? '.'
      let end = x + 1
      while (end < 12 && line[end] === ch) end++
      if (fills[ch]) rects += `<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${fills[ch]}"/>`
      x = end
    }
  })
  // X eyes: two crossed strokes over each eye
  if (state === 'failed') {
    rects += `<path d="M1.7 4.8 3.3 7.2M3.3 4.8 1.7 7.2M5.7 4.8 7.3 7.2M7.3 4.8 5.7 7.2" stroke="${CRITTER.eye}" stroke-width="0.5"/>`
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="${size}" height="${size}" shape-rendering="crispEdges">` +
    `<g${faded ? ' opacity="0.8"' : ''}>${rects}</g></svg>`
  if (critterCache.size >= 64) critterCache.clear()
  critterCache.set(key, svg)
  return svg
}
