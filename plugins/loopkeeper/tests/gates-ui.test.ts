// gates-ui.test.ts: the gates band and the status pane (/lk gates). Ported from change-control's ui tests (8); names
// changed (loopkeeper:, /lk gates, pane id loopkeeper-gates, button keys gates-reset and gates-close), plus kit v2:
// colors are theme keys where v1 drew dimColor, yellow and red, and the band is one kit line (bold `gates`, `● word`
// chips in their tone, an inactive right side): the files chip is ok at rest, warn near the limit, error when a rule
// fired; the base limit is 10, not 6.
// New: the band and the pane show `<count>/<limit> files` with the plan budget, a session raise or a max in force.
// Kit v3: the pane is a hero (shield, GATES), tiles and four cards (rules, protected paths, this turn, decisions)
// with pills, type badges and short paths; /lk gates text keeps the status lines.
import { expect, test } from 'claude-code/testing'

import { TONES, pillSvg } from '../hooks/lib/kit.ts'
import { BAND, CWD, HOME, bandLineOf, edit, lineOf, linePlain, lk, projectGates, startTurn, texts, userGates, world } from './world.ts'
import { render } from './render.ts'

const SLOW = { timeoutMs: 20_000 }
const SURFACES = ['terminal', 'desktop'] as const
/** A RegExp matching exactly this text (find matches a string by inclusion). */
const exact = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
/** Every element of a drawn tree, depth first. */
function* walk(n: any): Generator<any> {
  if (n === null || typeof n !== 'object') return
  yield n
  for (const c of Array.isArray(n.children) ? n.children : n.children === undefined ? [] : [n.children]) yield* walk(c)
}
const svgAlts = (tree: unknown) => [...walk(tree)].filter(n => n.type === 'Svg').map(n => String(n.props?.alt))

const PANE = {
  plugin: 'loopkeeper',
  component: 'Pane',
  requestId: 'loopkeeper-gates',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Gates', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

/** The gates band line, drawn on a surface. */
const gates = ($: any, surface: 'terminal' | 'desktop' = 'terminal') => bandLineOf($, 'gates', surface)

const editAll = async ($: any, names: string[]) => {
  for (const f of names) await $.tool.check(edit(`${CWD}/${f}.ts`))
}

test('the band shows files, plan and merge gate', { timeoutMs: 20_000 }, async ($, on) => {
  world(on, { files: projectGates({ requirePlan: true }) })
  await startTurn($)
  let l = await gates($)
  expect(linePlain(l)).toBe('gates  ● 0/10 files  ● plan needed  ● merge gate  ● ship open')
  expect(l?.chips[1]).toEqual({ text: '● plan needed', color: TONES.warn.fg, bold: true })
  await lk($, 'gates plan ok')
  await editAll($, ['a', 'b', 'c'])
  l = await gates($)
  expect(linePlain(l)).toBe('gates  ● 3/10 files  ● plan ok  ● merge gate  ● ship open')
  // the label is bold in the default color; each chip is a bold `● word` in its tone; no right side at the base limit
  expect(l?.label).toEqual({ text: 'gates', color: undefined, bold: true })
  expect(l?.chips.map(c => c.color)).toEqual([TONES.ok.fg, TONES.ok.fg, TONES.info.fg, TONES.ok.fg])
  expect(l?.chips.every(c => c.bold === true)).toBe(true)
  expect(l?.right).toBeUndefined()
})

test('the band turns the files chip to the warning color near the limit', { timeoutMs: 20_000 }, async ($, on) => {
  world(on)
  await startTurn($)
  await editAll($, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])
  const l = await gates($)
  expect(l?.chips[0]).toEqual({ text: '● 9/10 files', color: TONES.warn.fg, bold: true })
  expect(linePlain(l)).toBe('gates  ● 9/10 files  ● merge gate  ● ship open')
})

test('the band turns the files chip to a bold error when a rule fired this turn, and clears next turn', async ($, on) => {
  world(on)
  await startTurn($)
  await $.tool.check(edit(`${CWD}/.env`))
  let l = await gates($)
  expect(l?.chips[0]).toEqual({ text: '● 0/10 files', color: TONES.danger.fg, bold: true })
  await $.turn.start({ text: 'next', turnId: 't2' })
  l = await gates($)
  expect(l?.chips[0]).toEqual({ text: '● 0/10 files', color: TONES.ok.fg, bold: true })
})

test('/lk gates band off hides the band and saves it', async ($, on) => {
  const w = world(on)
  await startTurn($)
  await lk($, 'gates band off')
  expect(w.store.get('loopkeeper:gates:band')).toBe(false)
  expect(await gates($)).toBeUndefined()
})

test('/lk gates off: the band says off for this session in the error tone, and how to resume', async ($, on) => {
  world(on)
  await startTurn($)
  await lk($, 'gates off')
  const l = await gates($)
  expect(linePlain(l)).toBe('gates  ● off for this session   /lk gates on to resume')
  expect(l?.chips[0]?.color).toBe(TONES.danger.fg)
  expect(l?.right?.color).toBe(TONES.muted.fg)
})

test('the pane: a hero, tiles, rules with sources, protected paths, this turn and decisions; Reset turn clears the turn', SLOW, async ($, on) => {
  world(on)
  await startTurn($)
  await $.tool.check(edit(`${CWD}/src/a.ts`))
  await $.tool.check(edit(`${CWD}/.env`))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    const has = async (text: string) => expect(await ui.find({ type: 'Text', text: exact(text) })).toBeDefined()
    const propsOf = async (text: string) => (await ui.find({ type: 'Text', text: exact(text) }))?.props
    const tree = await ui.drawn()
    // kit 3.1: the pane is a page, one row between its blocks
    expect((tree as { props?: Record<string, unknown> }).props).toMatchObject({ flexDirection: 'column', rowGap: 1 })
    const alts = svgAlts(tree)
    // the hero: the shield, the eyebrow, on with the files this turn, where the limit comes from
    if (surface === 'desktop') expect(alts).toContain('shield')
    else expect(alts).toEqual([])
    await has('GATES')
    await has('On · 1/10 files this turn')
    await has('the base limit, maxFilesPerTurn')
    // the tiles, their values toned
    for (const label of ['Files per turn', 'Plan', 'Ship', 'Merge gate']) await has(label)
    expect((await propsOf('not required'))?.color).toBe(TONES.muted.fg)
    expect((await propsOf('open'))?.color).toBe(TONES.ok.fg)
    expect((await propsOf('on'))?.color).toBe(TONES.info.fg)
    // the four section headers, with their right sides
    for (const header of ['RULES', 'SOURCE', 'PROTECTED PATHS', '3', 'THIS TURN', '1 FILE', 'DECISIONS', '1 · NEWEST FIRST']) await has(header)
    // a rule: the key, the value bold, the source quiet on the right; planPaths one glob per line
    await has('maxFilesPerTurn: 10')
    expect((await propsOf('10'))?.bold).toBe(true)
    expect((await propsOf('default'))?.color).toBe(TONES.muted.fg)
    await has('planPaths:')
    for (const glob of ['  .claude/plans/**', '  docs/plans/**', '  + scratchpad']) await has(glob)
    await has('Config files: none (defaults)')
    // protected paths: the glob and its pill (an Svg chip on the desktop, deny danger and ask warn; ● chips on the
    // terminal), the row centered on it; the desktop pane has no fill anywhere
    await has('.env*')
    const pill = async (word: string) =>
      surface === 'desktop' ? [...walk(tree)].find(n => n.type === 'Svg' && n.props?.alt === word)?.props : propsOf(`● ${word}`)
    expect(await pill('deny')).toMatchObject(surface === 'desktop' ? { source: pillSvg('deny', 'danger'), height: 18 } : { color: TONES.danger.fg })
    expect(await pill('ask')).toMatchObject(surface === 'desktop' ? { source: pillSvg('ask', 'warn'), height: 18 } : { color: TONES.warn.fg })
    expect((await ui.find({ key: 'protected-.env*' }))?.props?.alignItems).toBe('center')
    if (surface === 'desktop') expect(JSON.stringify(tree)).not.toContain('backgroundColor')
    // this turn: the type badge, the name and its folder
    if (surface === 'desktop') expect(alts).toContain('TS')
    else await has('TS')
    await has('a.ts  src')
    // decisions: a denied pill, the file name and the reason
    expect(await pill('denied')).toMatchObject(surface === 'desktop' ? { source: pillSvg('denied', 'danger') } : { color: TONES.danger.fg })
    expect((await ui.find({ key: 'decision-0' }))?.props?.alignItems).toBe('center')
    await has('.env · matches .env* (deny)')
    await ui.unmount()
  }
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'gates-reset' })
  expect(await ui.find({ type: 'Text', text: exact('On · 0/10 files this turn') })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: exact('no files yet') })).toBeDefined()
  await ui.unmount()
})

test('the pane Close button closes it', async ($, on) => {
  const w = world(on)
  await startTurn($)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'gates-close' })
  expect(w.panes).toEqual(['closed:loopkeeper-gates'])
  await ui.unmount()
})

test('/lk gates opens the pane and answers with the status line; unknown verbs print usage; bad max is refused', async ($, on) => {
  const w = world(on)
  await startTurn($)
  expect(await lk($, 'gates')).toBe('gates ● on · 0/10 files · plan – · ship open · merge gate on')
  expect(w.panes).toEqual(['loopkeeper-gates'])
  expect(await lk($, 'gates frobnicate')).toContain('usage')
  expect(await lk($, 'gates max zero')).toContain('usage')
})

test('/lk gates reload reports files and rules', async ($, on) => {
  world(on, { files: projectGates({ maxFilesPerTurn: 4 }) })
  await startTurn($)
  const text = await lk($, 'gates reload')
  expect(text).toContain(`reloaded ${CWD}/.claude/loopkeeper.json`)
  expect(text).toContain('maxFilesPerTurn: 4  [.claude/loopkeeper.json]')
})

// ---- New: the limit in force on the band and in the pane (ADR 0011) ----------------------------

test('the band shows <count>/<limit> files with the plan budget, a session raise or a max in force', async ($, on) => {
  const w = world(on)
  await startTurn($)
  await editAll($, ['a', 'b'])
  // the budget the stage left once it approved a plan of 13 files; the right side says where the limit comes from
  w.atoms.stagePlanFiles = 13
  w.atoms.stageBudget = 23
  let l = await gates($)
  expect(linePlain(l)).toBe('gates  ● 2/23 files  ● merge gate  ● ship open   budget 23')
  expect(l?.chips[0]?.color).toBe(TONES.ok.fg)
  expect(l?.right).toEqual({ text: 'budget 23', color: TONES.muted.fg, bold: undefined })
  // a smaller session raise does not lower it; a larger one wins
  w.atoms.gateSessionRaise = 20
  expect(linePlain(await gates($))).toBe('gates  ● 2/23 files  ● merge gate  ● ship open   budget 23')
  w.atoms.gateSessionRaise = 30
  expect(linePlain(await gates($))).toBe('gates  ● 2/30 files  ● merge gate  ● ship open   raised 30')
  // /lk gates max wins over all of them, and two of three files is near it
  await lk($, 'gates max 3')
  l = await gates($)
  expect(linePlain(l)).toBe('gates  ● 2/3 files  ● merge gate  ● ship open   max 3')
  expect(l?.chips[0]?.color).toBe(TONES.warn.fg)
})

test('the pane hero says where the limit comes from, and off when the gates are off', SLOW, async ($, on) => {
  const w = world(on)
  await startTurn($)
  await editAll($, ['a'])
  const hero = async () => {
    const ui = await $.ui.mount(PANE)
    const t = texts(await ui.drawn())
    await ui.unmount()
    return t.slice(t.indexOf('GATES') + 1, t.indexOf('GATES') + 3)
  }
  w.atoms.stagePlanFiles = 13
  w.atoms.stageBudget = 23
  expect(await hero()).toEqual(['On · 1/23 files this turn', "the approved plan's budget: 13 planned + 10"])
  expect(await lk($, 'gates')).toBe('gates ● on · 1/23 files (budget) · plan – · ship open · merge gate on')
  w.atoms.gateSessionRaise = 30
  expect(await hero()).toEqual(['On · 1/30 files this turn', 'raised for this session'])
  await lk($, 'gates max 3')
  expect(await hero()).toEqual(['On · 1/3 files this turn', 'max override for this session (/lk gates max)'])
  await lk($, 'gates off')
  expect(await hero()).toEqual(['Off for this session', 'no rule is enforced; /lk gates on turns them back on'])
})

// ---- Kit v2 and v3 on both surfaces ---------------------------------------------------------------

test('kit v2: the band line draws the same on both surfaces, in theme keys, with no dimColor or fills', async ($, on) => {
  world(on)
  await startTurn($)
  await $.tool.check(edit(`${CWD}/.env`))
  const bands: string[] = []
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface } as never)
    const l = lineOf(await band.drawn(), 'gates')
    bands.push(linePlain(l))
    expect(l?.label).toEqual({ text: 'gates', color: undefined, bold: true })
    expect(l?.chips.map(c => c.color)).toEqual([TONES.danger.fg, TONES.info.fg, TONES.ok.fg])
    expect(JSON.stringify(await band.drawn())).not.toMatch(/dimColor|backgroundColor/)
    await band.unmount()
  }
  expect(bands[0]).toBe('gates  ● 0/10 files  ● merge gate  ● ship open')
  expect(bands[1]).toBe(bands[0])
})

test('kit v3: the pane fills only pills, draws Svg only off the terminal, and no absolute path from outside the project', SLOW, async ($, on) => {
  world(on, { files: userGates({ protected: [{ glob: 'secrets/**', action: 'ask' }] }) })
  await startTurn($)
  await $.tool.check(edit(`${CWD}/src/a.ts`))
  await $.tool.check(edit(`${HOME}/notes/todo.md`))
  await $.tool.check(edit('/etc/hosts'))
  await $.tool.check(edit(`${CWD}/.env`))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    const tree = await ui.drawn()
    const json = JSON.stringify(tree)
    expect(json).not.toMatch(/dimColor|yellow|white|gray|grey|black|subtle/i)
    // no fill anywhere: the desktop's pills are Svg chips, the terminal's are ● text
    expect(json).not.toContain('backgroundColor')
    if (surface === 'terminal') expect(json).not.toContain('"Svg"')
    else for (const alt of ['shield', 'TS', 'MD']) expect(svgAlts(tree)).toContain(alt)
    // paths: the project's relative, home's under ~, anywhere else its last segments; the config file under ~
    const shown = texts(tree)
    for (const t of shown) expect(t).not.toMatch(/(^|[\s(,])\/(home|etc|work)\b/)
    for (const t of ['todo.md', '  ~/notes', 'hosts', '  …/etc']) expect(shown).toContain(t)
    expect(shown).toContain('Config files: ~/.claude/loopkeeper.json')
    expect(shown).toContain('~/.claude/loopkeeper.json')
    await ui.unmount()
  }
})

// ---- The hub row and the nav bar --------------------------------------------------------------------------------

const HUB = { ...PANE, requestId: 'loopkeeper-hub', props: { ...PANE.props, title: 'loopkeeper' } } as const
/** The text of a drawn subtree. */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object') return ''
  const n = node as { children?: unknown; props?: { children?: unknown } }
  const kids = n.children ?? n.props?.children ?? []
  return (Array.isArray(kids) ? kids : [kids]).map(textOf).join('')
}

/** A world with ui.open recorded (its options) and ui.panes answering for the last pane opened. */
function linked(on: any, opts: Parameters<typeof world>[1] = {}) {
  const opened: any[] = []
  const focused = { value: true }
  on('ui.open', {}, ($: unknown, e: any, next: (e: unknown) => unknown) => {
    opened.push(e)
    return next(e)
  })
  const w = world(on, opts)
  on('ui.panes', () => ({ value: opened.length ? [{ id: opened[opened.length - 1].id, title: '', isShown: true, isFocused: focused.value, isPlaced: true }] : [] }))
  return { w, opened, focused }
}

for (const surface of SURFACES) {
  test(`hub on ${surface}: the Gates row is 2: Gates and the band's words, quiet; a press switches to the Gates pane`, SLOW, async ($, on) => {
    const { w, opened, focused } = linked(on)
    await startTurn($)
    await $.tool.check(edit(`${CWD}/src/a.ts`))
    const ui = await $.ui.mount({ ...HUB, surface } as never)
    const row = await ui.find({ key: 'hub-gates' })
    expect(textOf(row)).toContain('on · 1/10 files · merge gate · ship open')
    expect((await ui.find({ key: 'panel-gates' }))?.props).toMatchObject({ label: 'Gates', hotkey: '2', plain: true })
    const words = [...walk(row)].find(n => n.type === 'Text' && textOf(n).startsWith('on · '))
    expect(words?.props?.color).toBe(TONES.muted.fg)
    if (surface === 'terminal') expect(render(await ui.drawn(), 100)).toContain('2: Gates')
    // the press closes the hub and opens the Gates pane with the focus; unfocused, the ctrl+x tab hint in the
    // terminal (the press's surface), never on the desktop
    focused.value = false
    await ui.press({ key: 'panel-gates' })
    expect(w.panes.slice(-2)).toEqual(['closed:loopkeeper-hub', 'loopkeeper-gates'])
    expect(opened[opened.length - 1]).toMatchObject({ id: 'loopkeeper-gates', title: 'Gates', focus: true, closeOnEscape: true })
    expect(w.toasts.filter(t => t === 'ctrl+x tab to focus the panel').length).toBe(surface === 'terminal' ? 1 : 0)
    await ui.unmount()
  })

  test(`Gates pane on ${surface}: the nav bar leads, Gates bold, the others digit Buttons that switch panes`, SLOW, async ($, on) => {
    const { w, opened } = linked(on)
    await startTurn($)
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    const nav = await ui.find({ key: 'nav' })
    const items = nav?.children as any[]
    expect(items.map(n => n.type)).toEqual(['Button', 'Button', 'Text', 'Button', 'Button', 'Button', 'Button'])
    expect(textOf(items[2])).toBe('Gates')
    expect(items[2].props).toMatchObject({ bold: true, color: TONES.accent.fg })
    const buttons = items.filter(n => n.type === 'Button')
    expect(buttons.map(n => n.props?.hotkey)).toEqual(['0', '1', '3', '4', '5', '6'])
    expect(buttons.map(n => n.props?.label)).toEqual(['Hub', 'Stage', 'Files', 'Routes', 'Reviews', 'Decisions'])
    expect(buttons.every(n => n.props?.plain === true)).toBe(true)
    if (surface === 'terminal') expect(render(await ui.drawn(), 100).split('\n')[0]).toBe('0: Hub  1: Stage  Gates  3: Files  4: Routes  5: Reviews  6: Decisions')
    // the pane's own letter hotkeys stay: r Reset turn, c Close
    expect((await ui.find({ key: 'gates-reset' }))?.props?.hotkey).toBe('r')
    await ui.press({ key: 'stage' })
    expect(w.panes.slice(-2)).toEqual(['closed:loopkeeper-gates', 'loopkeeper-stage'])
    await ui.press({ key: 'hub' })
    expect(w.panes.slice(-2)).toEqual(['closed:loopkeeper-gates', 'loopkeeper-hub'])
    expect(opened[opened.length - 1]).toMatchObject({ id: 'loopkeeper-hub', focus: true, closeOnEscape: true, rows: 22 })
    await ui.unmount()
  })
}

test('the hub keeps the Gates row with the band off, with the gates off, and with the kill switch on', SLOW, async ($, on) => {
  linked(on)
  await startTurn($)
  await lk($, 'gates band off')
  let ui = await $.ui.mount(HUB)
  expect(textOf(await ui.find({ key: 'hub-gates' }))).toContain('on · 0/10 files · merge gate · ship open · band off')
  await ui.unmount()
  await lk($, 'gates off')
  ui = await $.ui.mount(HUB)
  expect(textOf(await ui.find({ key: 'hub-gates' }))).toContain('off for this session · /lk gates on to resume · band off')
  await ui.unmount()
})

test('with CLAUDE_MODS_DISABLE=loopkeeper the hub row says the gates are off', SLOW, async ($, on) => {
  linked(on, { env: { CLAUDE_MODS_DISABLE: 'loopkeeper' } })
  await startTurn($)
  const ui = await $.ui.mount(HUB)
  expect(textOf(await ui.find({ key: 'hub-gates' }))).toContain('off (CLAUDE_MODS_DISABLE)')
  expect(await ui.find({ key: 'panel-gates' })).toBeDefined()
  await ui.unmount()
})
