// filesModel.ts: the Files pane's state and pure helpers, ported from change-control's files.ts. No mods API here:
// files.ts feeds the tool calls in, filesPane.ts draws the result.
//
// What is tracked:
//   - reads: Read and NotebookRead (a file), Glob and Grep (a search: pattern + folder), and a file
//     a prompt @-mentions (prompt.mention);
//   - edits: Edit, Write, MultiEdit, NotebookEdit once the call ran without a deny or an error,
//     and Bash writes (sed -i, >, tee, cp, mv, touch, rm) the gates let through (gates.ts records those);
//   - the call in flight ("Claude is reading X"), set before `await next(e)` and cleared after it; a Write of a
//     missing file is "creating" (its id ends in CREATING);
//   - git: `git status --porcelain` and the branch, refreshed after each edit and on Refresh.
// Bash reads (cat, head) are not detected.

import type { LkFilesActivity, LkFilesGit, LkFolderListing, LkListEntry, LkTouchEntry } from '../../types/index.d.ts'
import { normalizePath } from './gateRules.ts'
import { shortPath } from './kit.ts'
import type { IconName, PillTone } from './kit.ts'

/** The touched list keeps the newest this many entries. */
export const TOUCHED_CAP = 200
/** A folder draws at most this many entries, then "… and N more". */
export const LIST_CAP = 400
/** A folder's listing keeps at most this many entries in state (hidden ones are filtered when drawn). */
export const LIST_KEEP = 2000
/** The tree draws at most this many rows in all. */
export const TREE_ROWS_CAP = 1000

export type FilesState = {
  touched: LkTouchEntry[]
  live: LkFilesActivity[]
  last: string
  git: LkFilesGit | null
}

export type Badge = { label: string; tone: PillTone }

export const emptyFiles = (): FilesState => ({ touched: [], live: [], last: '', git: null })

// ---------------------------------------------------------------- paths

/** The last part of a path ('' for ''). */
export function baseName(path: string): string {
  const p = path.replace(/\/+$/, '')
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1) || '/'
}

/** The folder part of a path ('' when there is none; '/' for a file at the root). */
export function dirName(path: string): string {
  const p = path.replace(/\/+$/, '')
  const i = p.lastIndexOf('/')
  if (i < 0) return ''
  return i === 0 ? '/' : p.slice(0, i)
}

/** `path` relative to `root` ('' when it is the root), or `path` itself when it is outside. Both absolute. */
export function relativeTo(root: string, path: string): string {
  const r = root === '/' ? '' : root.replace(/\/+$/, '')
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path
  if (p === r || (r === '' && p === '/')) return ''
  if (p.startsWith(r + '/')) return p.slice(r.length + 1)
  return p
}

/** A touched path (relative to cwd, or absolute) made absolute. */
export function absOf(cwd: string, path: string): string {
  if (path.startsWith('/')) return path
  const root = cwd.replace(/\/+$/, '')
  return path === '' ? root || '/' : `${root}/${path}`
}

/** The parent folder of an absolute path ('/' stays '/'). */
export function parentOf(abs: string): string {
  const d = dirName(abs)
  return d === '' ? '/' : d
}

// ---------------------------------------------------------------- recording

function upsert(state: FilesState, id: string, make: (prev: LkTouchEntry | undefined) => LkTouchEntry): FilesState {
  const prev = state.touched.find(t => t.id === id)
  const next = make(prev)
  const touched = [...state.touched.filter(t => t.id !== id), next]
  return { ...state, touched: touched.slice(-TOUCHED_CAP) }
}

/** A file Claude read (Read, NotebookRead) or a prompt @-mentioned. `path` as normalizePath gives it. */
export function noteRead(state: FilesState, path: string, kind: 'read' | 'mention' = 'read', tool = kind === 'mention' ? 'mention' : 'Read', at = Date.now()): FilesState {
  if (typeof path !== 'string' || path === '') return state
  const next = upsert(state, path, prev => ({
    id: path,
    kind: 'file',
    path,
    tool,
    read: true,
    edited: prev?.edited ?? false,
    created: prev?.created ?? false,
    at,
  }))
  return { ...next, last: `${kind === 'mention' ? 'opened' : 'read'} ${baseName(path)}` }
}

/** A Glob or Grep search: the pattern and the folder searched ('' for the session folder). */
export function noteSearch(state: FilesState, tool: string, pattern: string, dir: string, at = Date.now()): FilesState {
  if (typeof pattern !== 'string' || pattern === '') return state
  const folder = typeof dir === 'string' ? dir : ''
  const id = `search:${tool}:${folder}:${pattern}`
  const next = upsert(state, id, () => ({ id, kind: 'search', path: folder, pattern, tool, read: true, edited: false, created: false, at }))
  // A folder outside the session's is kept short ('…/a/b'): the hero draws this text as it is.
  return { ...next, last: `searched ${shortPath(folder, '', '') || 'the project'} for ${pattern}` }
}

/** A file Claude changed; `created` when a Write made a file that was not there. */
export function noteEdit(state: FilesState, path: string, created = false, tool = 'Edit', at = Date.now()): FilesState {
  if (typeof path !== 'string' || path === '') return state
  const next = upsert(state, path, prev => ({
    id: path,
    kind: 'file',
    path,
    tool,
    read: prev?.read ?? false,
    edited: true,
    created: (prev?.created ?? false) || created,
    at,
  }))
  return { ...next, last: `${created ? 'created' : 'edited'} ${baseName(path)}` }
}

export function setActivity(state: FilesState, act: LkFilesActivity): FilesState {
  return { ...state, live: [...state.live.filter(a => a.id !== act.id), act].slice(-20) }
}

export function clearActivity(state: FilesState, id: string): FilesState {
  return { ...state, live: state.live.filter(a => a.id !== id) }
}

/** Distinct files touched (searches are not files): the files band's `● n touched`. */
export function touchedCount(touched: readonly LkTouchEntry[]): number {
  return touched.filter(t => t.kind === 'file').length
}

// ---------------------------------------------------------------- git

/** `git status --porcelain` (v1) lines as { xy, path }: renames give the new path, quoted paths unquoted, ignored (!!) skipped. */
export function parseGitStatus(text: string): Array<{ xy: string; path: string }> {
  const out: Array<{ xy: string; path: string }> = []
  for (const line of String(text ?? '').split('\n')) {
    if (line.length < 4 || line[2] !== ' ') continue
    const xy = line.slice(0, 2)
    if (xy === '!!') continue
    let p = line.slice(3)
    const arrow = p.indexOf(' -> ')
    if (arrow >= 0) p = p.slice(arrow + 4)
    if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) p = p.slice(1, -1).replace(/\\(.)/g, '$1')
    if (p !== '') out.push({ xy, path: p })
  }
  return out
}

/**
 * The repository's state into the pane's: porcelain paths are relative to the repository root, so with
 * `root` and `cwd` each one is keyed as a touched path is (relative to cwd, or absolute); a folder keeps its '/'.
 */
export function applyGitStatus(state: FilesState, porcelainText: string, branch: string, opts: { root?: string; cwd?: string } = {}): FilesState {
  const changed: Record<string, string> = {}
  for (const { xy, path } of parseGitStatus(porcelainText)) {
    const isDir = path.endsWith('/')
    let key = path
    if (opts.cwd) {
      const root = (opts.root || opts.cwd).replace(/\/+$/, '')
      key = normalizePath(`${root}/${path}`, opts.cwd) + (isDir ? '/' : '')
    }
    changed[key] = xy
  }
  return { ...state, git: { branch: branch || 'HEAD', changed } }
}

/** The porcelain status of a path, or of an untracked folder that holds it. */
export function gitStatusOf(git: LkFilesGit | null | undefined, path: string): string | undefined {
  if (!git || !path) return undefined
  const own = git.changed[path]
  if (own !== undefined) return own
  for (const key of Object.keys(git.changed)) {
    if (key.endsWith('/') && path.startsWith(key)) return git.changed[key]
  }
  return undefined
}

// ---------------------------------------------------------------- badges and labels

/** The end of a call-in-flight id when a Write makes a file that was not there (the hero's plus). */
export const CREATING = ':new'

/** Whether a call in flight is a Write making a new file. */
export function isCreating(act: LkFilesActivity | undefined): boolean {
  return act?.verb === 'editing' && String(act.id).endsWith(CREATING)
}

/**
 * The one badge a row carries, strongest first: the call in flight (Reading, Editing, Creating,
 * Searching), Deleted (an edited file git reports deleted), Created, Edited, Not committed (git),
 * Searched, Opened. The pill tones follow the legend: reads violet, edits Claude's color.
 */
export function badgeFor(entry: LkTouchEntry | undefined, git: LkFilesGit | null | undefined, opts: { live?: LkFilesActivity; path?: string } = {}): Badge | null {
  const live = opts.live
  if (live) {
    if (isCreating(live)) return { label: 'Creating', tone: 'ok' }
    if (live.verb === 'editing') return { label: 'Editing', tone: 'accent' }
    if (live.verb === 'searching') return { label: 'Searching', tone: 'violet' }
    return { label: 'Reading', tone: 'violet' }
  }
  const path = entry?.kind === 'search' ? undefined : (entry?.path ?? opts.path)
  const status = path === undefined ? undefined : gitStatusOf(git, path)
  if (entry?.edited && status?.includes('D')) return { label: 'Deleted', tone: 'danger' }
  if (entry?.created) return { label: 'Created', tone: 'ok' }
  if (entry?.edited) return { label: 'Edited', tone: 'accent' }
  if (status !== undefined) return { label: 'Not committed', tone: 'accent' }
  if (entry?.kind === 'search') return { label: 'Searched', tone: 'violet' }
  if (entry?.read) return { label: 'Opened', tone: 'violet' }
  return null
}

/** '0 B', '512 B', '1.5 KB', '34 KB', '1.2 MB', '3 GB'. */
export function fmtSize(bytes: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  const r = Math.round(v * 10) / 10
  const s = r < 10 ? String(r).replace(/\.0$/, '') : String(Math.round(v))
  return `${s} ${units[u]}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '09 Oct' (local time); the year is added when it is not this year; '' for no time. */
export function fmtDate(ms: number, now: number = Date.now()): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  const dd = d.getDate() < 10 ? `0${d.getDate()}` : String(d.getDate())
  const base = `${dd} ${MONTHS[d.getMonth()]}`
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base} ${d.getFullYear()}`
}

/** Items whose text holds the query, ignoring case; all of them for an empty query. */
export function filterEntries<T>(items: readonly T[], query: string, text: (item: T) => string = item => String((item as { path?: unknown }).path ?? '')): T[] {
  const q = String(query ?? '').trim().toLowerCase()
  if (q === '') return [...items]
  return items.filter(item => text(item).toLowerCase().includes(q))
}

/** Dotfiles and node_modules are hidden until "Show hidden files". */
export function isHidden(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules'
}

/** Folders first, then the rest, each by name ignoring case. */
export function sortEntries(entries: readonly LkListEntry[]): LkListEntry[] {
  const rank = (e: LkListEntry) => (e.kind === 'dir' ? 0 : 1)
  return [...entries].sort((a, b) => rank(a) - rank(b) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------- the hero and the touched rows

/** The hero card: `icon` and `tone` pick its picture (eye, pencil, plus, search; a clock when idle). */
export type Hero = { kicker: string; title: string; sub?: string; live: boolean; icon: IconName; tone?: PillTone }

/**
 * "Claude is reading client.test.js" in tests, "Claude is searching src for TODO", or idle with the
 * last thing done as the sub line. `short` draws a folder for display (the pane passes kit's
 * shortPath, so no absolute path from outside the project is drawn).
 */
export function heroFor(state: Pick<FilesState, 'live' | 'last'>, short: (path: string) => string = p => p): Hero {
  const act = state.live[state.live.length - 1]
  if (act) {
    if (act.verb === 'searching') {
      const where = short(act.path) || 'the project'
      return { kicker: 'right now', title: `Claude is searching ${where} for ${act.pattern ?? ''}`.trimEnd(), sub: `with ${act.tool}`, live: true, icon: 'search', tone: 'violet' }
    }
    const dir = short(dirName(act.path))
    const sub = `in ${dir || 'the project'}`
    if (isCreating(act)) return { kicker: 'right now', title: `Claude is creating ${baseName(act.path)}`, sub, live: true, icon: 'plus', tone: 'ok' }
    if (act.verb === 'editing') return { kicker: 'right now', title: `Claude is editing ${baseName(act.path)}`, sub, live: true, icon: 'pencil', tone: 'accent' }
    return { kicker: 'right now', title: `Claude is ${act.verb} ${baseName(act.path)}`, sub, live: true, icon: 'eye', tone: 'violet' }
  }
  return state.last
    ? { kicker: 'right now', title: 'Claude is idle', sub: `last: ${state.last}`, live: false, icon: 'clock' }
    : { kicker: 'right now', title: 'Claude is idle', sub: 'nothing read or edited yet', live: false, icon: 'clock' }
}

export type TouchedRow = { id: string; kind: 'file' | 'search'; name: string; folder: string; badge: Badge | null; at: number }

/**
 * The "Claude touched" rows, newest first: every touched entry, plus a file being read or edited
 * right now that is not in the list yet. Filtered by `query` on the path (or a search's pattern and folder).
 */
export function touchedRows(state: FilesState, query = ''): TouchedRow[] {
  const liveFor = (path: string) => [...state.live].reverse().find(a => a.verb !== 'searching' && a.path === path)
  const liveSearch = (t: LkTouchEntry) => [...state.live].reverse().find(a => a.verb === 'searching' && a.path === t.path && a.pattern === t.pattern && a.tool === t.tool)
  const rows: TouchedRow[] = []
  const seen = new Set<string>()
  for (const t of [...state.touched].reverse()) {
    seen.add(t.id)
    if (t.kind === 'search') {
      rows.push({ id: t.id, kind: 'search', name: t.pattern ?? '', folder: t.path, badge: badgeFor(t, state.git, { live: liveSearch(t) }), at: t.at })
    } else {
      rows.push({ id: t.id, kind: 'file', name: baseName(t.path), folder: dirName(t.path), badge: badgeFor(t, state.git, { live: liveFor(t.path) }), at: t.at })
    }
  }
  const pending: TouchedRow[] = []
  for (const a of state.live) {
    if (a.verb === 'searching') {
      const id = `search:${a.tool}:${a.path}:${a.pattern ?? ''}`
      if (seen.has(id)) continue
      seen.add(id)
      pending.push({ id, kind: 'search', name: a.pattern ?? '', folder: a.path, badge: badgeFor(undefined, state.git, { live: a }), at: a.at })
    } else {
      if (seen.has(a.path)) continue
      seen.add(a.path)
      pending.push({ id: a.path, kind: 'file', name: baseName(a.path), folder: dirName(a.path), badge: badgeFor(undefined, state.git, { live: a }), at: a.at })
    }
  }
  const all = [...pending.reverse(), ...rows]
  return filterEntries(all, query, r => (r.kind === 'search' ? `${r.name} ${r.folder || 'project'}` : r.folder ? `${r.folder}/${r.name}` : r.name))
}

// ---------------------------------------------------------------- the tree

export type TreeRow =
  | { kind: 'dir'; key: string; abs: string; name: string; depth: number; open: boolean; isLink: boolean }
  | { kind: 'file'; key: string; abs: string; name: string; depth: number; badge: Badge | null; right: string; live: boolean }
  | { kind: 'note'; key: string; depth: number; text: string }

export type TreeInput = {
  root: string
  cwd: string
  listings: Record<string, LkFolderListing>
  expanded: readonly string[]
  showHidden: boolean
  showSizes: boolean
  query: string
  touched: readonly LkTouchEntry[]
  live: readonly LkFilesActivity[]
  git: LkFilesGit | null
  now?: number
}

/**
 * The "All files" rows: the root's listing, and each expanded folder's under it, folders first.
 * With a query, a file shows when its name holds it, a folder when its name holds it or a loaded
 * folder under it has a match, and folders with a match are drawn open.
 */
export function treeRows(input: TreeInput): TreeRow[] {
  const q = input.query.trim().toLowerCase()
  const expanded = new Set(input.expanded)
  const byPath = new Map<string, LkTouchEntry>()
  for (const t of input.touched) if (t.kind === 'file') byPath.set(absOf(input.cwd, t.path), t)
  const liveByPath = new Map<string, LkFilesActivity>()
  for (const a of input.live) if (a.verb !== 'searching') liveByPath.set(absOf(input.cwd, a.path), a)
  const visible = (l: LkFolderListing | undefined) => (l ? l.entries.filter(e => input.showHidden || !isHidden(e.name)) : [])
  const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)

  const memo = new Map<string, boolean>()
  const hasMatch = (dir: string, depth: number): boolean => {
    if (q === '' || depth > 30) return false
    const hit = memo.get(dir)
    if (hit !== undefined) return hit
    memo.set(dir, false)
    const found = visible(input.listings[dir]).some(e => e.name.toLowerCase().includes(q) || (e.kind === 'dir' && hasMatch(join(dir, e.name), depth + 1)))
    memo.set(dir, found)
    return found
  }

  const rows: TreeRow[] = []
  let capped = false
  const walk = (dir: string, depth: number) => {
    const listing = input.listings[dir]
    if (!listing) {
      rows.push({ kind: 'note', key: `note:${dir}`, depth, text: 'loading…' })
      return
    }
    if (listing.error) {
      rows.push({ kind: 'note', key: `note:${dir}`, depth, text: `cannot list: ${listing.error}` })
      return
    }
    let shown = visible(listing)
    if (q !== '') shown = shown.filter(e => e.name.toLowerCase().includes(q) || (e.kind === 'dir' && hasMatch(join(dir, e.name), 0)))
    if (shown.length === 0) {
      if (q === '') rows.push({ kind: 'note', key: `note:${dir}`, depth, text: '(empty)' })
      return
    }
    const hiddenOut = listing.entries.length - visible(listing).length
    const unlisted = Math.max(0, listing.total - listing.entries.length)
    const drawn = shown.slice(0, LIST_CAP)
    for (const e of drawn) {
      if (rows.length >= TREE_ROWS_CAP) {
        capped = true
        return
      }
      const abs = join(dir, e.name)
      if (e.kind === 'dir') {
        const open = expanded.has(abs) || (q !== '' && hasMatch(abs, 0))
        rows.push({ kind: 'dir', key: `dir:${abs}`, abs, name: e.name, depth, open, isLink: e.isLink })
        if (open) walk(abs, depth + 1)
        if (capped) return
      } else {
        const t = byPath.get(abs)
        const live = liveByPath.get(abs)
        const badge = badgeFor(t, input.git, { live, path: normalizePath(abs, input.cwd) })
        const right = badge ? '' : input.showSizes ? (e.kind === 'file' ? fmtSize(e.size) : '') : fmtDate(e.mtimeMs, input.now)
        rows.push({ kind: 'file', key: `file:${abs}`, abs, name: e.isLink ? `${e.name} ↗` : e.name, depth, badge, right, live: live !== undefined })
      }
    }
    const more = shown.length - drawn.length + (q === '' ? unlisted : 0)
    if (more > 0) rows.push({ kind: 'note', key: `more:${dir}`, depth, text: `… and ${more} more` })
    else if (q === '' && hiddenOut > 0 && depth === 0 && !input.showHidden) {
      rows.push({ kind: 'note', key: `hidden:${dir}`, depth, text: `${hiddenOut} hidden` })
    }
  }
  walk(input.root, 0)
  if (capped) rows.push({ kind: 'note', key: 'capped', depth: 0, text: `… stopped at ${TREE_ROWS_CAP} rows: collapse folders or find a file` })
  return rows
}

/** Every folder the tree needs listed: the root and each open folder under it (a filter opens matches too). */
export function foldersToList(root: string, expanded: readonly string[]): string[] {
  const r = root.replace(/\/+$/, '') || '/'
  const under = expanded.filter(d => d !== r && (r === '/' ? d.startsWith('/') : d.startsWith(r + '/')))
  return [r, ...under]
}

/** A listing as the tree keeps it: sorted, at most LIST_KEEP entries, with the total. */
export function toListing(entries: readonly unknown[]): LkFolderListing {
  const clean: LkListEntry[] = []
  for (const raw of entries) {
    const e = (raw ?? {}) as Record<string, unknown>
    if (typeof e.name !== 'string' || e.name === '') continue
    const kind = e.kind === 'dir' || e.kind === 'file' ? e.kind : 'other'
    clean.push({
      name: e.name,
      kind,
      size: typeof e.size === 'number' && Number.isFinite(e.size) ? e.size : 0,
      mtimeMs: typeof e.mtimeMs === 'number' && Number.isFinite(e.mtimeMs) ? e.mtimeMs : 0,
      isLink: e.isLink === true,
    })
  }
  const sorted = sortEntries(clean)
  return { entries: sorted.slice(0, LIST_KEEP), total: sorted.length }
}
