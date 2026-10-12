// watch.ts: the decision watch of loopkeeper (off by default; see ADR 0006).
//
// After each main turn (no agentId) whose prompt plus answer is long enough and holds a decision
// cue word, one small $.model.complete call (haiku by default) reads the last user message and
// Claude's final text and answers in JSON: the decisions the turn settled, each major or minor,
// and the user's recurring preferences. Major decisions wait on the band with Record and Skip;
// minor ones are appended to the log at once (by: claude) and summed up in one toast. Anything
// already in the log, skipped before, recorded this turn or waiting is left out. Preferences are
// merged per project into $.store and shown in the pane.
//
// This module is pure: no `$`, no atoms. The mods engine follows `$` only into functions of the
// file that holds the hook and reads atoms only from consts of that file, so the engine side (the
// turn hooks, the model call, the store reads and writes, Record and Skip) is in decisions.ts.

import { parseConfigText } from './config.ts'
import { normalizeTags, oneLine } from './decisionFormats.ts'
import type { Entry, Kind, Proposed, WatchConfig } from './decisionFormats.ts'
import { TONES } from './kit.ts'
import type { Kit } from './kit.ts'
import { storeKey } from './names.ts'

/** The watch is off until a config file or /decide watch on turns it on (ADR 0006). */
export const WATCH_DEFAULTS: WatchConfig = { watch: false, watchModel: 'haiku', watchMaxPerHour: 20, watchMinChars: 200 }

export const MAX_PENDING = 5
export const MAX_SKIPPED = 100
export const MAX_PREFS = 40
export const MAX_KINDS = 200
/** How many log entries the watch call sees. */
export const LOG_CONTEXT = 20
export const WATCH_MAX_TOKENS = 600
/** The watch call gives up after this long, so the turn's end is never held for more. */
export const WATCH_TIMEOUT_MS = 8000
const HOUR_MS = 3_600_000
const PROMPT_CLIP = 4000
const ANSWER_CLIP = 6000

export const KEY_BAND = storeKey('decisions', 'band')
export const KEY_WATCH = storeKey('decisions', 'watch')
export const KEY_MODEL = storeKey('decisions', 'watch-model')
export const KEY_CALLS = storeKey('decisions', 'watch-calls')
export const skippedKey = (cwd: string) => storeKey('decisions', 'skipped:' + cwd)
export const prefsKey = (cwd: string) => storeKey('decisions', 'prefs:' + cwd)
export const kindsKey = (cwd: string) => storeKey('decisions', 'kinds:' + cwd)

export type Weighted = Proposed & { weight: 'major' | 'minor' }
export type WatchReply = { decisions: Weighted[]; preferences: string[] }

// ---------------------------------------------------------------- pure helpers

/** The words that make a turn worth a call: a decision is rarely settled without one. */
export const CUE_RE =
  /\b(?:decid\w*|decision\w*|us(?:e|es|ed|ing)|instead|go(?:es|ing)?\s+with|went\s+with|prefer\w*|switch\w*|choos\w*|chose\w*|keep\w*|kept|drop\w*|adopt\w*|convention\w*|agree\w*|settl\w*)\b/i

export function hasCue(text: string): boolean {
  return CUE_RE.test(text)
}

/** Lowercase, punctuation out, single spaces. */
export function normText(text: unknown): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function wordsOf(text: string): Set<string> {
  return new Set(normText(text).split(' ').filter(Boolean))
}

/** Decisions seen so far; `has` is true when 80 % or more of a text's words are in one of them. */
export function makePool(texts: readonly string[]): { has(text: string): boolean; add(text: string): void } {
  const sets = texts.map(wordsOf).filter(s => s.size > 0)
  return {
    has(text) {
      const a = wordsOf(text)
      if (a.size === 0) return true
      return sets.some(b => {
        let shared = 0
        for (const w of a) if (b.has(w)) shared += 1
        return shared / a.size >= 0.8
      })
    },
    add(text) {
      const s = wordsOf(text)
      if (s.size > 0) sets.push(s)
    },
  }
}

/** The first `max` characters, with an ellipsis when cut. */
export function cut(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…'
}

/** Keeps the start and the end of a long text. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  return text.slice(0, half) + '\n[…]\n' + text.slice(text.length - half)
}

/** The first balanced {...} in a text that parses as JSON, or null. */
export function firstJsonObject(text: string): unknown {
  let from = 0
  for (let tries = 0; tries < 20; tries++) {
    const start = text.indexOf('{', from)
    if (start < 0) return null
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let i = start; i < text.length; i++) {
      const c = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (c === '\\') escaped = true
        else if (c === '"') inString = false
        continue
      }
      if (c === '"') inString = true
      else if (c === '{') depth += 1
      else if (c === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end < 0) return null
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1))
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {
      // not JSON: try the next brace
    }
    from = start + 1
  }
  return null
}

/** The watch reply as decisions and preferences, or null when it holds no JSON object. */
export function parseWatchReply(text: unknown): WatchReply | null {
  if (typeof text !== 'string') return null
  const o = firstJsonObject(text) as Record<string, unknown> | null
  if (!o) return null
  const decisions: Weighted[] = []
  for (const raw of Array.isArray(o.decisions) ? o.decisions.slice(0, 8) : []) {
    if (!raw || typeof raw !== 'object') continue
    const d = raw as Record<string, unknown>
    const body = cut(oneLine(d.text) || oneLine(d.decision), 300)
    if (!body) continue
    const tags = normalizeTags(d.tags)
      .map(t => t.toLowerCase())
      .filter((t, i, all) => all.indexOf(t) === i)
      .slice(0, 5)
    decisions.push({ text: body, why: cut(oneLine(d.why), 300), tags, weight: d.weight === 'minor' ? 'minor' : 'major' })
  }
  const preferences: string[] = []
  for (const raw of Array.isArray(o.preferences) ? o.preferences.slice(0, 10) : []) {
    const pref = cut(oneLine(raw), 200)
    if (pref) preferences.push(pref)
  }
  return { decisions, preferences }
}

export const WATCH_SYSTEM = [
  'You read one turn of a coding session between a user and Claude and pick out the decisions it settled, for the project\'s decision log.',
  'Reply with strict JSON only, no prose and no code fence, in exactly this shape:',
  '{"decisions":[{"text":"...","why":"...","weight":"major","tags":["..."]}],"preferences":["..."]}',
  'Rules:',
  '- A decision is a choice the user and Claude settled in this turn. Leave out options still under discussion, plan steps and routine edits.',
  '- "text" is one plain sentence such as "Use SQLite for the cache". "why" is the reason given, short, or "" when none was given. "tags" are one to three short lowercase words.',
  '- "weight" is "major" for an architecture, library or framework choice, a data model, an API contract, security, a convention adopted for the project, or anything costly to reverse.',
  '- "weight" is "minor" for naming, a local default, a small trade-off or formatting.',
  '- "preferences" are recurring ways this user likes things done, each a short rule such as "Prefer small commits". Only what the user showed or said, nothing about this one task.',
  '- Leave out anything already recorded, already learned, or equivalent to it. The lists come first in the message.',
  '- When nothing was settled, reply {"decisions":[],"preferences":[]}.',
].join('\n')

const listOf = (items: readonly string[]) => (items.length ? items.map(s => '- ' + cut(oneLine(s), 200)).join('\n') : '(none)')

/** The user message of the watch call. */
export function buildWatchPrompt(p: { log: readonly string[]; turn: readonly string[]; prefs: readonly string[]; prompt: string; answer: string }): string {
  return [
    'Already in the decision log (newest last):',
    listOf(p.log),
    '',
    'Recorded during this turn:',
    listOf(p.turn),
    '',
    'Learned preferences:',
    listOf(p.prefs),
    '',
    "The user's last message:",
    '<<<',
    clip(p.prompt, PROMPT_CLIP),
    '>>>',
    '',
    "Claude's final answer:",
    '<<<',
    clip(p.answer, ANSWER_CLIP),
    '>>>',
  ].join('\n')
}

/** Adds preferences at the end, dropping earlier ones with the same normalised text; keeps the newest `max`. */
export function mergePrefs(old: readonly string[], add: readonly string[], max: number = MAX_PREFS): string[] {
  let out = old.filter(s => typeof s === 'string' && normText(s))
  for (const pref of add) {
    const n = normText(pref)
    if (!n) continue
    out = out.filter(s => normText(s) !== n)
    out.push(pref)
  }
  return out.slice(-max)
}

export function isModelId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\-[\]/@]{0,99}$/.test(id.trim())
}

const isWhole = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

/**
 * The "decisions" section of each config file's text, user first. A file that is missing, broken or
 * has no such section gives no layer. Feed the result to mergeWatchConfig with the store's values last.
 */
export function decisionsLayers(userText: string | null | undefined, projectText: string | null | undefined): unknown[] {
  const out: unknown[] = []
  for (const [text, label] of [
    [userText, 'user config'],
    [projectText, 'project config'],
  ] as const) {
    const section = parseConfigText(text, label).value.decisions
    if (section && typeof section === 'object' && !Array.isArray(section)) out.push(section)
  }
  return out
}

/** Defaults, then each layer in order; a bad value in a layer is ignored. */
export function mergeWatchConfig(layers: readonly unknown[]): WatchConfig {
  const c: WatchConfig = { ...WATCH_DEFAULTS }
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue
    const o = layer as Record<string, unknown>
    if (typeof o.watch === 'boolean') c.watch = o.watch
    if (isModelId(o.watchModel)) c.watchModel = o.watchModel.trim()
    if (isWhole(o.watchMaxPerHour, 0, 1000)) c.watchMaxPerHour = o.watchMaxPerHour
    if (isWhole(o.watchMinChars, 0, 100_000)) c.watchMinChars = o.watchMinChars
  }
  return c
}

/** Who recorded each jsonl entry, by normalised decision text. */
export function byOfJsonl(content: unknown): Map<string, 'user' | 'claude'> {
  const out = new Map<string, 'user' | 'claude'>()
  if (typeof content !== 'string') return out
  for (const line of content.split('\n')) {
    if (!line.includes('"by"')) continue
    try {
      const o = JSON.parse(line) as Record<string, unknown>
      const by = o?.by
      const text = normText(o?.title || o?.decision)
      if (text && (by === 'user' || by === 'claude')) out.set(text, by)
    } catch {
      // not JSON
    }
  }
  return out
}

/** The pane's badge for an entry: what the watch noted, else who the log says recorded it. */
export function kindOf(entry: Entry, kinds: ReadonlyMap<string, Kind>): Kind | undefined {
  const known = kinds.get(normText(entry.decision))
  if (known) return known
  if (entry.by === 'user') return 'you'
  if (entry.by === 'claude') return 'major'
  return undefined
}

/** The one toast for the minor decisions a turn recorded. */
export function minorToast(texts: readonly string[]): string {
  const n = texts.length
  return `loopkeeper: recorded ${n} minor decision${n === 1 ? '' : 's'}: ${texts.map(t => cut(t, 60)).join('; ')}`
}

/** Timestamps within the hour before `now`. */
export function recentCalls(saved: unknown, now: number): number[] {
  if (!Array.isArray(saved)) return []
  return saved.filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > now - HOUR_MS && t <= now)
}

export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])

// ---------------------------------------------------------------- the band card

export const WATCH_USAGE =
  'Usage: /decide prefs [clear]   /decide watch [on | off | status]   /decide watch model <haiku | sonnet | model id>'

export type Proposal = { minors: Proposed[]; majors: Proposed[]; preferences: string[] }

/** The band card for the oldest waiting major decision, or null when none waits. */
export function majorCard(
  k: Kit,
  waiting: readonly Proposed[],
  onRecord: () => unknown,
  onSkip: () => unknown,
): unknown {
  const m = waiting[0]
  if (!m) return null
  return k.card({
    title: 'loopkeeper · major decision',
    right: waiting.length > 1 ? `1 of ${waiting.length}` : undefined,
    tone: 'accent',
    children: [
      k.text(m.text, { bold: true, wrap: 'wrap' }),
      m.why ? k.text('why: ' + m.why, { color: TONES.muted.fg, wrap: 'wrap' }) : null,
      k.buttons([
        { key: 'decisions-record', label: 'Record', hotkey: 'r', plain: true, onPress: onRecord },
        { key: 'decisions-skip', label: 'Skip', hotkey: 's', plain: true, onPress: onSkip },
      ]),
    ],
  })
}
