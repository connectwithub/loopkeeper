// Pure helpers for the decision log: parsing /decide, building entries in each
// log format, parsing entries back out, and keeping paths inside the project.
// Nothing here touches the mods API, so tests can call it directly.

/** The three log formats. 'markdown' is a dated bullet list; 'brain-md' is accepted on input as its alias. */
export type Format = 'jsonl' | 'markdown' | 'journal-md'

/** Where decisions go, relative to the session's working directory. */
export type Target = {
  /** Path relative to the working directory, with forward slashes */
  file: string
  /** Absolute path handed to $.fs */
  abs: string
  format: Format
  /** Whether the file existed when the target was last checked */
  exists: boolean
  /** How the target was chosen: "override", "found", "adr-dir" or "default" */
  source: string
  /** A problem met while detecting, such as an unreadable override */
  note?: string
}

/** One decision as parsed back out of a log. */
export type Entry = {
  date: string
  decision: string
  why: string
  tags: string[]
  id?: string
  /** Who recorded it, when a jsonl log says so; filled in by decisions.ts for the pane, never by the parser */
  by?: 'user' | 'claude'
}

/** The badge a decision gets in the pane: major or minor (Claude or the watch), you (/decide). */
export type Kind = 'major' | 'minor' | 'you'

/** A decision the watch found in a turn, before it is recorded. */
export type Proposed = {
  text: string
  why: string
  tags: string[]
}

/** The watch settings: defaults (watch off), then the two config files, then the session store. */
export type WatchConfig = {
  /** Run the watch after each main turn */
  watch: boolean
  /** Model alias or id for the watch call, such as 'haiku' or 'sonnet' */
  watchModel: string
  /** At most this many watch calls in any hour, across sessions */
  watchMaxPerHour: number
  /** Skip turns whose prompt plus answer is shorter than this */
  watchMinChars: number
}

export const FORMATS: readonly Format[] = ['jsonl', 'markdown', 'journal-md']

/** Accepts the public names and the 'brain-md' alias; anything else is null. */
export function normalizeFormat(value: unknown): Format | null {
  if (value === 'brain-md') return 'markdown'
  return typeof value === 'string' && (FORMATS as readonly string[]).includes(value) ? (value as Format) : null
}

/** The project config file, relative to the working directory. The override lives in its "decisions" section. */
export const OVERRIDE_FILE = '.claude/loopkeeper.json'

/** Existing logs, checked in this order after the override. */
export const CANDIDATES: readonly { file: string; format: Format }[] = [
  { file: 'docs/decisions/decisions.jsonl', format: 'jsonl' },
  { file: '.claude/brain/decisions.md', format: 'markdown' },
  { file: 'brain/decisions.md', format: 'markdown' },
  { file: 'DECISION_JOURNAL.md', format: 'journal-md' },
]

/** Directory whose ADR files mean "start a jsonl log beside them". */
export const ADR_DIR = 'docs/decisions'
export const ADR_DIR_LOG = 'docs/decisions/decisions.jsonl'

/** Where decisions go when nothing else is found. */
export const DEFAULT_LOG = '.claude/decisions.jsonl'

/** One record about to be appended. */
export type DecisionRecord = {
  id: string
  date: string
  decision: string
  why: string
  tags: string[]
  session: string
  by: 'user' | 'claude'
}

export type DecisionInput = { decision: string; why: string; tags: string[] }

const EM = '—'

/** Collapses whitespace, including newlines, to single spaces. */
export function oneLine(text: unknown): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
}

/** Strips '#', keeps letters, digits, _, - and /, dedupes, drops empties. */
export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  const out: string[] = []
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_\-/]/gu, '')
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out
}

/**
 * Parses the text after /decide: `<decision> -- <why> #tag #tag`.
 * `-- why` and the tags are optional; a tag is a `#word` that starts a token.
 */
export function parseDecideArgs(args: unknown): DecisionInput {
  const text = typeof args === 'string' ? args : ''
  const tags: string[] = []
  const stripped = text.replace(/(^|\s)#([\p{L}\p{N}_\-/]+)/gu, (_m, lead: string, tag: string) => {
    tags.push(tag)
    return lead
  })
  const cut = stripped.search(/(^|\s)--(\s|$)/)
  let decision = stripped
  let why = ''
  if (cut >= 0) {
    decision = stripped.slice(0, cut)
    why = stripped.slice(cut).replace(/^\s*--/, '')
  }
  return { decision: oneLine(decision), why: oneLine(why), tags: normalizeTags(tags) }
}

/** Reads a record_decision tool call's fields, guarding every one. */
export function toolInputOf(e: unknown): DecisionInput {
  const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
  const tags = Array.isArray(o.tags) ? o.tags : typeof o.tags === 'string' ? o.tags.split(/[\s,]+/) : []
  return { decision: oneLine(o.decision), why: oneLine(o.why), tags: normalizeTags(tags) }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Local date and minute id for a time in milliseconds. */
export function stampOf(ms: number): { date: string; id: string } {
  const d = new Date(Number.isFinite(ms) ? ms : 0)
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const id = `D-${date.replace(/-/g, '')}-${pad(d.getHours())}${pad(d.getMinutes())}`
  return { date, id }
}

/** Adds -2, -3, ... when the id already appears in the log. */
export function uniqueId(id: string, existing: string | null): string {
  if (!existing) return id
  const taken = (candidate: string) => existing.includes(`"id":"${candidate}"`)
  if (!taken(id)) return id
  let n = 2
  while (taken(`${id}-${n}`)) n += 1
  return `${id}-${n}`
}

const noStop = (s: string) => s.replace(/[.\s]+$/, '')
const tagText = (tags: string[]) => tags.map(t => '#' + t).join(' ')

/** A markdown decision log: `- YYYY-MM-DD — text` bullets. */
const BRAIN_BULLET = /^- \d{4}-\d{2}-\d{2} [—-] /m

/** The text one record adds to a file, without the separator before it. */
export function entryText(format: Format, rec: DecisionRecord, existing: string | null): string {
  if (format === 'jsonl') {
    return JSON.stringify({
      id: rec.id,
      date: rec.date,
      decision: rec.decision,
      why: rec.why,
      tags: rec.tags,
      session: rec.session,
      by: rec.by,
    }) + '\n'
  }
  const decision = noStop(rec.decision)
  const why = noStop(rec.why)
  const tags = rec.tags.length ? ' ' + tagText(rec.tags) : ''
  if (format === 'markdown') {
    const isBrain = !existing || !existing.trim() || BRAIN_BULLET.test(existing) || !/^- /m.test(existing)
    if (isBrain) {
      return `- ${rec.date} ${EM} ${decision}.${why ? ` Why: ${why}.` : ''}${tags}\n`
    }
    return `- **${rec.date}** ${EM} ${decision}.${why ? ` _Why:_ ${why}.` : ''}${tags}\n`
  }
  const lines = [`## ${rec.date} ${EM} ${titleOf(decision)}`, `- **What:** ${decision}.`]
  if (why) lines.push(`- **Why:** ${why}.`)
  if (rec.tags.length) lines.push(`- **Tags:** ${tagText(rec.tags)}`)
  return lines.join('\n') + '\n'
}

/** A short heading from a decision: its first sentence, cut at 80 characters on a word. */
export function titleOf(decision: string): string {
  const first = decision.split(/(?<=[.;:])\s/)[0] ?? decision
  const text = noStop(first)
  if (text.length <= 80) return text
  const cut = text.slice(0, 80)
  const space = cut.lastIndexOf(' ')
  return (space > 40 ? cut.slice(0, space) : cut) + '…'
}

/** The header a new file starts with, by format. */
function headerOf(format: Format): string {
  if (format === 'markdown') return '# Decisions\n\n'
  if (format === 'journal-md') return '# Decision Journal\n\n'
  return ''
}

/**
 * The whole new content: the existing text untouched, a separator so the
 * entry starts on its own line (a blank line before a journal section), then
 * the entry. A missing file gets the format's header first.
 */
export function appendEntry(existing: string | null, format: Format, rec: DecisionRecord): string {
  const entry = entryText(format, rec, existing)
  if (existing === null || existing === '') return headerOf(format) + entry
  let sep = existing.endsWith('\n') ? '' : '\n'
  if (format === 'journal-md' && !(existing + sep).endsWith('\n\n')) sep += '\n'
  return existing + sep + entry
}

const splitTags = (text: string) => normalizeTags(text.match(/#[\p{L}\p{N}_\-/]+/gu) ?? [])

/** Parses every entry in file order. Unparseable lines are skipped. */
export function parseEntries(content: unknown, format: Format): Entry[] {
  if (typeof content !== 'string' || !content) return []
  if (format === 'jsonl') return parseJsonl(content)
  if (format === 'journal-md') return parseJournal(content)
  return parseBrain(content)
}

function parseJsonl(content: string): Entry[] {
  const out: Entry[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line) as Record<string, unknown>
      if (!o || typeof o !== 'object') continue
      const decision = oneLine(o.title) || oneLine(o.decision)
      if (!decision) continue
      out.push({
        id: typeof o.id === 'string' ? o.id : undefined,
        date: oneLine(o.date),
        decision,
        why: oneLine(o.why) || oneLine(o.context),
        tags: normalizeTags(o.tags),
      })
    } catch {
      // not JSON: skip the line
    }
  }
  return out
}

function parseBrain(content: string): Entry[] {
  const out: Entry[] = []
  const bullet = /^- (?:\*\*)?(\d{4}-\d{2}-\d{2})(?:\*\*)? [—-]+ (.*)$/
  for (const line of content.split('\n')) {
    const m = bullet.exec(line)
    if (!m) continue
    let body = m[2] ?? ''
    const tags: string[] = []
    const project = /^\[([^\]]+)\]\s*/.exec(body)
    if (project) {
      tags.push(project[1] ?? '')
      body = body.slice(project[0].length)
    }
    const trailing = /((?:\s+#[\p{L}\p{N}_\-/]+)+)\s*$/u.exec(body)
    if (trailing) {
      tags.push(...splitTags(trailing[1] ?? ''))
      body = body.slice(0, trailing.index)
    }
    const whyAt = body.search(/\s(?:_Why:_|Why:)\s/)
    const decision = whyAt >= 0 ? body.slice(0, whyAt) : body
    const why = whyAt >= 0 ? body.slice(whyAt).replace(/^\s*(?:_Why:_|Why:)\s*/, '') : ''
    out.push({ date: m[1] ?? '', decision: oneLine(decision), why: oneLine(why), tags: normalizeTags(tags) })
  }
  return out
}

function parseJournal(content: string): Entry[] {
  const out: Entry[] = []
  const heading = /^## (\d{4}-\d{2}-\d{2})\s*[—-]+\s*(.*)$/
  let current: Entry | null = null
  for (const line of content.split('\n')) {
    const m = heading.exec(line)
    if (m) {
      current = { date: m[1] ?? '', decision: oneLine(m[2]), why: '', tags: [] }
      out.push(current)
      continue
    }
    if (line.startsWith('## ') || line.startsWith('# ')) {
      current = null
      continue
    }
    if (!current) continue
    const why = /^- \*\*Why[^*]*\*\*\s*(.*)$/.exec(line)
    if (why && !current.why) current.why = oneLine(why[1])
    const tags = /^- \*\*Tags:\*\*\s*(.*)$/.exec(line)
    if (tags) current.tags = splitTags(tags[1] ?? '')
  }
  return out
}

/** The last n entries, newest first: by date, later in the file first on a tie. */
export function lastEntries(content: unknown, format: Format, n: number): Entry[] {
  const all = parseEntries(content, format).map((entry, index) => ({ entry, index }))
  all.sort((a, b) => (a.entry.date === b.entry.date ? b.index - a.index : a.entry.date < b.entry.date ? 1 : -1))
  return all.slice(0, Math.max(0, n)).map(x => x.entry)
}

/**
 * Normalizes a relative path and refuses one that leaves the project:
 * absolute paths, drive letters, and `..` above the root return null.
 */
export function resolveInside(rel: unknown): string | null {
  if (typeof rel !== 'string') return null
  const text = rel.trim()
  if (!text || text.includes('\0') || /^[\\/]/.test(text) || /^[A-Za-z]:/.test(text) || text.startsWith('~')) return null
  const parts: string[] = []
  for (const seg of text.split(/[\\/]+/)) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return parts.length ? parts.join('/') : null
}

/** Joins the working directory and a relative path already checked by resolveInside. */
export function absOf(cwd: string, rel: string): string {
  if (!cwd) return rel
  return cwd.replace(/[\\/]+$/, '') + '/' + rel
}

/** Where an error about the project config file points: the file and the section. */
const SECTION = `${OVERRIDE_FILE}, "decisions" section`

/**
 * The log override in the project config file's "decisions" section: `{ file, format }`.
 * Returns null when the file names no log (it may hold other sections or only watch settings),
 * the override when both are valid, and an error text otherwise. Only the project file is read for this.
 */
export function parseOverride(raw: unknown): { file: string; format: Format } | { error: string } | null {
  let o: unknown
  try {
    o = JSON.parse(typeof raw === 'string' ? raw : '')
  } catch {
    return { error: `${OVERRIDE_FILE} is not valid JSON` }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: `${OVERRIDE_FILE} is not an object` }
  const section = (o as Record<string, unknown>).decisions
  if (section === undefined) return null
  if (!section || typeof section !== 'object' || Array.isArray(section)) return { error: `${SECTION}: expected an object` }
  const rec = section as Record<string, unknown>
  // Watch settings alone are not an override
  if (!('file' in rec) && !('format' in rec)) return null
  // An empty file means "find one", the default
  if (rec.file === '' && !('format' in rec)) return null
  const file = resolveInside(rec.file)
  if (!file) return { error: `${SECTION}: "file" must be a relative path inside the project` }
  const format = normalizeFormat(rec.format)
  if (!format) return { error: `${SECTION}: "format" must be one of ${FORMATS.join(', ')}` }
  return { file, format }
}

/** Whether a file name in docs/decisions looks like an ADR. */
export function isAdrFile(name: unknown): boolean {
  return typeof name === 'string' && /^(?:ADR[-_ ]?\d+|\d{3,4}[-_]).*\.md$/i.test(name)
}

/** The band's chip: kit.line('decisions', [{ text: bandText(n), tone: 'info' }], 'watch on' while the watch is on). */
export function bandText(n: number): string {
  return `${n} this session`
}

/** Usage for /decide and /decisions. */
export const DECIDE_USAGE = 'Usage: /decide <decision> -- <why> #tag #tag   (the "-- why" and the #tags are optional)'
export const DECISIONS_USAGE = 'Usage: /decisions [text | reload | band on|off]'

/** The plain-text listing /decisions text prints. */
export function textListing(target: Target | null, list: readonly Entry[]): string {
  if (!target) return 'loopkeeper has no decision target yet. Run /decisions reload.'
  const head = `Decisions · ${target.file} (${target.format})${target.exists ? '' : ' · created on first record'}`
  const lines = [head]
  if (target.note) lines.push(`Note: ${target.note}`)
  if (list.length === 0) {
    lines.push('No decisions yet. Record one with /decide <decision> -- <why> #tag')
    return lines.join('\n')
  }
  lines.push(`Last ${list.length}, newest first:`)
  for (const entry of list) {
    lines.push(`${entry.date || '----------'}  ${entry.decision}`)
    if (entry.why) lines.push(`            why: ${entry.why}`)
    if (entry.tags.length) lines.push(`            ${tagText(entry.tags)}`)
  }
  return lines.join('\n')
}
