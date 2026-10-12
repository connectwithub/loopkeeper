// Routing pane and band as the kit draws them, in the terminal and the desktop app (ported from
// gsd-orchestrator's pane tests; kit v2: `● x` badges, case kept, theme-key colors, no fills).
import { expect, test } from 'claude-code/testing'

import { TONES } from '../hooks/lib/kit.ts'
import { render } from './render.ts'
import { BAND, CWD, bandLineOf, lineOf, linePlain, lk, start, world } from './world.ts'

const SLOW = { timeoutMs: 20_000 }
const SURFACES = ['terminal', 'desktop'] as const

const PANE = {
  plugin: 'loopkeeper',
  component: 'Pane',
  requestId: 'loopkeeper-routes',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Routing', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

function nodesIn(node: unknown): Node[] {
  if (!node || typeof node !== 'object') return []
  const n = node as Node & { props?: { children?: unknown[] } }
  return [n, ...(n.children ?? n.props?.children ?? []).flatMap(nodesIn)]
}

function textIn(node: unknown): string {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  const n = node as Node & { props?: { children?: unknown[] } }
  return (n.children ?? n.props?.children ?? []).map(textIn).join('')
}

/** The badge Text inside a drawn row: `● word`. */
function badgeIn(row: unknown, word: string): Node | undefined {
  return nodesIn(row).find(n => n.type === 'Text' && textIn(n) === '● ' + word)
}

function spawnOf(description: string) {
  return {
    tool_use_id: 'toolu_1',
    prompt: 'Do the task.',
    description,
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-main-model',
    background: false,
    fork: false,
  } as any
}

/** A world with the mode on, the plan approval stored as given, and a band drawn after the routing one. */
function paneWorld(on: any, approval?: string) {
  const w = world(on)
  w.store.set('loopkeeper:routing:mode', true)
  if (approval) w.store.set(`loopkeeper:stage:approval:${CWD}`, approval)
  return w
}

for (const surface of SURFACES) {
  test(`pane on ${surface}: hero, tiles, routes with role badges, recent spawns, loop; Toggle loop turns it off`, SLOW, async ($, on) => {
    const w = paneWorld(on, 'ask')
    await start($)
    await $.agent.spawn(spawnOf('Survey the repo layout'))
    await $.agent.spawn(spawnOf('Design the caching strategy'))

    const ui = await $.ui.mount({ ...PANE, surface } as never)
    // kit 3.1: the pane is a page, one row between its blocks
    expect(((await ui.drawn()) as Node).props).toMatchObject({ flexDirection: 'column', rowGap: 1 })
    expect(await ui.find({ type: 'Text', text: 'GSD' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Orchestrator on/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Plan approval: ask/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Routes' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Spawns' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'ask' })).toBeDefined()

    // Routes: one row per role, the badge toned by role (theme keys; both surfaces draw the same color)
    expect(await ui.find({ type: 'Text', text: /^Routes/ })).toBeDefined()
    const tones: Record<string, string> = {
      recon: TONES.muted.fg,
      execute: TONES.info.fg,
      verify: TONES.ok.fg,
      hard: TONES.accent.fg,
      default: TONES.muted.fg,
    }
    for (const role of ['recon', 'execute', 'verify', 'hard', 'default']) {
      const row = await ui.find({ key: 'route-' + role })
      expect(textIn(row)).toContain('→ ')
      expect(badgeIn(row, role)?.props?.color).toBe(tones[role])
    }

    // Recent spawns: newest first
    expect(await ui.find({ type: 'Text', text: /^Recent spawns · 2/ })).toBeDefined()
    expect(textIn(await ui.find({ key: 'spawn-0' }))).toMatch(/hard.*Design the caching strategy.*routed.*→ opus/)
    expect(textIn(await ui.find({ key: 'spawn-1' }))).toMatch(/recon.*Survey the repo layout.*routed.*→ haiku/)

    // The loop, and the Toggle loop button: with the mode on, the loop follows through the prompt box
    expect(textIn(await ui.find({ key: 'loop-row' }))).toContain('Loop on')
    await ui.press({ key: 'loop' })
    expect(w.filled).toEqual(['/lk loop off'])
    await lk($, 'loop off')
    expect(w.store.get('loopkeeper:routing:loop')).toBe(false)
    expect(textIn(await ui.find({ key: 'loop-row' }))).toContain('Loop off')
    await ui.unmount()
  })
}

test('the band draws the same kit line on both surfaces, on and off', SLOW, async ($, on) => {
  paneWorld(on)
  await start($)
  await $.agent.spawn(spawnOf('Survey the repo layout'))
  for (const surface of SURFACES) {
    const line = await bandLineOf($, 'routing', surface)
    expect(linePlain(line)).toBe('routing  ● on  ● loop   recon→haiku · exec→sonnet · verify→sonnet · hard→opus · routed 1')
    expect(line?.label).toEqual({ text: 'routing', color: undefined, bold: true })
    expect(line?.chips.map(c => c.color)).toEqual([TONES.ok.fg, TONES.info.fg])
    expect(line?.right?.color).toBe(TONES.muted.fg)
  }
  await lk($, 'off')
  for (const surface of SURFACES) {
    const off = await bandLineOf($, 'routing', surface)
    expect(linePlain(off)).toBe('routing  ● off')
    expect(off?.chips[0]).toEqual({ text: '● off', color: TONES.muted.fg, bold: undefined })
  }
})

test('the band stacks the bands drawn after it, on and off', SLOW, async ($, on) => {
  paneWorld(on)
  await start($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface } as never)
    expect(linePlain(lineOf(await ui.drawn(), 'routing'))).toMatch(/^routing {2}● on/)
    expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
    await ui.unmount()
  }
  await lk($, 'off')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect(linePlain(lineOf(await ui.drawn(), 'routing'))).toBe('routing  ● off')
  expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  await ui.unmount()
})

// ---- The hub row and the nav bar ---------------------------------------------------------------------------------

const HUB = { ...PANE, requestId: 'loopkeeper-hub', props: { ...PANE.props, title: 'loopkeeper' } } as const

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
  test(`hub on ${surface}: the Routes row is 4: Routes and GSD on|off · routed n, quiet; a press switches to the Routing pane`, SLOW, async ($, on) => {
    // the session draws on this surface alone, so on the desktop the focus hint never shows
    const { w, opened, focused } = linked(on, { surfaces: [surface] })
    w.store.set('loopkeeper:routing:mode', true)
    await start($)
    await $.agent.spawn(spawnOf('Survey the repo layout'))
    const ui = await $.ui.mount({ ...HUB, surface } as never)
    const row = await ui.find({ key: 'hub-routes' })
    expect(textIn(row)).toContain('GSD on · routed 1')
    expect((await ui.find({ key: 'panel-routes' }))?.props).toMatchObject({ label: 'Routes', hotkey: '4', plain: true })
    const words = nodesIn(row).find(n => n.type === 'Text' && textIn(n).startsWith('GSD on'))
    expect(words?.props?.color).toBe(TONES.muted.fg)
    if (surface === 'terminal') expect(render(await ui.drawn(), 100)).toContain('4: Routes')
    // the press closes the hub and opens the Routing pane with the focus; unfocused, the ctrl+x tab hint in the
    // terminal (once a session), never on the desktop
    focused.value = false
    await ui.press({ key: 'panel-routes' })
    expect(w.panes.slice(-2)).toEqual(['closed:loopkeeper-hub', 'loopkeeper-routes'])
    expect(opened[opened.length - 1]).toMatchObject({ id: 'loopkeeper-routes', title: 'Routing', focus: true, closeOnEscape: true })
    await ui.press({ key: 'panel-routes' })
    expect(w.toasts.filter(t => t === 'ctrl+x tab to focus the panel').length).toBe(surface === 'terminal' ? 1 : 0)
    await ui.unmount()
  })

  test(`Routing pane on ${surface}: the nav bar leads, Routes bold, the others digit Buttons that switch panes`, SLOW, async ($, on) => {
    const { w, opened } = linked(on)
    await start($)
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    const nav = await ui.find({ key: 'nav' })
    const items = (nav?.children ?? []) as Node[]
    expect(items.map(n => n.type)).toEqual(['Button', 'Button', 'Button', 'Button', 'Text', 'Button', 'Button'])
    expect(textIn(items[4])).toBe('Routes')
    expect(items[4].props).toMatchObject({ bold: true, color: TONES.accent.fg })
    const buttons = items.filter(n => n.type === 'Button')
    expect(buttons.map(n => n.props?.hotkey)).toEqual(['0', '1', '2', '3', '5', '6'])
    expect(buttons.map(n => n.props?.label)).toEqual(['Hub', 'Stage', 'Gates', 'Files', 'Reviews', 'Decisions'])
    expect(buttons.every(n => n.props?.plain === true)).toBe(true)
    if (surface === 'terminal') expect(render(await ui.drawn(), 100).split('\n')[0]).toBe('0: Hub  1: Stage  2: Gates  3: Files  Routes  5: Reviews  6: Decisions')
    // the pane's own letter hotkeys stay: t Toggle mode, l Toggle loop, c Close
    expect((await ui.find({ key: 'toggle' }))?.props?.hotkey).toBe('t')
    expect((await ui.find({ key: 'loop' }))?.props?.hotkey).toBe('l')
    await ui.press({ key: 'reviews' })
    expect(w.panes.slice(-2)).toEqual(['closed:loopkeeper-routes', 'loopkeeper-review'])
    await ui.press({ key: 'hub' })
    expect(w.panes.slice(-2)).toEqual(['closed:loopkeeper-routes', 'loopkeeper-hub'])
    expect(opened[opened.length - 1]).toMatchObject({ id: 'loopkeeper-hub', focus: true, closeOnEscape: true, rows: 22 })
    await ui.unmount()
  })
}

test('the hub keeps the Routes row with the band off', SLOW, async ($, on) => {
  linked(on)
  await start($)
  await lk($, 'band routing off')
  let ui = await $.ui.mount({ ...HUB, surface: 'terminal' } as never)
  expect(textIn(await ui.find({ key: 'hub-routes' }))).toContain('GSD off · routed 0 · band off')
  await ui.unmount()
  await lk($, 'band routing on')
  ui = await $.ui.mount({ ...HUB, surface: 'terminal' } as never)
  expect(textIn(await ui.find({ key: 'hub-routes' }))).toContain('GSD off · routed 0')
  expect(textIn(await ui.find({ key: 'hub-routes' }))).not.toContain('band off')
  await ui.unmount()
})

test('with CLAUDE_MODS_DISABLE=loopkeeper the Routes row says routing is off', SLOW, async ($, on) => {
  linked(on, { env: { CLAUDE_MODS_DISABLE: 'loopkeeper' } })
  await start($)
  const ui = await $.ui.mount({ ...HUB, surface: 'terminal' } as never)
  expect(textIn(await ui.find({ key: 'hub-routes' }))).toContain('spawn routing off (CLAUDE_MODS_DISABLE)')
  expect(await ui.find({ key: 'panel-routes' })).toBeDefined()
  await ui.unmount()
})
