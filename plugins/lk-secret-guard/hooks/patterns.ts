// lk-secret-guard: the pattern table and the pure matching helpers.
//
// Nothing in this file touches the mods API, so it can be imported by the
// hooks module and unit tested directly. Every function is total: bad input
// yields "no finding", never a throw.

export type Action = 'block' | 'warn'

export type Pattern = {
  /** Stable id, used by `disabledKinds` in the config file. */
  id: string
  /** Human label shown in messages. */
  kind: string
  action: Action
  regex: RegExp
  /** Capture group holding the value to mask and placeholder-check (0 = whole match). */
  group?: number
  /** When true, values that look like placeholders are ignored. */
  skipPlaceholders?: boolean
}

/** Built-in credential patterns. Order matters only for which finding is reported first. */
export const PATTERNS: readonly Pattern[] = [
  { id: 'private-key', kind: 'private key block', action: 'block', regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g },
  { id: 'aws-access-key', kind: 'AWS access key', action: 'block', regex: /AKIA[0-9A-Z]{16}/g },
  { id: 'anthropic-key', kind: 'Anthropic API key', action: 'block', regex: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-key', kind: 'OpenAI API key', action: 'block', regex: /sk-proj-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-key', kind: 'OpenAI API key', action: 'block', regex: /sk-[A-Za-z0-9]{20,}/g },
  { id: 'github-token', kind: 'GitHub token', action: 'block', regex: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { id: 'github-token', kind: 'GitHub token', action: 'block', regex: /github_pat_[A-Za-z0-9_]{22,}/g },
  { id: 'slack-token', kind: 'Slack token', action: 'block', regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'google-api-key', kind: 'Google API key', action: 'block', regex: /AIza[0-9A-Za-z_-]{35}/g },
  { id: 'stripe-key', kind: 'Stripe live key', action: 'block', regex: /(?:sk|rk)_live_[0-9a-zA-Z]{20,}/g },
  { id: 'twilio-key', kind: 'Twilio API key', action: 'warn', regex: /\bSK[0-9a-f]{32}\b/g },
  { id: 'jwt', kind: 'JWT', action: 'warn', regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    id: 'generic-secret',
    kind: 'hard-coded secret',
    action: 'warn',
    regex: /(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"]?([^\s'"]{8,})/gi,
    group: 2,
    skipPlaceholders: true,
  },
]

/** Every id `disabledKinds` accepts. */
export const KIND_IDS: readonly string[] = [...new Set(PATTERNS.map(p => p.id))]

const PLACEHOLDER_MARKERS = [
  'xxx', 'your_', '<', '${', 'example', 'changeme', 'placeholder', 'redacted',
  // References to the environment are not literal secrets.
  'process.env', 'os.environ', 'getenv',
]

/** True when a value is an obvious placeholder rather than a real secret. */
export function isPlaceholder(value: string): boolean {
  const v = value.toLowerCase()
  if (PLACEHOLDER_MARKERS.some(m => v.includes(m))) return true
  if (v.length > 0 && [...v].every(c => c === v[0])) return true
  return false
}

/**
 * Masks a value so the whole of it is never shown: the first 4 and last 3
 * characters with an ellipsis between. Shorter values reveal less, so that at
 * most about half of any value is ever visible.
 */
export function mask(value: string): string {
  const s = String(value ?? '')
  const n = s.length
  if (n >= 12) return s.slice(0, 4) + '…' + s.slice(-3)
  if (n >= 6) return s.slice(0, 2) + '…' + s.slice(-1)
  if (n >= 2) return s.slice(0, 1) + '…'
  return '…'
}

export type Config = {
  deny: string[]
  warn: string[]
  /** null when no config file set it: the word lists then apply everywhere. */
  publicPaths: string[] | null
  allowPaths: string[]
  disabledKinds: string[]
}

export const EMPTY_CONFIG: Config = { deny: [], warn: [], publicPaths: null, allowPaths: [], disabledKinds: [] }

function strings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim())
}

/** Parses one config file's text. Throws on malformed JSON (the caller records it). */
export function parseConfig(text: string): Partial<Config> {
  const raw = JSON.parse(text) as unknown
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('the top level must be a JSON object')
  }
  const o = raw as Record<string, unknown>
  const out: Partial<Config> = {}
  const deny = strings(o.deny)
  const warn = strings(o.warn)
  const publicPaths = strings(o.publicPaths)
  const allowPaths = strings(o.allowPaths)
  const disabledKinds = strings(o.disabledKinds)
  if (deny) out.deny = deny
  if (warn) out.warn = warn
  if (publicPaths) out.publicPaths = publicPaths
  if (allowPaths) out.allowPaths = allowPaths
  if (disabledKinds) out.disabledKinds = disabledKinds
  return out
}

/**
 * Merges config layers, global first, project last. A later file replaces
 * `publicPaths`, `allowPaths` and `disabledKinds` when it sets them. The
 * `deny` and `warn` word lists are unioned, so a project file can add words
 * but can never silently drop the private words in the global file.
 */
export function mergeConfig(layers: readonly Partial<Config>[]): Config {
  const out: Config = { ...EMPTY_CONFIG, deny: [], warn: [], allowPaths: [], disabledKinds: [] }
  for (const l of layers) {
    if (l.deny) out.deny = [...new Set([...out.deny, ...l.deny])]
    if (l.warn) out.warn = [...new Set([...out.warn, ...l.warn])]
    if (l.publicPaths) out.publicPaths = [...l.publicPaths]
    if (l.allowPaths) out.allowPaths = [...l.allowPaths]
    if (l.disabledKinds) out.disabledKinds = [...l.disabledKinds]
  }
  return out
}

// ---- Paths ------------------------------------------------------------------

export type PathCtx = { cwd: string; home: string }

const GLOB_CHARS = /[*?]/

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\*?]/g, '\\$&')
}

function globBody(glob: string): string {
  let re = ''
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (c === '*') {
      re += '[^/]*'
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += escapeRe(c)
    }
  }
  return re
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/')
}

/** The absolute and cwd-relative forms of a path. */
export function pathForms(path: string, ctx: PathCtx): { abs: string; rel: string } {
  let p = normalize(String(path ?? ''))
  const home = normalize(ctx.home || '')
  if (home && (p === '~' || p.startsWith('~/'))) p = home + p.slice(1)
  const cwd = normalize(ctx.cwd || '').replace(/\/$/, '')
  const abs = p.startsWith('/') ? p : cwd ? cwd + '/' + p.replace(/^\.\//, '') : p
  const rel = cwd && abs.startsWith(cwd + '/') ? abs.slice(cwd.length + 1) : abs
  return { abs, rel }
}

/**
 * Whether one config entry matches a path. Kept simple:
 * - an entry with `*` or `?` is a glob (`**` crosses folders). Without a `/` it
 *   is tested against the file name; otherwise against the path relative to
 *   the working directory, the absolute path, or any trailing part of it.
 * - any other entry matches, case-insensitively, wherever a path segment
 *   starts with it: `README` matches `docs/README.md`, `public/` matches
 *   `site/public/index.html`, `.env` matches `.env` and `.env.local`.
 * A leading `~/` stands for the home directory.
 */
export function pathMatches(entry: string, path: string, ctx: PathCtx): boolean {
  if (!entry || !path) return false
  const { abs, rel } = pathForms(path, ctx)
  let pat = normalize(entry)
  const home = normalize(ctx.home || '')
  if (home && (pat === '~' || pat.startsWith('~/'))) pat = home + pat.slice(1)
  if (GLOB_CHARS.test(pat)) {
    const body = globBody(pat)
    if (!pat.includes('/')) {
      const base = abs.slice(abs.lastIndexOf('/') + 1)
      return new RegExp('^' + body + '$').test(base)
    }
    if (pat.startsWith('/')) return new RegExp('^' + body + '$').test(abs)
    const anchored = new RegExp('^' + body + '$')
    const trailing = new RegExp('(?:^|/)' + body + '$')
    return anchored.test(rel) || trailing.test(abs)
  }
  const needle = pat.toLowerCase()
  if (needle.startsWith('/')) return abs.toLowerCase().startsWith(needle)
  const hay = '/' + abs.toLowerCase()
  return hay.includes('/' + needle) || ('/' + rel.toLowerCase()).includes('/' + needle)
}

export function anyPathMatches(entries: readonly string[], path: string, ctx: PathCtx): boolean {
  return entries.some(entry => pathMatches(entry, path, ctx))
}

/** Whether a shell command mentions a path that one of the entries matches. */
export function commandMentions(entries: readonly string[], command: string, ctx: PathCtx): boolean {
  const lower = command.toLowerCase()
  const tokens = command.split(/[\s'"`;|&<>()=]+/).filter(t => t !== '')
  return entries.some(entry => {
    if (!GLOB_CHARS.test(entry)) {
      const plain = entry.replace(/^~\//, '').toLowerCase()
      if (plain !== '' && lower.includes(plain)) return true
    }
    return tokens.some(t => pathMatches(entry, t, ctx))
  })
}

// ---- Scanning ---------------------------------------------------------------

export type Finding = {
  kind: string
  id: string
  action: Action
  masked: string
}

function wordRegex(phrase: string): RegExp | null {
  const words = phrase.trim().split(/\s+/).filter(w => w !== '').map(escapeRe)
  if (words.length === 0) return null
  return new RegExp('(?<![A-Za-z0-9_])' + words.join('\\s+') + '(?![A-Za-z0-9_])', 'i')
}

export type ScanOptions = {
  config: Config
  /** Whether the deny and warn word lists apply to this write. */
  wordsApply: boolean
}

/**
 * Every finding in `text`, blocks first. Overlapping matches of different
 * credential patterns are reported once (the earlier, stricter pattern wins).
 */
export function scan(text: string, opts: ScanOptions): Finding[] {
  if (typeof text !== 'string' || text === '') return []
  const disabled = new Set(opts.config.disabledKinds)
  const found: Finding[] = []
  const spans: [number, number][] = []
  for (const p of PATTERNS) {
    if (disabled.has(p.id)) continue
    const re = new RegExp(p.regex.source, p.regex.flags.includes('g') ? p.regex.flags : p.regex.flags + 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m[0] === '') {
        re.lastIndex += 1
        continue
      }
      const start = m.index
      const end = start + m[0].length
      if (spans.some(([s, e]) => start < e && end > s)) continue
      const value = p.group ? m[p.group] ?? m[0] : m[0]
      if (p.skipPlaceholders && isPlaceholder(value)) continue
      spans.push([start, end])
      found.push({ kind: p.kind, id: p.id, action: p.action, masked: mask(value) })
    }
  }
  if (opts.wordsApply) {
    for (const [list, action, kind] of [
      [opts.config.deny, 'block', 'deny-listed word'],
      [opts.config.warn, 'warn', 'warn-listed word'],
    ] as const) {
      for (const phrase of list) {
        const re = wordRegex(phrase)
        const m = re ? re.exec(text) : null
        if (m) found.push({ kind, id: action === 'block' ? 'deny-word' : 'warn-word', action, masked: mask(m[0]) })
      }
    }
  }
  return [...found.filter(f => f.action === 'block'), ...found.filter(f => f.action === 'warn')]
}

// ---- What a tool call writes ------------------------------------------------

export type Target = {
  /** The file written, or null for a Bash command. */
  path: string | null
  /** Where, as shown in messages: the file path or 'Bash command'. */
  where: string
  /** Only the new text being written. */
  texts: string[]
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/** The new text a guarded tool call would write, or null for any other call. */
export function targetOf(e: Record<string, unknown>): Target | null {
  const tool = str(e.tool)
  if (tool === 'Bash') {
    const command = str(e.command)
    return { path: null, where: 'Bash command', texts: command ? [command] : [] }
  }
  const path = str(e.file_path) ?? str(e.notebook_path)
  const where = path ?? '(unknown file)'
  if (tool === 'Write') {
    const content = str(e.content)
    return { path, where, texts: content ? [content] : [] }
  }
  if (tool === 'Edit') {
    const added = str(e.new_string)
    return { path, where, texts: added ? [added] : [] }
  }
  if (tool === 'MultiEdit') {
    const edits = Array.isArray(e.edits) ? e.edits : []
    const texts = edits
      .map(x => (x !== null && typeof x === 'object' ? str((x as Record<string, unknown>).new_string) : null))
      .filter((x): x is string => x !== null && x !== '')
    return { path, where, texts }
  }
  if (tool === 'NotebookEdit') {
    const source = str(e.new_source)
    return { path, where, texts: source ? [source] : [] }
  }
  return null
}

export type Verdict = { findings: Finding[]; exempt: boolean }

/** Applies allowPaths and publicPaths, then scans each new text. */
export function judge(target: Target, config: Config, ctx: PathCtx): Verdict {
  if (target.path !== null && anyPathMatches(config.allowPaths, target.path, ctx)) {
    return { findings: [], exempt: true }
  }
  const pub = config.publicPaths
  const wordsApply =
    pub === null
      ? true
      : target.path !== null
        ? anyPathMatches(pub, target.path, ctx)
        : target.texts.some(t => commandMentions(pub, t, ctx))
  const findings = target.texts.flatMap(t => scan(t, { config, wordsApply }))
  return {
    findings: [...findings.filter(f => f.action === 'block'), ...findings.filter(f => f.action === 'warn')],
    exempt: false,
  }
}

export function blockMessage(f: Finding, where: string): string {
  return (
    `secret-guard: ${f.kind} detected in ${where} (${f.masked}). Secrets must not be written here. ` +
    `If this is intentional, add the path to allowPaths in .claude/secret-guard.json or run /secret-guard off for this session.`
  )
}

export function askQuestion(f: Finding, where: string, more: number): string {
  const extra = more > 0 ? ` and ${more} more` : ''
  return `secret-guard: possible ${f.kind} in ${where} (${f.masked})${extra}. Allow?`
}

/**
 * The band's parts, drawn as kit.line('secret-guard', chips, right): `secret-guard  ● 2 blocked  ● 1 allowed`
 * while on (blocked in danger and allowed in ok once nonzero, else quiet), or `secret-guard  ● off for this
 * session      /secret-guard on to resume` when off, which is urgent: the right side in the default text color.
 */
export type BandParts = { chips: { text: string; tone: 'danger' | 'ok' | 'muted' }[]; right: string; urgent: boolean }

export function bandParts(isOn: boolean, blocked: number, allowed: number): BandParts {
  if (!isOn) return { chips: [{ text: 'off for this session', tone: 'danger' }], right: '/secret-guard on to resume', urgent: true }
  return {
    chips: [
      { text: `${blocked} blocked`, tone: blocked > 0 ? 'danger' : 'muted' },
      { text: `${allowed} allowed`, tone: allowed > 0 ? 'ok' : 'muted' },
    ],
    right: '',
    urgent: false,
  }
}
