// filesPane.ts: the Files pane, drawn with kit v3 (lib/kit.ts) plus an Input. Ported from change-control.
// Pure apart from the callbacks it is handed: files.ts reads the state, this builds the tree. files.ts hands in the
// nav bar too (kit.nav, `Files` current), drawn first.
//
//   0: Hub  1: Stage  2: Gates  Files  4: Routes  5: Reviews  6: Decisions
//   ╭──────────────────────────────────────────────────╮
//   │ ◉ RIGHT NOW                                      │
//   │   Claude is reading client.test.js               │
//   │   in tests                                       │
//   │ ──────────────────────────────────────────────── │
//   │ ⎇ feature                              3 changed │
//   │ ● Claude read  ● Claude edited  ● Not committed  │
//   ╰──────────────────────────────────────────────────╯
//   ⌕ Find a file: ____
//   [Refresh] [Collapse all] [Show sizes] [Up a folder] [Back to project] [Show hidden files]
//   ╭──────────────────────────────────────────────────╮
//   │ CLAUDE TOUCHED                           2 FILES │
//   │ JS client.test.js tests                ● Reading │
//   │ ⌕ TODO · src                          ● Searched │
//   ╰──────────────────────────────────────────────────╯
//   ALL FILES                                  PROJECT
//   ▾ src
//     TS index.ts                               09 Oct
//
// That is the terminal. Where the element table has Svg (desktop, mobile, vscode) the icons and type
// badges are Svg and the pills are filled; mobile has no Input, so no search row. Folders in the
// touched rows are drawn by kit's shortPath: relative in the project, `~/…` under HOME, `…/a/b`
// elsewhere, never a full absolute path. A pill sits in a Box that never shrinks: the name side truncates.

import type { LkFilesView, LkFolderListing } from '../../types/index.d.ts'
import { baseName, heroFor, touchedCount, touchedRows, treeRows } from './filesModel.ts'
import type { FilesState, TouchedRow, TreeRow } from './filesModel.ts'
import { TONES, extOf, shortPath } from './kit.ts'
import type { Elements, Kit } from './kit.ts'

export const FILES_PANE = 'files'

/** Keys of the pane's controls, for tests and for anything that handles ui.press / ui.input. */
export const FILES_KEYS = {
  find: 'files-find',
  refresh: 'files-refresh',
  collapse: 'files-collapse',
  sizes: 'files-sizes',
  up: 'files-up',
  back: 'files-back',
  hidden: 'files-hidden',
} as const

/** The tree draws at most this many Svg pictures (folder icons and type badges), then their text. */
export const TREE_SVG_CAP = 200

export type FilesPaneState = {
  cwd: string
  /** HOME, for `~/…` folders ('' when unknown). */
  home?: string
  /** The pane body's width in columns, for the hero's divider. */
  columns?: number
  files: FilesState
  view: LkFilesView
  listings: Record<string, LkFolderListing>
  now?: number
}

export type FilesActions = {
  refresh(): unknown
  collapseAll(): unknown
  toggleSizes(): unknown
  up(): unknown
  back(): unknown
  toggleHidden(): unknown
  toggleDir(abs: string): unknown
  find(value: string): unknown
}

/** The key of a folder's toggle button in the tree. */
export const dirKey = (abs: string) => `files-dir:${abs}`

/** Secondary text: the kit's quiet color (a theme key), never dim text. */
const QUIET = TONES.muted.fg
/** The eyebrow, the "Claude read" dot and the file Claude is on: the theme key of kit v3's violet pill. */
const VIOLET = 'permission'
/** The "Claude edited" and "Not committed" dots: Claude's color, never the theme's 'warning' key. */
const CLAUDE = TONES.accent.fg

/** An element maker from `$.ui.resolve(e)`; the kit's Elements type leaves each one possibly undefined. */
const make = (ui: Elements, type: string) => ui[type] as (props: Record<string, unknown>) => unknown
const present = (xs: unknown[]) => xs.filter(x => x !== null && x !== undefined && x !== false && x !== '')

export function filesTree(kit: Kit, ui: Elements, state: FilesPaneState, actions: FilesActions, nav: unknown = null): unknown {
  const root = state.view.root || state.cwd
  const filter = state.view.filter ?? ''
  const shortOf = (path: string) => shortPath(path, state.cwd, state.home ?? '')
  const Box = make(ui, 'Box')

  const find =
    typeof ui.Input === 'function'
      ? Box({
          flexDirection: 'row',
          alignItems: 'center',
          columnGap: 1,
          children: [
            Box({ flexShrink: 0, children: [kit.icon('search')] }),
            Box({
              flexGrow: 1,
              flexShrink: 1,
              children: [
                ui.Input({
                  key: FILES_KEYS.find,
                  label: 'Find a file',
                  placeholder: 'part of a name or path',
                  value: filter,
                  submitLabel: 'find',
                  onInput: (value: string) => actions.find(value),
                  onSubmit: (value: string) => actions.find(value),
                }),
              ],
            }),
          ],
        })
      : null

  const buttons = kit.buttons([
    { key: FILES_KEYS.refresh, label: 'Refresh', hotkey: 'r', onPress: () => actions.refresh() },
    { key: FILES_KEYS.collapse, label: 'Collapse all', hotkey: 'c', onPress: () => actions.collapseAll() },
    { key: FILES_KEYS.sizes, label: state.view.showSizes ? 'Hide sizes' : 'Show sizes', hotkey: 's', onPress: () => actions.toggleSizes() },
    { key: FILES_KEYS.up, label: 'Up a folder', hotkey: 'u', onPress: () => actions.up() },
    { key: FILES_KEYS.back, label: 'Back to project', hotkey: 'b', onPress: () => actions.back() },
    { key: FILES_KEYS.hidden, label: state.view.showHidden ? 'Hide hidden files' : 'Show hidden files', hotkey: 'h', onPress: () => actions.toggleHidden() },
  ])

  // Claude touched
  const rows = touchedRows(state.files, filter)
  const count = touchedCount(state.files.touched)
  const files = `${count} ${count === 1 ? 'file' : 'files'}`
  const touched = kit.card({
    children: [
      kit.header('Claude touched', filter.trim() ? `${files} · ${rows.length} shown` : files),
      ...(rows.length > 0
        ? rows.map(r => touchedRow(kit, ui, r, shortOf))
        : [kit.text(filter.trim() ? 'no touched file matches' : 'nothing yet: files Claude reads or edits show here', { color: QUIET })]),
    ],
  })

  // All files
  const tree = treeRows({
    root,
    cwd: state.cwd,
    listings: state.listings,
    expanded: state.view.expanded,
    showHidden: state.view.showHidden,
    showSizes: state.view.showSizes,
    query: filter,
    touched: state.files.touched,
    live: state.files.live,
    git: state.files.git,
    now: state.now,
  })
  const svgOk = kit.surface !== 'terminal' && typeof ui.Svg === 'function'
  let budget = TREE_SVG_CAP
  // The kit's picture (Svg) while the budget lasts, then text; on the terminal the kit draws text anyway.
  const pic = (svg: () => unknown, text: () => unknown): unknown => (!svgOk || budget-- > 0 ? svg() : text())
  const all = kit.stack([kit.header('All files', baseName(root) || '/'), ...tree.map(r => treeRow(kit, ui, r, actions, pic))])

  return kit.page([nav, heroCard(kit, ui, state, shortOf), find, buttons, touched, all])
}

/** The hero: the icon, RIGHT NOW, what Claude is doing and where; a divider, the branch row and the legend. */
function heroCard(kit: Kit, ui: Elements, state: FilesPaneState, shortOf: (path: string) => string): unknown {
  const Box = make(ui, 'Box')
  const hero = heroFor(state.files, shortOf)
  const git = state.files.git
  const changed = git ? Object.keys(git.changed).length : 0
  const top = Box({
    flexDirection: 'row',
    columnGap: 1,
    children: [
      Box({ flexShrink: 0, children: [kit.icon(hero.icon, hero.tone)] }),
      Box({
        flexDirection: 'column',
        flexShrink: 1,
        children: present([
          kit.text(hero.kicker.toUpperCase(), { bold: true, color: VIOLET, wrap: 'truncate' }),
          kit.text(hero.title, { bold: true, wrap: 'truncate' }),
          hero.sub ? kit.text(hero.sub, { color: QUIET, wrap: 'truncate' }) : null,
        ]),
      }),
    ],
  })
  const divider = kit.text('─'.repeat(Math.max(8, (state.columns ?? 64) - 4)), { color: QUIET, wrap: 'truncate' })
  const branch = git
    ? line(ui, 'files-branch', kit.icon('branch'), [kit.text(git.branch, { bold: true, wrap: 'truncate' })], kit.text(changed === 0 ? 'clean, nothing changed' : `${changed} changed`, { color: QUIET }))
    : null
  const dot = (color: string, label: string) => [kit.text('●', { color }), ` ${label}`]
  const legend = make(ui, 'Text')({
    wrap: 'wrap',
    children: [...dot(VIOLET, 'Claude read'), '  ', ...dot(CLAUDE, 'Claude edited'), '  ', ...dot(CLAUDE, 'Not committed')],
  })
  return kit.card({ children: [top, divider, branch, legend] })
}

/** One row: a leading picture, a left side that truncates, and a right side in a Box that never shrinks.
 *  Centered, so the Svg picture and pill sit on the middle of the text line. */
function line(ui: Elements, key: string, lead: unknown, left: unknown[], right: unknown): unknown {
  const Box = make(ui, 'Box')
  return Box({
    key,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    columnGap: 1,
    children: present([
      Box({ flexDirection: 'row', flexShrink: 1, alignItems: 'center', columnGap: 1, children: present([lead ? Box({ flexShrink: 0, children: [lead] }) : null, ...left]) }),
      right ? Box({ flexDirection: 'row', flexShrink: 0, alignItems: 'center', children: [right] }) : null,
    ]),
  })
}

function touchedRow(kit: Kit, ui: Elements, r: TouchedRow, shortOf: (path: string) => string): unknown {
  const folder = shortOf(r.folder)
  const name = kit.text(r.name, { bold: true, wrap: 'truncate' })
  const pill = r.badge ? kit.pill(r.badge.label, r.badge.tone) : null
  if (r.kind === 'search') {
    return line(ui, `files-touched:${r.id}`, kit.icon('search'), [name, kit.text(`· ${folder || 'project'}`, { color: QUIET, wrap: 'truncate' })], pill)
  }
  const where = folder ? kit.text(folder, { color: QUIET, wrap: 'truncate' }) : null
  return line(ui, `files-touched:${r.id}`, kit.typeBadge(r.name) ?? kit.icon('file'), present([name, where]), pill)
}

function treeRow(kit: Kit, ui: Elements, r: TreeRow, actions: FilesActions, pic: (svg: () => unknown, text: () => unknown) => unknown): unknown {
  let row: unknown
  if (r.kind === 'dir') {
    const icon = pic(
      () => kit.icon(r.open ? 'folder-open' : 'folder'),
      () => kit.text(r.open ? '▾' : '▸', { color: QUIET }),
    )
    const toggle = make(ui, 'Button')({ key: dirKey(r.abs), label: r.name, plain: true, onPress: () => actions.toggleDir(r.abs) })
    row = line(ui, `files-row:${r.key}`, icon, [toggle], null)
  } else if (r.kind === 'file') {
    const file = r.name.replace(/ ↗$/, '')
    const badge = pic(
      () => kit.typeBadge(file) ?? kit.icon('file'),
      () => kit.text(extOf(file).slice(0, 4).toUpperCase() || '·', { bold: true, color: QUIET }),
    )
    // The file Claude is on is bold violet with a lower-case pill; any other badge is its pill; else the date or size.
    const name = kit.text(r.name, r.live ? { bold: true, color: VIOLET, wrap: 'truncate' } : { wrap: 'truncate' })
    const right = r.badge ? kit.pill(r.live ? r.badge.label.toLowerCase() : r.badge.label, r.badge.tone) : r.right ? kit.text(r.right, { color: QUIET }) : null
    row = line(ui, `files-row:${r.key}`, badge, [name], right)
  } else {
    row = kit.text(r.text, { color: QUIET, wrap: 'truncate' })
  }
  if (r.depth <= 0) return row
  return make(ui, 'Box')({ key: `files-indent:${r.key}`, flexDirection: 'column', paddingLeft: r.depth * 2, children: [row] })
}
