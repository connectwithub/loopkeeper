// Review loops: the pure part. Parsing tool input, applying a cycle or an item to a subject, and every
// piece of text the review concern shows. Nothing here touches $.

import { storeKey } from './names.ts'
import type { LkReviewCycle, LkReviewItem, LkReviewKind, LkSubject } from '../../types/index.d.ts'

/** How urgent an open item is; p0 first. */
export type Priority = 'p0' | 'p1' | 'p2'
/** A reviewer's verdict as stored. */
export type Verdict = 'ship' | 'iterate' | 'stop'
/** What is being iterated on; each kind has a preset for how it is done. */
export type Kind = LkReviewKind
/** What ends a loop: a score reaching the target, or no open p0/p1 items. */
export type DoneBy = 'score' | 'items'
/** Where a subject's loop stands. Only 'active' subjects show in the band. */
export type Status = 'active' | 'ship' | 'stop'
export type Item = LkReviewItem
export type Cycle = LkReviewCycle
/** The shape the reviewSubjects atom holds; stage's review_cycle wrapper reads it. */
export type Subject = LkSubject
export type Subjects = Record<string, Subject>

/** Per-kind target and cycle limit, from the config file's review section. */
export type KindDefaults = Record<string, { target?: number; maxCycles?: number }>
/**
 * Defaults beyond the kind presets. `target` and `maxCycles` are what the user set with /reviews target and
 * /reviews max (they win over everything); `kinds` is the config file's per-kind layer. A missing value
 * means the next layer down applies: store override, then config kind, then the kind's preset.
 */
export type Defaults = { target?: number; maxCycles?: number; kinds?: KindDefaults }

export const DEFAULT_TARGET = 9.0
export const MAX_CYCLES_CAP = 20
export const PRUNE_MS = 14 * 24 * 60 * 60 * 1000
export const LOG_FILE = '.claude/loopkeeper-review.jsonl'
export const CONTEXT_BLOCK = 'reviewLoop'

const MAX_NAME = 80
const MAX_TEXT = 300
const MAX_NOTES = 600
const MAX_PROOF = 300
const MAX_ITEMS = 50
const SPARKS = '▁▂▃▄▅▆▇█'

export const USAGE = [
  'Usage: /reviews [text | clear <subject> | kinds | kind <subject> <kind> | target <n> [subject] |',
  '        max <n> [subject] | ship <subject> | reopen <subject> | stop <subject> | band on|off | context on|off]',
].join('\n')

// ---------- kinds ----------

export const KIND_NAMES: Kind[] = ['critic', 'review', 'plan', 'qa', 'copy', 'design']

export type KindPreset = { doneBy: DoneBy; target?: number; maxCycles: number; word: string }

/** What each kind of loop is by default. `word` is what one pass is called. */
export const KINDS: Record<Kind, KindPreset> = {
  critic: { doneBy: 'score', target: 9.0, maxCycles: 4, word: 'critic pass' },
  review: { doneBy: 'items', maxCycles: 3, word: 'review round' },
  plan: { doneBy: 'items', maxCycles: 2, word: 'validation pass' },
  qa: { doneBy: 'items', maxCycles: 3, word: 'test run' },
  copy: { doneBy: 'score', target: 8.5, maxCycles: 3, word: 'edit pass' },
  design: { doneBy: 'score', target: 9.0, maxCycles: 4, word: 'design review' },
}

export function kindOf(v: unknown): Kind | undefined {
  const s = oneLine(v).toLowerCase()
  return (KIND_NAMES as string[]).includes(s) ? (s as Kind) : undefined
}

export function doneByOf(v: unknown): DoneBy | undefined {
  const s = oneLine(v).toLowerCase()
  return s === 'score' || s === 'items' ? s : undefined
}

/** The table /reviews kinds prints. */
export function kindsText(): string {
  const rows = KIND_NAMES.map(k => {
    const p = KINDS[k]
    return [k, p.doneBy, p.target !== undefined ? fmt(p.target) : '–', String(p.maxCycles), p.word]
  })
  const head = ['kind', 'done by', 'target', 'max', 'pass word']
  const width = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)))
  const line = (r: string[]) => r.map((c, i) => c.padEnd(width[i]!)).join('  ').trimEnd()
  return [
    'Kinds: set with "kind" on the first review_cycle, or change with /reviews kind <subject> <kind>.',
    line(head),
    ...rows.map(line),
    'Score kinds are done when the last score reaches the target. Item kinds are done when no p0 or p1 item is open and the last verdict is not iterate or stop.',
  ].join('\n')
}

/**
 * The target and cycle limit a new subject of this kind starts with:
 * the kind's preset, over it the config file's kind entry, over that the user's /reviews target and max.
 */
export function presetFor(kind: Kind, defaults: Defaults): { target?: number; maxCycles: number } {
  const p = KINDS[kind]
  const conf = defaults.kinds?.[kind]
  const target = defaults.target ?? validTarget(conf?.target) ?? p.target
  return { maxCycles: defaults.maxCycles ?? validMax(conf?.maxCycles) ?? p.maxCycles, ...(target !== undefined ? { target } : {}) }
}

/** Builds a new, empty subject from a kind's preset; config and user-set defaults win over the preset. */
function newSubject(name: string, kind: Kind, doneBy: DoneBy | undefined, target: number | undefined, max: number | undefined, defaults: Defaults, now: number): Subject {
  const p = KINDS[kind]
  const by = doneBy ?? p.doneBy
  const at = presetFor(kind, defaults)
  const s: Subject = {
    name,
    kind,
    doneBy: by,
    maxCycles: max ?? at.maxCycles,
    cycles: [],
    items: [],
    status: 'active',
    updatedAt: now,
  }
  if (by === 'score') s.target = target ?? at.target ?? DEFAULT_TARGET
  return s
}

/** The kind's preset applied to an existing subject (/reviews kind). History and items stay. */
export function withKind(s: Subject, kind: Kind, defaults: Defaults, now: number): Subject {
  const fresh = newSubject(s.name, kind, undefined, undefined, undefined, defaults, now)
  const out: Subject = { ...s, cycles: s.cycles.map(c => ({ ...c })), items: s.items.map(i => ({ ...i })), kind, doneBy: fresh.doneBy, maxCycles: fresh.maxCycles, updatedAt: now }
  if (fresh.target !== undefined) out.target = fresh.target
  else delete out.target
  return out
}

export const targetOf = (s: Subject): number => s.target ?? KINDS[s.kind].target ?? DEFAULT_TARGET
export const wordOf = (s: Subject): string => KINDS[s.kind].word
export const unitOf = (s: Subject): string => (s.doneBy === 'items' ? 'round' : 'cycle')

// ---------- small guards ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** One line of text, trimmed and capped. */
export function oneLine(v: unknown, cap = MAX_TEXT): string {
  if (typeof v !== 'string' && typeof v !== 'number') return ''
  const s = String(v).replace(/\s+/g, ' ').trim()
  return s.length > cap ? s.slice(0, cap - 1) + '…' : s
}

/** A subject name: one line, capped. */
export const nameOf = (v: unknown): string => oneLine(v, MAX_NAME)

/** A number from a number or a numeric string, or undefined. */
export function numberOf(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim())
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

const round1 = (n: number) => Math.round(n * 10) / 10
export const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '?')

export function validTarget(v: unknown): number | undefined {
  const n = numberOf(v)
  return n !== undefined && n >= 0 && n <= 10 ? round1(n) : undefined
}

export function validMax(v: unknown): number | undefined {
  const n = numberOf(v)
  return n !== undefined && Number.isInteger(n) && n >= 1 && n <= MAX_CYCLES_CAP ? n : undefined
}

/** The config file's review.kinds, keeping only known kinds and valid numbers. */
export function kindDefaultsFrom(v: unknown): KindDefaults {
  const out: KindDefaults = {}
  if (!isObj(v)) return out
  for (const [key, raw] of Object.entries(v)) {
    const kind = kindOf(key)
    if (!kind || !isObj(raw)) continue
    const target = validTarget(raw.target)
    const maxCycles = validMax(raw.maxCycles)
    if (target === undefined && maxCycles === undefined) continue
    out[kind] = { ...(target !== undefined ? { target } : {}), ...(maxCycles !== undefined ? { maxCycles } : {}) }
  }
  return out
}

const SHIP_WORDS = new Set(['ship', 'shipped', 'consistent', 'pass', 'passed', 'ok', 'approve', 'approved', 'lgtm', 'green'])
const ITERATE_WORDS = new Set([
  'iterate', 'one-more-polish', 'needs-rework', 'rework', 'polish', 'fail',
  'inconsistent', 'issues', 'needs-work', 'needs-changes', 'changes-requested', 'red', 'failing',
])

/** Maps a critic's or reviewer's words onto the three verdicts; unknown words give undefined. */
export function verdictOf(v: unknown): Verdict | undefined {
  const s = oneLine(v).toLowerCase().replace(/[\s_]+/g, '-')
  if (!s) return undefined
  if (SHIP_WORDS.has(s)) return 'ship'
  if (s === 'stop' || s === 'stopped' || s === 'abandon' || s === 'halt') return 'stop'
  if (ITERATE_WORDS.has(s)) return 'iterate'
  return undefined
}

export function priorityOf(v: unknown): Priority | undefined {
  const s = oneLine(v).toLowerCase()
  return s === 'p0' || s === 'p1' || s === 'p2' ? s : undefined
}

const boolOf = (v: unknown): boolean | undefined =>
  typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined

const keyOf = (text: string) => text.toLowerCase()

/** Finds a subject by exact name, then case-insensitively. */
export function findSubject(subjects: Subjects, name: string): Subject | undefined {
  if (!name) return undefined
  if (isObj(subjects[name])) return subjects[name]
  const lower = name.toLowerCase()
  for (const key of Object.keys(subjects)) if (key.toLowerCase() === lower) return subjects[key]
  return undefined
}

// ---------- reading what comes back from $.store ----------

function itemFrom(v: unknown): Item | null {
  if (!isObj(v)) return null
  const text = oneLine(v.text)
  if (!text) return null
  const item: Item = {
    text,
    priority: priorityOf(v.priority) ?? 'p1',
    done: v.done === true,
    addedCycle: Math.max(0, Math.floor(numberOf(v.addedCycle) ?? 0)),
  }
  const proof = oneLine(v.proof, MAX_PROOF)
  if (proof) item.proof = proof
  const closed = numberOf(v.closedCycle)
  if (closed !== undefined) item.closedCycle = Math.floor(closed)
  return item
}

function cycleFrom(v: unknown, doneBy: DoneBy): (Cycle | null) {
  if (!isObj(v)) return null
  const cycle = numberOf(v.cycle)
  const score = numberOf(v.score)
  const validScore = score !== undefined && score >= 0 && score <= 10
  if (cycle === undefined || cycle < 1) return null
  if (doneBy === 'score' && !validScore) return null
  const c: Cycle = { cycle: Math.floor(cycle), at: numberOf(v.at) ?? 0 }
  if (validScore) c.score = round1(score!)
  const open = numberOf(v.open)
  if (open !== undefined && open >= 0) c.open = Math.floor(open)
  const verdict = verdictOf(v.verdict)
  if (verdict) c.verdict = verdict
  const notes = oneLine(v.notes, MAX_NOTES)
  if (notes) c.notes = notes
  return c
}

/** Rebuilds subjects from stored JSON, dropping anything malformed. */
export function subjectsFrom(v: unknown, defaults: Defaults): Subjects {
  const out: Subjects = {}
  if (!isObj(v)) return out
  for (const [key, raw] of Object.entries(v)) {
    if (!isObj(raw)) continue
    const name = nameOf(raw.name) || nameOf(key)
    if (!name) continue
    const status: Status = raw.status === 'ship' || raw.status === 'stop' ? raw.status : 'active'
    const kind = kindOf(raw.kind) ?? 'critic'
    // subjects stored before kinds existed are critic/score
    const doneBy = doneByOf(raw.doneBy) ?? (raw.kind === undefined ? 'score' : KINDS[kind].doneBy)
    const subject: Subject = {
      name,
      kind,
      doneBy,
      maxCycles: validMax(raw.maxCycles) ?? presetFor(kind, defaults).maxCycles,
      cycles: (Array.isArray(raw.cycles) ? raw.cycles : [])
        .map(c => cycleFrom(c, doneBy))
        .filter((c): c is Cycle => c !== null)
        .sort((a, b) => a.cycle - b.cycle),
      items: (Array.isArray(raw.items) ? raw.items : []).map(itemFrom).filter((i): i is Item => i !== null),
      status,
      updatedAt: numberOf(raw.updatedAt) ?? 0,
    }
    if (doneBy === 'score') subject.target = validTarget(raw.target) ?? presetFor(kind, defaults).target ?? DEFAULT_TARGET
    out[name] = subject
  }
  return out
}

/** Drops subjects untouched for 14 days. Returns the kept ones and the dropped names. */
export function prune(subjects: Subjects, now: number): { kept: Subjects; dropped: string[] } {
  const kept: Subjects = {}
  const dropped: string[] = []
  for (const [name, s] of Object.entries(subjects)) {
    if (now - (s.updatedAt || 0) > PRUNE_MS) dropped.push(name)
    else kept[name] = s
  }
  return { kept, dropped }
}

/** Store keys of the review concern: loopkeeper:review:<key>. Subjects are kept per project. */
export const SUBJECTS_PREFIX = storeKey('review', 'subjects:')
export const storeKeyOf = (cwd: string) => SUBJECTS_PREFIX + (cwd || '-')

// ---------- derived facts ----------

export const lastCycle = (s: Subject): Cycle | undefined => s.cycles[s.cycles.length - 1]
export const usedCycles = (s: Subject): number => lastCycle(s)?.cycle ?? 0

const RANK: Record<Priority, number> = { p0: 0, p1: 1, p2: 2 }
export const openItems = (s: Subject): Item[] =>
  s.items.filter(i => !i.done).sort((a, b) => RANK[a.priority] - RANK[b.priority])
export const doneItems = (s: Subject): Item[] => s.items.filter(i => i.done)
/** Open items with priority p0 or p1: what keeps an item kind from being done. */
export const blocking = (s: Subject): number => s.items.filter(i => !i.done && (i.priority === 'p0' || i.priority === 'p1')).length
const p0Count = (s: Subject): number => s.items.filter(i => !i.done && i.priority === 'p0').length
const holds = (s: Subject, c: Cycle): boolean =>
  s.doneBy === 'score'
    ? c.score !== undefined && c.score >= targetOf(s)
    : blocking(s) === 0 && c.verdict !== 'iterate' && c.verdict !== 'stop'
/** Score kinds: the last score is at the target. Item kinds: a cycle exists, no p0/p1 is open, the last verdict is not iterate or stop. */
export const reached = (s: Subject): boolean => {
  const last = lastCycle(s)
  return !!last && holds(s, last)
}
export const cyclesLeft = (s: Subject): number => Math.max(0, s.maxCycles - usedCycles(s))
/** At or past the cycle limit without reaching the target, and not shipped. */
export const notConverging = (s: Subject): boolean => s.status !== 'ship' && usedCycles(s) >= s.maxCycles && !reached(s)

export function deltaText(s: Subject): string {
  const n = s.cycles.length
  if (n < 2) return ''
  const a = s.cycles[n - 1]!.score
  const b = s.cycles[n - 2]!.score
  if (a === undefined || b === undefined) return ''
  const d = round1(a - b)
  return d > 0 ? `+${fmt(d)}` : d < 0 ? `-${fmt(-d)}` : '±0.0'
}

const allScored = (s: Subject): boolean => s.cycles.length > 0 && s.cycles.every(c => c.score !== undefined)

/** Scores joined by arrows; item kinds without scores show the open count per cycle. */
export function historyText(s: Subject): string {
  if (!s.cycles.length) return s.doneBy === 'items' ? 'no rounds yet' : 'no scores yet'
  if (allScored(s)) return s.cycles.map(c => fmt(c.score!)).join(' → ')
  return s.cycles.map(c => (c.open === undefined ? '? open' : `${c.open} open`)).join(' → ')
}

const historyLabel = (s: Subject): string => (allScored(s) || s.doneBy === 'score' ? 'scores' : 'open per ' + unitOf(s))

/** The scores of a subject whose every cycle has one, for the sparkline. */
export const scoresOf = (s: Subject): number[] => (allScored(s) ? s.cycles.map(c => c.score!) : [])

/** ▁▂▃▄▅▆▇█ from the lowest whole score to 10. */
export function sparkline(scores: number[]): string {
  if (!scores.length) return ''
  const lo = Math.min(Math.floor(Math.min(...scores)), 9)
  const span = 10 - lo
  return scores
    .map(v => {
      const idx = Math.round(((Math.max(lo, Math.min(10, v)) - lo) / span) * (SPARKS.length - 1))
      return SPARKS[Math.max(0, Math.min(SPARKS.length - 1, idx))]
    })
    .join('')
}

export const proofMark = (i: Item): string => (i.done ? (i.proof ? `✓ ${i.proof}` : '✓ (no proof)') : '')

export const itemLine = (i: Item): string => `[${i.priority}] ${i.text}${i.done ? '  ' + proofMark(i) : ''}`

// ---------- applying tool input ----------

export type CycleInput = {
  subject: string
  kind?: Kind
  doneBy?: DoneBy
  cycle?: number
  score?: number
  target?: number
  maxCycles?: number
  verdict?: Verdict
  items: { text: string; priority?: Priority; done?: boolean; proof?: string }[]
  notes: string
  errors: string[]
}

/** Reads review_cycle input, collecting problems instead of throwing. */
export function cycleInputOf(e: unknown): CycleInput {
  const o = isObj(e) ? e : {}
  const errors: string[] = []
  const subject = nameOf(o.subject)
  if (!subject) errors.push('"subject" is required (asset name, PR or file set)')
  const score = numberOf(o.score)
  if (o.score !== undefined && o.score !== null && o.score !== '' && score === undefined) errors.push('"score" must be a number from 0 to 10')
  else if (score !== undefined && (score < 0 || score > 10)) errors.push(`"score" ${score} is outside 0–10`)
  let kind: Kind | undefined
  if (o.kind !== undefined && o.kind !== null && o.kind !== '') {
    kind = kindOf(o.kind)
    if (!kind) errors.push(`"kind" must be one of ${KIND_NAMES.join(', ')}`)
  }
  let doneBy: DoneBy | undefined
  if (o.doneBy !== undefined && o.doneBy !== null && o.doneBy !== '') {
    doneBy = doneByOf(o.doneBy)
    if (!doneBy) errors.push('"doneBy" must be score or items')
  }
  let cycle: number | undefined
  if (o.cycle !== undefined && o.cycle !== null) {
    const n = numberOf(o.cycle)
    if (n === undefined || !Number.isInteger(n) || n < 1) errors.push('"cycle" must be a whole number of 1 or more, or left out')
    else cycle = n
  }
  let target: number | undefined
  if (o.target !== undefined && o.target !== null) {
    target = validTarget(o.target)
    if (target === undefined) errors.push('"target" must be a number from 0 to 10')
  }
  let maxCycles: number | undefined
  if (o.maxCycles !== undefined && o.maxCycles !== null) {
    maxCycles = validMax(o.maxCycles)
    if (maxCycles === undefined) errors.push(`"maxCycles" must be a whole number from 1 to ${MAX_CYCLES_CAP}`)
  }
  let verdict: Verdict | undefined
  if (o.verdict !== undefined && o.verdict !== null && o.verdict !== '') {
    verdict = verdictOf(o.verdict)
    if (!verdict) errors.push('"verdict" must be ship, iterate or stop')
  }
  const items: CycleInput['items'] = []
  for (const raw of Array.isArray(o.items) ? o.items.slice(0, MAX_ITEMS) : []) {
    const text = typeof raw === 'string' ? oneLine(raw) : isObj(raw) ? oneLine(raw.text) : ''
    if (!text) continue
    const it: CycleInput['items'][number] = { text }
    if (isObj(raw)) {
      const p = priorityOf(raw.priority)
      if (p) it.priority = p
      const d = boolOf(raw.done)
      if (d !== undefined) it.done = d
      const proof = oneLine(raw.proof, MAX_PROOF)
      if (proof) it.proof = proof
    }
    items.push(it)
  }
  return {
    subject,
    ...(kind ? { kind } : {}),
    ...(doneBy ? { doneBy } : {}),
    ...(cycle !== undefined ? { cycle } : {}),
    ...(score !== undefined ? { score: round1(score) } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(maxCycles !== undefined ? { maxCycles } : {}),
    ...(verdict ? { verdict } : {}),
    items,
    notes: oneLine(o.notes, MAX_NOTES),
    errors,
  }
}

export type CycleOutcome =
  | { ok: true; subject: Subject; cycle: Cycle; created: boolean; warnings: string[] }
  | { ok: false; reply: string }

const clone = (s: Subject): Subject => ({ ...s, cycles: s.cycles.map(c => ({ ...c })), items: s.items.map(i => ({ ...i })) })

/** Merges items into a subject: match by text, add the new, keep the rest. */
function mergeItems(items: Item[], incoming: CycleInput['items'], cycle: number): Item[] {
  const out = items.map(i => ({ ...i }))
  for (const inc of incoming) {
    const found = out.find(i => keyOf(i.text) === keyOf(inc.text))
    if (found) {
      if (inc.priority) found.priority = inc.priority
      if (inc.done === true && !found.done) {
        found.done = true
        found.closedCycle = cycle
      } else if (inc.done === false && found.done) {
        found.done = false
        delete found.closedCycle
        delete found.proof
      }
      if (inc.proof) found.proof = inc.proof
    } else if (out.length < MAX_ITEMS) {
      const item: Item = { text: inc.text, priority: inc.priority ?? 'p1', done: inc.done === true, addedCycle: cycle }
      if (item.done) item.closedCycle = cycle
      if (inc.proof) item.proof = inc.proof
      out.push(item)
    }
  }
  return out
}

/**
 * Applies one pass. Kind, doneBy, target and maxCycles from the tool count only
 * when the subject is new (or has no cycle yet): after that only the user
 * changes them (/reviews kind, target, max), so the limit cannot be moved from
 * inside the loop.
 */
export function applyCycle(subjects: Subjects, input: CycleInput, defaults: Defaults, now: number): CycleOutcome {
  if (input.errors.length) return { ok: false, reply: 'Not recorded: ' + input.errors.join('; ') + '.' }
  const existing = findSubject(subjects, input.subject)
  const created = !existing
  const warnings: string[] = []
  let s: Subject
  if (!existing || (existing.cycles.length === 0 && (input.kind || input.doneBy || input.target !== undefined || input.maxCycles !== undefined))) {
    s = newSubject(existing?.name ?? input.subject, input.kind ?? existing?.kind ?? 'critic', input.doneBy, input.target, input.maxCycles, defaults, now)
    if (existing) s.items = existing.items.map(i => ({ ...i }))
    if (s.doneBy === 'items' && input.target !== undefined) warnings.push(`target ignored: kind ${s.kind} is done by items, not by score`)
  } else {
    s = clone(existing)
    if (input.kind && input.kind !== s.kind) warnings.push(`kind stays ${s.kind}: only the user changes it (/reviews kind ${s.name} <kind>)`)
    if (input.doneBy && input.doneBy !== s.doneBy) warnings.push(`doneBy stays ${s.doneBy} for ${s.name}`)
    if (input.target !== undefined && s.doneBy === 'score' && input.target !== s.target)
      warnings.push(`target stays ${fmt(targetOf(s))}: only the user changes it (/reviews target <n> ${s.name})`)
    if (input.maxCycles !== undefined && input.maxCycles !== s.maxCycles)
      warnings.push(`maxCycles stays ${s.maxCycles}: only the user changes it (/reviews max <n> ${s.name})`)
  }
  if (s.doneBy === 'score' && input.score === undefined) {
    return { ok: false, reply: `Not recorded: "score" is required for kind ${s.kind} (done by score), a number from 0 to 10. For a review that ends when no p0/p1 item is open, use kind review, plan or qa.` }
  }

  if (s.status !== 'active') {
    const how = s.status === 'ship' ? 'shipped' : 'stopped'
    return {
      ok: false,
      reply: `Not recorded: ${s.name} is ${how}. The user can reopen it from /reviews (or /reviews reopen ${s.name}).\n\n${subjectText(s)}`,
    }
  }
  const number = input.cycle ?? usedCycles(s) + 1
  if (number > s.maxCycles) {
    return {
      ok: false,
      reply:
        `Not recorded: ${unitOf(s)} ${number} is past the limit of ${s.maxCycles} for ${s.name}. ` +
        `Do not run another ${wordOf(s)}. Stop and surface to the user: report the ${historyLabel(s)} and open items and ask how to proceed. ` +
        `The user can raise the limit with /reviews max <n> ${s.name}.\n\n${subjectText(s)}`,
    }
  }
  const cycle: Cycle = { cycle: number, at: now }
  if (input.score !== undefined) cycle.score = input.score
  if (input.verdict) cycle.verdict = input.verdict
  if (input.notes) cycle.notes = input.notes
  const at = s.cycles.findIndex(c => c.cycle === number)
  if (at >= 0) {
    s.cycles[at] = cycle
    warnings.push(`${unitOf(s)} ${number} was already recorded; it is replaced`)
  } else {
    s.cycles.push(cycle)
    s.cycles.sort((a, b) => a.cycle - b.cycle)
  }
  s.items = mergeItems(s.items, input.items, number)
  cycle.open = openItems(s).length
  if (input.verdict === 'ship') s.status = 'ship'
  else if (input.verdict === 'stop') s.status = 'stop'
  s.updatedAt = now
  if (input.verdict === 'ship') {
    if (s.doneBy === 'score' && !reached(s)) warnings.push(`shipped below target (${fmt(input.score ?? 0)} < ${fmt(targetOf(s))})`)
    const open = blocking(s)
    if (s.doneBy === 'items' && open > 0) warnings.push(`shipped with ${open} open p0/p1 item${open === 1 ? '' : 's'}`)
  }
  return { ok: true, subject: s, cycle, created, warnings }
}

export type ItemInput = { subject: string; text: string; done?: boolean; proof: string; priority?: Priority; errors: string[] }

export function itemInputOf(e: unknown): ItemInput {
  const o = isObj(e) ? e : {}
  const errors: string[] = []
  const subject = nameOf(o.subject)
  const text = oneLine(o.text)
  if (!subject) errors.push('"subject" is required')
  if (!text) errors.push('"text" is required')
  const done = boolOf(o.done)
  const priority = priorityOf(o.priority)
  return {
    subject,
    text,
    ...(done !== undefined ? { done } : {}),
    proof: oneLine(o.proof, MAX_PROOF),
    ...(priority ? { priority } : {}),
    errors,
  }
}

export type ItemOutcome = { ok: true; subject: Subject; reply: string } | { ok: false; reply: string }

/**
 * Adds or closes an item. Closing matches the exact text first, then a single
 * open item whose text contains the given words.
 */
export function applyItem(subjects: Subjects, input: ItemInput, defaults: Defaults, now: number): ItemOutcome {
  if (input.errors.length) return { ok: false, reply: 'Not changed: ' + input.errors.join('; ') + '.' }
  const existing = findSubject(subjects, input.subject)
  const s: Subject = existing ? clone(existing) : newSubject(input.subject, 'critic', undefined, undefined, undefined, defaults, now)
  const cycle = usedCycles(s)
  let found = s.items.find(i => keyOf(i.text) === keyOf(input.text))
  if (!found && input.done === true) {
    const hits = s.items.filter(i => !i.done && keyOf(i.text).includes(keyOf(input.text)))
    if (hits.length > 1) {
      return { ok: false, reply: `Not changed: "${input.text}" matches ${hits.length} open items of ${s.name}; use the full text:\n` + hits.map(i => '- ' + i.text).join('\n') }
    }
    found = hits[0]
  }
  let what: string
  if (!found) {
    if (s.items.length >= MAX_ITEMS) return { ok: false, reply: `Not changed: ${s.name} already has ${MAX_ITEMS} items.` }
    const item: Item = { text: input.text, priority: input.priority ?? 'p1', done: input.done === true, addedCycle: cycle }
    if (item.done) {
      item.closedCycle = cycle
      if (input.proof) item.proof = input.proof
    }
    s.items.push(item)
    what = item.done ? `Added and closed: ${item.text} ${proofMark(item)}` : `Added [${item.priority}] ${item.text}`
  } else if (input.done === true) {
    if (input.priority) found.priority = input.priority
    if (input.proof) found.proof = input.proof
    if (!found.done) found.closedCycle = cycle
    found.done = true
    what = `Closed: ${found.text} ${proofMark(found)}`
  } else if (input.done === false) {
    if (input.priority) found.priority = input.priority
    found.done = false
    delete found.closedCycle
    delete found.proof
    what = `Reopened [${found.priority}] ${found.text}`
  } else {
    if (input.priority) found.priority = input.priority
    if (input.proof) found.proof = input.proof
    what = `Already tracked: ${itemLine(found)}`
  }
  s.updatedAt = now
  const open = openItems(s).length
  return { ok: true, subject: s, reply: `${what}\n${s.name}: ${open} open item${open === 1 ? '' : 's'}.` }
}

// ---------- text ----------

/** What the subject is waiting on, e.g. `cycle 3/4 · target 9.0 · 1 cycle left`; used by the pane. */
export function progressText(s: Subject): string {
  const left = cyclesLeft(s)
  const unit = unitOf(s)
  const goal = s.doneBy === 'score' ? `target ${fmt(targetOf(s))}` : 'until no open p0/p1'
  return `${unit} ${usedCycles(s)}/${s.maxCycles} · ${goal} · ${left} ${unit}${left === 1 ? '' : 's'} left`
}

/** The block of text the tools and /reviews text reply with for one subject. */
export function subjectText(s: Subject): string {
  const used = usedCycles(s)
  const last = lastCycle(s)
  const delta = deltaText(s)
  const unit = unitOf(s)
  const lines: string[] = []
  const state = s.status === 'ship' ? ' · shipped' : s.status === 'stop' ? ' · stopped' : ''
  lines.push(`review ${s.name} · ${unit} ${used}/${s.maxCycles} · ${s.kind}${state}`)
  lines.push(`${historyLabel(s)}: ${historyText(s)}${delta ? ` (${delta})` : ''}`)
  const left = cyclesLeft(s)
  const leftText = `${left} ${unit}${left === 1 ? '' : 's'} left`
  const shipHint = s.status === 'ship' ? '' : ': ready to ship (call review_cycle with verdict "ship", or the user marks it shipped in /reviews)'
  if (s.doneBy === 'score') {
    const target = targetOf(s)
    if (!last) {
      lines.push(`target ${fmt(target)} · ${s.maxCycles} ${unit}s left`)
    } else if (reached(s)) {
      lines.push(`target ${fmt(target)} reached` + shipHint)
    } else {
      lines.push(`target ${fmt(target)} not reached (${last.score === undefined ? '?' : fmt(round1(target - last.score))} short) · ${leftText}`)
    }
  } else if (!last) {
    lines.push(`done when no p0/p1 item is open · ${s.maxCycles} ${unit}s left`)
  } else if (reached(s)) {
    lines.push('done: no open p0/p1 items' + shipHint)
  } else {
    const n = blocking(s)
    const why = n > 0 ? `${n} open p0/p1 item${n === 1 ? '' : 's'}` : `last verdict was ${last.verdict ?? 'not ship'}`
    lines.push(`not done: ${why} · ${leftText}`)
  }
  if (notConverging(s) && s.status === 'active') {
    lines.push(`not converging: surface to the user. Do not run another ${wordOf(s)}; report the ${s.doneBy === 'score' ? 'scores and ' : ''}open items and ask how to proceed.`)
  }
  const open = openItems(s)
  if (open.length) {
    lines.push(`open items (${open.length}):`)
    for (const i of open) lines.push(`- ${itemLine(i)}`)
  } else {
    lines.push('open items: none')
  }
  const done = doneItems(s)
  if (done.length) lines.push(`closed: ${done.length} (${done.filter(i => !i.proof).length} without proof)`)
  if (last?.notes) lines.push(`notes: ${last.notes}`)
  return lines.join('\n')
}

export function statusText(subjects: Subjects, name?: string): string {
  const list = Object.values(subjects)
  if (name) {
    const s = findSubject(subjects, name)
    if (s) return subjectText(s)
    return `No review for "${name}".` + (list.length ? ' Known: ' + list.map(x => x.name).join(', ') + '.' : '')
  }
  if (!list.length) return 'No reviews yet. After a pass (critic pass, review round, validation pass, test run), call review_cycle with the subject, its kind and the result.'
  return list
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(subjectText)
    .join('\n\n')
}

/** The reply to a recorded cycle: the subject's state plus any warnings. */
export function cycleReply(s: Subject, warnings: string[]): string {
  const extra = warnings.length ? '\n' + warnings.map(w => 'note: ' + w).join('\n') : ''
  return subjectText(s) + extra
}

/** Toast for a loop that just reached its goal. */
export const reachedToast = (s: Subject): string =>
  s.doneBy === 'score' ? `review ${s.name}: target ${fmt(targetOf(s))} reached` : `review ${s.name}: no open p0/p1 items, ready to ship`

/** Toast for a loop at its limit without reaching its goal. */
export function notConvergingToast(s: Subject): string {
  const base = `review ${s.name}: not converging after ${usedCycles(s)}/${s.maxCycles} ${unitOf(s)}s`
  const last = lastCycle(s)
  if (s.doneBy === 'score') return `${base} (${last?.score === undefined ? '?' : fmt(last.score)} < ${fmt(targetOf(s))})`
  return `${base} (${blocking(s)} open p0/p1)`
}

/** The subjects the band can show, most recently changed first. */
export const activeSubjects = (subjects: Subjects): Subject[] =>
  Object.values(subjects)
    .filter(s => s.status === 'active')
    .sort((a, b) => b.updatedAt - a.updatedAt)

/** A band chip: its words and the kit tone it is drawn in (lib/kit.ts TONES; never a color name). */
export type BandChip = { text: string; tone: 'ok' | 'danger' | 'info' | 'warn' | 'muted' }
/** The review band as kit.line('review', chips, right) draws it. */
export type Band = { chips: BandChip[]; right: string[] }

/**
 * `review  ● login_page cycle 3/4  ● 2 open   8.4 → 9.0` for score kinds,
 * `review  ● PR-42 round 2/3  ● 3 open   1 p0` for item kinds; null when nothing is active. The subject chip is ok
 * once reached, danger when not converging, info otherwise; the open chip is warn while a p0/p1 is open. The right
 * side adds `not converging` and `+N more` when other subjects are active.
 */
export function bandOf(subjects: Subjects): Band | null {
  const active = activeSubjects(subjects)
  const s = active[0]
  if (!s) return null
  const last = lastCycle(s)
  const stuck = notConverging(s)
  const right: string[] = []
  if (s.doneBy === 'score') right.push(`${last?.score === undefined ? '–' : fmt(last.score)} → ${fmt(targetOf(s))}`)
  else if (p0Count(s) > 0) right.push(`${p0Count(s)} p0`)
  if (stuck) right.push('not converging')
  if (active.length > 1) right.push(`+${active.length - 1} more`)
  return {
    chips: [
      { text: `${s.name} ${unitOf(s)} ${usedCycles(s)}/${s.maxCycles}`, tone: reached(s) ? 'ok' : stuck ? 'danger' : 'info' },
      { text: `${openItems(s).length} open`, tone: blocking(s) > 0 ? 'warn' : 'muted' },
    ],
    right,
  }
}

/** What the user has set as defaults, for the pane and /reviews target|max. */
export function defaultsLine(d: Defaults): string {
  return `defaults: target ${d.target !== undefined ? fmt(d.target) : 'by kind'} · max ${d.maxCycles !== undefined ? d.maxCycles : 'by kind'}`
}

export function contextText(defaults: Defaults): string {
  const maxes = KIND_NAMES.filter(k => k === 'critic' || k === 'review' || k === 'plan' || k === 'qa')
    .map(k => `${k} ${presetFor(k, defaults).maxCycles}`)
    .join(', ')
  return [
    'loopkeeper tracks bounded iterate-until-good loops of any kind: critic passes on assets (kind critic, score ≥ target), code/design/copy review rounds (kind review, until no open p0/p1), plan validation (kind plan), test-fix rounds (kind qa). ' +
      'Tools: review_cycle {subject, kind?, score?, cycle?, verdict? ship|iterate|stop, items?[{text, priority? p0|p1|p2, done?}], notes?}; review_item {subject, text, done?, proof?}; review_status {subject?}.',
    `Rule: after each pass call review_cycle. Do not run more than maxCycles passes (${maxes}). ` +
      `Score kinds aim for the target (default ${fmt(presetFor('critic', defaults).target ?? DEFAULT_TARGET)}); item kinds end when no p0/p1 item is open. If not reached by the limit, stop and surface to the user.`,
    'Close fixed items with review_item done:true and a proof (a path, command output or commit).',
  ].join('\n')
}

/** One jsonl line for the project log. */
export function jsonlLine(s: Subject, c: Cycle, session: string): string {
  return JSON.stringify({
    at: new Date(c.at || 0).toISOString(),
    session,
    subject: s.name,
    kind: s.kind,
    doneBy: s.doneBy,
    cycle: c.cycle,
    maxCycles: s.maxCycles,
    score: c.score ?? null,
    target: s.doneBy === 'score' ? targetOf(s) : null,
    delta: deltaText(s) || null,
    reached: holds(s, c),
    verdict: c.verdict ?? null,
    open: openItems(s).length,
    closed: doneItems(s).length,
    notes: c.notes ?? null,
  })
}

/** The command's words: verb, then the rest. */
export function parseArgs(args: unknown): { verb: string; rest: string[] } {
  const words = (typeof args === 'string' ? args : '').trim().split(/\s+/).filter(Boolean)
  return { verb: (words[0] ?? '').toLowerCase(), rest: words.slice(1) }
}

export function absOf(cwd: string, rel: string): string {
  const base = (cwd || '.').replace(/\/+$/, '')
  return base + '/' + rel
}
