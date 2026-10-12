// The /reviews pane and the review band, drawn with the kit, on both surfaces. These assert text and
// structure (what is drawn, in which order, which keys press), not the kit's colors: those belong to the kit tests.
// Kit v3: the item pills keep their width, and the gauges are kit.progress Svg bars off the terminal.
import { expect, test } from 'claude-code/testing'

import { TONES, barText, pillSvg } from '../hooks/lib/kit.ts'
import { render } from './render.ts'
import { reviewWorld } from './review-world.ts'
import { BAND, lineOf, linePlain, lk, start, tool } from './world.ts'


const SURFACES = ['terminal', 'desktop'] as const
const PANE_ID = 'loopkeeper-review'

const PANE = {
  plugin: 'loopkeeper',
  component: 'Pane',
  requestId: PANE_ID,
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Review loops', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const result = async ($: any, name: string, input: Record<string, unknown>) => String((await tool($, name, input)).result)

/** Every element of a drawn tree with its parent, depth first. */
const kids = (n: any): any[] => (Array.isArray(n.children) ? n.children : n.children === undefined ? [] : [n.children])
function* walk(n: any, parent: any = null): Generator<{ n: any; parent: any }> {
  if (n === null || typeof n !== 'object') return
  yield { n, parent }
  for (const c of kids(n)) yield* walk(c, n)
}
/** The Text drawing `text` exactly, and the element holding it. */
const textAt = (tree: unknown, text: string) => [...walk(tree)].find(x => x.n.type === 'Text' && kids(x.n).join('') === text)
const svgAlts = (tree: unknown) => [...walk(tree)].filter(x => x.n.type === 'Svg').map(x => String(x.n.props?.alt))
const svgAt = (tree: unknown, alt: string) => [...walk(tree)].find(x => x.n.type === 'Svg' && x.n.props?.alt === alt)

/** A review round on PR-42, then two critic passes on a landing page mockup with one item closed. */
async function fixture($: any, w: ReturnType<typeof reviewWorld>): Promise<void> {
  await start($)
  await result($, 'review_cycle', { subject: 'PR-42', kind: 'review', items: [{ text: 'race in cache', priority: 'p0' }, 'naming'] })
  await w.clock.advance(1000)
  const items = [
    { text: 'Header too dark', priority: 'p0' },
    { text: 'Footer folds', priority: 'p1' },
    { text: 'Ear tips', priority: 'p2' },
  ]
  await result($, 'review_cycle', { subject: 'landing-page.png', score: 7.1, items })
  await result($, 'review_cycle', { subject: 'landing-page.png', score: 8.0, verdict: 'iterate' })
  await result($, 'review_item', { subject: 'landing-page.png', text: 'Footer folds', done: true, proof: 'out/footer.png' })
  await w.clock.advance(1000)
}

/** The review band line on a surface, as plain text with its colors, and whether the band under it is kept. */
async function band($: any, surface: (typeof SURFACES)[number]) {
  const ui = await $.ui.mount({ ...BAND, surface })
  const line = lineOf(await ui.drawn(), 'review')
  const theirs = await ui.find({ type: 'Text', text: 'drawn by Claude Code' })
  await ui.unmount()
  if (!line) return undefined
  return {
    text: linePlain(line),
    label: line.label,
    colors: line.chips.map(c => c.color),
    right: line.right?.color,
    stacked: theirs !== undefined,
  }
}

test('the pane draws the selected subject as a hero, a score gauge, the cycle strip, tiles, items and subjects', { timeoutMs: 20_000 }, async ($, on) => {
  const w = reviewWorld(on)
  await fixture($, w)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // kit v2 draws a badge as '● label' on both surfaces; kit v3's pill is an Svg chip on the desktop
    const badge = (s: string) => new RegExp(`^● ${s}$`)
    const tree = await ui.drawn()
    expect(await ui.find({ type: 'Text', text: /^review loop$/i })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'landing-page.png · critic' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'cycle 2/4 · target 9.0' })).toBeDefined()
    // the gauge: 8.0 of 10, a text bar at width 20 on the terminal, a full-width kit.progress Svg on the desktop
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: barText(0.8, 20) })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '80%' })).toBeDefined()
      expect(svgAlts(tree)).toEqual([])
    } else {
      expect(await ui.find({ type: 'Text', text: barText(0.8, 20) })).toBeUndefined()
      // the gauge, then one chip per item pill (open items first)
      expect(svgAlts(tree)).toEqual(['80%', 'p0', 'p2', 'p1'])
      expect([...walk(tree)].find(x => x.n.type === 'Svg')?.n.props.width).toBeUndefined()
    }
    expect(await ui.find({ type: 'Text', text: /^8\.0$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^target 9\.0$/ })).toBeDefined()
    // the cycle strip: one badge per allowed cycle
    for (const glyph of ['①', '②', '③', '④']) expect(await ui.find({ type: 'Text', text: badge(glyph) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: badge('⑤') })).toBeUndefined()
    for (const label of ['Cycle', 'Score', 'Target', 'Verdict']) expect(await ui.find({ type: 'Text', text: label })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^iterate$/ })).toBeDefined()
    // items: a p0 pill in a Box that never shrinks (it was cut to "●…"), the mark likewise, the text wrapping;
    // the closed item with its proof
    expect(await ui.find({ type: 'Text', text: /^items · 3$/i })).toBeDefined()
    const p0 = surface === 'desktop' ? svgAt(tree, 'p0') : textAt(tree, '● p0')
    expect(p0?.n.props).toMatchObject(surface === 'desktop' ? { source: pillSvg('p0', 'danger'), height: 18 } : { color: TONES.danger.fg })
    expect(p0?.parent.props).toMatchObject({ flexShrink: 0 })
    if (surface === 'desktop') expect(svgAt(tree, 'p1')?.n.props.source).toBe(pillSvg('p1', 'warn'))
    else expect(textAt(tree, '● p1')?.n.props.color).toBe(TONES.warn.fg)
    // the item row centers its pill on the text line; the desktop pane has no fill anywhere
    expect(((await ui.find({ key: 'item-0' })) as any)?.props?.alignItems).toBe('center')
    if (surface === 'desktop') expect(JSON.stringify(tree)).not.toContain('backgroundColor')
    expect(textAt(tree, '○')?.parent.props).toMatchObject({ flexShrink: 0 })
    expect(textAt(tree, '✓')?.parent.props).toMatchObject({ flexShrink: 0 })
    expect(textAt(tree, 'Header too dark')?.n.props.wrap).toBe('wrap')
    expect(await ui.find({ type: 'Text', text: 'Header too dark' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'out/footer.png' })).toBeDefined()
    // the other subject with its kind, a status badge and its buttons
    expect(await ui.find({ type: 'Text', text: /^subjects · 1$/i })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: badge('active') })).toBeDefined()
    expect(await ui.find({ key: 'ship:PR-42' })).toBeDefined()
    expect(await ui.find({ key: 'reopen:PR-42' })).toBeDefined()
    expect(await ui.find({ key: 'stop:PR-42' })).toBeDefined()
    expect(await ui.find({ key: 'close' })).toBeDefined()
    // kit 3.1: the pane is a page (one row between blocks); the subject blocks a list, each block tight inside
    expect((tree as any).props).toMatchObject({ flexDirection: 'column', rowGap: 1 })
    const block = [...walk(tree)].find(x => x.n.props?.key === 'subject-PR-42')!.parent
    expect(block.props.rowGap).toBeUndefined()
    const list = [...walk(tree)].find(x => x.n === block)!.parent
    expect(list.props).toMatchObject({ flexDirection: 'column', rowGap: 1 })
    // the defaults line names no stored override
    expect(await ui.find({ type: 'Text', text: 'defaults: target by kind · max by kind' })).toBeDefined()
    await ui.unmount()
  }
})

test('Mark shipped and Reopen keep their effect on both surfaces; an items subject shows round, p0 and a closed bar', { timeoutMs: 20_000 }, async ($, on) => {
  const w = reviewWorld(on)
  await fixture($, w)
  for (const surface of SURFACES) {
    let ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'ship:landing-page.png' })
    expect(await result($, 'review_status', { subject: 'landing-page.png' })).toContain('shipped')
    await ui.unmount()
    // the band's subject is now PR-42, an items kind
    ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'PR-42 · review' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'round 1/3 · 1 p0 · 2 open' })).toBeDefined()
    // the closed-items bar: the text bar on the terminal, kit.progress on the desktop
    if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: barText(0, 20) })).toBeDefined()
    else expect(svgAlts(await ui.drawn())).toEqual(['0%', 'p0', 'p1'])
    expect(await ui.find({ type: 'Text', text: '0/2 closed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^● shipped$/ })).toBeDefined()
    await ui.press({ key: 'reopen:landing-page.png' })
    expect(await result($, 'review_status', { subject: 'landing-page.png' })).not.toContain('shipped')
    await ui.press({ key: 'close' })
    await ui.unmount()
    await w.clock.advance(1000)
  }
  expect(w.panes).toEqual([`closed:${PANE_ID}`, `closed:${PANE_ID}`])
})

test('no subjects: a quiet hero and the close button', async ($, on) => {
  reviewWorld(on)
  await start($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'No reviews yet' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Claude records one with review_cycle after each pass.' })).toBeDefined()
    expect(await ui.find({ key: 'close' })).toBeDefined()
    await ui.unmount()
  }
})

test('the band is one kit line on both surfaces (bold label, toned chips, quiet right side) and stacks the band under it', { timeoutMs: 20_000 }, async ($, on) => {
  const w = reviewWorld(on)
  await fixture($, w)
  for (const surface of SURFACES) {
    expect(await band($, surface)).toEqual({
      text: 'review  ● landing-page.png cycle 2/4  ● 2 open   8.0 → 9.0 · +1 more',
      label: { text: 'review', color: undefined, bold: true },
      colors: [TONES.info.fg, TONES.warn.fg],
      right: TONES.muted.fg,
      stacked: true,
    })
  }
  await w.clock.advance(1000)
  await result($, 'review_cycle', { subject: 'logo.svg', score: 9.2 })
  for (const surface of SURFACES) {
    expect(await band($, surface)).toEqual({
      text: 'review  ● logo.svg cycle 1/4  ● 0 open   9.2 → 9.0 · +2 more',
      label: { text: 'review', color: undefined, bold: true },
      colors: [TONES.ok.fg, TONES.muted.fg],
      right: TONES.muted.fg,
      stacked: true,
    })
  }
})

// ---- The hub row and the nav bar ---------------------------------------------------------------------------------

const HUB = { ...PANE, requestId: 'loopkeeper-hub', props: { ...PANE.props, title: 'loopkeeper' } } as const
const SLOW = { timeoutMs: 20_000 }
const textOf = (n: any): string => (typeof n === 'string' ? n : n && typeof n === 'object' ? kids(n).map(textOf).join('') : '')

/** A review world with ui.open recorded (its options) and ui.panes answering for the last pane opened. */
function linked(on: any, opts: Parameters<typeof reviewWorld>[1] = {}) {
  const opened: any[] = []
  const focused = { value: true }
  on('ui.open', {}, ($: unknown, e: any, next: (e: unknown) => unknown) => {
    opened.push(e)
    return next(e)
  })
  const w = reviewWorld(on, opts)
  on('ui.panes', () => ({ value: opened.length ? [{ id: opened[opened.length - 1].id, title: '', isShown: true, isFocused: focused.value, isPlaced: true }] : [] }))
  return { w, opened, focused }
}

for (const surface of SURFACES) {
  test(`hub on ${surface}: the Reviews row is 5: Reviews and n active of m subjects, quiet; a press switches to the pane`, SLOW, async ($, on) => {
    const { w, opened, focused } = linked(on)
    await fixture($, w)
    await result($, 'review_cycle', { subject: 'PR-42', verdict: 'ship' })
    const ui = await $.ui.mount({ ...HUB, surface })
    const row = await ui.find({ key: 'hub-reviews' })
    expect(textOf(row)).toContain('1 active of 2 subjects')
    expect((await ui.find({ key: 'panel-reviews' }))?.props).toMatchObject({ label: 'Reviews', hotkey: '5', plain: true })
    const words = [...walk(row)].find(x => x.n.type === 'Text' && textOf(x.n).startsWith('1 active'))
    expect(words?.n.props?.color).toBe(TONES.muted.fg)
    if (surface === 'terminal') expect(render(await ui.drawn(), 100)).toContain('5: Reviews')
    focused.value = false
    await ui.press({ key: 'panel-reviews' })
    expect(w.panes.slice(-2)).toEqual(['closed:loopkeeper-hub', PANE_ID])
    expect(opened[opened.length - 1]).toMatchObject({ id: PANE_ID, title: 'Review loops', focus: true, closeOnEscape: true })
    // the ctrl+x tab hint in the terminal (the press's surface), never on the desktop
    expect(w.toasts.filter(t => t === 'ctrl+x tab to focus the panel').length).toBe(surface === 'terminal' ? 1 : 0)
    await ui.unmount()
  })

  test(`Reviews pane on ${surface}: the nav bar leads (with or without subjects), Reviews bold, digit Buttons switch panes`, SLOW, async ($, on) => {
    const { w, opened } = linked(on)
    await start($)
    const check = async () => {
      const ui = await $.ui.mount({ ...PANE, surface })
      const items = kids(await ui.find({ key: 'nav' }))
      expect(items.map((n: any) => n.type)).toEqual(['Button', 'Button', 'Button', 'Button', 'Button', 'Text', 'Button'])
      expect(textOf(items[5])).toBe('Reviews')
      expect(items[5].props).toMatchObject({ bold: true, color: TONES.accent.fg })
      const buttons = items.filter((n: any) => n.type === 'Button')
      expect(buttons.map((n: any) => n.props?.hotkey)).toEqual(['0', '1', '2', '3', '4', '6'])
      expect(buttons.map((n: any) => n.props?.label)).toEqual(['Hub', 'Stage', 'Gates', 'Files', 'Routes', 'Decisions'])
      expect(buttons.every((n: any) => n.props?.plain === true)).toBe(true)
      if (surface === 'terminal') expect(render(await ui.drawn(), 100).split('\n')[0]).toBe('0: Hub  1: Stage  2: Gates  3: Files  4: Routes  Reviews  6: Decisions')
      // the pane's own letter hotkey stays: c Close pane
      expect((await ui.find({ key: 'close' }))?.props?.hotkey).toBe('c')
      return ui
    }
    // no subjects yet, then one
    await (await check()).unmount()
    await result($, 'review_cycle', { subject: 'PR-42', kind: 'review', items: ['naming'] })
    const ui = await check()
    await ui.press({ key: 'decisions' })
    expect(w.panes.slice(-2)).toEqual(['closed:' + PANE_ID, 'loopkeeper-decisions'])
    await ui.press({ key: 'hub' })
    expect(w.panes.slice(-2)).toEqual(['closed:' + PANE_ID, 'loopkeeper-hub'])
    expect(opened[opened.length - 1]).toMatchObject({ id: 'loopkeeper-hub', focus: true, closeOnEscape: true, rows: 22 })
    await ui.unmount()
  })
}

test('the hub keeps the Reviews row with the band off and with the kill switch on', SLOW, async ($, on) => {
  linked(on, { env: { CLAUDE_MODS_DISABLE: 'loopkeeper' } })
  await start($)
  await lk($, 'band review off')
  const ui = await $.ui.mount({ ...HUB, surface: 'terminal' })
  expect(textOf(await ui.find({ key: 'hub-reviews' }))).toContain('0 active of 0 subjects · band off')
  expect(await ui.find({ key: 'panel-reviews' })).toBeDefined()
  await ui.unmount()
})
