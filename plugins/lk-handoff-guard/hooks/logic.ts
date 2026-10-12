// handoff-guard: pure logic, no $ calls, so every rule here is unit tested on its own.
//
// Config merge and thresholds, the band, fact extraction from the transcript, the brief
// template and its validation, the unverified-figures pass, and the text transforms that
// write the handoff files (.claude/brain/{project,log,decisions,questions}.md) in the
// handoff folder format the README describes.

import type { Config, Mode, Reading } from '../types'

export const MODES: readonly Mode[] = ['ask', 'auto', 'off']

export const DEFAULTS: Config = {
  warnAt: 0.7,
  handoffAt: 0.85,
  reaskAt: 0.92,
  denyAt: 0.95,
  mode: 'ask',
  model: 'haiku',
  maxBriefTokens: 2000,
  band: true,
}

export const HELP = [
  '/handoff                 write the handoff into .claude/brain/ now (no clear)',
  '/handoff clear           write the handoff, then /clear and resume from it',
  '/handoff status          context fill, last handoff time and path',
  '/handoff show            pane: last brief and readings',
  '/handoff mode ask|auto|off',
  '/handoff at <0-1>        handoff level (default 0.85)',
  '/handoff warn <0-1>      warning level (default 0.70)',
  '/handoff band on|off',
].join('\n')

// ---------------------------------------------------------------- config

function frac(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1 ? v : undefined
}

/** Keeps only the known, well-typed fields of one config layer. */
export function sanitize(raw: unknown): Partial<Config> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const out: Partial<Config> = {}
  for (const k of ['warnAt', 'handoffAt', 'reaskAt', 'denyAt'] as const) {
    const f = frac(r[k])
    if (f !== undefined) out[k] = f
  }
  if (typeof r.mode === 'string' && (MODES as readonly string[]).includes(r.mode)) out.mode = r.mode as Mode
  if (typeof r.model === 'string' && r.model.trim()) out.model = r.model.trim()
  if (typeof r.maxBriefTokens === 'number' && Number.isFinite(r.maxBriefTokens)) {
    out.maxBriefTokens = Math.min(8000, Math.max(300, Math.round(r.maxBriefTokens)))
  }
  if (typeof r.band === 'boolean') out.band = r.band
  return out
}

/** Defaults, then each layer in order (user file, project file, $.store), later wins. */
export function mergeConfig(...layers: unknown[]): Config {
  let cfg: Config = { ...DEFAULTS }
  for (const l of layers) cfg = { ...cfg, ...sanitize(l) }
  // Keep the levels in order: warn <= handoff <= reask <= deny.
  if (cfg.warnAt > cfg.handoffAt) cfg.warnAt = cfg.handoffAt
  if (cfg.reaskAt < cfg.handoffAt) cfg.reaskAt = Math.min(1, cfg.handoffAt + 0.05)
  if (cfg.denyAt < cfg.reaskAt) cfg.denyAt = Math.min(1, Math.max(cfg.reaskAt, cfg.handoffAt + 0.1))
  return cfg
}

/** "0.8", "80" or "80%" as 0.8; null when it is not in (0, 1]. */
export function parseFraction(arg: string): number | null {
  const s = arg.trim()
  if (!s) return null
  const pct = s.endsWith('%')
  const n = Number(pct ? s.slice(0, -1) : s)
  if (!Number.isFinite(n)) return null
  const f = pct || n > 1 ? n / 100 : n
  return f > 0 && f <= 1 ? Math.round(f * 1000) / 1000 : null
}

// ---------------------------------------------------------------- readings and levels

export type Level = 'ok' | 'warn' | 'due'

/** A usage() context block as a reading; null when it carries no usable figure. */
export function readingOf(context: unknown, at: number, where: string, extraTokens = 0): Reading | null {
  if (!context || typeof context !== 'object') return null
  const c = context as { tokens?: unknown; window?: unknown; percent?: unknown }
  const tokens = typeof c.tokens === 'number' && Number.isFinite(c.tokens) ? c.tokens : null
  const window = typeof c.window === 'number' && Number.isFinite(c.window) && c.window > 0 ? c.window : null
  let f: number | null = null
  if (tokens !== null && window !== null) f = (tokens + Math.max(0, extraTokens)) / window
  else if (typeof c.percent === 'number' && Number.isFinite(c.percent)) f = c.percent / 100
  if (f === null || !Number.isFinite(f) || f < 0) return null
  return { tokens: tokens === null ? null : tokens + Math.max(0, extraTokens), window, frac: Math.min(f, 1.5), at, where }
}

export function levelOf(f: number, cfg: Config): Level {
  if (f >= cfg.handoffAt) return 'due'
  if (f >= cfg.warnAt) return 'warn'
  return 'ok'
}

export const pct = (f: number) => Math.round(f * 100)

/** The kit tone of a level (the kit's Tone names): ok, accent (the Claude orange, not the warning
 *  key) at warnAt, danger at handoffAt. */
export const LEVEL_TONE: Record<Level, 'ok' | 'accent' | 'danger'> = { ok: 'ok', warn: 'accent', due: 'danger' }

/** The band's parts: the chip (`ctx 41%`), its kit tone (muted before the first reading), the right
 *  side (what to do, then the last or resumed handoff) and whether it is urgent: at or past
 *  handoffAt the right side is drawn in the default text color, else quiet. */
export type BandParts = { chip: string; tone: 'ok' | 'accent' | 'danger' | 'muted'; right: string[]; urgent: boolean }

/** The one-line band, drawn as kit.line('handoff', [chip], right): `handoff  ● ctx 41%   last 14:02`. */
export function bandParts(
  r: Reading | null,
  cfg: Config,
  o: { lastWhen?: string; busy?: boolean; sessionOff?: boolean; resumed?: string } = {},
): BandParts {
  if (!r) return { chip: 'ctx --', tone: 'muted', right: o.lastWhen ? [`last ${shortWhen(o.lastWhen)}`] : [], urgent: false }
  const level = levelOf(r.frac, cfg)
  const bits: string[] = []
  if (o.busy) bits.push('writing handoff…')
  else if (level === 'due') {
    if (cfg.mode === 'off' || o.sessionOff) bits.push('handoff due · guard off')
    else bits.push(cfg.mode === 'auto' ? 'auto handoff' : 'handoff due: /handoff clear')
  } else if (level === 'warn') bits.push('/handoff at a stopping point')
  if (o.resumed) bits.push(`resumed from handoff ${shortWhen(o.resumed)}`)
  else if (o.lastWhen) bits.push(`last ${shortWhen(o.lastWhen)}`)
  return { chip: `ctx ${pct(r.frac)}%`, tone: LEVEL_TONE[level], right: bits, urgent: level === 'due' }
}

/** "2026-10-09 14:02" as "14:02" when it is today's, else as written. */
export function shortWhen(when: string, today?: string): string {
  if (today && when.startsWith(today + ' ')) return when.slice(today.length + 1)
  return when
}

// ---------------------------------------------------------------- time

const two = (n: number) => String(n).padStart(2, '0')

export function dateOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

export function whenOf(ms: number): string {
  const d = new Date(ms)
  return `${dateOf(ms)} ${two(d.getHours())}:${two(d.getMinutes())}`
}

// ---------------------------------------------------------------- facts from the transcript

/** The slice of a $.session.messages() row this mod reads. */
export type Msg = {
  role: string
  text: string
  toolUses?: readonly { tool: string; input?: Record<string, unknown>; result?: unknown; text?: string; isError?: boolean }[]
}

// Harness signals that arrive as user messages but are never the user's words (from auto-handoff).
const META_PREFIXES = [
  'Stop hook feedback',
  '[handoff-guard]',
  'Resume from the handoff in .claude/brain/',
  '[Image',
  '<system-reminder>',
  '<command-name>',
  '<local-command',
  '<task-notification>',
  '[Request interrupted',
]

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export function isMeta(text: string): boolean {
  const t = text.trim()
  return META_PREFIXES.some(p => t.startsWith(p))
}

export type Transcript = {
  lastPrompt: string
  lastAnswer: string
  openQuestions: string[]
  edited: string[]
}

/** The last real prompt, the last answer, unanswered AskUserQuestion calls and edited files. */
export function extractFromMessages(messages: readonly Msg[]): Transcript {
  let lastPrompt = ''
  let lastAnswer = ''
  const open: string[] = []
  const answered = new Set<string>()
  const edited = new Set<string>()
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue
    const text = typeof m.text === 'string' ? m.text.trim() : ''
    if (m.role === 'user' && text && !isMeta(text)) lastPrompt = text
    if (m.role === 'assistant' && text) lastAnswer = text
    for (const t of Array.isArray(m.toolUses) ? m.toolUses : []) {
      if (!t || typeof t.tool !== 'string') continue
      const input = t.input && typeof t.input === 'object' ? t.input : {}
      const path = input.file_path ?? input.notebook_path
      if (EDIT_TOOLS.has(t.tool) && typeof path === 'string' && !t.isError) edited.add(path)
      if (t.tool === 'AskUserQuestion') {
        const qs = Array.isArray(input.questions) ? input.questions : []
        const unanswered = t.isError === true || (t.result === undefined && t.text === undefined)
        for (const q of qs) {
          const s = q && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string' ? (q as { question: string }).question.trim() : ''
          if (!s) continue
          if (unanswered) open.push(s)
          else answered.add(s)
        }
      }
    }
  }
  const openQuestions = [...new Set(open.filter(q => !answered.has(q)))].slice(-5)
  return { lastPrompt, lastAnswer, openQuestions, edited: [...edited] }
}

export type Facts = {
  cwd: string
  when: string
  branch: string
  commits: string[]
  editedTurn: string[]
  editedSession: string[]
  lastPrompt: string
  lastAnswer: string
  openQuestions: string[]
  stage: string
  ctxPercent: number | null
  ctxTokens: number | null
  ctxWindow: number | null
}

export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

/** Strips credential-shaped strings before anything is written or sent. */
export function redact(text: string): string {
  return text
    .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)\s*[=:]\s*\S+/g, '$1=[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, m => (/^[0-9a-f]{40}$/.test(m) ? m : '[redacted]'))
}

function rel(path: string, cwd: string): string {
  const base = cwd.replace(/\/+$/, '') + '/'
  return cwd && path.startsWith(base) ? path.slice(base.length) : path
}

/** The facts block: everything here came from code, not from a model. */
export function factsBlock(f: Facts): string {
  const list = (xs: string[], empty = 'None.') => (xs.length ? xs.map(x => `- ${x}`).join('\n') : empty)
  const ctx =
    f.ctxPercent === null
      ? 'unknown'
      : `${f.ctxPercent}%` + (f.ctxTokens !== null && f.ctxWindow !== null ? ` (${f.ctxTokens} of ${f.ctxWindow} tokens)` : '')
  const lines = [
    '## Facts (from code)',
    `- Written: ${f.when}`,
    `- Working directory: ${f.cwd || 'unknown'}`,
    `- Git branch: ${f.branch || 'not a git repository'}`,
    `- Context at handoff: ${ctx}`,
  ]
  if (f.stage) lines.push(`- Pipeline stage: ${f.stage}`)
  lines.push('', '### Last commits', list(f.commits))
  lines.push('', '### Files edited this turn', list(f.editedTurn.map(p => rel(p, f.cwd))))
  const earlier = f.editedSession.filter(p => !f.editedTurn.includes(p))
  lines.push('', '### Files edited earlier this session', list(earlier.slice(-20).map(p => rel(p, f.cwd))))
  lines.push('', '### Unanswered questions to the user', list(f.openQuestions))
  lines.push('', '### Last user request', f.lastPrompt ? clip(redact(f.lastPrompt), 600) : 'None found.')
  lines.push('', '### Last answer (excerpt)', f.lastAnswer ? clip(redact(f.lastAnswer), 600) : 'None found.')
  return lines.join('\n')
}

// ---------------------------------------------------------------- the brief

export const HEADINGS = ['Status', 'Next steps', 'Dead ends', 'Open questions', 'Decisions', 'Log'] as const
export type Heading = (typeof HEADINGS)[number]

export function briefTemplate(maxWords: number): string {
  return `Write the judgment sections of a session handoff for the next session in this project. Use exactly these six headings, in this order, and nothing before the first:

## Status
Two to four sentences: where the work stands, what works, what is broken.

## Next steps
- One to three concrete next steps, most important first.

## Dead ends
- Approaches tried and dropped this session, with the reason. Write "None." if there were none.

## Open questions
- Questions only the human can answer. Write "None." if there are none.

## Decisions
- One line per decision someone outside this repo should know, as a pointer (a file, an ADR or a commit), not the reasoning. Write "None." if there are none.

## Log
One line, past tense, under 250 characters: what changed. Next: the next step. Blocked: only when something is.

Rules: use only what the conversation and the Facts block support. Copy any number exactly from the Facts block and write no other figures. No secrets, tokens, credentials, phone numbers or personal names. Plain sentences, no em dashes. Under ${maxWords} words in total.`
}

export function wordsFor(maxBriefTokens: number): number {
  return Math.max(120, Math.min(600, Math.round(maxBriefTokens * 0.3)))
}

/** The fork's one user message: it already sees the conversation, so only facts and the template. */
export function forkPrompt(facts: string, maxWords: number): string {
  return `[handoff-guard] A side request from a mod, not from the user, and not part of the task: the context window is nearly full, so the session is writing its handoff before it clears. Do not call tools and do not continue the task. Reply with the handoff only.

${facts}

---

${briefTemplate(maxWords)}`
}

/** A compact transcript for the $.model.complete fallback, which has no conversation of its own. */
export function renderTranscript(messages: readonly Msg[], maxChars = 60_000): string {
  const rows = (Array.isArray(messages) ? messages : []).slice(-80).map(m => {
    const role = m.role === 'user' && isMeta(String(m.text ?? '')) ? 'system signal (not the user)' : m.role
    const text = clip(redact(String(m.text ?? '')), 1500)
    const tools = (Array.isArray(m.toolUses) ? m.toolUses : []).map(
      t => `  [tool ${t.tool}${t.isError ? ' ERROR' : ''}] ${clip(redact(JSON.stringify(t.input ?? {})), 200)}`,
    )
    return [`### ${role}`, text, ...tools].filter(Boolean).join('\n')
  })
  const joined = rows.join('\n\n')
  return joined.length > maxChars ? joined.slice(-maxChars) : joined
}

export function completePrompt(facts: string, transcript: string, maxWords: number): string {
  // Data first, instructions last (as auto-handoff does).
  return `${facts}\n\n## Conversation (most recent part)\n${transcript || '(empty)'}\n\n---\n\n${briefTemplate(maxWords)}`
}

export type Parsed = Record<Heading, string>

/** The reply's six sections, or null when any heading is missing (then the facts stand alone). */
export function parseBrief(text: unknown): Parsed | null {
  if (typeof text !== 'string' || !text.trim()) return null
  const t = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/, '')
  const re = /^#{1,4}\s*\**\s*(Status|Next steps|Dead ends|Open questions|Decisions|Log)\s*\**\s*:?\s*$/gim
  const marks: { h: Heading; start: number; end: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(t)) !== null) {
    const h = HEADINGS.find(x => x.toLowerCase() === m![1].toLowerCase())
    if (h) marks.push({ h, start: m.index, end: m.index + m[0].length })
  }
  const out: Partial<Parsed> = {}
  marks.forEach((mk, i) => {
    if (out[mk.h] !== undefined) return
    out[mk.h] = t.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : t.length).trim()
  })
  return HEADINGS.every(h => out[h] !== undefined) ? (out as Parsed) : null
}

const NONE = /^(none|n\/a|nothing|no\b.*(?:dead ends?|questions?|decisions?))\.?$/i

/** Bullet lines of a section ("None." gives []); prose without bullets is one item. */
export function itemsOf(section: string): string[] {
  const lines = section.split('\n').map(l => l.trim()).filter(Boolean)
  const bullets = lines.filter(l => /^([-*•]|\d+[.)])\s+/.test(l)).map(l => l.replace(/^([-*•]|\d+[.)])\s+/, '').trim())
  const items = bullets.length ? bullets : lines.length ? [lines.join(' ')] : []
  return items.map(i => i.replace(/\s+/g, ' ').trim()).filter(i => i && !NONE.test(i))
}

// ---------------------------------------------------------------- unverified figures

// A figure: 93, 93.5, 1,200, 72%, 93k, 3x. Not part of a word, path, version-free id or date.
const FIGURE = /(?<![\w.\/#:@-])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(%|k\b|K\b|x\b)?(?![\w\/]|\.\d|-\d)/g

function valueOf(num: string, suffix: string | undefined): number {
  const n = Number(num.replace(/,/g, ''))
  return suffix === 'k' || suffix === 'K' ? n * 1000 : n
}

/** Masks spans whose numbers are not claims: inline code, ISO dates, times, versions. */
function maskSpans(text: string): string {
  return text
    .replace(/`[^`\n]*`/g, s => ' '.repeat(s.length))
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, s => ' '.repeat(s.length))
    .replace(/\b\d{1,2}:\d{2}\b/g, s => ' '.repeat(s.length))
    .replace(/\bv?\d+\.\d+\.\d+\b/g, s => ' '.repeat(s.length))
}

/**
 * Marks every figure in the model's text that the facts do not hold, by appending
 * " (unverified)". Single-digit counts (step 1, 3 files) are left alone. Borrowed from
 * auto-handoff's markUnverifiedFigures, widened from token figures to any number.
 */
export function markUnverifiedFigures(text: string, facts: string): { text: string; flagged: string[] } {
  const allowed: number[] = []
  for (const m of maskSpans(facts).matchAll(FIGURE)) allowed.push(valueOf(m[1], m[2]))
  for (const m of facts.matchAll(/\d+(?:\.\d+)?/g)) allowed.push(Number(m[0]))
  const masked = maskSpans(text)
  const flagged: string[] = []
  const cuts: { at: number; fig: string }[] = []
  for (const m of masked.matchAll(FIGURE)) {
    const v = valueOf(m[1], m[2])
    if (!m[2] && Number.isInteger(v) && v < 10) continue
    const k = m[2] === 'k' || m[2] === 'K'
    if (allowed.some(a => (k ? Math.abs(a - v) < 1000 : a === v))) continue
    flagged.push(m[0])
    cuts.push({ at: (m.index ?? 0) + m[0].length, fig: m[0] })
  }
  let out = text
  for (const c of cuts.reverse()) out = out.slice(0, c.at) + ' (unverified)' + out.slice(c.at)
  return { text: out, flagged }
}

// ---------------------------------------------------------------- sections for the brain files

export type Sections = {
  /** Body of `## Status today`. */
  status: string
  /** Body of `## Next` (bullets). */
  next: string
  /** Body of `## Dead ends`, or null to leave the section as it is. */
  deadEnds: string | null
  /** One log line, without the date prefix. */
  log: string
  decisions: string[]
  questions: string[]
}

const bullets = (xs: string[]) => xs.map(x => `- ${x}`).join('\n')

function ctxPhrase(f: Facts): string {
  return f.ctxPercent === null ? '' : `, context ${f.ctxPercent}%`
}

function atCtx(f: Facts): string {
  return f.ctxPercent === null ? '' : ` at ${f.ctxPercent}% context`
}

/** What goes into the files: the model's sections when they parsed, else facts only. */
export function buildSections(parsed: Parsed | null, f: Facts): Sections {
  const stamp = `(Written by handoff-guard ${f.when}${ctxPhrase(f)}${f.branch ? `, branch ${f.branch}` : ''}${parsed ? '' : ', facts only'}.)`
  const qs = [...f.openQuestions]
  if (parsed) {
    for (const q of itemsOf(parsed['Open questions'])) if (!qs.includes(q)) qs.push(q)
    const next = itemsOf(parsed['Next steps']).slice(0, 5)
    const dead = itemsOf(parsed['Dead ends'])
    const log = itemsOf(parsed.Log)[0] ?? ''
    return {
      status: clip(parsed.Status.replace(/^[-*]\s+/gm, ''), 1200) + '\n\n' + stamp,
      next: next.length ? bullets(next) : '- Re-read the last request in the log and continue.',
      deadEnds: dead.length ? bullets(dead.slice(0, 6)) : null,
      log: oneLine(log || `Handed off by handoff-guard${atCtx(f)}.`),
      decisions: itemsOf(parsed.Decisions).slice(0, 5).map(x => oneLine(x)),
      questions: qs.slice(0, 5).map(x => oneLine(x)),
    }
  }
  const parts: string[] = []
  if (f.commits.length) parts.push(`Last commits: ${f.commits.slice(0, 3).join('; ')}.`)
  const edited = (f.editedTurn.length ? f.editedTurn : f.editedSession).slice(-6).map(p => rel(p, f.cwd))
  if (edited.length) parts.push(`Edited: ${edited.join(', ')}.`)
  if (f.stage) parts.push(`Pipeline stage: ${f.stage}.`)
  if (f.lastPrompt) parts.push(`Last request: "${clip(redact(f.lastPrompt), 300)}"`)
  const next = ['Re-read the last request below and check git status before continuing.']
  if (f.lastPrompt) next.push(`Continue: ${clip(redact(f.lastPrompt), 160)}`)
  return {
    status: (parts.join(' ') || 'No facts could be collected.') + '\n\n' + stamp,
    next: bullets(next),
    deadEnds: null,
    log: oneLine(
      `(handoff-guard, facts only) Handed off${atCtx(f)}${edited.length ? ` after editing ${edited.slice(0, 3).join(', ')}` : ''}. Next: re-read the last request.`,
    ),
    decisions: [],
    questions: qs.slice(0, 5).map(x => oneLine(x)),
  }
}

/** The whole brief as shown in the pane: sections, then the facts. */
export function briefMarkdown(s: Sections, facts: string): string {
  return [
    '## Status today',
    s.status,
    '',
    '## Next',
    s.next,
    ...(s.deadEnds ? ['', '## Dead ends', s.deadEnds] : []),
    '',
    `Log: ${s.log}`,
    ...(s.decisions.length ? ['', 'Decisions:', bullets(s.decisions)] : []),
    ...(s.questions.length ? ['', 'Open questions:', bullets(s.questions)] : []),
    '',
    facts,
  ].join('\n')
}

// ---------------------------------------------------------------- handoff folder file shapes

/** One data line's text: no newlines, no leading bullet, under 300 characters (the handoff folder's line rule). */
export function oneLine(text: string, max = 290): string {
  return clip(redact(text.replace(/^\s*[-*]\s+/, '')), max)
}

export function datedLine(date: string, text: string): string {
  return `- ${date} — ${oneLine(text)}`
}

export function slugOf(cwd: string): string {
  const name = cwd.replace(/\/+$/, '').split('/').pop() ?? ''
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
}

/** The handoff folder's project.md template, filled in, for a project that has no .claude/brain/ yet. */
export function projectTemplate(slug: string, date: string): string {
  return `---
type: project
name: "${slug}"
group: ""
status: active
role: ""
public: false
live_url:
summary: "${slug}: handoff written by handoff-guard; replace this line with what the project is."
tags: [project, active]
created: ${date}
updated: ${date}
---

## What it is

Not filled in yet: handoff-guard created this file. Describe the project here.

## Why

Not filled in yet.

## Status today

## Next

## Dead ends
`
}

export const FILE_HEADERS: Record<'log.md' | 'decisions.md' | 'questions.md', string> = {
  'log.md': '# Log\n\nOne line per session, newest last: `- YYYY-MM-DD — what changed, what is next, what is blocked`.\n',
  'decisions.md':
    '# Decisions\n\nOne line per decision worth knowing outside this repo: `- YYYY-MM-DD — decision and why`. Append only; to reverse one, add a new dated line.\n',
  'questions.md':
    '# Questions\n\nOne line per question only the human can answer: `- YYYY-MM-DD — question`. Remove a line once it is answered and record the answer as a decision.\n',
}

/**
 * Rewrites the body of `## <heading>` (up to the next `## ` or the end), keeping every
 * other section and the frontmatter. A missing section is added at the end.
 */
export function replaceSection(doc: string, heading: string, body: string): string {
  const lines = doc.replace(/\r\n/g, '\n').split('\n')
  const head = `## ${heading}`
  const start = lines.findIndex(l => l.trim() === head)
  const block = [head, '', ...body.trim().split('\n'), '']
  if (start === -1) {
    const trimmed = lines.join('\n').replace(/\s+$/, '')
    return trimmed + '\n\n' + block.join('\n')
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i
      break
    }
  }
  const out = [...lines.slice(0, start), ...block, ...lines.slice(end)]
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n')
}

/** Sets `key: value` in the frontmatter block, when there is one. */
export function setFrontmatter(doc: string, key: string, value: string): string {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(doc)
  if (!m) return doc
  const re = new RegExp(`^${key}:.*$`, 'm')
  const front = re.test(m[1]) ? m[1].replace(re, `${key}: ${value}`) : `${m[1]}\n${key}: ${value}`
  return `---\n${front}\n---\n` + doc.slice(m[0].length)
}

/** Appends a dated line unless the identical line is there (the handoff folder's append rule). */
export function appendLine(doc: string, line: string): { doc: string; added: boolean } {
  const body = doc.replace(/\s+$/, '')
  if (body.split('\n').includes(line)) return { doc: body + '\n', added: false }
  return { doc: body + '\n' + line + '\n', added: true }
}

/**
 * The session's log line: replaces the line this session wrote before when it is still
 * the last one (a second handoff in one session refines it), else appends.
 */
export function upsertLogLine(doc: string, line: string, previous: string | undefined): string {
  const lines = doc.replace(/\s+$/, '').split('\n')
  if (previous && lines.length && lines[lines.length - 1] === previous) {
    lines[lines.length - 1] = line
    return lines.join('\n') + '\n'
  }
  return appendLine(doc, line).doc
}
