// lk-where-am-i: pure helpers. Git output parsing, usage-window thresholds, the
// prompt-cache clock, and the band's composition (the kit line truncates it).
// Nothing here touches $, so every function is unit tested directly.
//
// The stale-window filter and the "re-arm the toast once the window drops back
// under the line" rule follow an idea from another mod; see the README's Credits.

import type { CacheState, Level, Location, RateWindow, Worktree } from '../types'

export const DEFAULT_TTL_MIN = 60
export const WARN_PCT = 80
export const TOAST_PCT = 90
export const DANGER_PCT = 95
export const CACHE_LOW_MS = 5 * 60_000

const ORDER = ['five_hour', 'seven_day', 'spend_limit']
const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

// ---------------------------------------------------------------- paths

function trimSlashes(p: string): string {
  const t = p.replace(/[\\/]+$/, '')
  return t === '' && p !== '' ? '/' : t
}

export function basename(p: string): string {
  const t = trimSlashes(String(p ?? ''))
  if (t === '/') return '/'
  const parts = t.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

export function dirname(p: string): string {
  const t = trimSlashes(String(p ?? ''))
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'))
  if (i < 0) return '.'
  if (i === 0) return '/'
  return t.slice(0, i)
}

function isAbsolute(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p)
}

/** Joins a relative path onto base and folds `.` and `..`; an absolute path is only normalized. */
export function resolvePath(base: string, p: string): string {
  const raw = isAbsolute(p) ? p : String(base ?? '').replace(/[\\/]+$/, '') + '/' + p
  const drive = /^[A-Za-z]:/.test(raw) ? raw.slice(0, 2) : ''
  const out: string[] = []
  for (const seg of raw.slice(drive.length).split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return drive + '/' + out.join('/')
}

// ---------------------------------------------------------------- git output

export type RevParse = { gitDir: string; commonDir: string; toplevel: string }

/** `git rev-parse --absolute-git-dir --git-common-dir --show-toplevel`, relative paths resolved against cwd. */
export function parseRevParse(stdout: string, cwd: string): RevParse | null {
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
  if (lines.length < 3) return null
  return {
    gitDir: resolvePath(cwd, lines[0]),
    commonDir: resolvePath(cwd, lines[1]),
    toplevel: resolvePath(cwd, lines[2]),
  }
}

/** A linked worktree has its own git dir under the common dir's worktrees/. */
export function isLinkedWorktree(r: RevParse): boolean {
  return trimSlashes(r.gitDir) !== trimSlashes(r.commonDir)
}

/** The repository's name: the folder holding the common .git, so linked worktrees name the main repo. */
export function repoName(r: RevParse): string {
  const common = trimSlashes(r.commonDir)
  const b = basename(common)
  if (b === '.git') return basename(dirname(common)) || basename(r.toplevel)
  if (b.endsWith('.git') && b.length > 4) return b.slice(0, -4)
  return basename(r.toplevel) || b
}

/** `git symbolic-ref --short -q HEAD`: the branch, or null when HEAD is detached (exit 1). */
export function parseBranch(res: { exitCode: number; stdout: string } | null): string | null {
  if (!res || res.exitCode !== 0) return null
  const b = String(res.stdout ?? '').trim()
  return b || null
}

/** `git rev-parse --short HEAD`. */
export function parseSha(res: { exitCode: number; stdout: string } | null): string | null {
  if (!res || res.exitCode !== 0) return null
  const s = String(res.stdout ?? '').trim()
  return /^[0-9a-f]{4,64}$/i.test(s) ? s : null
}

/** `git status --porcelain`: one line per changed or untracked path. */
export function countLines(stdout: string): number {
  return String(stdout ?? '')
    .split(/\r?\n/)
    .filter(l => l.trim() !== '').length
}

/** `git rev-list --count A..B`. */
export function parseCount(stdout: string): number | null {
  const s = String(stdout ?? '').trim()
  return /^\d+$/.test(s) ? Number(s) : null
}

/** `git log -1 --format=%ct%x00%s`: commit time in seconds and the subject. */
export function parseLastCommit(stdout: string): { at: number; subject: string } | null {
  const s = String(stdout ?? '').replace(/\r?\n$/, '')
  const i = s.indexOf('\u0000')
  const ct = (i >= 0 ? s.slice(0, i) : s).trim()
  if (!/^\d+$/.test(ct)) return null
  return { at: Number(ct), subject: i >= 0 ? s.slice(i + 1).trim() : '' }
}

/** `git symbolic-ref --short refs/remotes/origin/HEAD` ("origin/main") to "main". */
export function parseDefaultBranch(res: { exitCode: number; stdout: string } | null): string | null {
  if (!res || res.exitCode !== 0) return null
  const s = String(res.stdout ?? '').trim()
  if (!s) return null
  const short = s.replace(/^refs\/remotes\//, '')
  const slash = short.indexOf('/')
  return slash >= 0 ? short.slice(slash + 1) || null : short
}

/** `git worktree list --porcelain`. */
export function parseWorktrees(stdout: string): Worktree[] {
  const out: Worktree[] = []
  let cur: Worktree | null = null
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur)
      cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false }
      continue
    }
    if (!cur) continue
    if (line.startsWith('HEAD ')) cur.head = line.slice(5).trim()
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '')
    else if (line === 'detached') cur.detached = true
    else if (line === 'bare') cur.bare = true
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true
  }
  if (cur) out.push(cur)
  return out
}

/** The location shown outside a git repository: the folder name only. */
export function folderOnly(cwd: string, checkedAt: number): Location {
  return {
    isRepo: false,
    cwd,
    folder: basename(cwd) || cwd,
    repo: '',
    toplevel: '',
    branch: null,
    sha: null,
    isLinkedWorktree: false,
    worktreeName: null,
    dirty: null,
    upstream: 'unknown',
    upstreamName: null,
    ahead: null,
    lastCommitAt: null,
    lastSubject: null,
    defaultBranch: null,
    worktrees: [],
    checkedAt,
  }
}

// ---------------------------------------------------------------- formatting

/** 14m, 5h, 3d. */
export function fmtAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** 41m, 1h20, <1m. */
export function fmtLeft(ms: number): string {
  if (ms < 60_000) return '<1m'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

// ---------------------------------------------------------------- usage windows

export function kindLabel(kind: string): string {
  return LABELS[kind] ?? kind
}

export function levelOf(pct: number): Level {
  if (pct >= DANGER_PCT) return 'danger'
  if (pct >= WARN_PCT) return 'warn'
  return 'ok'
}

/** Keeps well-formed windows from an untrusted list. */
export function sanitizeWindows(input: unknown): RateWindow[] {
  if (!Array.isArray(input)) return []
  const out: RateWindow[] = []
  for (const w of input) {
    if (!w || typeof w !== 'object') continue
    const r = w as Record<string, unknown>
    if (typeof r.kind !== 'string' || !r.kind) continue
    if (typeof r.percentUsed !== 'number' || !Number.isFinite(r.percentUsed)) continue
    out.push({
      kind: r.kind,
      percentUsed: r.percentUsed,
      ...(typeof r.resetsAt === 'string' && r.resetsAt ? { resetsAt: r.resetsAt } : {}),
    })
  }
  return out
}

function resetMs(w: RateWindow): number {
  const t = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  return Number.isFinite(t) ? t : 0
}

/** Windows to show: those not past their reset time, 5h then 7d then the rest. */
export function liveWindows(windows: readonly RateWindow[], nowMs: number): RateWindow[] {
  const rank = (k: string) => {
    const i = ORDER.indexOf(k)
    return i < 0 ? ORDER.length : i
  }
  return windows
    .filter(w => {
      const r = resetMs(w)
      return r === 0 || r > nowMs
    })
    .sort((a, b) => rank(a.kind) - rank(b.kind))
}

/**
 * Decides the one-time toasts. A window at TOAST_PCT or more that was not
 * warned yet gets one; a window back under the line (a new period) re-arms.
 */
export function nextWarned(
  warned: Readonly<Record<string, boolean>>,
  windows: readonly RateWindow[],
): { warned: Record<string, boolean>; toast: RateWindow[] } {
  const next: Record<string, boolean> = { ...warned }
  const toast: RateWindow[] = []
  for (const w of windows) {
    if (w.percentUsed >= TOAST_PCT) {
      if (!next[w.kind]) {
        next[w.kind] = true
        toast.push(w)
      }
    } else if (next[w.kind]) {
      delete next[w.kind]
    }
  }
  return { warned: next, toast }
}

export function toastText(w: RateWindow, nowMs: number): string {
  const r = resetMs(w)
  const when = r > 0 ? `, resets in ${fmtLeft(r - nowMs)}` : ''
  const what = w.kind === 'spend_limit' ? 'Spend limit' : `${kindLabel(w.kind)} usage window`
  return `${what} at ${Math.round(w.percentUsed)}%${when}`
}

// ---------------------------------------------------------------- prompt cache

export function sanitizeTtl(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v.trim()) : v
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > 24 * 60) return null
  return Math.round(n * 10) / 10
}

export function cacheState(lastStepMs: number | null, nowMs: number, ttlMin: number): CacheState {
  if (lastStepMs === null || !Number.isFinite(lastStepMs)) return { kind: 'unknown' }
  const left = lastStepMs + ttlMin * 60_000 - nowMs
  if (left <= 0) return { kind: 'cold' }
  if (left <= CACHE_LOW_MS) return { kind: 'low', leftMs: left }
  return { kind: 'warm', leftMs: left }
}

// ---------------------------------------------------------------- band

/** A band part; `tone` (a kit tone) marks one that needs you. */
export type Seg = { text: string; tone?: 'warn' | 'danger' }

export type BandInput = {
  loc: Location | null
  windows: readonly RateWindow[]
  nowMs: number
  lastStepMs: number | null
  ttlMin: number
}

/** The location parts: `repo@branch ⑂wt:name`, dirty, ahead, since commit. */
export function locationParts(loc: Location | null, nowMs: number): Seg[][] {
  if (!loc) return []
  if (!loc.isRepo) return loc.folder ? [[{ text: `${loc.folder} (no git)` }]] : []
  const parts: Seg[][] = []
  const head = loc.branch ?? (loc.sha ? `(${loc.sha})` : '?')
  let name = `${loc.repo || basename(loc.toplevel)}@${head}`
  if (loc.isLinkedWorktree && loc.worktreeName) name += ` ⑂wt:${loc.worktreeName}`
  parts.push([{ text: name }])
  if (loc.dirty !== null) parts.push([{ text: loc.dirty === 0 ? 'clean' : `${loc.dirty} dirty` }])
  if (loc.upstream === 'none' && loc.branch) parts.push([{ text: 'no upstream' }])
  else if (loc.ahead !== null && loc.ahead > 0) parts.push([{ text: `${loc.ahead}↑` }])
  if (loc.lastCommitAt !== null) parts.push([{ text: `${fmtAge(nowMs / 1000 - loc.lastCommitAt)} since commit` }])
  return parts
}

export function usageParts(windows: readonly RateWindow[], nowMs: number): Seg[][] {
  return liveWindows(windows, nowMs).map(w => {
    const lvl = levelOf(w.percentUsed)
    const seg: Seg = { text: `${kindLabel(w.kind)} ${Math.round(w.percentUsed)}%` }
    if (lvl !== 'ok') seg.tone = lvl
    return [seg]
  })
}

export function cacheParts(lastStepMs: number | null, nowMs: number, ttlMin: number): Seg[][] {
  const c = cacheState(lastStepMs, nowMs, ttlMin)
  if (c.kind === 'unknown') return []
  if (c.kind === 'cold') return [[{ text: 'cache cold' }]]
  const seg: Seg = { text: `cache ${fmtLeft(c.leftMs)}` }
  if (c.kind === 'low') seg.tone = 'warn'
  return [[seg]]
}

/** Every part of the band, joined with ` · `. Parts that are unknown are left out. */
export function bandSegments(input: BandInput): Seg[] {
  const parts = [
    ...locationParts(input.loc, input.nowMs),
    ...usageParts(input.windows, input.nowMs),
    ...cacheParts(input.lastStepMs, input.nowMs, input.ttlMin),
  ]
  const out: Seg[] = []
  parts.forEach((p, i) => {
    if (i > 0) out.push({ text: ' · ' })
    out.push(...p)
  })
  return out
}

/** A band chip, drawn `● text` in a kit tone: muted until it needs you. */
export type Chip = { text: string; tone: 'muted' | 'warn' | 'danger' }

export type BandLine = { label: string; chips: Chip[]; right: string[]; urgent: boolean }

/** The kit draws at most this many chips on a band line. */
const MAX_CHIPS = 4

/**
 * The band as a kit line: the bold label (`repo@branch ⑂wt:name`, the folder outside git, or
 * `where` before git is read), the usage windows and the prompt cache as chips, and the rest of the
 * location (dirty, ahead, since commit) quiet on the right. Windows past the fourth chip move to the
 * right side; the cache chip always stays. `urgent` when a window is at the danger level. null when
 * nothing is known yet.
 */
export function bandLine(input: BandInput): BandLine | null {
  const loc = locationParts(input.loc, input.nowMs).map(p => p.map(s => s.text).join(''))
  const chip = (p: Seg[]): Chip => ({ text: p.map(s => s.text).join(''), tone: p.find(s => s.tone)?.tone ?? 'muted' })
  const windows = usageParts(input.windows, input.nowMs).map(chip)
  const cache = cacheParts(input.lastStepMs, input.nowMs, input.ttlMin).map(chip)
  if (loc.length === 0 && windows.length === 0 && cache.length === 0) return null
  const room = MAX_CHIPS - cache.length
  const chips = [...windows.slice(0, room), ...cache]
  const right = [...loc.slice(1), ...windows.slice(room).map(c => c.text)]
  return { label: loc[0] ?? 'where', chips, right, urgent: chips.some(c => c.tone === 'danger') }
}

export function bandText(segs: readonly Seg[]): string {
  return segs.map(s => s.text).join('')
}

// ---------------------------------------------------------------- pane and /where text

export type Row = { label: string; value: string; tone?: 'warn' | 'danger' }

export function detailRows(input: BandInput & { costUsd: number | null; ttlSource: string }): Row[] {
  const { loc, nowMs } = input
  const rows: Row[] = []
  if (!loc) {
    rows.push({ label: 'Location', value: 'not checked yet' })
  } else if (!loc.isRepo) {
    rows.push({ label: 'Folder', value: `${loc.folder} (not a git repository)` })
    rows.push({ label: 'cwd', value: loc.cwd })
  } else {
    rows.push({ label: 'Repo', value: loc.repo })
    rows.push({ label: 'Branch', value: loc.branch ?? (loc.sha ? `detached at ${loc.sha}` : 'unknown') })
    rows.push({
      label: 'Worktree',
      value: loc.isLinkedWorktree ? `linked: ${loc.worktreeName ?? basename(loc.toplevel)}` : 'main checkout',
    })
    rows.push({ label: 'cwd', value: loc.cwd })
    rows.push({ label: 'Top level', value: loc.toplevel })
    rows.push({ label: 'Default branch', value: loc.defaultBranch ?? 'unknown (no origin/HEAD)' })
    rows.push({
      label: 'Upstream',
      value:
        loc.upstream === 'set'
          ? `${loc.upstreamName ?? '?'}${loc.ahead !== null ? ` · ${loc.ahead} unpushed` : ''}`
          : loc.upstream === 'none'
            ? 'no upstream'
            : 'unknown',
    })
    rows.push({
      label: 'Changes',
      value: loc.dirty === null ? 'unknown' : loc.dirty === 0 ? 'clean' : `${loc.dirty} dirty paths`,
    })
    rows.push({
      label: 'Last commit',
      value:
        loc.lastCommitAt === null
          ? 'none'
          : `${fmtAge(nowMs / 1000 - loc.lastCommitAt)} ago${loc.lastSubject ? ` · ${loc.lastSubject}` : ''}`,
    })
  }
  const live = liveWindows(input.windows, nowMs)
  if (live.length === 0) rows.push({ label: 'Usage', value: 'no rate-limit reading yet' })
  for (const w of live) {
    const r = resetMs(w)
    const lvl = levelOf(w.percentUsed)
    const row: Row = {
      label: `Usage ${kindLabel(w.kind)}`,
      value: `${Math.round(w.percentUsed)}% used${r > 0 ? ` · resets in ${fmtLeft(r - nowMs)}` : ''}`,
    }
    if (lvl !== 'ok') row.tone = lvl
    rows.push(row)
  }
  if (input.costUsd !== null && input.costUsd > 0) rows.push({ label: 'Session cost', value: `$${input.costUsd.toFixed(2)}` })
  const c = cacheState(input.lastStepMs, nowMs, input.ttlMin)
  const ttl = `TTL ${input.ttlMin}m from ${input.ttlSource}`
  const cache: Row = {
    label: 'Prompt cache',
    value:
      c.kind === 'unknown'
        ? `no request yet · ${ttl}`
        : c.kind === 'cold'
          ? `cold · ${ttl}`
          : `${fmtLeft(c.leftMs)} left · ${ttl}`,
  }
  if (c.kind === 'low') cache.tone = 'warn'
  rows.push(cache)
  return rows
}

export function worktreeLines(loc: Location | null): string[] {
  if (!loc || !loc.isRepo || loc.worktrees.length === 0) return []
  return loc.worktrees.map(w => {
    const here = trimSlashes(w.path) === trimSlashes(loc.toplevel) ? '●' : '○'
    const head = w.bare ? 'bare' : w.branch ?? (w.head ? `detached ${w.head.slice(0, 7)}` : 'detached')
    const flags = [w.locked ? 'locked' : '', w.prunable ? 'prunable' : ''].filter(Boolean).join(', ')
    return `${here} ${w.path}  ${head}${flags ? `  (${flags})` : ''}`
  })
}

export function summaryText(input: BandInput & { costUsd: number | null; ttlSource: string }): string {
  const rows = detailRows(input)
  const w = Math.max(...rows.map(r => r.label.length))
  const lines = [bandText(bandSegments(input)) || 'where-am-i: nothing known yet', '']
  for (const r of rows) lines.push(`${r.label.padEnd(w)}  ${r.value}`)
  const wts = worktreeLines(input.loc)
  if (wts.length > 0) {
    lines.push('', `Worktrees (${wts.length})`)
    for (const l of wts) lines.push('  ' + l)
  }
  return lines.join('\n')
}

export const HELP = [
  'Usage: /where [text | refresh | band on|off | cache <minutes>]',
  '  /where              open the pane',
  '  /where text         print the details here',
  '  /where refresh      check git again now',
  '  /where band on|off  show or hide the line above the prompt',
  '  /where cache <min>  set the prompt-cache TTL (default 60)',
].join('\n')
