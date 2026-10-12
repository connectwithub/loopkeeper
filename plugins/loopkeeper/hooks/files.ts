// Files concern, ported from change-control: the Files pane (/files, /lk gates files) and git status.
//
// It watches rather than rules. tool.call hooks on Read, NotebookRead, Glob, Grep and the edit tools set "what Claude
// is doing right now" before `await next(e)`, clear it after, and record the file when the call was not refused and did
// not fail; prompt.submit records the files a prompt @-mentions. Bash writes come from the gates: only they parse Bash, so
// gates.ts records the writes it lets through into the same atoms (filesTouched, filesActivity.last).
// Every change to filesTouched and filesActivity goes through update (compare-and-set) and never writes a stale copy,
// so the gates' Bash writes and parallel tool calls all land.
// The pane's state and pure helpers live in lib/filesModel.ts, its tree in lib/filesPane.ts. The band line
// (`files ● N touched`, only once something was touched) follows the gates band switch: files has none of its own.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { LkAnyNext, LkFilesActivity, LkFilesGit, LkFilesLive, LkFilesView, LkFolderListing, LkNext, LkTouchEntry } from '../types/index.d.ts'
import {
  absOf,
  applyGitStatus,
  clearActivity,
  CREATING,
  emptyFiles,
  foldersToList,
  noteEdit,
  noteRead,
  noteSearch,
  parentOf,
  setActivity,
  toListing,
  touchedCount,
} from './lib/filesModel.ts'
import type { FilesState } from './lib/filesModel.ts'
import { FILES_PANE, filesTree } from './lib/filesPane.ts'
import type { FilesActions } from './lib/filesPane.ts'
import { editPath, normalizePath } from './lib/gateRules.ts'
import { TONES, makeKit } from './lib/kit.ts'
import type { Elements } from './lib/kit.ts'
import { CMD, DISABLE_ENV, PLUGIN, joinText, subOf } from './lib/names.ts'
import { HUB_ID, HUB_ROWS, PANES } from './lib/panes.ts'
import { killSwitchOn } from './lib/stageModel.ts'

// As change-control watched them. Claude Code 2.1.294 lists no Glob, Grep, NotebookRead or MultiEdit among its built-in
// tools (the typed matcher refuses those names), so the matchers are patterns: where the tools exist they are watched.
const READ_TOOLS = /^(?:Read|NotebookRead)$/
const SEARCH_TOOLS = /^(?:Glob|Grep)$/
const EDIT_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/
// git runs after each recorded edit and on Refresh: short timeouts keep a hook well under its 10 s
const GIT_TIMEOUT_MS = 2_000
// folders listed in one go (open, Refresh) and in one drawing
const LOAD_FOLDERS_MAX = 40
const RENDER_LIST_MAX = 10
// a file the listing gives no time for is stat'ed, at most this many per folder
const STAT_MAX = 50
// folder listings kept in $.state; the oldest go first (Refresh drops them all)
const LISTINGS_KEEP = 80

const filesTouched = atom({ plugin: 'loopkeeper', key: 'filesTouched' } as const, [] as LkTouchEntry[])
const filesActivity = atom({ plugin: 'loopkeeper', key: 'filesActivity' } as const, { live: [], last: '' } as LkFilesLive)
const filesGit = atom({ plugin: 'loopkeeper', key: 'filesGit' } as const, null as LkFilesGit | null)
const filesView = atom({ plugin: 'loopkeeper', key: 'filesView' } as const, { root: '', expanded: [], showSizes: false, showHidden: false, filter: '' } as LkFilesView)
const filesListing = atom({ plugin: 'loopkeeper', key: 'filesListing' } as const, {} as Record<string, LkFolderListing>)
// Declared by gates.ts too: the Files band line follows the gates band switch.
const gateBand = atom({ plugin: 'loopkeeper', key: 'gateBand' } as const, true)

// ---- The module's own bits: the kill switch, the activity ids, the git roots ------------------------------------

let killed: boolean | null = null
let hydrated = false
let actSeq = 0
// Activity ids carry this module's tag, so calls in flight left by a module before a hot reload can be told apart.
const MODULE_TAG = Math.random().toString(36).slice(2, 8) || 'm'
const gitRoots = new Map<string, string>()

/** A call to watch; `creating` (a Write of a missing file) ends its id in CREATING, for the hero's plus. */
type Watch = { verb: LkFilesActivity['verb']; path: string; pattern?: string; tool: string; creating?: boolean }
type Failure = { error?: { kind?: string; message?: string }; called?: boolean }

/** CLAUDE_MODS_DISABLE names loopkeeper (or all): nothing is tracked and no band line is drawn; /files still opens. */
async function isKilled($: EngineInterface): Promise<boolean> {
  if (killed !== null) return killed
  let raw: unknown = ''
  try {
    raw = await $.env.get('CLAUDE_MODS_DISABLE')
  } catch {
    raw = ''
  }
  killed = killSwitchOn(raw)
  return killed
}

async function sessionCwd($: EngineInterface): Promise<string> {
  try {
    return (await $.session.cwd()).replace(/\/+$/, '') || '/'
  } catch {
    return '/'
  }
}

/** Once per module: drop the calls in flight a previous module left (they never clear). */
async function hydrate($: EngineInterface): Promise<void> {
  if (hydrated) return
  hydrated = true
  const stale = (a: LkFilesActivity) => !String(a.id).startsWith(`${MODULE_TAG}:`)
  const now = await read($, filesActivity)
  if (now.live.some(stale)) await update($, filesActivity, a => ({ live: a.live.filter(x => !stale(x)), last: a.last }))
}

/** A path a tool names, as the pane keys it (relative to the session folder when inside it; '' is the folder itself), or null to leave the call alone. */
async function trackedPath($: EngineInterface, raw: unknown): Promise<string | null> {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    if (await isKilled($)) return null
    await hydrate($)
    const cwd = await sessionCwd($)
    const p = normalizePath(raw, cwd)
    return p === cwd ? '' : p
  } catch {
    return null
  }
}

/** The @path tokens in a prompt (a quoted @"a b.md" too), without a `#L…` line suffix or trailing punctuation; at most 20. */
function mentionedPaths(text: unknown): string[] {
  if (typeof text !== 'string' || !text.includes('@')) return []
  const found: string[] = []
  for (const m of text.matchAll(/(?:^|\s)@(?:"([^"\n]+)"|(\S+))/g)) {
    const raw = (m[1] ?? m[2] ?? '').replace(/#L\d.*$/, '').replace(/[.,;:!?)\]}'"]+$/, '')
    if (raw !== '' && !found.includes(raw)) found.push(raw)
    if (found.length >= 20) break
  }
  return found
}

/** A tool call's result that counts: not refused (deny) and not failed (isError). */
function succeeded(r: unknown): boolean {
  if (typeof r !== 'object' || r === null) return false
  const o = r as { deny?: unknown; isError?: unknown }
  return o.deny === undefined && o.isError !== true
}

/** A change to the touched list, then the hero's "last:" text; each through update, from the value now in $.state. */
async function noteTouch($: EngineInterface, change: (s: FilesState) => FilesState): Promise<void> {
  let last = ''
  await update($, filesTouched, touched => {
    const s = change({ ...emptyFiles(), touched: [...touched] })
    last = s.last
    return s.touched
  })
  if (last !== '') await update($, filesActivity, a => ({ live: a.live, last }))
}

/** A change to the calls in flight, through update. */
async function changeLive($: EngineInterface, change: (s: FilesState) => FilesState): Promise<void> {
  await update($, filesActivity, a => {
    const s = change({ ...emptyFiles(), live: [...a.live], last: a.last })
    return { live: s.live, last: s.last }
  })
}

/** "Claude is <verb> <path>" while the call runs, then the change recorded when the call succeeded. */
async function watchCall($: EngineInterface, e: unknown, next: LkAnyNext, watch: Watch, change: (s: FilesState) => FilesState): Promise<never> {
  const { creating, ...act } = watch
  const id = `${MODULE_TAG}:${++actSeq}${creating ? CREATING : ''}`
  try {
    await changeLive($, s => setActivity(s, { ...act, id, at: Date.now() }))
  } catch {
    // The call goes ahead; the hero misses it.
  }
  let r: unknown
  try {
    r = await next(e)
  } finally {
    try {
      await changeLive($, s => clearActivity(s, id))
    } catch {
      // Dropped by the next module's hydrate at worst.
    }
  }
  if (succeeded(r)) {
    try {
      await noteTouch($, change)
    } catch {
      // The result stands; the pane misses one file.
    }
  }
  return r as never
}

/** Whether a file is there; true when that cannot be told, so a doubtful Write reads as Edited. */
async function fileExists($: EngineInterface, path: string): Promise<boolean> {
  try {
    return await $.fs.exists(absOf(await sessionCwd($), path))
  } catch {
    return true
  }
}

// ---- git -----------------------------------------------------------------------------------------------------------

/** `git status --porcelain` and the branch, into filesGit; outside a repository (or without git) the git line goes away. */
async function refreshGit($: EngineInterface): Promise<void> {
  try {
    const cwd = await sessionCwd($)
    const status = await $.process.run(['git', 'status', '--porcelain'], { cwd, timeoutMs: GIT_TIMEOUT_MS }).catch(() => null)
    if (status === null || status.exitCode !== 0) {
      if ((await read($, filesGit)) !== null) await update($, filesGit, () => null)
      return
    }
    const branch = await $.process.run(['git', 'branch', '--show-current'], { cwd, timeoutMs: GIT_TIMEOUT_MS }).catch(() => null)
    const name = branch !== null && branch.exitCode === 0 ? branch.stdout.trim() : ''
    const root = await gitRoot($, cwd)
    const git = applyGitStatus(emptyFiles(), status.stdout, name || 'HEAD', { root, cwd }).git
    await update($, filesGit, () => git)
  } catch {
    // Skipped silently.
  }
}

/** Porcelain paths are relative to the repository root; asked once per folder, the folder itself when git cannot say. */
async function gitRoot($: EngineInterface, cwd: string): Promise<string> {
  const known = gitRoots.get(cwd)
  if (known !== undefined) return known
  const r = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: GIT_TIMEOUT_MS }).catch(() => null)
  const root = r !== null && r.exitCode === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : cwd
  gitRoots.set(cwd, root)
  return root
}

// ---- The pane: open, list folders, the buttons ------------------------------------------------------------------

/** Before the pane opens, however it opens (the ui.open hook): list the tree's open folders and read git. */
async function preloadFiles($: EngineInterface): Promise<void> {
  try {
    const cwd = await sessionCwd($)
    const view = await read($, filesView)
    await loadFolders($, foldersToList(view.root || cwd, view.expanded), false)
    await refreshGit($)
  } catch {
    // The pane lists what it can when it draws.
  }
}

/** /files and /lk gates files: open the pane (the ui.open hook preloads it). */
async function openFiles($: EngineInterface): Promise<void> {
  await $.ui.open({ id: FILES_PANE, title: 'Files', focus: true, closeOnEscape: true })
}

/** Lists folders into filesListing: the ones missing, or (replace) all of them afresh, as Refresh does. */
async function loadFolders($: EngineInterface, dirs: string[], replace: boolean): Promise<void> {
  const have = replace ? {} : await read($, filesListing)
  const todo = [...new Set(dirs)].filter(d => replace || have[d] === undefined).slice(0, LOAD_FOLDERS_MAX)
  if (todo.length === 0 && !replace) return
  const listed = await Promise.all(todo.map(d => listFolder($, d)))
  const loaded: Record<string, LkFolderListing> = {}
  todo.forEach((d, i) => {
    loaded[d] = listed[i] as LkFolderListing
  })
  await update($, filesListing, l => {
    const merged: Record<string, LkFolderListing> = replace ? { ...loaded } : { ...l, ...loaded }
    const keys = Object.keys(merged)
    for (const k of keys.slice(0, Math.max(0, keys.length - LISTINGS_KEEP))) if (!(k in loaded)) delete merged[k]
    return merged
  })
}

/** One folder from $.fs.list, sorted and capped; a file the listing gives no time for is stat'ed (at most STAT_MAX). */
async function listFolder($: EngineInterface, abs: string): Promise<LkFolderListing> {
  try {
    const listing = toListing(await $.fs.list(abs))
    const undated = listing.entries.filter(x => x.kind === 'file' && x.mtimeMs <= 0).slice(0, STAT_MAX)
    await Promise.all(
      undated.map(async entry => {
        try {
          const st = await $.fs.stat(abs === '/' ? `/${entry.name}` : `${abs}/${entry.name}`)
          if (typeof st?.mtimeMs === 'number' && Number.isFinite(st.mtimeMs)) entry.mtimeMs = st.mtimeMs
        } catch {
          // No date for this file.
        }
      }),
    )
    return listing
  } catch (err) {
    const message = String((err as { message?: unknown } | null)?.message ?? err).replace(/\s+/g, ' ')
    return { entries: [], total: 0, error: message.slice(0, 80) || 'unreadable' }
  }
}

function filesActions($: EngineInterface, cwd: string): FilesActions {
  const setView = (fn: (v: LkFilesView) => LkFilesView) => update($, filesView, fn)
  return {
    refresh: async () => {
      const v = await read($, filesView)
      await loadFolders($, foldersToList(v.root || cwd, v.expanded), true)
      await refreshGit($)
    },
    collapseAll: () => setView(v => ({ ...v, expanded: [] })),
    toggleSizes: () => setView(v => ({ ...v, showSizes: !v.showSizes })),
    toggleHidden: () => setView(v => ({ ...v, showHidden: !v.showHidden })),
    up: async () => {
      const v = await read($, filesView)
      const cur = v.root || cwd
      const parent = parentOf(cur)
      if (parent === cur) return
      await loadFolders($, [parent], false)
      await setView(x => ({ ...x, root: parent === cwd ? '' : parent }))
    },
    back: async () => {
      await loadFolders($, [cwd], false)
      await setView(v => ({ ...v, root: '' }))
    },
    toggleDir: async (abs: string) => {
      const v = await read($, filesView)
      const open = v.expanded.includes(abs)
      if (!open) await loadFolders($, [abs], false)
      await setView(x => ({ ...x, expanded: open ? x.expanded.filter(d => d !== abs) : [...x.expanded.filter(d => d !== abs), abs] }))
    },
    find: (value: string) => setView(v => ({ ...v, filter: String(value ?? '') })),
  }
}

// ---- /files, /lk gates files and the /lk status line ------------------------------------------------------------

async function statusLine($: EngineInterface): Promise<string> {
  if (await isKilled($)) return `files ● off · ${DISABLE_ENV} names ${PLUGIN}, so nothing is tracked (/files still opens)`
  const n = touchedCount(await read($, filesTouched))
  const last = (await read($, filesActivity)).last
  return `files ● ${n} touched${last ? ` · last: ${last}` : ''}`
}

const failText = (next: any) =>
  `${PLUGIN}: the Files pane could not open (${next.error?.kind ?? 'throw'}: ${String(next.error?.message ?? '').slice(0, 120)}).`

const isGatesFiles = (args: unknown) => {
  const { sub, rest } = subOf(args)
  return sub === 'gates' && (rest[0] ?? '').toLowerCase() === 'files'
}

type LkResult = { text?: string }

/** /lk gates files opens the pane (the gates pass that word on); /lk status gets the files line. */
async function lk($: EngineInterface, e: { args?: unknown }, next: LkNext): Promise<LkResult> {
  if (isGatesFiles(e?.args)) {
    await openFiles($)
    return {}
  }
  const { sub, rest } = subOf(e?.args)
  if (sub === 'status') {
    const after = await next(e)
    let line = ''
    try {
      line = await statusLine($)
    } catch {
      line = `${PLUGIN}: the files line could not be read.`
    }
    return { ...(after ?? {}), text: joinText(line, after?.text) }
  }
  if (sub === 'band' && rest.some(w => w.toLowerCase() === 'files')) {
    // files has no band switch of its own: say which one it follows
    const after = await next(e)
    return { ...(after ?? {}), text: joinText('The files line follows the gates band: /lk band gates on|off.', after?.text) }
  }
  return (await next(e)) ?? {}
}

async function lkFailed($: EngineInterface, e: { args?: unknown }, next: any): Promise<LkResult> {
  if (next.called) return (await next(e)) ?? {}
  if (isGatesFiles(e?.args)) return { text: failText(next) }
  return (await next(e)) ?? {}
}

// ---- The hub row and the nav bar -----------------------------------------------------------------------------

/** The hub row's words: the band line without its label (`14 touched · last: read README.md`), or why it is off. */
async function hubWords($: EngineInterface): Promise<string> {
  if (await isKilled($)) return `off (${DISABLE_ENV}): nothing is tracked`
  const n = touchedCount(await read($, filesTouched))
  const last = (await read($, filesActivity)).last
  const band = await read($, gateBand)
  return [`${n} touched`, ...(last ? [`last: ${last}`] : []), ...(band ? [] : ['band off'])].join(' · ')
}

// HUB_ID, HUB_ROWS and PANES (every loopkeeper pane in wiring order) come from lib/panes.ts.

function toast($: EngineInterface, text: string): void {
  try {
    const p = $.ui.toast(text) as unknown
    if (p && typeof (p as Promise<unknown>).catch === 'function') (p as Promise<unknown>).catch(() => undefined)
  } catch {
    // display only
  }
}

// the "ctrl+x tab to focus the panel" toast showed this session (stage.ts's atom, shared by all six concern files)
const stageFocusHinted = atom({ plugin: 'loopkeeper', key: 'stageFocusHinted' } as const, false)

// Switch panes: close `fromId` first ('' closes nothing), since a focus request is refused while the person holds a
// pane, then open `toId` with the focus. The composer keeps the focus while it holds a draft: then a toast says how to
// reach the pane, once a session and only in the terminal (the press's `surface`; with no press, a session whose every
// surface is the terminal). False when the pane could not be opened.
async function switchTo($: EngineInterface, fromId: string, toId: string, title: string, surface?: unknown): Promise<boolean> {
  if (fromId) {
    try {
      await $.ui.close({ id: fromId })
    } catch {
      // already closed
    }
  }
  try {
    await $.ui.open({ id: toId, title, focus: true, closeOnEscape: true, ...(toId === HUB_ID ? { rows: HUB_ROWS } : {}) })
  } catch {
    return false
  }
  try {
    const pane = (await $.ui.panes()).find(p => p.id === toId)
    if (pane && !pane.isFocused && !(await read($, stageFocusHinted))) {
      const terminal = typeof surface === 'string' ? surface === 'terminal' : (await $.session.surfaces()).every(s => s === 'terminal')
      if (terminal) {
        await update($, stageFocusHinted, () => true)
        toast($, 'ctrl+x tab to focus the panel')
      }
    }
  } catch {
    // no list: no hint
  }
  return true
}

// The nav bar's items: every loopkeeper pane, a press switching from `fromId` to it
function navItems($: EngineInterface, fromId: string) {
  return PANES.map(p => ({
    key: p.key,
    label: p.label,
    hotkey: p.hotkey,
    onPress: async (e?: { surface?: unknown }) => {
      if (!(await switchTo($, fromId, p.id, p.title, e?.surface))) toast($, 'Could not open the ' + p.label + ' pane.')
    },
  }))
}

// ---- Wiring ----------------------------------------------------------------------------------------------------

export function wireFiles(on: On): void {
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    try {
      await $.command.register({
        name: CMD.files,
        description: 'Files: what Claude is reading right now, every file it touched this session, and the project tree',
        immediate: true,
      })
    } catch {
      // The name is taken; /lk gates files still opens the pane.
    }
    return next(e)
  })

  // /clear, /resume and /branch start a new conversation: the touched list, the hero and git start over.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try {
      await update($, filesTouched, () => [])
      await update($, filesActivity, () => ({ live: [], last: '' }))
      await update($, filesGit, () => null)
    } catch {
      // The old list stays until the next change.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: READ_TOOLS }, async ($, e, next) => {
    const path = await trackedPath($, editPath(e))
    if (path === null) return next(e)
    const tool = String(e.tool)
    return watchCall($, e, next, { verb: 'reading', path, tool }, s => noteRead(s, path, 'read', tool))
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: SEARCH_TOOLS }, async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>
    const pattern = typeof args.pattern === 'string' ? args.pattern : ''
    const where = typeof args.path === 'string' && args.path !== '' ? args.path : '.'
    const dir = pattern === '' ? null : await trackedPath($, where)
    if (dir === null) return next(e)
    const tool = String(e.tool)
    return watchCall($, e, next, { verb: 'searching', path: dir, pattern, tool }, s => noteSearch(s, tool, pattern, dir))
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const path = await trackedPath($, editPath(e))
    if (path === null) return next(e)
    const tool = String(e.tool)
    const existed = tool === 'Write' ? await fileExists($, path) : true
    const r = await watchCall($, e, next, { verb: 'editing', path, tool, creating: !existed }, s => noteEdit(s, path, !existed, tool))
    if (succeeded(r)) await refreshGit($)
    return r
  }).catch(($, e, next) => next(e))

  // A file a prompt @-mentions is read for Claude: recorded as opened when it exists. The prompt passes on unchanged.
  on('prompt.submit', {}, async ($, e, next) => {
    try {
      for (const raw of mentionedPaths(e.text)) {
        const path = await trackedPath($, raw)
        if (path === null || path === '') continue
        const there = await $.fs.exists(absOf(await sessionCwd($), path)).catch(() => false)
        if (there) await noteTouch($, s => noteRead(s, path, 'mention'))
      }
    } catch {
      // The prompt stands; the pane misses a file.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'files' }, async $ => {
    await openFiles($)
    return {}
  }).catch(async ($, e, next) => ({ text: failText(next) }))

  on('command.run', { command: 'lk' }, async ($, e, next) => lk($, e, next)).catch(($, e, next) => lkFailed($, e, next))
  on('command.run', { command: 'loopkeeper' }, async ($, e, next) => lk($, e, next)).catch(($, e, next) => lkFailed($, e, next))

  // Before the Files pane opens its folders are listed and git read: here for an open from a hook (/files, /lk gates
  // files); a Button's onPress runs beneath every hook, so its open skips this plugin's own ui.open hooks.
  on('ui.open', {}, async ($, e, next) => {
    if ((e as { id?: unknown }).id === FILES_PANE) await preloadFiles($)
    return next(e)
  })

  // ... and here for a press that opens it: the hub's Files row, or the Files item of a loopkeeper pane's nav bar.
  on('ui.press', { plugin: PLUGIN, element: ['panel-files', 'files'] }, async ($, e, next) => {
    await preloadFiles($)
    return next(e)
  })

  // The hub's Files row, above the later concerns' rows (next): `3: Files` and the band's words, quiet. It shows
  // with the band off or the kill switch on; a failure draws what the chain drew.
  on('ui.render', { component: 'Pane', requestId: HUB_ID }, async ($, e, next) => {
    let asked = false
    let theirs: unknown = null
    try {
      const ui = $.ui.resolve(e) as unknown as Elements
      const kit = makeKit(ui, e.surface)
      const row = kit.row({
        key: 'hub-files',
        left: [
          ui.Button({
            key: 'panel-files',
            label: 'Files',
            hotkey: '3',
            plain: true,
            onPress: async (press?: { surface?: unknown }) => {
              if (!(await switchTo($, HUB_ID, FILES_PANE, 'Files', press?.surface))) toast($, 'Could not open the Files pane.')
            },
          }),
          kit.text(await hubWords($), { color: TONES.muted.fg, wrap: 'truncate' }),
        ],
      })
      asked = true
      theirs = await next(e)
      return (theirs === null || theirs === undefined ? row : kit.stack([row, theirs])) as never
    } catch {
      return (asked ? theirs : await next(e)) as never
    }
  })

  // The band line: `files  ● N touched`, once something was touched, while the gates band is on.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const props = (e.props ?? {}) as { hasSurvey?: boolean }
    let mine: unknown = null
    try {
      if (props.hasSurvey !== true && !(await isKilled($)) && (await read($, gateBand))) {
        const n = touchedCount(await read($, filesTouched))
        if (n > 0) mine = makeKit($.ui.resolve(e) as unknown as Elements, e.surface).line('files', [`${n} touched`])
      }
    } catch {
      mine = null
    }
    if (mine === null) return next(e)
    const { Box } = $.ui.resolve(e)
    const theirs = await next(e)
    if (theirs === null || theirs === undefined) return mine as ReturnType<typeof Box>
    return Box({ flexDirection: 'column', children: [mine as ReturnType<typeof Box>, theirs] })
  })

  // The Files pane, the nav bar first. A drawing may read state, not write it: a folder not loaded yet is listed for
  // this drawing only.
  on('ui.render', { component: 'Pane', requestId: FILES_PANE }, async ($, e) => {
    const cwd = await sessionCwd($)
    const view = await read($, filesView)
    const listings = { ...(await read($, filesListing)) }
    const missing = foldersToList(view.root || cwd, view.expanded).filter(d => listings[d] === undefined).slice(0, RENDER_LIST_MAX)
    for (const d of missing) listings[d] = await listFolder($, d)
    const activity = await read($, filesActivity)
    const files: FilesState = { touched: await read($, filesTouched), live: activity.live, last: activity.last, git: await read($, filesGit) }
    // HOME draws a folder under it as `~/…`; the body's width sizes the hero's divider.
    const home = String((await $.env.get('HOME').catch(() => undefined)) ?? '')
    const columns = Number((e.props as { bodyColumns?: unknown } | undefined)?.bodyColumns) || undefined
    const ui = $.ui.resolve(e) as unknown as Elements
    const kit = makeKit(ui, e.surface)
    const nav = kit.nav(navItems($, FILES_PANE), 'files')
    return filesTree(kit, ui, { cwd, home, columns, files, view, listings }, filesActions($, cwd), nav) as never
  })
}
