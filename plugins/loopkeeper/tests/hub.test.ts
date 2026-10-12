// hub.test.ts: the loopkeeper hub (/lk alone) and the nav bar of the Stage pane, in the terminal and the desktop app.
// The stage draws the hub's frame (hero, the Panels header, its own row, the other mods, the actions) around the
// rows the later concerns add (six panel rows in wiring order); a row or a nav item switches panes (close, then open
// with the focus). The other mods' commands are read again whenever the hub opens: by /lk, a hook's open, a nav press.
// A mod press runs the mod's command on the desktop and fills the composer in the terminal.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { TONES } from '../hooks/lib/kit.ts'
import { render } from './render.ts'
import { CWD, start, world } from './world.ts'
import type { World } from './world.ts'

const TOOL = 'mcp__loopkeeper__set_stage'
const SURFACES = ['terminal', 'desktop'] as const
const VIEW = { viewport: { columns: 120, rows: 40 }, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} }
const pane = (requestId: string, title: string, surface: string) =>
  ({
    plugin: 'loopkeeper',
    component: 'Pane',
    requestId,
    surface,
    viewport: VIEW.viewport,
    props: { title, isFocused: true, bodyColumns: 80, placement: VIEW.placement, scroll: VIEW.scroll, view: VIEW.view },
  }) as never
const hub = (surface: string) => pane('loopkeeper-hub', 'loopkeeper', surface)

type Node = { type?: string; props?: Record<string, any>; children?: unknown[] }
function textIn(node: unknown): string {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  const n = node as Node
  return (n.children ?? n.props?.children ?? []).map(textIn).join('')
}

// The other mods' commands as $.command.list() reports them: two match, one is another plugin's
const LISTED = [
  { name: 'agent-map', description: 'Agents', source: 'plugin', plugin: 'lk-agent-map' },
  { name: 'budget', description: 'Budget', source: 'plugin', plugin: 'someone-else' },
  { name: 'where', description: 'Where', source: 'plugin', plugin: 'lk-where-am-i@market' },
  { name: 'lk', description: 'loopkeeper', source: 'plugin', plugin: 'loopkeeper' },
]

// The hub's panel rows in wiring order: each row's key, its Button's key, digit hotkey and label, and the pane it opens
const PANELS = [
  { row: 'hub-stage', key: 'panel-stage', hotkey: '1', label: 'Stage', id: 'loopkeeper-stage', title: 'Stage' },
  { row: 'hub-gates', key: 'panel-gates', hotkey: '2', label: 'Gates', id: 'loopkeeper-gates', title: 'Gates' },
  { row: 'hub-files', key: 'panel-files', hotkey: '3', label: 'Files', id: 'files', title: 'Files' },
  { row: 'hub-routes', key: 'panel-routes', hotkey: '4', label: 'Routes', id: 'loopkeeper-routes', title: 'Routing' },
  { row: 'hub-reviews', key: 'panel-reviews', hotkey: '5', label: 'Reviews', id: 'loopkeeper-review', title: 'Review loops' },
  { row: 'hub-decisions', key: 'panel-decisions', hotkey: '6', label: 'Decisions', id: 'loopkeeper-decisions', title: 'Decisions' },
] as const
const PANEL_KEYS = PANELS.map(p => p.key)

type Hub = { w: World; opened: any[]; draft: { text: string }; focused: { value: boolean }; lists: { n: number }; ran: any[] }

// A world with command.list (LISTED unless `listed` is given), prompt.read and ui.panes stubbed; ui.open recorded with
// its options. /agent-map is a known command (its runs recorded); /where is not, so running it is refused.
function hubWorld(on: any, opts: Parameters<typeof world>[1] = {}, listed: readonly object[] = LISTED): Hub {
  const opened: any[] = []
  const draft = { text: '' }
  const focused = { value: true }
  const lists = { n: 0 }
  const ran: any[] = []
  on('ui.open', {}, ($: unknown, e: any, next: (e: unknown) => unknown) => {
    opened.push(e)
    return next(e)
  })
  on('command.run', { command: 'agent-map' }, ($: unknown, e: any) => {
    ran.push({ command: e.command, args: e.args })
    return { text: '' }
  })
  const w = world(on, { now: 1_000_000, ...opts })
  on('command.list', () => {
    lists.n++
    return { value: listed }
  })
  on('prompt.read', () => ({ value: { text: draft.text, cursor: draft.text.length } }))
  on('ui.panes', () => ({
    value: opened.length ? [{ id: opened[opened.length - 1].id, title: '', isShown: true, isFocused: focused.value, isPlaced: true }] : [],
  }))
  return { w, opened, draft, focused, lists, ran }
}

const cmd = async ($: Engine, args: string, command = 'lk'): Promise<string> =>
  String(((await $.command.run({ command, args })) as { text?: string })?.text ?? '')

test('/lk and /loopkeeper open the hub (rows about 16, focus, Escape); /lk stage opens the Stage pane', async ($, on) => {
  const { w, opened } = hubWorld(on)
  await start($)
  expect(await cmd($, '')).toBe('')
  expect(await cmd($, '', 'loopkeeper')).toBe('')
  expect(await cmd($, 'stage')).toBe('')
  expect(w.panes).toEqual(['loopkeeper-hub', 'loopkeeper-hub', 'loopkeeper-stage'])
  expect(opened[0]).toMatchObject({ id: 'loopkeeper-hub', title: 'loopkeeper', focus: true, closeOnEscape: true, rows: 22 })
  expect(opened[2]).toMatchObject({ id: 'loopkeeper-stage', title: 'Stage', focus: true, closeOnEscape: true })
  expect(opened[2].rows).toBeUndefined()
  expect(w.toasts).toEqual([])
})

test('/lk help lists the keys: panels 0-6, the other mods, approve, GSD, close, the band and the Files filter', async ($, on) => {
  hubWorld(on)
  await start($)
  const text = await cmd($, 'help')
  for (const part of ['/lk opens the hub', '/lk stage', '0 Hub', '1 Stage', '6 Decisions', 'm Agents', 'p PRs', 'a approves', 'o fills /lk on', 'c closes', 'ctrl+x tab', 'Files pane']) {
    expect(text).toContain(part)
  }
  expect(await cmd($, 'nonsense')).toContain('unknown sub-command')
})

for (const surface of SURFACES) {
  test(`hub on ${surface}: hero, the Stage row with hotkey 1, other mods only for listed commands, GSD and Close`, { timeoutMs: 20_000 }, async ($, on) => {
    const { w, opened, draft, focused, ran } = hubWorld(on)
    await start($)
    await cmd($, '')
    const ui = await $.ui.mount(hub(surface))
    expect(await ui.find({ type: 'Text', text: 'LOOPKEEPER' })).toBeDefined()
    expect(textIn(await ui.find({ key: 'next-step' }))).toBe('Next: Build. Claude moves on when it starts that work, or /lk next.')
    expect(await ui.find({ type: 'Text', text: '⚑ Plan · 1 of 4' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'preset default · approval auto · GSD off' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'PANELS' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'OTHER MODS' })).toBeDefined()
    // the Stage row: a plain Button with hotkey 1, then the band's words without the label, quiet
    const row = (await ui.find({ key: 'hub-stage' })) as Node
    expect(textIn(row)).toContain('● Plan ─ ○ Build ─ ○ QA ─ ○ Ship · in Plan')
    const stage = (await ui.find({ key: 'panel-stage' })) as Node
    expect(stage.props).toMatchObject({ label: 'Stage', hotkey: '1', plain: true })
    const words = (row.children as Node[]).flatMap(function all(n: any): Node[] { return [n, ...((n?.children ?? []) as Node[]).flatMap(all)] }).find(n => n?.type === 'Text' && textIn(n).startsWith('● Plan')) as Node
    expect(words.props?.color).toBe(TONES.muted.fg)
    // other mods: agent-map and where (by lk- plugin name or name@marketplace); budget is another plugin's
    const buttons = ((await ui.findAll({ type: 'Button' })) as Node[]).map(b => b.props?.key)
    expect(buttons).toEqual([...PANEL_KEYS, 'mod-agents', 'mod-where', 'hub-gsd', 'hub-close'])
    expect(((await ui.find({ key: 'mod-agents' })) as Node).props).toMatchObject({ label: 'Agents', hotkey: 'm', plain: true })
    if (surface === 'terminal') {
      const text = render(await ui.drawn(), 80)
      expect(text).toContain('1: Stage')
      expect(text).toContain('m: Agents  w: Where')
      expect(text).toContain('o: GSD on  c: Close')
    }

    // the terminal: with a draft the press keeps it and says what to type; with an empty composer it closes the hub and
    // fills. The desktop: the press closes the hub and runs the mod's command (no toast); a refused run (/where is not
    // a known command here) falls back to the terminal's way.
    draft.text = 'half a thought'
    await ui.press({ key: 'mod-where' })
    expect(w.filled).toEqual([])
    expect(w.toasts.pop()).toBe('Type /where to open Where')
    draft.text = ''
    await ui.press({ key: 'mod-agents' })
    expect(w.panes.slice(-1)).toEqual(['closed:loopkeeper-hub'])
    if (surface === 'terminal') {
      expect(ran).toEqual([])
      expect(w.filled).toEqual(['/agent-map cards'])
      expect(w.toasts.pop()).toBe('Press Enter to open Agents')
    } else {
      expect(ran).toEqual([{ command: 'agent-map', args: 'cards' }])
      expect(w.filled).toEqual([])
      expect(w.toasts).toEqual([])
    }
    const filled = [...w.filled]

    // o keeps a draft and says what to type; with an empty composer it fills /lk on while GSD is off
    draft.text = 'half a thought'
    await ui.press({ key: 'hub-gsd' })
    expect(w.filled).toEqual(filled)
    expect(w.toasts.pop()).toBe('Type /lk on to turn GSD mode on')
    draft.text = ''
    await ui.press({ key: 'hub-gsd' })
    expect(w.filled.slice(-1)).toEqual(['/lk on'])
    expect(w.toasts.pop()).toBe('Press Enter to run /lk on')

    // the Stage row switches: the hub closes, the Stage pane opens with the focus; no focus: the ctrl+x tab hint, in
    // the terminal only, once a session
    focused.value = false
    await ui.press({ key: 'panel-stage' })
    expect(w.panes.slice(-2)).toEqual(['closed:loopkeeper-hub', 'loopkeeper-stage'])
    expect(opened[opened.length - 1]).toMatchObject({ id: 'loopkeeper-stage', focus: true, closeOnEscape: true })
    if (surface === 'terminal') expect(w.toasts.pop()).toBe('ctrl+x tab to focus the panel')
    await ui.press({ key: 'panel-stage' })
    focused.value = true
    await ui.press({ key: 'hub-close' })
    expect(w.panes.slice(-1)).toEqual(['closed:loopkeeper-hub'])
    expect(w.toasts).toEqual([])
    await ui.unmount()
  })

  test(`hub on ${surface}: Approve shows only while a gate waits and approves it, then the task continues`, { timeoutMs: 20_000 }, async ($, on) => {
    const { w } = hubWorld(on)
    w.store.set('loopkeeper:stage:preset:' + CWD, 'gsd')
    await start($)
    const plan = await $.ui.mount(hub(surface))
    expect(await plan.find({ key: 'hub-approve' })).toBeUndefined()
    await plan.unmount()
    await $.tool.call({ tool: TOOL, stage: 'plan', size: 'large', note: 'add the parser' } as never)
    await cmd($, 'validate-plan')
    const ui = await $.ui.mount(hub(surface))
    expect(await ui.find({ type: 'Text', text: /^⚑ Validate plan · 2 of 6$/ })).toBeDefined()
    const approve = (await ui.find({ key: 'hub-approve' })) as Node
    expect(approve.props).toMatchObject({ label: 'Approve gate', hotkey: 'a', plain: true })
    await ui.press({ key: 'hub-approve' })
    expect(await cmd($, 'status')).toContain('Gates: Validate plan approved')
    await w.clock.advance(5_000)
    expect(w.submitted.filter(s => String(s.text).startsWith('The user pressed Approve gate.')).length).toBe(1)
    await ui.unmount()
    const after = await $.ui.mount(hub(surface))
    expect(await after.find({ key: 'hub-approve' })).toBeUndefined()
    await after.unmount()
  })

  test(`hub on ${surface}: kit 3.1 spacing: a page of four sections one row apart, mods and actions as kit button rows`, { timeoutMs: 20_000 }, async ($, on) => {
    hubWorld(on)
    await start($)
    await cmd($, '')
    const ui = await $.ui.mount(hub(surface))
    const tree = (await ui.drawn()) as Node
    const kids = (n: Node): Node[] => (n.children ?? n.props?.children ?? []) as Node[]
    expect(tree.type).toBe('Box')
    expect(tree.props).toMatchObject({ flexDirection: 'column', rowGap: 1 })
    expect(kids(tree)).toHaveLength(4)
    // inside a section the rows stay tight: the hero and next line, the Panels header and its six rows
    for (const section of kids(tree).slice(0, 3)) expect(section.props?.rowGap).toBeUndefined()
    const all = (n: Node): Node[] => [n, ...kids(n).filter(c => c && typeof c === 'object').flatMap(all)]
    const rows = all(tree).filter(n => n.type === 'Box' && n.props?.flexWrap === 'wrap')
    expect(rows.map(n => [n.props?.columnGap, n.props?.rowGap])).toEqual([[2, 1], [2, 1]])
    expect(rows.map(n => kids(n).map(b => b.props?.key))).toEqual([['mod-agents', 'mod-where'], ['hub-gsd', 'hub-close']])
    if (surface === 'terminal') {
      const lines = render(tree, 80).split('\n')
      for (const label of ['PANELS', 'OTHER MODS', 'o: GSD on  c: Close']) {
        const at = lines.findIndex(l => l.startsWith(label))
        expect(at).toBeGreaterThan(0)
        expect(lines[at - 1]).toBe('')
      }
    }
    await ui.unmount()
  })

  test(`Stage pane on ${surface}: the nav bar leads, Stage bold, the others digit Buttons that switch panes`, { timeoutMs: 20_000 }, async ($, on) => {
    const { w, opened } = hubWorld(on)
    await start($)
    const ui = await $.ui.mount(pane('loopkeeper-stage', 'Stage', surface))
    const nav = (await ui.find({ key: 'nav' })) as Node
    const items = nav.children as Node[]
    expect(items.map(n => n.type)).toEqual(['Button', 'Text', 'Button', 'Button', 'Button', 'Button', 'Button'])
    expect(textIn(items[1])).toBe('Stage')
    expect(items[1].props).toMatchObject({ bold: true, color: TONES.accent.fg })
    expect(items.filter(n => n.type === 'Button').map(n => n.props?.hotkey)).toEqual(['0', '2', '3', '4', '5', '6'])
    expect(items.filter(n => n.type === 'Button').map(n => n.props?.label)).toEqual(['Hub', 'Gates', 'Files', 'Routes', 'Reviews', 'Decisions'])
    if (surface === 'terminal') expect(render(await ui.drawn(), 100).split('\n')[0]).toBe('0: Hub  Stage  2: Gates  3: Files  4: Routes  5: Reviews  6: Decisions')
    await ui.press({ key: 'gates' })
    expect(w.panes.slice(-2)).toEqual(['closed:loopkeeper-stage', 'loopkeeper-gates'])
    await ui.press({ key: 'hub' })
    expect(w.panes.slice(-2)).toEqual(['closed:loopkeeper-stage', 'loopkeeper-hub'])
    expect(opened[opened.length - 1]).toMatchObject({ id: 'loopkeeper-hub', focus: true, closeOnEscape: true, rows: 22 })
    await ui.unmount()
  })
}

test('the hub keeps its Stage row with the band off and names the kill switch in the hero', { timeoutMs: 20_000 }, async ($, on) => {
  hubWorld(on, { env: { CLAUDE_MODS_DISABLE: 'loopkeeper' } })
  await start($)
  await cmd($, 'band off')
  const ui = await $.ui.mount(hub('terminal'))
  expect(textIn(await ui.find({ key: 'hub-stage' }))).toContain('● Plan')
  expect(await ui.find({ type: 'Text', text: /GSD off · growth guard off/ })).toBeDefined()
  await ui.unmount()
})

// ---- All six panel rows, in wiring order ---------------------------------------------------------------------------

for (const surface of SURFACES) {
  test(`hub on ${surface}: six panel rows in wiring order, 1 Stage to 6 Decisions; each digit switches to its pane`, { timeoutMs: 20_000 }, async ($, on) => {
    const { w, opened } = hubWorld(on)
    await start($)
    await cmd($, '')
    const ui = await $.ui.mount(hub(surface))
    // the rows in document order, each led by a plain Button with its digit, then its concern's words, quiet
    const tree = await ui.drawn()
    const all = (n: any): any[] => (n && typeof n === 'object' ? [n, ...((n.children ?? []) as unknown[]).flatMap(all)] : [])
    const rowKeys = all(tree).map(n => n.props?.key).filter((k: unknown) => typeof k === 'string' && k.startsWith('hub-') && PANELS.some(p => p.row === k))
    expect(rowKeys).toEqual(PANELS.map(p => p.row))
    for (const p of PANELS) {
      const row = (await ui.find({ key: p.row })) as Node
      const button = (await ui.find({ key: p.key })) as Node
      expect(button.props).toMatchObject({ label: p.label, hotkey: p.hotkey, plain: true })
      expect(all(row).some(n => n.type === 'Button' && (n.key ?? n.props?.key) === p.key)).toBe(true)
      const words = all(row).filter(n => n.type === 'Text' && n.props?.color === TONES.muted.fg)
      expect(words.length).toBeGreaterThan(0)
    }
    const panelButtons = ((await ui.findAll({ type: 'Button' })) as Node[]).filter(b => String(b.props?.key).startsWith('panel-'))
    expect(panelButtons.map(b => b.props?.hotkey)).toEqual(['1', '2', '3', '4', '5', '6'])
    if (surface === 'terminal') {
      const text = render(tree, 100)
      const at = PANELS.map(p => text.indexOf(p.hotkey + ': ' + p.label))
      expect(at.every(i => i >= 0)).toBe(true)
      expect([...at].sort((a, b) => a - b)).toEqual(at)
      expect(text.indexOf('PANELS')).toBeLessThan(at[0])
      expect(text.indexOf('OTHER MODS')).toBeGreaterThan(at[5])
    }
    // each digit's Button closes the hub and opens its pane with the focus
    for (const p of PANELS) {
      const button = panelButtons.find(b => b.props?.hotkey === p.hotkey) as Node
      await ui.press({ key: String(button.props?.key) })
      expect(w.panes.slice(-2)).toEqual(['closed:loopkeeper-hub', p.id])
      expect(opened[opened.length - 1]).toMatchObject({ id: p.id, title: p.title, focus: true, closeOnEscape: true })
    }
    expect(w.toasts).toEqual([])
    await ui.unmount()
  })
}

test('the hub keeps all six rows with every band off, and with the kill switch on', { timeoutMs: 20_000 }, async ($, on) => {
  hubWorld(on)
  await start($)
  await cmd($, 'band off')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(hub(surface))
    const keys = ((await ui.findAll({ type: 'Button' })) as Node[]).map(b => String(b.props?.key)).filter(k => k.startsWith('panel-'))
    expect(keys).toEqual(PANEL_KEYS)
    expect(textIn(await ui.find({ key: 'hub-routes' }))).toContain('GSD off · routed 0 · band off')
    expect(textIn(await ui.find({ key: 'hub-reviews' }))).toContain('0 active of 0 subjects · band off')
    expect(textIn(await ui.find({ key: 'hub-decisions' }))).toContain('0 this session · watch off · band off')
    await ui.unmount()
  }
})

test('with CLAUDE_MODS_DISABLE=loopkeeper the hub still draws all six rows', { timeoutMs: 20_000 }, async ($, on) => {
  hubWorld(on, { env: { CLAUDE_MODS_DISABLE: 'loopkeeper' } })
  await start($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(hub(surface))
    const keys = ((await ui.findAll({ type: 'Button' })) as Node[]).map(b => String(b.props?.key)).filter(k => k.startsWith('panel-'))
    expect(keys).toEqual(PANEL_KEYS)
    expect(textIn(await ui.find({ key: 'hub-routes' }))).toContain('GSD off · routed 0 · spawn routing off (CLAUDE_MODS_DISABLE)')
    for (const p of PANELS) expect(textIn(await ui.find({ key: p.row })).length).toBeGreaterThan(p.label.length)
    await ui.unmount()
  }
})

// ---- The other mods' commands, read again when the hub opens without /lk -------------------------------------------

test('the Hub item of a nav bar reads the other mods again before the hub opens; another item does not', { timeoutMs: 20_000 }, async ($, on) => {
  const { w, lists } = hubWorld(on)
  await start($)
  expect(lists.n).toBe(0)
  let ui = await $.ui.mount(hub('terminal'))
  expect(await ui.find({ key: 'mod-agents' })).toBeUndefined()
  await ui.unmount()
  for (const [id, title] of [['loopkeeper-routes', 'Routing'], ['loopkeeper-decisions', 'Decisions']] as const) {
    const from = await $.ui.mount(pane(id, title, 'terminal'))
    const before = lists.n
    await from.press({ key: 'gates' })
    expect(lists.n).toBe(before)
    await from.press({ key: 'hub' })
    expect(lists.n).toBe(before + 1)
    expect(w.panes.slice(-2)).toEqual(['closed:' + id, 'loopkeeper-hub'])
    await from.unmount()
  }
  ui = await $.ui.mount(hub('terminal'))
  expect(((await ui.findAll({ type: 'Button' })) as Node[]).map(b => b.props?.key).filter(k => String(k).startsWith('mod-'))).toEqual(['mod-agents', 'mod-where'])
  await ui.unmount()
})

// A test's own hooks may not call $.ui.open, so the open from a hook is loopkeeper's own: /lk opens the hub from its
// command hook (one read there, one in the ui.open hook); /lk stage opens the Stage pane (one read, none on the open).
test('an open of the hub from a hook reads the other mods again; an open of another pane does not', { timeoutMs: 20_000 }, async ($, on) => {
  const { lists } = hubWorld(on)
  await start($)
  await cmd($, 'stage')
  expect(lists.n).toBe(1)
  await cmd($, '')
  expect(lists.n).toBe(3)
  const ui = await $.ui.mount(hub('desktop'))
  expect(((await ui.find({ key: 'mod-where' })) as Node).props).toMatchObject({ label: 'Where', hotkey: 'w', plain: true })
  await ui.unmount()
})

// During the switch to the lk- names either plugin name links a mod, and both listed draw one Button; a near name or
// another plugin's command does not. Secrets is the seventh mod, on s, and no two hub Buttons share a hotkey.
test('the hub links a mod from its lk- or old plugin name; Secrets on s; every hub hotkey is distinct', { timeoutMs: 20_000 }, async ($, on) => {
  const listed = [
    { name: 'agent-map', description: 'Agents', source: 'plugin', plugin: 'agent-map' },
    { name: 'budget', description: 'Budget', source: 'plugin', plugin: 'token-budget@market' },
    { name: 'handoff', description: 'Handoff', source: 'plugin', plugin: 'lk-handoff-guard-extra' },
    { name: 'attention', description: 'Attention', source: 'plugin', plugin: 'someone-else' },
    { name: 'pr', description: 'PRs', source: 'plugin', plugin: 'pr-watch' },
    { name: 'pr', description: 'PRs', source: 'plugin', plugin: 'lk-pr-watch' },
    { name: 'secret-guard', description: 'Secrets', source: 'plugin', plugin: 'lk-secret-guard' },
  ]
  const { w } = hubWorld(on, {}, listed)
  await start($)
  const help = await cmd($, 'help')
  expect(help).toContain('p PRs, s Secrets open the other mods')
  await cmd($, '')
  const ui = await $.ui.mount(hub('terminal'))
  const buttons = (await ui.findAll({ type: 'Button' })) as Node[]
  expect(buttons.map(b => b.props?.key)).toEqual([...PANEL_KEYS, 'mod-agents', 'mod-budget', 'mod-prs', 'mod-secrets', 'hub-gsd', 'hub-close'])
  const hotkeys = buttons.map(b => b.props?.hotkey)
  expect(new Set(hotkeys).size).toBe(hotkeys.length)
  expect(((await ui.find({ key: 'mod-secrets' })) as Node).props).toMatchObject({ label: 'Secrets', hotkey: 's', plain: true })
  expect(render(await ui.drawn(), 80)).toContain('m: Agents  u: Budget  p: PRs  s: Secrets')
  await ui.press({ key: 'mod-secrets' })
  expect(w.filled).toEqual(['/secret-guard'])
  expect(w.toasts.pop()).toBe('Press Enter to open Secrets')
  await ui.unmount()
})
