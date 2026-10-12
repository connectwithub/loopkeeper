// gateRules.ts: the gates' pure rules. Nothing here takes `$`; hooks/gates.ts does the I/O.
// Ported from change-control's rules.ts; the scope-guard part below keeps its MIT notice.

import { defaultConfig } from './config.ts'
import { DISABLE_ENV, PLUGIN } from './names.ts'
import { at } from './shell.ts'
import type { LkGateConfig, LkProtectedRule, LkTouchEntry } from '../../types/index.d.ts'

export const MOD = PLUGIN
/** The /lk sub-command the gates own, as messages name it. */
export const GATES_CMD = `/lk gates`

/** The changeControl section's defaults, from the one place loopkeeper keeps them (lib/config.ts). */
export const DEFAULTS: LkGateConfig = defaultConfig().changeControl as LkGateConfig

/** Labels for the two config files, as the status lines and sources name them. */
export const USER_LABEL = '~/.claude/loopkeeper.json'
export const PROJECT_LABEL = '.claude/loopkeeper.json'

const BOOL_KEYS = ['requirePlan', 'mergeGate', 'requireGreenCi', 'blockAmend', 'blockAddAll', 'countSubagents', 'shipGate'] as const
type BoolKey = (typeof BOOL_KEYS)[number]
// whole-number keys: [key, lowest, highest]
const NUM_KEYS = [
  ['maxFilesPerTurn', 1, 1000],
  ['planSlack', 0, 1000],
  ['autoBudgetMax', 0, 1000],
] as const
type NumKey = (typeof NUM_KEYS)[number][0]

/** One config layer: only the fields it sets. `protected` entries with action "off" remove a glob. */
export type Layer = {
  maxFilesPerTurn?: number
  planSlack?: number
  autoBudgetMax?: number
  protected?: Array<{ glob: string; action: LkProtectedRule['action'] | 'off' }>
  requirePlan?: boolean
  mergeGate?: boolean
  requireGreenCi?: boolean
  blockAmend?: boolean
  blockAddAll?: boolean
  countSubagents?: boolean
  shipGate?: boolean
  planPaths?: string[]
}

/** Reads one layer from a parsed JSON object; bad fields are skipped and named. */
export function checkLayer(o: Record<string, unknown>): { layer: Layer; errors: string[] } {
  const layer: Layer = {}
  const errors: string[] = []
  for (const [k, lo, hi] of NUM_KEYS) {
    if (!(k in o)) continue
    const n = o[k]
    if (typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi) layer[k] = n
    else errors.push(`${k} must be a whole number from ${lo} to ${hi}`)
  }
  for (const k of BOOL_KEYS) {
    if (!(k in o)) continue
    const v = o[k]
    if (typeof v === 'boolean') layer[k] = v
    else errors.push(`${k} must be true or false`)
  }
  if ('protected' in o) {
    const list = o.protected
    if (!Array.isArray(list)) errors.push('protected must be a list of {glob, action}')
    else {
      const rules: NonNullable<Layer['protected']> = []
      list.forEach((r: unknown, i) => {
        const rec = (typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>
        const glob = rec.glob
        const action = rec.action
        if (typeof glob !== 'string' || glob.trim() === '') errors.push(`protected[${i}].glob must be a non-empty string`)
        else if (action !== 'ask' && action !== 'deny' && action !== 'off') errors.push(`protected[${i}].action must be "ask", "deny" or "off"`)
        else rules.push({ glob: glob.trim(), action })
      })
      layer.protected = rules
    }
  }
  if ('planPaths' in o) {
    const list = o.planPaths
    if (Array.isArray(list) && list.length <= 100 && list.every(g => typeof g === 'string' && g.trim() !== '')) {
      layer.planPaths = list.map(g => (g as string).trim())
    } else errors.push('planPaths must be a list of non-empty glob strings')
  }
  return { layer, errors }
}

/** Merges layers in order (later wins). Protected rules merge by glob. Returns the config and where each value came from. */
export function mergeLayers(layers: Array<{ label: string; layer: Layer }>): { config: LkGateConfig; sources: Record<string, string> } {
  const sources: Record<string, string> = {}
  const config: LkGateConfig = { ...DEFAULTS, protected: [], planPaths: [...DEFAULTS.planPaths] }
  for (const [k] of NUM_KEYS) sources[k] = 'default'
  sources.planPaths = 'default'
  for (const k of BOOL_KEYS) sources[k] = 'default'
  const globs = new Map<string, LkProtectedRule>()
  for (const r of DEFAULTS.protected) {
    globs.set(r.glob, { ...r })
    sources[`protected:${r.glob}`] = 'default'
  }
  for (const { label, layer } of layers) {
    for (const [k] of NUM_KEYS) {
      const v = layer[k as NumKey]
      if (v !== undefined) {
        config[k as NumKey] = v
        sources[k] = label
      }
    }
    for (const k of BOOL_KEYS) {
      const v = layer[k as BoolKey]
      if (v !== undefined) {
        config[k as BoolKey] = v
        sources[k] = label
      }
    }
    if (layer.planPaths !== undefined) {
      config.planPaths = [...layer.planPaths]
      sources.planPaths = label
    }
    for (const r of layer.protected ?? []) {
      if (r.action === 'off') {
        globs.delete(r.glob)
        delete sources[`protected:${r.glob}`]
      } else {
        globs.set(r.glob, { glob: r.glob, action: r.action })
        sources[`protected:${r.glob}`] = label
      }
    }
  }
  config.protected = [...globs.values()]
  return { config, sources }
}

/** The changeControl section of a whole loopkeeper.json, as one layer. Throws when the file is not a JSON object. */
export function sectionLayer(text: string): { layer: Layer; errors: string[] } {
  // an empty file is an empty layer, as lib/config.ts reads it
  if (String(text).trim() === '') return { layer: {}, errors: [] }
  const raw: unknown = JSON.parse(text)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('not a JSON object')
  const section = (raw as Record<string, unknown>).changeControl
  if (section === undefined) return { layer: {}, errors: [] }
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return { layer: {}, errors: ['changeControl must be an object'] }
  return checkLayer(section as Record<string, unknown>)
}

// ---- The file budget (ADR 0011) ---------------------------------------------------------

/**
 * The files-per-turn limit before this turn's extras: the `/lk gates max <n>` session override when set, otherwise
 * the largest of the base (maxFilesPerTurn), the approved plan budget (stageBudget, 0 for none) and the session raise.
 */
export function limitOf(s: { max?: number | null; base: number; budget: number; raise: number }): number {
  if (typeof s.max === 'number' && Number.isFinite(s.max) && s.max >= 1) return Math.floor(s.max)
  const whole = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)
  return Math.max(Math.max(1, whole(s.base)), whole(s.budget), whole(s.raise))
}

/** The figure "Raise to N for this session" offers: the limit in force plus planSlack. */
export function raiseTo(limit: number, slack: number): number {
  const s = Number.isFinite(slack) && slack > 0 ? Math.floor(slack) : 0
  return Math.max(1, Math.floor(limit)) + s
}

/** Where the limit in force comes from, for the band and the status lines. */
export function limitSource(s: { max?: number | null; base: number; budget: number; raise: number }): 'max' | 'budget' | 'raise' | 'base' {
  if (typeof s.max === 'number' && Number.isFinite(s.max) && s.max >= 1) return 'max'
  const limit = limitOf(s)
  if (s.budget > 0 && limit === Math.floor(s.budget) && s.budget > s.base) return 'budget'
  if (s.raise > 0 && limit === Math.floor(s.raise) && s.raise > s.base) return 'raise'
  return 'base'
}

/** The four answers of the limit question; the third carries the figure, computed once. */
export function filesOptions(raise: number): [string, string, string, string] {
  return ['Allow 1 more', 'Allow rest of turn', `Raise to ${raise} for this session`, 'Stop']
}

// ---- Paths and globs ----------------------------------------------------------

/** A path as a rule sees it: relative to cwd when inside it, else absolute; `.` and `..` resolved. */
export function normalizePath(path: string, cwd: string): string {
  const root = cwd.replace(/\/+$/, '')
  const abs = path.startsWith('/') ? path : `${root}/${path}`
  const parts: string[] = []
  for (const p of abs.split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  const full = `/${parts.join('/')}`
  if (root !== '' && full.startsWith(root + '/')) return full.slice(root.length + 1)
  return full
}

const globCache = new Map<string, RegExp>()

/**
 * A small glob: `**` spans folders, `*` and `?` stay inside one name. A glob with no `/`
 * matches a file's name at any depth (as .gitignore does), so `.env*` also guards `api/.env.local`.
 */
export function globToRegExp(glob: string): RegExp {
  const hit = globCache.get(glob)
  if (hit) return hit
  const g = glob.replace(/^\.\//, '').replace(/^\/+/, '')
  let out = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i] ?? ''
    if (c === '*' && g[i + 1] === '*') {
      const before = i === 0 || g[i - 1] === '/'
      const after = g[i + 2] === '/' || i + 2 === g.length
      if (before && g[i + 2] === '/') {
        out += '(?:.*/)?'
        i += 2
      } else if (before && after) {
        out += '.*'
        i += 1
      } else {
        out += '.*'
        i += 1
      }
    } else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  const anyDepth = !g.includes('/')
  const re = new RegExp(anyDepth ? `^(?:.*/)?${out}$` : `^${out}$`)
  globCache.set(glob, re)
  return re
}

/** Whether `path` (relative to cwd, or absolute when outside it) matches `glob`. */
export function matchGlob(glob: string, path: string): boolean {
  const p = path.replace(/^\/+/, '')
  return globToRegExp(glob).test(p)
}

// Claude Code's per-user temp root, where the session scratchpad lives (macOS resolves /tmp to /private/tmp)
const PLAN_TEMP = /^\/(?:private\/)?tmp\/claude-[^/]+\/./

/**
 * Plan material: a plan page or notes written while planning. It is exempt from the plan gate and
 * the files-per-turn count (protected paths still apply). An absolute path under Claude Code's
 * temp root (/tmp/claude-<uid>/...) always is; a path inside the project is when it matches one of `globs` (planPaths).
 */
export function isPlanMaterial(path: string, cwd: string, globs: readonly string[] = DEFAULTS.planPaths): boolean {
  if (typeof path !== 'string' || path === '') return false
  const p = normalizePath(path, cwd)
  if (p.startsWith('/')) return PLAN_TEMP.test(p)
  return globs.some(g => matchGlob(g, p))
}

/** /lk gates plan paths: the active plan-material list and where it came from. */
export function planPathsText(globs: readonly string[], source: string): string {
  return [
    `Plan material (exempt from the plan gate and the files-per-turn count; protected paths still apply) [${source}]:`,
    '  /tmp/claude-*/** (the session scratchpad; always)',
    ...globs.map(g => `  ${g}`),
    `Set "changeControl.planPaths" in .claude/loopkeeper.json (or ~/.claude/loopkeeper.json) to change the list.`,
  ].join('\n')
}

export function matchProtected(rules: readonly LkProtectedRule[], path: string): LkProtectedRule | undefined {
  // deny beats ask when two globs match
  const hits = rules.filter(r => matchGlob(r.glob, path))
  return hits.find(r => r.action === 'deny') ?? hits[0]
}

// ---- Files a Bash command writes ------------------------------------------------
// Adapted from yash-gadodia/claude-mods scope-guard (MIT, Copyright (c) 2026 Yash Gadodia):
// heredoc bodies and quoted strings blanked, then sed -i, a redirection, tee, cp/mv's
// destination and touch read for targets. `rm` and the cwd-relative result are ours.

const QUOTED = '\u0001'
const SCRATCH = ['/tmp/', '/private/tmp/', '/dev/']
const FLAG = (t: string) => t.startsWith('-') && t !== '-'
const WRITERS: Record<string, (args: string[]) => string[]> = {
  sed: args => {
    if (!args.some(a => a === '-i' || a.startsWith('-i') || a.startsWith('--in-place'))) return []
    // ours: the value after -e / -f / --expression is the script, not a file
    const rest = args.filter((a, i) => !FLAG(a) && !['-e', '-f', '--expression', '--file'].includes(args[i - 1] ?? ''))
    const scripted = args.some(a => a === '-e' || a === '--expression' || a.startsWith('--expression=')) || rest.includes(QUOTED)
    return (scripted ? rest : rest.slice(1)).filter(a => a !== QUOTED)
  },
  tee: args => args.filter(a => !FLAG(a)),
  touch: args => args.filter(a => !FLAG(a)),
  rm: args => args.filter(a => !FLAG(a)),
  cp: args => args.filter(a => !FLAG(a)).slice(-1),
  mv: args => args.filter(a => !FLAG(a)).slice(-1),
}

export function bashTargets(command: string, cwd: string): string[] {
  let text = command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2(?=\n|$)/g, m => m.slice(0, m.indexOf('\n')))
  text = text.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, QUOTED)
  const found: string[] = []
  for (const segment of text.split(/\n|&&|\|\||[;|]/)) {
    for (const m of segment.matchAll(/(?<![<>&\w])\d?&?>{1,2}\s*([^\s&|;<>]+)/g)) found.push(m[1] ?? '')
    const tokens = segment.replace(/\d?&?>{1,2}\s*[^\s&|;<>]+/g, ' ').trim().split(/\s+/)
    const idx = tokens.findIndex(t => !/^\w+=/.test(t) && t !== 'sudo')
    const cmd = tokens[idx]?.replace(/^.*\//, '')
    const writer = cmd ? WRITERS[cmd] : undefined
    if (writer) found.push(...writer(tokens.slice(idx + 1)))
  }
  const root = cwd.replace(/\/+$/, '')
  const paths = found
    .filter(t => t !== '' && t !== '-' && !t.includes(QUOTED) && !t.includes('$') && !t.includes('*'))
    .map(t => (t.startsWith('/') ? t : `${root}/${t.replace(/^\.\//, '')}`))
    .filter(p => !SCRATCH.some(s => p.startsWith(s)))
    .map(p => normalizePath(p, root))
  return [...new Set(paths)]
}

/** The file an editing tool names: file_path, or notebook_path for NotebookEdit. */
export function editPath(input: unknown): string | undefined {
  const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const v = typeof i.file_path === 'string' && i.file_path !== '' ? i.file_path : i.notebook_path
  return typeof v === 'string' && v !== '' ? v : undefined
}

// ---- Git and gh commands -------------------------------------------------------

export type GitAction =
  | { kind: 'gh-merge'; args: string[] }
  | { kind: 'git-merge'; args: string[] }
  | { kind: 'git-push'; args: string[] }
  | { kind: 'amend' }
  | { kind: 'add-all'; args: string[] }

const global = (re: RegExp) => new RegExp(re.source, 'g')
const GH_MERGE_G = global(at('gh', 'pr', 'merge'))
const GIT_MERGE_G = global(at('git', 'merge'))
const GIT_PUSH_G = global(at('git', 'push'))
const GIT_COMMIT_G = global(at('git', 'commit'))
const GIT_ADD_G = global(at('git', 'add'))

/** The words after a matched command, up to the end of that simple command. */
function argsAfter(shell: string, end: number): string[] {
  const rest = shell.slice(end)
  const stop = rest.search(/[;&|\n)`]/)
  const seg = stop < 0 ? rest : rest.slice(0, stop)
  return seg.trim().split(/\s+/).filter(t => t !== '')
}

/** What a command (already through bare()) does with git or gh that a rule cares about. */
export function gitActions(shell: string): GitAction[] {
  const out: GitAction[] = []
  for (const m of shell.matchAll(GH_MERGE_G)) out.push({ kind: 'gh-merge', args: argsAfter(shell, (m.index ?? 0) + m[0].length) })
  for (const m of shell.matchAll(GIT_MERGE_G)) {
    const args = argsAfter(shell, (m.index ?? 0) + m[0].length)
    if (args.some(a => a === '--abort' || a === '--continue' || a === '--quit')) continue
    out.push({ kind: 'git-merge', args })
  }
  for (const m of shell.matchAll(GIT_PUSH_G)) out.push({ kind: 'git-push', args: argsAfter(shell, (m.index ?? 0) + m[0].length) })
  for (const m of shell.matchAll(GIT_COMMIT_G)) {
    const args = argsAfter(shell, (m.index ?? 0) + m[0].length)
    if (args.includes('--amend')) out.push({ kind: 'amend' })
  }
  for (const m of shell.matchAll(GIT_ADD_G)) {
    const args = argsAfter(shell, (m.index ?? 0) + m[0].length)
    if (isAddAll(args)) out.push({ kind: 'add-all', args })
  }
  return out
}

// Commands that ship work: they are held by the ship gate until the stage says shipping is open.
const SHIP_COMMANDS: Array<{ name: string; re: RegExp }> = [
  { name: 'git commit', re: at('git', 'commit') },
  { name: 'git push', re: at('git', 'push') },
  { name: 'gh pr create', re: at('gh', 'pr', 'create') },
  { name: 'gh pr merge', re: at('gh', 'pr', 'merge') },
  { name: 'gh release create', re: at('gh', 'release', 'create') },
  { name: 'npm publish', re: at('npm', 'publish') },
  { name: 'pnpm publish', re: at('pnpm', 'publish') },
  { name: 'yarn publish', re: at('yarn', 'publish') },
  { name: 'yarn npm publish', re: at('yarn', 'npm', 'publish') },
  { name: 'cargo publish', re: at('cargo', 'publish') },
  { name: 'pip upload', re: at('pip', 'upload') },
  { name: 'twine upload', re: at('twine', 'upload') },
]

/** The shipping commands a command (already through bare()) runs, by name, in the order listed above. */
export function shipCommands(shell: string): string[] {
  return SHIP_COMMANDS.filter(c => c.re.test(shell)).map(c => c.name)
}

export function isAddAll(args: string[]): boolean {
  return args.some(a => a === '-A' || a === '--all' || a === '.' || a === ':/' || a === './' || /^-[a-zA-Z]*A[a-zA-Z]*$/.test(a))
}

const branchName = (ref: string) => ref.replace(/^\+/, '').replace(/^refs\/heads\//, '')

/** Whether `git merge <args>` merges into or from a default branch. */
export function mergeHitsDefault(args: string[], current: string, defaults: readonly string[]): boolean {
  if (current !== '' && defaults.includes(current)) return true
  return args
    .filter(a => !a.startsWith('-'))
    .map(a => a.replace(/^(?:origin|upstream)\//, ''))
    .some(a => defaults.includes(branchName(a)))
}

/** Whether `git push <args>` updates a default branch. `-o`/`--repo` style values are not parsed. */
export function pushHitsDefault(args: string[], current: string, defaults: readonly string[]): boolean {
  if (args.some(a => a === '--all' || a === '--mirror')) return true
  const words = args.filter(a => !a.startsWith('-'))
  const refspecs = words.slice(1) // the first word is the remote
  if (refspecs.length === 0) return current !== '' && defaults.includes(current)
  return refspecs.some(spec => {
    const dst = spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec
    if (dst === 'HEAD' || dst === '@') return current !== '' && defaults.includes(current)
    return defaults.includes(branchName(dst))
  })
}

export type CheckSummary = { pass: string[]; failing: string[]; pending: string[] }

/** `gh pr checks --json name,bucket` output, summarised. Unreadable output counts as one pending check. */
export function summarizeChecks(json: string): CheckSummary {
  try {
    const rows = JSON.parse(json) as unknown
    if (!Array.isArray(rows)) throw new Error('not a list')
    const out: CheckSummary = { pass: [], failing: [], pending: [] }
    for (const r of rows) {
      const rec = (typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>
      const name = typeof rec.name === 'string' ? rec.name : '(unnamed)'
      const bucket = typeof rec.bucket === 'string' ? rec.bucket : 'pending'
      if (bucket === 'pass' || bucket === 'skipping') out.pass.push(name)
      else if (bucket === 'fail' || bucket === 'cancel') out.failing.push(name)
      else out.pending.push(name)
    }
    return out
  } catch {
    return { pass: [], failing: [], pending: ['(could not read gh pr checks output)'] }
  }
}

/** Paths from `git status --porcelain` (v1). Renames give the new path. */
export function parsePorcelain(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (line.length < 4) continue
    let p = line.slice(3)
    const arrow = p.indexOf(' -> ')
    if (arrow >= 0) p = p.slice(arrow + 4)
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).replace(/\\(.)/g, '$1')
    out.push(p)
  }
  return out
}


// ---- What the person and Claude read --------------------------------------------

/** A tone of the kit (lib/kit.ts TONES maps it to a theme color); the band names tones, never colors. */
export type BandTone = 'ok' | 'warn' | 'danger' | 'muted' | 'info'
/** One `● text` chip of the band line. */
export type BandChip = { text: string; tone: BandTone }
/** The gates band, drawn with kit.line('gates', chips, right): at most four chips, a quiet right side. */
export type BandModel = { chips: BandChip[]; right?: string }

/** How the right side names where the limit in force comes from (nothing for the base). */
const SOURCE_WORD = { max: 'max', budget: 'budget', raise: 'raised' } as const

export function bandModel(s: {
  enabled: boolean
  count: number
  max: number
  unlimited: boolean
  requirePlan: boolean
  planOk: boolean
  mergeGate: boolean
  fired: boolean
  // the ship gate is on (undefined: no chip), and whether it holds shipping right now
  shipGate?: boolean
  shipHeld?: boolean
  // CLAUDE_MODS_DISABLE turned the gates off
  disabled?: boolean
  // where the limit in force comes from, and that limit before this turn's extras (the right side)
  source?: 'max' | 'budget' | 'raise' | 'base'
  limit?: number
}): BandModel {
  if (s.disabled === true) return { chips: [{ text: `off (${DISABLE_ENV})`, tone: 'muted' }] }
  if (!s.enabled) return { chips: [{ text: 'off for this session', tone: 'danger' }], right: `${GATES_CMD} on to resume` }
  const near = !s.unlimited && s.count >= Math.max(1, s.max - 1)
  const chips: BandChip[] = [{ text: `${s.count}/${s.unlimited ? '∞' : s.max} files`, tone: s.fired ? 'danger' : near ? 'warn' : 'ok' }]
  if (s.requirePlan) chips.push(s.planOk ? { text: 'plan ok', tone: 'ok' } : { text: 'plan needed', tone: 'warn' })
  if (s.mergeGate) chips.push({ text: 'merge gate', tone: 'info' })
  if (s.shipGate === true) chips.push(s.shipHeld === true ? { text: 'ship held', tone: 'warn' } : { text: 'ship open', tone: 'ok' })
  const from = s.source !== undefined && s.source !== 'base' && typeof s.limit === 'number' ? `${SOURCE_WORD[s.source]} ${s.limit}` : ''
  return from ? { chips, right: from } : { chips }
}

/** The `changeControl` rules block. `limit` is the files-per-turn limit in force (the base when left out). */
export function contextText(c: LkGateConfig, limit: number = c.maxFilesPerTurn): string {
  const lines = [`${MOD} is enforcing these rules in this session (a hook decides each edit, not a suggestion):`]
  lines.push(
    `- At most ${limit} distinct files may be changed per turn (Edit, Write, NotebookEdit and Bash writes all count); the base is ${c.maxFilesPerTurn}, and an approved plan's file budget (its planned files plus ${c.planSlack}) raises it. Plan larger changes in steps and say which files each step touches.${c.countSubagents ? ' Subagent edits count too.' : ''}`,
  )
  if (c.protected.length > 0) {
    const list = c.protected.map(r => `${r.glob} (${r.action})`).join(', ')
    lines.push(`- Protected paths: ${list}. "deny" means ask the user to make the change; "ask" means the user is asked first.`)
  }
  if (c.requirePlan) {
    lines.push('- No edits until a plan is approved: present the plan and get the user to approve it first.')
    lines.push(
      '- Plan material is exempt: files under the scratchpad (/tmp/claude-*), .claude/plans/, docs/plans/ and *.plan.md|html may be written during planning, and a plan page may be published with the Artifact tool for the user to read and answer questions in; that is not shipping.',
    )
  }
  if (c.mergeGate) {
    lines.push(
      `- Merges and pushes to the default branch are held${c.requireGreenCi ? ' until CI is green' : ''} and need the user's confirmation.`,
    )
  }
  if (c.shipGate) {
    lines.push(
      `- Shipping (git commit, git push, gh pr create/merge, gh release create, npm/pnpm/yarn/cargo publish, twine upload) is held until the user approves the ship stage (/lk approve) or runs ${GATES_CMD} ship ok (publishing an Artifact page is not shipping).`,
    )
  }
  const git: string[] = []
  if (c.blockAmend) git.push('no `git commit --amend` on shared branches')
  if (c.blockAddAll) git.push('no `git add -A` or `git add .` (stage files by name)')
  if (git.length > 0) lines.push(`- Git: ${git.join('; ')}.`)
  return lines.slice(0, 8).join('\n')
}

export function describeRules(c: LkGateConfig, sources: Record<string, string>): string[] {
  const src = (k: string) => sources[k] ?? 'default'
  const rows = [
    `maxFilesPerTurn: ${c.maxFilesPerTurn}  [${src('maxFilesPerTurn')}]`,
    `planSlack: ${c.planSlack}  [${src('planSlack')}]`,
    `autoBudgetMax: ${c.autoBudgetMax}  [${src('autoBudgetMax')}]`,
    ...c.protected.map(r => `protected ${r.glob}: ${r.action}  [${src(`protected:${r.glob}`)}]`),
    `planPaths: ${c.planPaths.join(', ')} + scratchpad  [${src('planPaths')}]`,
  ]
  for (const k of BOOL_KEYS) rows.push(`${k}: ${c[k] ? 'on' : 'off'}  [${src(k)}]`)
  return rows
}

/** The refusal a gating hook gives when it threw: fail closed, and name both ways out. */
export function failClosedReason(kind: string, message: string): string {
  const msg = message.replace(/\s+/g, ' ').slice(0, 160)
  return `${MOD}: the gates failed (${kind}${msg ? `: ${msg}` : ''}) and refused this call rather than let it through unchecked. Tell the user; they can run ${GATES_CMD} off, or set CLAUDE_MODS_DISABLE=${MOD}.`
}

export const USAGE = `usage: ${GATES_CMD} (pane) · text · files · max <n> · plan ok · plan required on|off · plan paths · ship ok · ship gate on|off · on · off · reload · band on|off`

// ---- The Files pane seam ------------------------------------------------------------------
// The gates see Bash writes (bashTargets) that no tool.call reports; they record them into the Files pane's
// filesTouched list the way change-control's noteEdit did: one entry per path, edited, created when the file
// was not there, newest last, at most TOUCHED_CAP entries. hooks/files.ts owns the pane and may swap this
// for its own model's noteEdit.

export const TOUCHED_CAP = 200

function baseOf(path: string): string {
  const p = path.replace(/\/+$/, '')
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1) || '/'
}

/** Bash-written paths into the touched list; `last` is the Files hero's "last:" text, '' when nothing was added. */
export function noteBashWrites(
  touched: readonly LkTouchEntry[],
  writes: Array<{ path: string; created: boolean }>,
  at: number,
): { touched: LkTouchEntry[]; last: string } {
  let list = [...touched]
  let last = ''
  for (const w of writes) {
    if (typeof w.path !== 'string' || w.path === '') continue
    const prev = list.find(t => t.id === w.path)
    const entry: LkTouchEntry = {
      id: w.path,
      kind: 'file',
      path: w.path,
      tool: 'Bash',
      read: prev?.read ?? false,
      edited: true,
      created: (prev?.created ?? false) || w.created,
      at,
    }
    list = [...list.filter(t => t.id !== w.path), entry].slice(-TOUCHED_CAP)
    last = `${w.created ? 'created' : 'edited'} ${baseOf(w.path)}`
  }
  return { touched: list, last }
}
