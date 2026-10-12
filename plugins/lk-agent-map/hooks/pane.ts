// pane.ts: the Agents pane of agent-map, drawn with the kit (hooks/kit.ts).
//
// Pure: every function takes plain values (and, for the trees, a kit made from the hook's
// resolved elements) and returns text or an element tree. register.ts reads $.state, wires
// the button handlers and hands them in.
import type { AgentRecord, CapConfig, CapSources, PaneView, PendingCall } from '../types'
import { TONES, clock, glyph, money, pct, tokensShort } from './kit'
import type { DoodleState, Elements, Kit, Role, Tone } from './kit'
import { CRITTER_SIZE, DEFAULT_STUCK_MS, cardOrder, critterSvg, cut, detailLines, effortLook, elapsedOf, flagOf, labelOf, markOf, returnedNote, shortModel } from './format'
import { MAIN, totalTokens } from './model'
import type { Agents } from './model'

/** The context window ctx % divides by when the session's could not be read. */
export const DEFAULT_WINDOW = 200_000

// ---------------------------------------------------------------- roles and labels

export type RoleInput = { id?: string; name?: string; description?: string; prompt?: string; model?: string }

const ROLE_TAG = /\[role:\s*([a-z-]+)\s*\]/i

const TAG_ROLES: Record<string, Role> = {
  recon: 'recon',
  explore: 'recon',
  search: 'recon',
  verify: 'verify',
  validate: 'verify',
  verifier: 'verify',
  validator: 'verify',
  review: 'reviewer',
  reviewer: 'reviewer',
  critic: 'reviewer',
  audit: 'reviewer',
  hard: 'hard',
  execute: 'execute',
  build: 'execute',
}

/**
 * The doodle's role: the main loop is main; a `[role:x]` tag in the prompt or description wins;
 * then the type and description words (recon|explore|search → recon, verif|valid → verify,
 * review|critic|audit → reviewer); then an Opus model → hard; else execute.
 */
export function roleOf(a: RoleInput): Role {
  if (a.id === MAIN) return 'main'
  const tag = ROLE_TAG.exec(String(a.prompt ?? '') + ' ' + String(a.description ?? ''))?.[1]?.toLowerCase()
  if (tag && TAG_ROLES[tag]) return TAG_ROLES[tag]
  const words = (String(a.name ?? '') + ' ' + String(a.description ?? '')).toLowerCase()
  if (/recon|explor|search/.test(words)) return 'recon'
  if (/verif|valid/.test(words)) return 'verify'
  if (/review|critic|audit/.test(words)) return 'reviewer'
  if (/opus/.test(String(a.model ?? '').toLowerCase())) return 'hard'
  return 'execute'
}

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable']
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** `claude-opus-5-5` → `Opus 5.5`, `claude-sonnet-4-20250514` → `Sonnet 4`, `haiku` → `Haiku`, '' → `?`; another id as given (24 characters at most). */
export function modelLabel(model: string): string {
  const m = String(model || '').toLowerCase().replace(/\./g, '-')
  const hit = /(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/.exec(m)
  if (hit) return capital(hit[1]) + ' ' + hit[2] + (hit[3] ? '.' + hit[3] : '')
  const s = shortModel(model)
  if (FAMILIES.includes(s)) return capital(s)
  return s === '?' ? s : cut(String(model).trim().replace(/^claude-/, ''), 24)
}

// ---------------------------------------------------------------- status

export type CardStatus = 'running' | 'waiting' | 'done' | 'failed' | 'stopped' | 'aborted'

/** Running, unless a tool call waits on the person; otherwise the record's end state. */
export function cardStatus(a: AgentRecord): CardStatus {
  if (a.status === 'running') return a.waiting?.length ? 'waiting' : 'running'
  return a.status
}

/** ● running and ✓ done (success) · ◷ waiting (claude) · ✗ failed (error) · ■ stopped · ○ aborted (inactive). */
export const MARKS: Record<CardStatus, { glyph: string; tone: Tone }> = {
  running: { glyph: '●', tone: 'ok' },
  waiting: { glyph: '◷', tone: 'accent' },
  done: { glyph: '✓', tone: 'ok' },
  failed: { glyph: '✗', tone: 'danger' },
  stopped: { glyph: '■', tone: 'muted' },
  aborted: { glyph: '○', tone: 'muted' },
}

const DOODLE_STATE: Record<CardStatus, DoodleState> = {
  running: 'running',
  waiting: 'waiting',
  done: 'done',
  failed: 'failed',
  stopped: 'idle',
  aborted: 'idle',
}

// ---------------------------------------------------------------- figures

/** The agent's context fill: its latest request's input side over the session's window. An approximation: a subagent's own window isn't exposed. */
export function ctxRatio(a: AgentRecord, window: number): number {
  const w = typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : DEFAULT_WINDOW
  return Math.max(0, a.lastRequestTokens ?? 0) / w
}

/** The agent's cost: what its requests added up to; $0 before any token, null when its tokens came from a model the price table doesn't know. */
export function agentCost(a: AgentRecord): number | null {
  if (typeof a.costUsd === 'number' && Number.isFinite(a.costUsd)) return a.costUsd
  return totalTokens(a.tokens) === 0 ? 0 : null
}

/** `tools 12 · last: Bash npm test`. */
export function toolsText(a: AgentRecord): string {
  const last = a.activity ? ' · last: ' + a.activity.replace(/^([^:\s]+): /, '$1 ') : ''
  return 'tools ' + a.toolCalls + last
}

/** The card's step: `4/5 · Signup` from its TodoWrite list, else `12 tools`. */
export function stepText(a: AgentRecord): string {
  const t = a.todo
  if (t && t.total > 0) return t.done + '/' + t.total + (t.current ? ' · ' + t.current : '')
  return a.toolCalls + ' tools'
}

/** `4/5 · Signing up` from its TodoWrite list, else `tools 12 · last: Bash npm test`. */
export function progressText(a: AgentRecord): string {
  const t = a.todo
  return t && t.total > 0 ? stepText(a) : toolsText(a)
}

/** `ctx 4% · 41k ≈$0.08 0:40`. */
export function statsText(a: AgentRecord, now: number, window: number): string {
  return 'ctx ' + pct(ctxRatio(a, window)) + ' · ' + tokensShort(totalTokens(a.tokens)) + ' ' + money(agentCost(a)) + ' ' + clock(elapsedOf(a, now))
}

/** `Opus 5.5 · low`: the model, then the effort as given when one was seen. */
export function modelLine(a: AgentRecord): string {
  return modelLabel(a.model) + (a.effort ? ' · ' + a.effort : '')
}

/** The card's bar: todo items done over all, else full once done, else its elapsed time over the
 *  longest sibling's (a failed card keeps the time it ran). */
export function barRatio(a: AgentRecord, now: number, longestMs: number): number {
  const t = a.todo
  if (t && t.total > 0) return Math.min(1, t.done / t.total)
  if (a.status === 'done') return 1
  return longestMs > 0 ? Math.min(1, elapsedOf(a, now) / longestMs) : 0
}

export type Totals = { costUsd: number | null; tokens: number; timeMs: number; agents: number }

/**
 * The header tiles over the session's subagents. Cost and tokens are sums. Time is wall-clock
 * time during which at least one subagent ran: the union of each agent's span, from its first
 * start to its end (now while it runs), so parallel agents count once.
 */
export function sessionTotals(agents: Agents, now: number): Totals {
  let cost: number | null = null
  let tokens = 0
  let n = 0
  const spans: [number, number][] = []
  for (const a of Object.values(agents)) {
    if (a.id === MAIN || !a.isSpawned) continue
    n++
    tokens += totalTokens(a.tokens)
    const c = agentCost(a)
    if (c !== null) cost = (cost ?? 0) + c
    const start = a.startedAt
    const end = a.status === 'running' ? now : (a.endedAt ?? start + (a.durationMs ?? 0))
    spans.push([start, Math.max(start, end)])
  }
  spans.sort((x, y) => x[0] - y[0])
  let timeMs = 0
  let open: [number, number] | null = null
  for (const s of spans) {
    if (open && s[0] <= open[1]) open[1] = Math.max(open[1], s[1])
    else {
      if (open) timeMs += open[1] - open[0]
      open = [s[0], s[1]]
    }
  }
  if (open) timeMs += open[1] - open[0]
  return { costUsd: n === 0 ? 0 : cost, tokens, timeMs, agents: n }
}

// ---------------------------------------------------------------- trees

export type PaneHandlers = {
  toggle: (id: string) => unknown
  stop: (id: string) => unknown
  collapse: () => unknown
  view: (v: PaneView) => unknown
}

export type HeaderOptions = {
  view: PaneView
  collapsed: boolean
  on: Pick<PaneHandlers, 'collapse' | 'view'>
  /** The main loop's line, drawn under the buttons (the cards view; the tree views draw it with their tree). */
  main?: unknown
}

/**
 * The header block: Cost · Tokens · Time tiles, then Collapse/Expand (cards only) and the view
 * buttons (the shown view's button is primary), then the main loop's line when given, one row apart.
 */
export function headerTree(kit: Kit, agents: Agents, now: number, o: HeaderOptions): unknown {
  const t = sessionTotals(agents, now)
  const viewButton = (v: PaneView, label: string) => ({
    key: 'view-' + v,
    label,
    variant: o.view === v ? ('primary' as const) : undefined,
    onPress: () => o.on.view(v),
  })
  return kit.stack(
    [
      kit.tiles([
        { label: 'Cost', value: money(t.costUsd) },
        { label: 'Tokens', value: tokensShort(t.tokens) },
        { label: 'Time', value: clock(t.timeMs) },
      ]),
      kit.buttons([
        ...(o.view === 'cards' ? [{ key: 'collapse', label: o.collapsed ? 'Expand' : 'Collapse', onPress: () => o.on.collapse() }] : []),
        viewButton('cards', 'Cards'),
        viewButton('tree', 'Tree'),
        viewButton('team', 'Team'),
      ]),
      o.main,
    ],
    1,
  )
}

export type CardsOptions = {
  /** The hook's resolved elements: each card sits in a Box keyed `card-<id>` and `columns` wide. */
  ui: Elements
  columns: number
  /** The session's context window, for ctx %. */
  window: number
  pending: readonly PendingCall[]
  /** Agents whose details are open. */
  expanded: readonly string[]
  collapsed: boolean
  /** The agent whose Stop button is armed. */
  armed: string | null
  stuckAfterMs?: number
  on: PaneHandlers
}

/** The critter on a surface with Svg; the role glyph on the terminal. */
function avatar(kit: Kit, ui: Elements, role: Role, status: CardStatus | 'idle', effort: string, size: number): unknown {
  const state = status === 'idle' ? 'idle' : DOODLE_STATE[status]
  if (kit.surface === 'terminal' || typeof ui.Svg !== 'function') {
    // The role glyph in the status's tone (kit.doodle would paint waiting in the warning key)
    const tone = status === 'idle' ? 'muted' : MARKS[status].tone
    return kit.text(glyph(role), { color: TONES[tone].fg, bold: status === 'running' })
  }
  const source = critterSvg({
    main: role === 'main',
    hat: effortLook(effort).hat,
    state,
    faded: status === 'stopped' || status === 'aborted',
    size,
  })
  return ui.Svg({ source, alt: role + ' ' + (status === 'idle' ? 'planned' : status), width: size, height: size })
}

function card(kit: Kit, agents: Agents, a: AgentRecord, now: number, longestMs: number, o: CardsOptions): unknown {
  const status = cardStatus(a)
  const mark = MARKS[status]
  const running = a.status === 'running'
  const open = o.expanded.includes(a.id)
  const effort = effortLook(a.effort)
  const quiet = (s: string) => kit.text(s, { color: 'inactive', wrap: 'truncate-end' })

  const right: unknown[] = [kit.text(mark.glyph, { color: TONES[mark.tone].fg, bold: true })]
  if (running) {
    right.push(kit.buttons([{ key: 'stop-' + a.id, label: o.armed === a.id ? 'Confirm stop' : 'Stop', plain: true, onPress: () => o.on.stop(a.id) }]))
  }
  const title = kit.row({
    left: [
      kit.buttons([{ key: 'row-' + a.id, label: open ? '▾' : '▸', plain: true, onPress: () => o.on.toggle(a.id) }]),
      kit.text(markOf(a) + labelOf(a), { bold: true, wrap: 'truncate-end' }),
    ],
    right,
  })
  const model = kit.row({
    left: [effort.word ? kit.text(effort.word, { color: TONES[effort.tone].fg, bold: true }) : null, quiet(modelLine(a))].filter(Boolean),
  })
  const step = kit.row({ left: [kit.text(stepText(a), { wrap: 'truncate-end' })], right: statsText(a, now, o.window) })
  // An Svg bar takes the column's width; the terminal's text bar as much as it leaves (frame 4, glyph 2, percent 5)
  const svgOk = kit.surface !== 'terminal' && typeof o.ui.Svg === 'function'
  const bar = o.collapsed
    ? null
    : kit.progress(barRatio(a, now, longestMs), svgOk ? { tone: effort.tone } : { width: Math.max(10, o.columns - 11), tone: effort.tone })
  const flag = o.collapsed ? undefined : flagOf(a, now, o.stuckAfterMs ?? DEFAULT_STUCK_MS)
  const ret = returnedNote(agents, a)
  const column = o.ui.Box({
    flexDirection: 'column',
    flexGrow: 1,
    flexShrink: 1,
    children: [
      title,
      model,
      step,
      bar,
      flag ? kit.text(flag.text, { color: flag.color ?? 'inactive', wrap: 'truncate-end' }) : null,
      open ? quiet(toolsText(a)) : null,
      open && ret ? quiet(ret) : null,
      // Then the full record, wrapped to the column (frame 4, avatar glyph and gap 2)
      ...(open ? detailLines(agents, a, now, Math.max(12, o.columns - 6)).map(quiet) : []),
    ].filter(Boolean),
  })
  const body = o.ui.Box({ flexDirection: 'row', columnGap: 1, children: [avatar(kit, o.ui, roleOf(a), status, a.effort, CRITTER_SIZE), column] })
  return o.ui.Box({
    key: 'card-' + a.id,
    flexDirection: 'column',
    width: o.columns,
    children: [kit.card({ tone: running ? 'info' : undefined, children: [body] })],
  })
}

/** The main loop's line: its critter, tokens, tool calls and any call waiting on the person. */
export function mainRow(kit: Kit, agents: Agents, ui: Elements): unknown {
  const m = agents[MAIN]
  const waits = m?.waiting?.length ? Array.from(new Set(m.waiting.map(w => w.tool))).join(', ') : ''
  return kit.row({
    key: 'main',
    left: [
      avatar(kit, ui, 'main', waits ? 'waiting' : 'running', m?.effort ?? '', ROW_CRITTER),
      kit.text('main (orchestrator) · ' + tokensShort(totalTokens(m?.tokens)) + ' tok · ' + (m?.toolCalls ?? 0) + ' tools', { bold: true, wrap: 'truncate-end' }),
    ],
    right: waits ? [kit.text('◷ waiting: ' + waits, { color: TONES[MARKS.waiting.tone].fg, wrap: 'truncate-end' })] : undefined,
  })
}

/** The critter's size on a one-line row (the main loop, a planned spawn). */
const ROW_CRITTER = 24

/**
 * The cards view's body, under the header block: the `Agents · n` section with one card per
 * subagent (running first, then waiting on the person, then finished; one row between cards) and
 * the `Planned · n` section of Agent calls whose spawn hasn't started, one row between sections.
 */
export function cardsTree(kit: Kit, agents: Agents, order: readonly string[], now: number, o: CardsOptions): unknown {
  const ids = cardOrder(agents, order)
  const running = ids.filter(id => agents[id].status === 'running').length
  const longestMs = Math.max(0, ...ids.map(id => elapsedOf(agents[id], now)))
  const sections: unknown[] = []
  if (ids.length > 0) {
    sections.push(
      kit.stack([
        kit.header('Agents · ' + ids.length, running + ' running'),
        kit.list(ids.map(id => card(kit, agents, agents[id], now, longestMs, o))),
      ]),
    )
  } else if (o.pending.length === 0) {
    sections.push(kit.text('no subagents yet', { color: 'inactive' }))
  }
  if (o.pending.length > 0) {
    const parts: unknown[] = [kit.header('Planned · ' + o.pending.length)]
    o.pending.forEach((p, i) => {
      const right = [p.subagentType, p.model ? modelLabel(p.model) : '', 'asked ' + clock(now - p.at) + ' ago'].filter(Boolean).join(' · ')
      const role = roleOf({ name: p.subagentType, description: p.description, prompt: p.prompt, model: p.model })
      parts.push(
        kit.row({
          key: 'planned-' + (p.toolUseId || String(i)),
          left: [avatar(kit, o.ui, role, 'idle', '', ROW_CRITTER), kit.text(p.description || p.subagentType || 'agent', { wrap: 'truncate-end' })],
          right,
        }),
      )
    })
    sections.push(kit.stack(parts))
  }
  return kit.stack(sections, 1)
}

// ---------------------------------------------------------------- caps

/** How to change the caps, under the Caps block. */
export const CAPS_HINT = 'Change in /config (lk-agent-map rows); /agent-map cap <kind> <n> saves an override, /agent-map cap reset clears it.'

/** The Caps block's rows, in the order the settings list them. */
const CAP_ROWS: readonly { key: keyof CapConfig; label: string }[] = [
  { key: 'maxConcurrent', label: 'Max running at once' },
  { key: 'maxPerTurn', label: 'Max spawns per turn' },
  { key: 'maxPerSession', label: 'Max spawns per session' },
  { key: 'warnAt', label: 'Warn at' },
  { key: 'maxReturnedTokens', label: 'Max result tokens in main' },
]

/** One cap's value: `4`, `75%`, `150k tok`; `no cap` for 0. */
export function capValue(caps: CapConfig, key: keyof CapConfig): string {
  if (key === 'warnAt') return Math.round(caps.warnAt * 100) + '%'
  const n = caps[key]
  if (!(n > 0)) return 'no cap'
  return key === 'maxReturnedTokens' ? tokensShort(n) + ' tok' : String(n)
}

/**
 * The Caps block: an upper-cased header with where the values came from, one row per cap
 * (label; value and source on the right) and the hint that says how to change them.
 */
export function capsTree(kit: Kit, caps: CapConfig, sources: CapSources): unknown {
  const from = Array.from(new Set(CAP_ROWS.map(r => sources[r.key]).filter(s => s !== 'default')))
  return kit.stack([
    kit.header('Caps', from.length ? 'from ' + from.join(', ') : 'defaults'),
    ...CAP_ROWS.map(r =>
      kit.row({
        key: 'cap-' + r.key,
        left: [kit.text(r.label, { wrap: 'truncate-end' })],
        right: [kit.text(capValue(caps, r.key), { bold: true, wrap: 'truncate' }), sources[r.key]],
      }),
    ),
    kit.text(CAPS_HINT, { color: 'inactive', wrap: 'wrap' }),
  ])
}
