// files.test.ts: the Files pane (hooks/files.ts, lib/filesModel.ts, lib/filesPane.ts), ported from change-control's
// files.test.ts. Kit v3 changed the look, not the meaning: the section headers are upper case ('CLAUDE TOUCHED', '1 FILE'),
// the hero's eyebrow reads 'RIGHT NOW', and a badge is a pill (a `● Opened` chip on the terminal).
import { expect, test } from 'claude-code/testing'

import {
  applyGitStatus,
  badgeFor,
  clearActivity,
  CREATING,
  emptyFiles,
  filterEntries,
  fmtDate,
  fmtSize,
  gitStatusOf,
  heroFor,
  LIST_CAP,
  noteEdit,
  noteRead,
  noteSearch,
  parseGitStatus,
  relativeTo,
  setActivity,
  toListing,
  TOUCHED_CAP,
  touchedRows,
  treeRows,
} from '../hooks/lib/filesModel.ts'
import { dirKey, FILES_KEYS, TREE_SVG_CAP } from '../hooks/lib/filesPane.ts'
import { TONE_HEX, TONES, pillSvg } from '../hooks/lib/kit.ts'
import type { PillTone } from '../hooks/lib/kit.ts'
import { noteBashWrites } from '../hooks/lib/gateRules.ts'
import { BAND, bash, CWD, HOME, lk, start, texts, world } from './world.ts'
import { render } from './render.ts'

const SURFACES = ['terminal', 'desktop'] as const
// 9 Oct 2026, noon UTC: the 9th in any time zone from UTC-11 to UTC+11
const OCT_9 = Date.UTC(2026, 9, 9, 12)

const FILES = {
  plugin: 'loopkeeper',
  component: 'Pane',
  requestId: 'files',
  surface: 'terminal',
  viewport: { columns: 144, rows: 60 },
  props: { title: 'Files', isFocused: true, bodyColumns: 140, placement: 'inline', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

// The session folder is /work/project; /work holds it beside etc, for "Up a folder".
const DIRS = {
  [CWD]: [
    { name: 'tests', kind: 'dir' as const },
    { name: 'src', kind: 'dir' as const },
    { name: '.git', kind: 'dir' as const },
    { name: 'node_modules', kind: 'dir' as const },
    { name: 'README.md', kind: 'file' as const, size: 2048, mtimeMs: OCT_9 },
    { name: '.env', kind: 'file' as const, size: 10, mtimeMs: OCT_9 },
  ],
  [`${CWD}/src`]: [
    { name: 'index.ts', kind: 'file' as const, size: 1536 },
    { name: 'lib', kind: 'dir' as const },
  ],
  [`${CWD}/src/lib`]: [{ name: 'util.ts', kind: 'file' as const, size: 100, mtimeMs: OCT_9 }],
  [`${CWD}/tests`]: [{ name: 'client.test.js', kind: 'file' as const, size: 300, mtimeMs: OCT_9 }],
  '/work': [
    { name: 'project', kind: 'dir' as const },
    { name: 'etc', kind: 'dir' as const },
  ],
}

/** Every string inside a found element, in order. */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object') return ''
  const n = node as { children?: unknown; props?: { children?: unknown } }
  const kids = n.children ?? n.props?.children ?? []
  return (Array.isArray(kids) ? kids : [kids]).map(textOf).join('')
}

/** A tree folder row's text: its icon's glyph on the terminal (▸ closed, ▾ open); the name is the Button's label. */
const folderIcon = async (ui: { find(q: unknown): Promise<unknown> }, abs: string) => textOf(await ui.find({ key: `files-row:dir:${abs}` }))

const editCall = (file: string, tool = 'Edit') =>
  tool === 'Write' ? { tool, file_path: file, content: 'x' } : { tool, file_path: file, old_string: 'a', new_string: 'b' }

// ---------------------------------------------------------------- the shape of next(e)

test('pin: await next(e) in a tool.call hook resolves to { result }, { result, isError } or { deny }, passed back unchanged', { timeoutMs: 20_000 }, async ($, on) => {
  const answers = [{ result: 'ran' }, { result: 'failed', isError: true }, { deny: 'refused' }]
  let n = 0
  world(on, { tool: e => (e.tool === 'Edit' ? answers[n++] : undefined) })
  await start($)
  expect(await $.tool.call(editCall(`${CWD}/a.ts`) as never)).toEqual({ result: 'ran' })
  expect(await $.tool.call(editCall(`${CWD}/b.ts`) as never)).toEqual({ result: 'failed', isError: true })
  expect(await $.tool.call(editCall(`${CWD}/c.ts`) as never)).toEqual({ deny: 'refused' })
  // Only the call that ran without an error counts as an edit
  const ui = await $.ui.mount(FILES)
  expect(await ui.find({ key: 'files-touched:a.ts' })).toBeDefined()
  expect(await ui.find({ key: 'files-touched:b.ts' })).toBeUndefined()
  expect(await ui.find({ key: 'files-touched:c.ts' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '1 FILE' })).toBeDefined()
})

// ---------------------------------------------------------------- what is recorded

test('reads from Read, NotebookRead, Grep, Glob and an @-mention are recorded with their badges', { timeoutMs: 20_000 }, async ($, on) => {
  world(on, { dirs: DIRS, files: { [`${CWD}/README.md`]: '# readme' } })
  await start($)
  expect(await $.tool.call({ tool: 'Read', file_path: `${CWD}/tests/client.test.js` } as never)).toEqual({ result: 'ran' })
  await $.tool.call({ tool: 'NotebookRead', notebook_path: `${CWD}/nb/plot.ipynb` } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'TODO', path: `${CWD}/src` } as never)
  await $.tool.call({ tool: 'Glob', pattern: '**/*.ts' } as never)
  await $.prompt.submit({ text: 'please read @README.md#L3-9, and write to a@b.example' } as never)
  const ui = await $.ui.mount(FILES)
  expect(await ui.find({ type: 'Text', text: '3 FILES' })).toBeDefined()
  const read = textOf(await ui.find({ key: 'files-touched:tests/client.test.js' }))
  expect(read).toContain('JS')
  expect(read).toContain('client.test.js')
  expect(read).toContain('tests')
  expect(read).toContain('● Opened')
  expect(textOf(await ui.find({ key: 'files-touched:nb/plot.ipynb' }))).toContain('● Opened')
  const grep = textOf(await ui.find({ key: 'files-touched:search:Grep:src:TODO' }))
  expect(grep).toContain('TODO')
  expect(grep).toContain('· src')
  expect(grep).toContain('● Searched')
  expect(textOf(await ui.find({ key: 'files-touched:search:Glob::**/*.ts' }))).toContain('· project')
  const mention = textOf(await ui.find({ key: 'files-touched:README.md' }))
  expect(mention).toContain('MD')
  expect(mention).toContain('● Opened')
  expect(await ui.find({ type: 'Text', text: 'last: opened README.md' })).toBeDefined()
})

test('a refused or failed read, and an @-mention of a file that is not there, are not recorded', async ($, on) => {
  world(on, { tool: e => (e.tool === 'Read' ? (String(e.file_path).endsWith('gone.ts') ? { result: 'no such file', isError: true } : { deny: 'denied by a rule' }) : undefined) })
  await start($)
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/gone.ts` } as never)
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/secret.ts` } as never)
  await $.prompt.submit({ text: 'and @big.bin' } as never)
  const ui = await $.ui.mount(FILES)
  expect(await ui.find({ type: 'Text', text: '0 FILES' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Claude is idle$/ })).toBeDefined()
})

test('an Edit is Edited, a Write of a missing path is Created, a Bash write is recorded, and git refreshes after an edit', async ($, on) => {
  const w = world(on, {
    files: { [`${CWD}/old.ts`]: 'x' },
    run: argv => (argv.join(' ') === 'git status --porcelain' ? { exitCode: 0, stdout: ' M old.ts\n?? new.ts\n' } : undefined),
  })
  await start($)
  await $.tool.call(editCall(`${CWD}/src/a.ts`) as never)
  await $.tool.call(editCall(`${CWD}/new.ts`, 'Write') as never)
  await $.tool.call(editCall(`${CWD}/old.ts`, 'Write') as never)
  expect((await $.tool.check(bash(`echo hi > ${CWD}/notes.txt`) as never)).decision).toBe('allow')
  expect(w.processes.filter(p => p.join(' ') === 'git status --porcelain').length).toBe(3)
  const ui = await $.ui.mount(FILES)
  expect(await ui.find({ type: 'Text', text: '4 FILES' })).toBeDefined()
  expect(textOf(await ui.find({ key: 'files-touched:src/a.ts' }))).toContain('● Edited')
  expect(textOf(await ui.find({ key: 'files-touched:new.ts' }))).toContain('● Created')
  expect(textOf(await ui.find({ key: 'files-touched:old.ts' }))).toContain('● Edited')
  expect(textOf(await ui.find({ key: 'files-touched:notes.txt' }))).toContain('● Created')
  expect(await ui.find({ type: 'Text', text: '2 changed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'last: created notes.txt' })).toBeDefined()
})

test('a Bash write the gates refuse is not recorded', async ($, on) => {
  world(on)
  await start($)
  expect((await $.tool.check(bash(`echo x > ${CWD}/.env.local`) as never)).decision).toBe('deny')
  const ui = await $.ui.mount(FILES)
  expect(await ui.find({ type: 'Text', text: '0 FILES' })).toBeDefined()
})

test('while a Read runs the hero says Claude is reading it and the row reads Reading; after, idle and Opened', async ($, on) => {
  let release: () => void = () => undefined
  let reached: () => void = () => undefined
  const gate = new Promise<void>(r => {
    release = r
  })
  const atNext = new Promise<void>(r => {
    reached = r
  })
  world(on, {
    tool: e =>
      e.tool === 'Read'
        ? (async () => {
            reached()
            await gate
            return { result: 'ran' }
          })()
        : undefined,
  })
  await start($)
  const call = $.tool.call({ tool: 'Read', file_path: `${CWD}/tests/client.test.js` } as never)
  await atNext
  let ui = await $.ui.mount(FILES)
  expect(await ui.find({ type: 'Text', text: 'RIGHT NOW' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Claude is reading client.test.js' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'in tests' })).toBeDefined()
  expect(textOf(await ui.find({ key: 'files-touched:tests/client.test.js' }))).toContain('● Reading')
  await ui.unmount()
  release()
  expect(await call).toEqual({ result: 'ran' })
  ui = await $.ui.mount(FILES)
  expect(await ui.find({ type: 'Text', text: 'last: read client.test.js' })).toBeDefined()
  expect(textOf(await ui.find({ key: 'files-touched:tests/client.test.js' }))).toContain('● Opened')
})

test('the activity is set before next and cleared after, also for a search', () => {
  let s = setActivity(emptyFiles(), { id: 'a1', verb: 'searching', path: 'src', pattern: 'TODO', tool: 'Grep', at: 1 })
  expect(heroFor(s)).toEqual({ kicker: 'right now', title: 'Claude is searching src for TODO', sub: 'with Grep', live: true, icon: 'search', tone: 'violet' })
  expect(touchedRows(s)[0]?.badge).toEqual({ label: 'Searching', tone: 'violet' })
  s = clearActivity(noteSearch(s, 'Grep', 'TODO', 'src', 2), 'a1')
  expect(s.live).toEqual([])
  expect(heroFor(s)).toMatchObject({ title: 'Claude is idle', sub: 'last: searched src for TODO', icon: 'clock' })
  expect(heroFor(emptyFiles())).toEqual({ kicker: 'right now', title: 'Claude is idle', sub: 'nothing read or edited yet', live: false, icon: 'clock' })
})

// ---------------------------------------------------------------- git

test('git porcelain: modified, untracked, added, renamed, quoted and folder entries all read as Not committed', () => {
  const text = [' M src/a.ts', '?? new.ts', 'A  added.ts', 'R  old name.ts -> renamed.ts', '?? "with space.ts"', '?? build/', '!! ignored.log', 'MM both.ts', ''].join('\n')
  expect(parseGitStatus(text)).toEqual([
    { xy: ' M', path: 'src/a.ts' },
    { xy: '??', path: 'new.ts' },
    { xy: 'A ', path: 'added.ts' },
    { xy: 'R ', path: 'renamed.ts' },
    { xy: '??', path: 'with space.ts' },
    { xy: '??', path: 'build/' },
    { xy: 'MM', path: 'both.ts' },
  ])
  const git = applyGitStatus(emptyFiles(), text, 'main').git
  expect(git?.branch).toBe('main')
  expect(Object.keys(git?.changed ?? {})).toHaveLength(7)
  for (const p of ['src/a.ts', 'new.ts', 'added.ts', 'renamed.ts', 'with space.ts', 'build/out/app.js', 'both.ts']) {
    expect(badgeFor(undefined, git, { path: p })).toEqual({ label: 'Not committed', tone: 'accent' })
  }
  expect(badgeFor(undefined, git, { path: 'old name.ts' })).toBe(null)
  expect(badgeFor(undefined, git, { path: 'ignored.log' })).toBe(null)
  expect(applyGitStatus(emptyFiles(), '', 'main').git).toEqual({ branch: 'main', changed: {} })
  // Porcelain paths are relative to the repository root; the pane keys them as touched paths are
  const sub = applyGitStatus(emptyFiles(), ' M app/x.ts\n M other/y.ts\n?? app/gen/\n', 'dev', { root: '/repo', cwd: '/repo/app' }).git
  expect(Object.keys(sub?.changed ?? {})).toEqual(['x.ts', '/repo/other/y.ts', 'gen/'])
  expect(gitStatusOf(sub, 'gen/types.d.ts')).toBe('??')
})

test('badges: live first, then Created, Edited, Not committed, Searched, Opened', () => {
  const git = applyGitStatus(emptyFiles(), ' M a.ts\n', 'main').git
  let s = noteRead(emptyFiles(), 'a.ts', 'read', 'Read', 1)
  expect(badgeFor(s.touched[0], null)).toEqual({ label: 'Opened', tone: 'violet' })
  expect(badgeFor(s.touched[0], git)).toEqual({ label: 'Not committed', tone: 'accent' })
  s = noteEdit(s, 'a.ts', false, 'Edit', 2)
  expect(badgeFor(s.touched[0], git)).toEqual({ label: 'Edited', tone: 'accent' })
  s = noteEdit(s, 'b.ts', true, 'Write', 3)
  s = noteEdit(s, 'b.ts', false, 'Edit', 4)
  expect(badgeFor(s.touched.find(t => t.id === 'b.ts'), git)).toEqual({ label: 'Created', tone: 'ok' })
  expect(badgeFor(s.touched[0], git, { live: { id: 'x', verb: 'editing', path: 'a.ts', tool: 'Edit', at: 5 } })).toEqual({ label: 'Editing', tone: 'accent' })
  expect(badgeFor(undefined, null)).toBe(null)
})

test('outside a git repository the pane draws no branch line; inside one it says clean', async ($, on) => {
  world(on, { dirs: DIRS, run: argv => (argv[1] === 'status' ? { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } : undefined) })
  await start($)
  await $.command.run({ command: 'files', args: '' } as never)
  const ui = await $.ui.mount(FILES)
  expect(await ui.find({ type: 'Text', text: /clean, nothing changed|changed$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'PROJECT' })).toBeDefined()
})

// ---------------------------------------------------------------- the tree

test('the tree: folders first, hidden entries hidden, lazy expand and collapse, sizes, hidden toggle, up and back', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, { dirs: DIRS, stats: { [`${CWD}/src/index.ts`]: OCT_9 } })
  await start($)
  await $.command.run({ command: 'files', args: '' } as never)
  expect(w.listed).toEqual([CWD])
  const ui = await $.ui.mount(FILES)
  expect(await ui.find({ type: 'Text', text: 'clean, nothing changed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'PROJECT' })).toBeDefined()
  const src: any = await ui.find({ key: dirKey(`${CWD}/src`) })
  expect(src?.props?.label).toBe('src')
  expect(await folderIcon(ui, `${CWD}/src`)).toBe('▸')
  expect(((await ui.find({ key: dirKey(`${CWD}/tests`) })) as any)?.props?.label).toBe('tests')
  expect(await folderIcon(ui, `${CWD}/tests`)).toBe('▸')
  expect(await ui.find({ key: dirKey(`${CWD}/.git`) })).toBeUndefined()
  expect(await ui.find({ key: dirKey(`${CWD}/node_modules`) })).toBeUndefined()
  expect(await ui.find({ key: `files-row:file:${CWD}/.env` })).toBeUndefined()
  expect(textOf(await ui.find({ key: `files-row:file:${CWD}/README.md` }))).toMatch(/README\.md09 Oct/)
  expect(await ui.find({ type: 'Text', text: '3 hidden' })).toBeDefined()

  // Expand: the folder is listed only now; its file has no time in the listing, so it is stat'ed
  await ui.press({ key: dirKey(`${CWD}/src`) })
  expect(w.listed).toEqual([CWD, `${CWD}/src`])
  expect(((await ui.find({ key: dirKey(`${CWD}/src`) })) as any)?.props?.label).toBe('src')
  expect(await folderIcon(ui, `${CWD}/src`)).toBe('▾')
  expect(textOf(await ui.find({ key: `files-row:file:${CWD}/src/index.ts` }))).toContain('09 Oct')
  expect(await ui.find({ key: `files-indent:file:${CWD}/src/index.ts` })).toBeDefined()

  // Sizes
  await ui.press({ key: FILES_KEYS.sizes })
  expect(((await ui.find({ key: FILES_KEYS.sizes })) as any)?.props?.label).toBe('Hide sizes')
  expect(textOf(await ui.find({ key: `files-row:file:${CWD}/README.md` }))).toContain('2 KB')
  expect(textOf(await ui.find({ key: `files-row:file:${CWD}/src/index.ts` }))).toContain('1.5 KB')

  // Hidden files
  await ui.press({ key: FILES_KEYS.hidden })
  expect(((await ui.find({ key: FILES_KEYS.hidden })) as any)?.props?.label).toBe('Hide hidden files')
  expect(await ui.find({ key: dirKey(`${CWD}/.git`) })).toBeDefined()
  expect(await ui.find({ key: `files-row:file:${CWD}/.env` })).toBeDefined()
  await ui.press({ key: FILES_KEYS.hidden })
  expect(await ui.find({ key: dirKey(`${CWD}/.git`) })).toBeUndefined()

  // Collapse all
  await ui.press({ key: FILES_KEYS.collapse })
  expect(((await ui.find({ key: dirKey(`${CWD}/src`) })) as any)?.props?.label).toBe('src')
  expect(await folderIcon(ui, `${CWD}/src`)).toBe('▸')
  expect(await ui.find({ key: `files-row:file:${CWD}/src/index.ts` })).toBeUndefined()

  // Up a folder, then back to the project
  await ui.press({ key: FILES_KEYS.up })
  expect(await ui.find({ type: 'Text', text: 'WORK' })).toBeDefined()
  expect(await ui.find({ key: dirKey(CWD) })).toBeDefined()
  expect(await ui.find({ key: dirKey('/work/etc') })).toBeDefined()
  await ui.press({ key: FILES_KEYS.back })
  expect(await ui.find({ type: 'Text', text: 'PROJECT' })).toBeDefined()
  expect(await ui.find({ key: dirKey(`${CWD}/src`) })).toBeDefined()
})

test('Find a file filters touched rows and loaded entries, and opens folders that hold a match', async ($, on) => {
  world(on, { dirs: DIRS })
  await start($)
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/src/lib/util.ts` } as never)
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/README.md` } as never)
  await $.command.run({ command: 'files', args: '' } as never)
  const ui = await $.ui.mount(FILES)
  await ui.press({ key: dirKey(`${CWD}/src`) })
  await ui.press({ key: dirKey(`${CWD}/src/lib`) })
  await ui.press({ key: FILES_KEYS.collapse })
  expect(await ui.find({ key: `files-row:file:${CWD}/src/lib/util.ts` })).toBeUndefined()

  await ui.input({ key: FILES_KEYS.find, text: 'UTIL' })
  expect(((await ui.find({ key: FILES_KEYS.find })) as any)?.props?.value).toBe('UTIL')
  expect(((await ui.find({ key: dirKey(`${CWD}/src`) })) as any)?.props?.label).toBe('src')
  expect(await folderIcon(ui, `${CWD}/src`)).toBe('▾')
  expect(((await ui.find({ key: dirKey(`${CWD}/src/lib`) })) as any)?.props?.label).toBe('lib')
  expect(await folderIcon(ui, `${CWD}/src/lib`)).toBe('▾')
  expect(textOf(await ui.find({ key: `files-row:file:${CWD}/src/lib/util.ts` }))).toContain('● Opened')
  expect(await ui.find({ key: `files-row:file:${CWD}/README.md` })).toBeUndefined()
  expect(await ui.find({ key: dirKey(`${CWD}/tests`) })).toBeUndefined()
  expect(await ui.find({ key: 'files-touched:src/lib/util.ts' })).toBeDefined()
  expect(await ui.find({ key: 'files-touched:README.md' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '2 FILES · 1 SHOWN' })).toBeDefined()

  await ui.input({ key: FILES_KEYS.find, text: 'nothing-like-this', kind: 'change' } as never)
  expect(await ui.find({ type: 'Text', text: 'no touched file matches' })).toBeDefined()
  await ui.input({ key: FILES_KEYS.find, text: '' })
  expect(await ui.find({ key: 'files-touched:README.md' })).toBeDefined()
  expect(((await ui.find({ key: dirKey(`${CWD}/src`) })) as any)?.props?.label).toBe('src')
  expect(await folderIcon(ui, `${CWD}/src`)).toBe('▸')
})

test('the pane validates on both surfaces and Refresh lists the folders and reads git again', async ($, on) => {
  const w = world(on, { dirs: DIRS })
  await start($)
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/README.md` } as never)
  await $.command.run({ command: 'files', args: '' } as never)
  const gitRuns = () => w.processes.filter(p => p.join(' ') === 'git status --porcelain').length
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...FILES, surface } as never)
    expect(await ui.find({ type: 'Text', text: 'RIGHT NOW' })).toBeDefined()
    expect(await ui.find({ key: FILES_KEYS.find })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Claude read/ })).toBeDefined()
    // The pill is a `● Opened` Text on the terminal and an Svg chip with that alt on the desktop.
    const readme = await ui.find({ key: 'files-touched:README.md' })
    expect([textOf(readme), ...altsIn(readme)].join(' ')).toContain('Opened')
    const listed = w.listed.length
    const runs = gitRuns()
    await ui.press({ key: FILES_KEYS.refresh })
    expect(w.listed.length).toBe(listed + 1)
    expect(w.listed[w.listed.length - 1]).toBe(CWD)
    expect(gitRuns()).toBe(runs + 1)
    await ui.unmount()
  }
})

test('a folder that cannot be listed says so', async ($, on) => {
  world(on, { dirs: { [CWD]: [{ name: 'locked', kind: 'dir' }] } })
  await start($)
  await $.command.run({ command: 'files', args: '' } as never)
  const ui = await $.ui.mount(FILES)
  await ui.press({ key: dirKey(`${CWD}/locked`) })
  expect(await ui.find({ type: 'Text', text: /^cannot list: / })).toBeDefined()
})

// ---------------------------------------------------------------- band and commands

test('the files band line says files ● n touched (distinct files, not searches), only once something was touched', async ($, on) => {
  world(on)
  await start($)
  let ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: / touched$/ })).toBeUndefined()
  expect(texts(await ui.drawn())).not.toContain('files')
  await ui.unmount()
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts` } as never)
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts` } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'x' } as never)
  await $.tool.call(editCall(`${CWD}/b.ts`) as never)
  ui = await $.ui.mount(BAND)
  const label: any = await ui.find({ type: 'Text', text: /^files$/ })
  expect(label?.props?.bold).toBe(true)
  const chip: any = await ui.find({ type: 'Text', text: '● 2 touched' })
  expect(chip?.props?.color).toBe('inactive')
  expect(chip?.props?.dimColor).toBeUndefined()
  // the gates band switch turns it off with the gates line
  await ui.unmount()
  await lk($, 'band gates off')
  ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: '● 2 touched' })).toBeUndefined()
  // files has no switch of its own, and says which one it follows
  expect(await lk($, 'band files on')).toContain('The files line follows the gates band: /lk band gates on|off.')
})

test('the files band line draws the same on the terminal and the desktop, in theme keys, with no dimColor or backgroundColor', async ($, on) => {
  world(on)
  await start($)
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts` } as never)
  await $.tool.call(editCall(`${CWD}/b.ts`) as never)
  const keys: string[] = [...Object.values(TONES).map(x => x.fg), 'inactive']
  const lines: string[] = []
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface } as never)
    const chip: any = await ui.find({ type: 'Text', text: '● 2 touched' })
    expect(chip).toBeDefined()
    expect(keys).toContain(chip.props?.color)
    expect(chip.props?.dimColor).toBeUndefined()
    expect(chip.props?.backgroundColor).toBeUndefined()
    const label: any = await ui.find({ type: 'Text', text: /^files$/ })
    expect(label?.props?.bold).toBe(true)
    expect(label?.props?.dimColor).toBeUndefined()
    expect(label?.props?.backgroundColor).toBeUndefined()
    expect(JSON.stringify(await ui.drawn())).not.toMatch(/dimColor|backgroundColor/)
    lines.push(texts(await ui.drawn()).join(''))
    await ui.unmount()
  }
  expect(lines[1]).toBe(lines[0])
  expect(lines[0]).toContain('● 2 touched')
})

test('/files is registered to run mid-turn; /files and /lk gates files open the pane, titled Files', async ($, on) => {
  const { w, opened } = linked(on)
  await start($)
  expect(w.commands.find(c => c.name === 'files')).toMatchObject({ name: 'files', immediate: true })
  expect(await $.command.run({ command: 'files', args: '' } as never)).toEqual({})
  expect(await $.command.run({ command: 'lk', args: 'gates files' } as never)).toEqual({})
  expect(await $.command.run({ command: 'loopkeeper', args: 'gates files' } as never)).toEqual({})
  expect(w.panes).toEqual(['files', 'files', 'files'])
  expect(opened.map(e => e.title)).toEqual(['Files', 'Files', 'Files'])
})

test('/clear starts the touched list over', async ($, on) => {
  world(on)
  await start($)
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts` } as never)
  await $.classic.SessionStart({ source: 'clear' } as never)
  const ui = await $.ui.mount(FILES)
  expect(await ui.find({ type: 'Text', text: '0 FILES' })).toBeDefined()
})

// ---------------------------------------------------------------- pure helpers

test('fmtSize, fmtDate and relativeTo', () => {
  expect(fmtSize(0)).toBe('0 B')
  expect(fmtSize(-4)).toBe('0 B')
  expect(fmtSize(512)).toBe('512 B')
  expect(fmtSize(1536)).toBe('1.5 KB')
  expect(fmtSize(2048)).toBe('2 KB')
  expect(fmtSize(34 * 1024 + 100)).toBe('34 KB')
  expect(fmtSize(1.2 * 1024 * 1024)).toBe('1.2 MB')
  expect(fmtSize(3 * 1024 ** 3)).toBe('3 GB')
  expect(fmtDate(OCT_9, OCT_9)).toBe('09 Oct')
  expect(fmtDate(Date.UTC(2023, 2, 15, 12), OCT_9)).toBe('15 Mar 2023')
  expect(fmtDate(0)).toBe('')
  expect(relativeTo('/work', '/work/src/a.ts')).toBe('src/a.ts')
  expect(relativeTo('/work/', '/work')).toBe('')
  expect(relativeTo('/work', '/workshop/a.ts')).toBe('/workshop/a.ts')
  expect(relativeTo('/', '/etc/hosts')).toBe('etc/hosts')
})

test('filterEntries ignores case and keeps everything for an empty query', () => {
  const items = [{ path: 'src/Client.ts' }, { path: 'README.md' }]
  expect(filterEntries(items, 'client')).toEqual([{ path: 'src/Client.ts' }])
  expect(filterEntries(items, '  ')).toEqual(items)
  expect(filterEntries(items, 'md', i => i.path)).toEqual([{ path: 'README.md' }])
})

test('limits: the touched list keeps the newest 200; a folder draws 400 entries then "… and N more"', () => {
  let s = emptyFiles()
  for (let i = 0; i < TOUCHED_CAP + 5; i++) s = noteRead(s, `f${i}.ts`, 'read', 'Read', i)
  expect(s.touched).toHaveLength(TOUCHED_CAP)
  expect(s.touched[0]?.path).toBe('f5.ts')
  expect(touchedRows(s)[0]?.name).toBe(`f${TOUCHED_CAP + 4}.ts`)
  // touching an entry again moves it to the newest end without a duplicate
  s = noteEdit(s, 'f5.ts', false, 'Edit', 999)
  expect(s.touched.filter(t => t.id === 'f5.ts')).toHaveLength(1)
  expect(s.touched[s.touched.length - 1]?.id).toBe('f5.ts')

  const many = Array.from({ length: LIST_CAP + 50 }, (_, i) => ({ name: `file${String(i).padStart(3, '0')}.txt`, kind: 'file', size: 1, mtimeMs: 0, isLink: false }))
  const rows = treeRows({
    root: '/big',
    cwd: '/big',
    listings: { '/big': toListing(many) },
    expanded: [],
    showHidden: false,
    showSizes: false,
    query: '',
    touched: [],
    live: [],
    git: null,
  })
  expect(rows.filter(r => r.kind === 'file')).toHaveLength(LIST_CAP)
  expect(rows[rows.length - 1]).toEqual({ kind: 'note', key: 'more:/big', depth: 0, text: '… and 50 more' })
})

// ---------------------------------------------------------------- new in loopkeeper

test('/lk status has the files line; a Bash write the gates record while a Read runs keeps both entries', async ($, on) => {
  let release: () => void = () => undefined
  let reached: () => void = () => undefined
  const gate = new Promise<void>(r => {
    release = r
  })
  const atNext = new Promise<void>(r => {
    reached = r
  })
  world(on, {
    tool: e =>
      e.tool === 'Read'
        ? (async () => {
            reached()
            await gate
            return { result: 'ran' }
          })()
        : undefined,
  })
  await start($)
  expect(await lk($, 'status')).toContain('files ● 0 touched')
  const call = $.tool.call({ tool: 'Read', file_path: `${CWD}/tests/client.test.js` } as never)
  await atNext
  // the gates record the Bash write through update while the Read is in flight
  expect((await $.tool.check(bash(`echo hi > ${CWD}/notes.txt`) as never)).decision).toBe('allow')
  expect(await lk($, 'status')).toContain('files ● 1 touched · last: created notes.txt')
  release()
  await call
  const status = await lk($, 'status')
  expect(status).toContain('files ● 2 touched · last: read client.test.js')
  const ui = await $.ui.mount(FILES)
  expect(textOf(await ui.find({ key: 'files-touched:notes.txt' }))).toContain('● Created')
  expect(textOf(await ui.find({ key: 'files-touched:tests/client.test.js' }))).toContain('● Opened')
  expect(await ui.find({ type: 'Text', text: /^Claude is reading/ })).toBeUndefined()
})

test("the gates' noteBashWrites records a Bash write as the Files model's noteEdit does", () => {
  const seed = noteRead(emptyFiles(), 'a.txt', 'read', 'Read', 1).touched
  const viaGates = noteBashWrites(seed, [{ path: 'a.txt', created: false }, { path: 'b.txt', created: true }], 7)
  let viaFiles = { ...emptyFiles(), touched: seed }
  viaFiles = noteEdit(viaFiles, 'a.txt', false, 'Bash', 7)
  viaFiles = noteEdit(viaFiles, 'b.txt', true, 'Bash', 7)
  expect(viaGates.touched).toEqual(viaFiles.touched)
  expect(viaGates.last).toBe(viaFiles.last)
  expect(viaGates.touched[0]).toMatchObject({ id: 'a.txt', read: true, edited: true, created: false, tool: 'Bash' })
})

test('CLAUDE_MODS_DISABLE=loopkeeper: nothing is tracked and no band line is drawn, but /files still opens', async ($, on) => {
  const w = world(on, { env: { CLAUDE_MODS_DISABLE: 'loopkeeper' } })
  await start($)
  expect(await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts` } as never)).toEqual({ result: 'ran' })
  expect(await $.tool.call(editCall(`${CWD}/b.ts`) as never)).toEqual({ result: 'ran' })
  expect(w.processes.filter(p => p.join(' ') === 'git status --porcelain')).toEqual([])
  expect(await lk($, 'status')).toContain('files ● off · CLAUDE_MODS_DISABLE names loopkeeper')
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: / touched$/ })).toBeUndefined()
  await band.unmount()
  expect(await $.command.run({ command: 'files', args: '' } as never)).toEqual({})
  expect(w.panes).toEqual(['files'])
  const ui = await $.ui.mount(FILES)
  expect(await ui.find({ type: 'Text', text: '0 FILES' })).toBeDefined()
})

// ---------------------------------------------------------------- kit v3: the reference look

type Drawn = { type?: string; props?: Record<string, any>; children?: unknown[] }

/** Every node of a drawn tree, depth first. */
function nodesOf(node: unknown, out: Drawn[] = []): Drawn[] {
  if (!node || typeof node !== 'object') return out
  const n = node as Drawn
  out.push(n)
  for (const c of n.children ?? []) nodesOf(c, out)
  return out
}

/** The tone of a drawn pill: the tone whose Svg chip it is (alt = the pill text); undefined for any other node. */
const pillTone = (n: Drawn): PillTone | undefined =>
  n.type === 'Svg' ? (Object.keys(TONE_HEX) as PillTone[]).find(t => pillSvg(String(n.props?.alt), t) === n.props?.source) : undefined

/** The pills in a drawn subtree: Svg chips. */
const pillsIn = (node: unknown) => nodesOf(node).filter(n => pillTone(n) !== undefined)

/** The alt text of every Svg in a drawn subtree. */
const altsIn = (node: unknown) => nodesOf(node).filter(n => n.type === 'Svg').map(n => String(n.props?.alt))

/** A world where calls to `tool` wait at next until released. */
function held(on: unknown, tool: string, opts: Record<string, unknown> = {}) {
  let release: () => void = () => undefined
  let reached: () => void = () => undefined
  const gate = new Promise<void>(r => {
    release = r
  })
  const atNext = new Promise<void>(r => {
    reached = r
  })
  const w = world(on, {
    ...opts,
    tool: (e: { tool?: unknown }) =>
      e.tool === tool
        ? (async () => {
            reached()
            await gate
            return { result: 'ran' }
          })()
        : undefined,
  })
  return { w, atNext, release: () => release() }
}

const DIRTY = (argv: string[]) => (argv.join(' ') === 'git status --porcelain' ? { exitCode: 0, stdout: ' M README.md\n' } : undefined)

async function touchSome($: any) {
  await start($)
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/tests/client.test.js` } as never)
  await $.tool.call(editCall(`${CWD}/src/index.ts`) as never)
  await $.tool.call({ tool: 'Grep', pattern: 'TODO', path: `${CWD}/src` } as never)
  await $.command.run({ command: 'files', args: '' } as never)
}

test('kit v3 desktop: RIGHT NOW hero with icons, branch row and legend; type badges; pills that never shrink', async ($, on) => {
  world(on, { dirs: DIRS, run: DIRTY })
  await touchSome($)
  const ui = await $.ui.mount({ ...FILES, surface: 'desktop' } as never)
  const tree = await ui.drawn()
  // kit 3.1: the pane is a page, one row between its blocks
  expect((tree as any).props).toMatchObject({ flexDirection: 'column', rowGap: 1 })
  expect(((await ui.find({ type: 'Text', text: 'RIGHT NOW' })) as any)?.props).toMatchObject({ bold: true, color: 'permission' })
  expect(await ui.find({ type: 'Text', text: 'Claude is idle' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'last: searched src for TODO' })).toBeDefined()
  const alts = altsIn(tree)
  for (const alt of ['clock', 'branch', 'search', 'JS', 'TS', 'MD', 'folder']) expect(alts).toContain(alt)
  expect(((await ui.find({ type: 'Text', text: 'feature' })) as any)?.props).toMatchObject({ bold: true })
  expect(((await ui.find({ type: 'Text', text: '1 changed' })) as any)?.props?.color).toBe('inactive')
  const legend = nodesOf(await ui.find({ type: 'Text', text: /Claude read/ })).filter(n => n.type === 'Text' && textOf(n) === '●')
  expect(legend.map(n => n.props?.color)).toEqual(['permission', 'claude', 'claude'])
  expect(((await ui.find({ type: 'Text', text: 'CLAUDE TOUCHED' })) as any)?.props).toMatchObject({ bold: true, color: 'inactive' })
  expect(await ui.find({ type: 'Text', text: '2 FILES' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ALL FILES' })).toBeDefined()
  const want: Array<[string, string, PillTone]> = [
    ['files-touched:tests/client.test.js', 'Opened', 'violet'],
    ['files-touched:src/index.ts', 'Edited', 'accent'],
    ['files-touched:search:Grep:src:TODO', 'Searched', 'violet'],
    [`files-row:file:${CWD}/README.md`, 'Not committed', 'accent'],
  ]
  for (const [key, text, tone] of want) {
    const row = await ui.find({ key })
    const pills = pillsIn(row)
    expect(pills.map(p => p.props?.alt)).toEqual([text])
    expect(pills[0]?.props).toMatchObject({ source: pillSvg(text, tone), height: 18 })
    expect(String(pills[0]?.props?.source)).toContain('height="18" rx="9"')
    // The chip never shrinks and sits on the middle of the row.
    const holder = nodesOf(row).find(n => n.type === 'Box' && (n.children ?? []).includes(pills[0]))
    expect(holder?.props).toMatchObject({ flexShrink: 0, alignItems: 'center' })
    expect(nodesOf(row)[0]?.props?.alignItems).toBe('center')
  }
  expect(altsIn(await ui.find({ key: 'files-touched:tests/client.test.js' }))).toEqual(['JS', 'Opened'])
  // Colours: theme keys only, and no fill anywhere: the pills are Svg chips.
  const json = JSON.stringify(tree)
  expect(json).not.toMatch(/backgroundColor|dimColor|yellow|white|gray|grey|black|subtle/i)
  expect(json).toContain('"borderStyle":"round"')
  await ui.unmount()
})

test('kit v3 terminal: the same parts as text, no Svg and no fill', async ($, on) => {
  world(on, { dirs: DIRS, run: DIRTY })
  await touchSome($)
  const ui = await $.ui.mount(FILES)
  const json = JSON.stringify(await ui.drawn())
  expect(json).not.toContain('"type":"Svg"')
  expect(json).not.toMatch(/backgroundColor|dimColor|yellow|white|gray|grey|black|subtle/i)
  expect(((await ui.find({ type: 'Text', text: 'RIGHT NOW' })) as any)?.props?.color).toBe('permission')
  expect(await ui.find({ type: 'Text', text: '◷' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '⎇' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '⌕' })).toBeDefined()
  expect(((await ui.find({ type: 'Text', text: '● Opened' })) as any)?.props).toMatchObject({ color: 'permission', bold: true })
  expect(((await ui.find({ type: 'Text', text: '● Edited' })) as any)?.props?.color).toBe('claude')
  expect(textOf(await ui.find({ key: 'files-touched:tests/client.test.js' }))).toMatch(/^JSclient\.test\.jstests● Opened$/)
  expect(textOf(await ui.find({ key: `files-row:file:${CWD}/README.md` }))).toBe('MDREADME.md● Not committed')
  await ui.unmount()
})

test('kit v3 desktop: while a Read runs the hero has the eye and the tree row is bold violet with a "reading" pill', async ($, on) => {
  const h = held(on, 'Read', { dirs: DIRS })
  await start($)
  const call = $.tool.call({ tool: 'Read', file_path: `${CWD}/tests/client.test.js` } as never)
  await h.atNext
  const ui = await $.ui.mount({ ...FILES, surface: 'desktop' } as never)
  await ui.press({ key: dirKey(`${CWD}/tests`) })
  expect(altsIn(await ui.drawn())[0]).toBe('eye')
  expect(await ui.find({ type: 'Text', text: 'in tests' })).toBeDefined()
  expect(pillsIn(await ui.find({ key: 'files-touched:tests/client.test.js' })).map(p => p.props?.alt)).toEqual(['Reading'])
  const row = await ui.find({ key: `files-row:file:${CWD}/tests/client.test.js` })
  const name = nodesOf(row).find(n => n.type === 'Text' && textOf(n) === 'client.test.js')
  expect(name?.props).toMatchObject({ bold: true, color: 'permission' })
  expect(pillsIn(row).map(p => p.props?.alt)).toEqual(['reading'])
  await ui.unmount()
  h.release()
  expect(await call).toEqual({ result: 'ran' })
})

test('kit v3: a Write of a missing file is "creating" with the plus; the hero icons and the Deleted pill', async ($, on) => {
  const h = held(on, 'Write', { dirs: DIRS })
  await start($)
  const call = $.tool.call(editCall(`${CWD}/new.ts`, 'Write') as never)
  await h.atNext
  const ui = await $.ui.mount({ ...FILES, surface: 'desktop' } as never)
  expect(altsIn(await ui.drawn())[0]).toBe('plus')
  expect(await ui.find({ type: 'Text', text: 'Claude is creating new.ts' })).toBeDefined()
  expect(pillsIn(await ui.find({ key: 'files-touched:new.ts' })).map(pillTone)).toEqual(['ok'])
  await ui.unmount()
  h.release()
  await call
  const live = (verb: 'reading' | 'editing' | 'searching', id = 'm:1') => heroFor({ live: [{ id, verb, path: 'tests/a.js', pattern: 'x', tool: 'T', at: 1 }], last: '' })
  expect(live('reading')).toMatchObject({ icon: 'eye', tone: 'violet', title: 'Claude is reading a.js', sub: 'in tests' })
  expect(live('editing')).toMatchObject({ icon: 'pencil', tone: 'accent', title: 'Claude is editing a.js' })
  expect(live('editing', `m:2${CREATING}`)).toMatchObject({ icon: 'plus', tone: 'ok', title: 'Claude is creating a.js' })
  expect(live('searching')).toMatchObject({ icon: 'search', title: 'Claude is searching tests/a.js for x' })
  expect(heroFor({ live: [], last: 'created errs5.txt' })).toMatchObject({ icon: 'clock', title: 'Claude is idle', sub: 'last: created errs5.txt' })
  const gone = applyGitStatus(noteEdit(emptyFiles(), 'gone.ts', false, 'Bash', 1), ' D gone.ts\n', 'main')
  expect(badgeFor(gone.touched[0], gone.git)).toEqual({ label: 'Deleted', tone: 'danger' })
})

test('kit v3: no Text draws an absolute path from outside the project; a file under HOME reads ~/…', async ($, on) => {
  world(on, { dirs: DIRS })
  await start($)
  await $.tool.call({ tool: 'Read', file_path: `${HOME}/notes/todo.md` } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'host', path: '/etc' } as never)
  await $.command.run({ command: 'files', args: '' } as never)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...FILES, surface } as never)
    const texts = nodesOf(await ui.drawn()).filter(n => n.type === 'Text').map(n => textOf(n))
    expect(texts.filter(t => /(^|[\s(·:])\/(home|etc|work)\b/.test(t))).toEqual([])
    expect(textOf(await ui.find({ key: `files-touched:${HOME}/notes/todo.md` }))).toContain('~/notes')
    expect(textOf(await ui.find({ key: 'files-touched:search:Grep:/etc:host' }))).toContain('· …/etc')
    expect(await ui.find({ type: 'Text', text: 'last: searched …/etc for host' })).toBeDefined()
    await ui.unmount()
  }
})

test(`kit v3 desktop: the tree draws at most ${TREE_SVG_CAP} Svg pictures, then text tags`, { timeoutMs: 20_000 }, async ($, on) => {
  const many = Array.from({ length: TREE_SVG_CAP + 20 }, (_, i) => ({ name: `f${String(i).padStart(3, '0')}.ts`, kind: 'file' as const, size: 1, mtimeMs: OCT_9 }))
  world(on, { dirs: { [CWD]: many } })
  await start($)
  await $.command.run({ command: 'files', args: '' } as never)
  const ui = await $.ui.mount({ ...FILES, surface: 'desktop' } as never)
  expect(altsIn(await ui.drawn()).filter(a => a === 'TS')).toHaveLength(TREE_SVG_CAP)
  const last = await ui.find({ key: `files-row:file:${CWD}/f${TREE_SVG_CAP + 19}.ts` })
  expect(altsIn(last)).toEqual([])
  expect(textOf(last)).toMatch(/^TSf\d+\.ts09 Oct$/)
  await ui.unmount()
})

test('calls in flight left by an earlier module are dropped on the first tracked call', async ($, on) => {
  const w = world(on, { atoms: { filesActivity: { live: [{ id: 'old:1', verb: 'reading', path: 'stale.ts', tool: 'Read', at: 1 }], last: '' } } })
  await start($)
  let ui = await $.ui.mount(FILES)
  expect(await ui.find({ type: 'Text', text: 'Claude is reading stale.ts' })).toBeDefined()
  await ui.unmount()
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts` } as never)
  expect(w.atoms.filesActivity).toEqual({ live: [], last: 'read a.ts' })
  ui = await $.ui.mount(FILES)
  expect(await ui.find({ type: 'Text', text: 'last: read a.ts' })).toBeDefined()
})

// ---------------------------------------------------------------- the hub row, the nav bar and the preload on open

const HUB = { ...FILES, requestId: 'loopkeeper-hub', props: { ...FILES.props, title: 'loopkeeper' } } as const

/** A world with ui.open recorded (its options) and ui.panes answering for the last pane opened. */
function linked(on: any, opts: Parameters<typeof world>[1] = {}) {
  const opened: any[] = []
  on('ui.open', {}, ($: unknown, e: any, next: (e: unknown) => unknown) => {
    opened.push(e)
    return next(e)
  })
  const w = world(on, { dirs: DIRS, ...opts })
  on('ui.panes', () => ({ value: opened.length ? [{ id: opened[opened.length - 1].id, title: '', isShown: true, isFocused: true, isPlaced: true }] : [] }))
  return { w, opened }
}
const gitRunsOf = (w: { processes: string[][] }) => w.processes.filter(p => p.join(' ') === 'git status --porcelain').length

for (const surface of SURFACES) {
  test(`hub on ${surface}: the Files row is 3: Files and the band's words, quiet; a press switches to the Files pane`, { timeoutMs: 20_000 }, async ($, on) => {
    const { w, opened } = linked(on)
    await start($)
    await $.tool.call({ tool: 'Read', file_path: `${CWD}/README.md` } as never)
    const ui = await $.ui.mount({ ...HUB, surface } as never)
    const row = await ui.find({ key: 'hub-files' })
    expect(textOf(row)).toContain('1 touched · last: read README.md')
    const button = (await ui.find({ key: 'panel-files' })) as Drawn
    expect(button.props).toMatchObject({ label: 'Files', hotkey: '3', plain: true })
    const words = nodesOf(row).find(n => n.type === 'Text' && textOf(n).startsWith('1 touched'))
    expect(words?.props?.color).toBe(TONES.muted.fg)
    if (surface === 'terminal') expect(render(await ui.drawn(), 100)).toContain('3: Files')
    // the press closes the hub and opens the Files pane with the focus; the ui.open hook lists the folders and reads git
    const listed = w.listed.length
    const runs = gitRunsOf(w)
    await ui.press({ key: 'panel-files' })
    expect(w.panes.slice(-2)).toEqual(['closed:loopkeeper-hub', 'files'])
    expect(opened[opened.length - 1]).toMatchObject({ id: 'files', focus: true, closeOnEscape: true })
    expect(w.listed.length).toBeGreaterThan(listed)
    expect(w.listed).toContain(CWD)
    expect(gitRunsOf(w)).toBe(runs + 1)
    expect(w.toasts).toEqual([])
    await ui.unmount()
  })

  test(`Files pane on ${surface}: the nav bar leads, Files bold, the others digit Buttons that switch panes`, { timeoutMs: 20_000 }, async ($, on) => {
    const { w, opened } = linked(on)
    await start($)
    const ui = await $.ui.mount({ ...FILES, surface } as never)
    const nav = (await ui.find({ key: 'nav' })) as Drawn
    const items = nav.children as Drawn[]
    expect(items.map(n => n.type)).toEqual(['Button', 'Button', 'Button', 'Text', 'Button', 'Button', 'Button'])
    expect(textOf(items[3])).toBe('Files')
    expect(items[3].props).toMatchObject({ bold: true, color: TONES.accent.fg })
    const buttons = items.filter(n => n.type === 'Button')
    expect(buttons.map(n => n.props?.hotkey)).toEqual(['0', '1', '2', '4', '5', '6'])
    expect(buttons.map(n => n.props?.label)).toEqual(['Hub', 'Stage', 'Gates', 'Routes', 'Reviews', 'Decisions'])
    expect(buttons.every(n => n.props?.plain === true)).toBe(true)
    if (surface === 'terminal') expect(render(await ui.drawn(), 140).split('\n')[0]).toBe('0: Hub  1: Stage  2: Gates  Files  4: Routes  5: Reviews  6: Decisions')
    await ui.press({ key: 'gates' })
    expect(w.panes.slice(-2)).toEqual(['closed:files', 'loopkeeper-gates'])
    await ui.press({ key: 'hub' })
    expect(w.panes.slice(-2)).toEqual(['closed:files', 'loopkeeper-hub'])
    expect(opened[opened.length - 1]).toMatchObject({ id: 'loopkeeper-hub', focus: true, closeOnEscape: true, rows: 22 })
    await ui.unmount()
  })
}

test('the hub keeps the Files row with the band off', { timeoutMs: 20_000 }, async ($, on) => {
  linked(on)
  await start($)
  await lk($, 'band gates off')
  const ui = await $.ui.mount(HUB)
  expect(textOf(await ui.find({ key: 'hub-files' }))).toContain('0 touched · band off')
  await ui.unmount()
})

test('with CLAUDE_MODS_DISABLE=loopkeeper the hub row says nothing is tracked', { timeoutMs: 20_000 }, async ($, on) => {
  linked(on, { env: { CLAUDE_MODS_DISABLE: 'loopkeeper' } })
  await start($)
  const ui = await $.ui.mount(HUB)
  expect(textOf(await ui.find({ key: 'hub-files' }))).toContain('off (CLAUDE_MODS_DISABLE): nothing is tracked')
  expect(await ui.find({ key: 'panel-files' })).toBeDefined()
  await ui.unmount()
})

test('opening the Files pane preloads it (folders and git): from /files and from a nav bar; another pane does not', async ($, on) => {
  const w = linked(on).w
  await start($)
  await lk($, 'gates')
  expect(w.listed).toEqual([])
  expect(gitRunsOf(w)).toBe(0)
  await $.command.run({ command: 'files', args: '' } as never)
  expect(w.listed).toContain(CWD)
  expect(gitRunsOf(w)).toBe(1)
  const gates = await $.ui.mount({ ...FILES, requestId: 'loopkeeper-gates', props: { ...FILES.props, title: 'Gates' } } as never)
  await gates.press({ key: 'stage' })
  expect(gitRunsOf(w)).toBe(1)
  await gates.press({ key: 'files' })
  expect(gitRunsOf(w)).toBe(2)
  expect(w.panes).toEqual(['loopkeeper-gates', 'files', 'closed:loopkeeper-gates', 'loopkeeper-stage', 'closed:loopkeeper-gates', 'files'])
  await gates.unmount()
})
