// kit.test.ts: tests of the shared UI kit (hooks/lib/kit.ts, kit v3). The first eleven tests are the
// kit v1 suite ported with the changes v2 makes on purpose (theme-key colors, one look on both
// surfaces, no fills and no dimColor); the rest pin the v2 rules on both surfaces. The drawings are
// made by the test's own ui.render hook (the `on` registrar), which touches none of the concerns.
// The kit v3 tests at the end pin the additions: pill, header, icon, typeBadge, progress, button
// variants and the pure helpers, on the terminal (text), the desktop and a mobile table (Svg).
import { expect, test } from 'claude-code/testing'

import { KIT_VERSION, PALETTE, TONES, barText, clock, makeKit, money, pct, tokensShort } from '../hooks/lib/kit.ts'
import { CHIP_HEX, PILL, TONE_HEX, extOf, pillSvg, shortPath } from '../hooks/lib/kit.ts'
import type { Elements, IconName, Kit, PillTone, Role, Tone } from '../hooks/lib/kit.ts'
import { render } from './render.ts'

type Node = { type: string; props: Record<string, unknown>; children: unknown[] }

const SURFACES = ['terminal', 'desktop'] as const
const ROLES: Role[] = ['main', 'recon', 'execute', 'verify', 'hard', 'reviewer', 'other']
const STATES = ['running', 'done', 'failed', 'waiting', 'idle'] as const

// What Claude Code passes to a ui.render hook for a pane, apart from the app.
const PANE = {
  plugin: 'test',
  component: 'Pane',
  requestId: 'kit-probe',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Kit', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

/** Stands in for $.ui.resolve(e) outside a hook: each element returns plain data. */
function fakeElements(): Elements {
  const names = ['Box', 'Text', 'Button', 'Input', 'Select', 'Link', 'Code', 'Markdown', 'Svg']
  const out: Elements = {}
  for (const type of names) {
    out[type] = (props: Record<string, unknown>) => {
      const { children, ...rest } = props
      return { type, props: rest, children: Array.isArray(children) ? children : [] }
    }
  }
  return out
}

/** Every string inside a node, in order. */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object') return ''
  return ((node as Node).children ?? []).map(textOf).join('')
}

/** One of every helper, so a mount validates every prop the kit uses. */
function everything(k: Kit, onPress: (e?: unknown) => unknown): unknown {
  return k.stack(
    [
      k.hero({ kicker: 'right now', title: 'Reading client.test.js', sub: 'in tests', icon: '◉', tone: 'info' }),
      k.card({ title: 'recon · haiku', right: '0:40', tone: 'ok', children: [k.bar(0.4, { tone: 'ok' }), k.kv('ctx', '4%')] }),
      k.section('Claude touched 3 files', '3'),
      k.tiles([
        { label: 'Cost', value: money(0.08), tone: 'accent' },
        { label: 'Tokens', value: tokensShort(18_000) },
        { label: 'Time', value: clock(40_000), tone: 'muted' },
      ]),
      k.row({ key: 'r1', left: [k.doodle('recon', 'running'), 'client.test.js', k.badge('edited', 'warn')], right: 'tests' }),
      k.row({ left: 'plain row', right: ['a', 'b'] }),
      k.legend([
        { tone: 'info', label: 'Claude read' },
        { tone: 'warn', label: 'Claude edited' },
        { tone: 'danger', label: 'Not committed' },
      ]),
      k.badge('ok', 'ok'),
      k.text('plain line', { bold: true }),
      k.line('worker', [k.badge('busy', 'info'), { text: '3 tasks', tone: 'ok' }, 'idle'], ['≈$1.2', '18k tok']),
      k.buttons([
        { key: 'refresh', label: 'Refresh', hotkey: 'r', onPress },
        { key: 'close', label: 'Close', plain: true, onPress },
        { key: 'skip', label: 'Skip', plain: false, onPress },
      ]),
    ],
    1,
  )
}

test('money rounds to cents, dimes or dollars and reads null as a dash', () => {
  expect(money(null)).toBe('—')
  expect(money(undefined)).toBe('—')
  expect(money(Number.NaN)).toBe('—')
  expect(money(0)).toBe('$0')
  expect(money(0.001)).toBe('<$0.01')
  expect(money(0.08)).toBe('≈$0.08')
  expect(money(0.084)).toBe('≈$0.08')
  expect(money(0.999)).toBe('≈$1.0')
  expect(money(1.23)).toBe('≈$1.2')
  expect(money(9.96)).toBe('≈$10')
  expect(money(12.4)).toBe('≈$12')
  expect(money(-3)).toBe('$0')
})

test('tokensShort writes k and M with one decimal under ten', () => {
  expect(tokensShort(0)).toBe('0')
  expect(tokensShort(-5)).toBe('0')
  expect(tokensShort(950)).toBe('950')
  expect(tokensShort(1000)).toBe('1k')
  expect(tokensShort(1500)).toBe('1.5k')
  expect(tokensShort(9_960)).toBe('10k')
  expect(tokensShort(37_000)).toBe('37k')
  expect(tokensShort(999_600)).toBe('1M')
  expect(tokensShort(1_200_000)).toBe('1.2M')
  expect(tokensShort(15_400_000)).toBe('15M')
})

test('clock writes m:ss under an hour and h:mm:ss above', () => {
  expect(clock(0)).toBe('0:00')
  expect(clock(-1)).toBe('0:00')
  expect(clock(40_000)).toBe('0:40')
  expect(clock(40_999)).toBe('0:40')
  expect(clock(605_000)).toBe('10:05')
  expect(clock(3_723_000)).toBe('1:02:03')
})

test('pct rounds to a whole percent; barText fills by the clamped ratio', () => {
  expect(pct(0.04)).toBe('4%')
  expect(pct(1)).toBe('100%')
  expect(pct(1.2)).toBe('120%')
  expect(pct(-0.5)).toBe('0%')
  expect(pct(Number.NaN)).toBe('0%')
  expect(barText(0.4)).toBe('━━━━╌╌╌╌╌╌')
  expect(barText(0)).toBe('╌'.repeat(10))
  expect(barText(1)).toBe('━'.repeat(10))
  expect(barText(1.7)).toBe('━'.repeat(10))
  expect(barText(-2)).toBe('╌'.repeat(10))
  expect(barText(Number.NaN)).toBe('╌'.repeat(10))
  expect(barText(0.5, 4)).toBe('━━╌╌')
  expect(barText(0.5, 0)).toBe('━━━━━╌╌╌╌╌')
})

test('TONES has all six tones with a color fg and bg (a theme key, camelCase allowed); KIT_VERSION is semver', () => {
  const tones: Tone[] = ['info', 'ok', 'warn', 'danger', 'muted', 'accent']
  expect(Object.keys(TONES).sort()).toEqual([...tones].sort())
  for (const t of tones) {
    expect(TONES[t].fg).toMatch(/^[a-zA-Z]+$/)
    expect(TONES[t].bg).toMatch(/^[a-zA-Z]+$/)
  }
  expect(KIT_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  expect(KIT_VERSION).toBe('3.1.0')
  for (const t of tones) expect(TONES[t].bg).toBe(TONES[t].fg)
})

test('every helper returns an element tree on both surfaces', () => {
  for (const surface of SURFACES) {
    const k = makeKit(fakeElements(), surface)
    expect(k.surface).toBe(surface)
    const trees: unknown[] = [
      k.hero({ title: 't' }),
      k.hero({ kicker: 'k', title: 't', sub: 's', icon: '◉', tone: 'warn' }),
      k.card({ children: [] }),
      k.card({ title: 't', right: 'r', tone: 'ok', children: [k.text('x')] }),
      k.section('label'),
      k.section('label', 'right'),
      k.tiles([{ label: 'a', value: '1' }]),
      k.tiles([]),
      k.badge('b'),
      k.legend([{ tone: 'ok', label: 'l' }]),
      k.bar(0.5),
      k.row({ left: 'l' }),
      k.row({ left: ['a', k.badge('b')], right: 'r', key: 'k' }),
      k.kv('k', 'v', 'danger'),
      k.buttons([{ key: 'a', label: 'A', onPress: () => undefined }]),
      k.doodle('main'),
      k.stack([k.text('a'), k.text('b')], 1),
      k.text('t', { bold: true }),
    ]
    for (const tree of trees) {
      expect(typeof tree).toBe('object')
      expect(tree).not.toBe(null)
    }
  }
})

test('terminal draws round frames, ● badges and glyph doodles', () => {
  const k = makeKit(fakeElements(), 'terminal')
  const hero = k.hero({ kicker: 'right now', title: 'Reading x', sub: 'in tests', tone: 'info' }) as Node
  expect(hero.type).toBe('Box')
  expect(hero.props.borderStyle).toBe('round')
  expect(hero.props.backgroundColor).toBeUndefined()
  expect(textOf(hero)).toBe('right nowReading xin tests')
  const badge = k.badge('edited', 'warn') as Node
  expect(badge.type).toBe('Text')
  expect(textOf(badge)).toBe('● edited')
  expect(badge.props).toEqual({ color: TONES.warn.fg, bold: true, wrap: 'truncate' })
  for (const role of ROLES) {
    const d = k.doodle(role, 'failed') as Node
    expect(d.type).toBe('Text')
    expect(d.props.color).toBe(TONES.danger.fg)
    expect(textOf(d)).toHaveLength(1)
  }
  expect((k.doodle('main', 'running') as Node).props.color).toBe(TONES.info.fg)
  expect((k.doodle('main') as Node).props.color).toBe(TONES.muted.fg)
  expect(textOf(k.doodle('verify', 'done'))).toBe('✓')
})

test('desktop draws the same frames and badges, with Svg doodles and no fills', () => {
  const k = makeKit(fakeElements(), 'desktop')
  const card = k.card({ title: 'T', children: [] }) as Node
  expect(card.type).toBe('Box')
  expect(card.props.borderStyle).toBe('round')
  expect(card.props.backgroundColor).toBeUndefined()
  expect(card.props.paddingX).toBe(1)
  const badge = k.badge('ok', 'ok') as Node
  expect(textOf(badge)).toBe('● ok')
  expect(badge.props.backgroundColor).toBeUndefined()
  expect(JSON.stringify(k.badge('ok', 'ok'))).toBe(JSON.stringify(makeKit(fakeElements(), 'terminal').badge('ok', 'ok')))
  for (const role of ROLES) {
    for (const state of STATES) {
      const d = k.doodle(role, state) as Node
      expect(d.type).toBe('Svg')
      expect(d.props.width).toBe(36)
      expect(d.props.height).toBe(36)
      const source = String(d.props.source)
      expect(source.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
      expect(source.length).toBeLessThan(131_072)
      expect(source).toContain('<rect ')
      expect(textOf(makeKit(fakeElements(), 'terminal').doodle(role, state))).toBe(String(d.props.alt))
    }
  }
})

test('section, legend, bar, row, kv and buttons lay out their parts', () => {
  const k = makeKit(fakeElements(), 'terminal')
  const section = k.section('Claude touched', '3 files') as Node
  expect(section.props).toEqual({ flexDirection: 'row', justifyContent: 'space-between', columnGap: 1 })
  expect(textOf(section)).toBe('Claude touched3 files')
  expect(textOf(k.legend([{ tone: 'info', label: 'read' }, { tone: 'warn', label: 'edited' }]))).toBe('● read  ● edited')
  expect(textOf(k.bar(0.25, { width: 4 }))).toBe('━╌╌╌ 25%')
  const row = k.row({ left: 'a.ts', right: 'src', key: 'r' }) as Node
  expect(row.props.key).toBe('r')
  const right = row.children[1] as Node
  expect((right.children[0] as Node).props.color).toBe('inactive')
  expect(row.children).toHaveLength(2)
  expect((k.row({ left: 'only' }) as Node).children).toHaveLength(1)
  expect(textOf(k.kv('ctx', '4%'))).toBe('ctx 4%')
  const bar = k.buttons([
    { key: 'a', label: 'A', hotkey: 'a', onPress: () => undefined, plain: false },
    { key: 'b', label: 'B', onPress: () => undefined, plain: true },
  ]) as Node
  expect(bar.props).toEqual({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, rowGap: 1 })
  const [a, b] = bar.children as Node[]
  expect(Object.keys(a.props).sort()).toEqual(['hotkey', 'key', 'label', 'onPress'])
  expect(b.props.plain).toBe(true)
  expect((k.stack([k.text('x')]) as Node).props).toEqual({ flexDirection: 'column' })
})

test('a hero, tiles and buttons tree validates on both surfaces and a press reaches its handler', { timeoutMs: 20_000 }, async ($, on) => {
  const presses: string[] = []
  on('ui.render', { component: 'Pane' }, ($$, e) => {
    const k = makeKit($$.ui.resolve(e) as unknown as Elements, e.surface)
    return k.stack(
      [
        k.hero({ kicker: 'right now', title: 'Claude is reading client.test.js', sub: 'in tests', tone: 'info' }),
        k.tiles([
          { label: 'Cost', value: money(1.23) },
          { label: 'Tokens', value: tokensShort(18_000) },
          { label: 'Time', value: clock(40_000) },
        ]),
        k.buttons([
          { key: 'refresh', label: 'Refresh', hotkey: 'r', onPress: (ev?: unknown) => presses.push(String((ev as { surface?: string })?.surface)) },
          { key: 'close', label: 'Close', plain: true, onPress: () => presses.push('close') },
        ]),
      ],
      1,
    ) as never
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    expect(await ui.find({ type: 'Text', text: 'right now' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '≈$1.2' })).toBeDefined()
    expect(await ui.find({ key: 'close' })).toBeDefined()
    await ui.press({ key: 'refresh' })
    await ui.unmount()
  }
  expect(presses).toEqual(['terminal', 'desktop'])
})

test('a tree using every helper validates on both surfaces', async ($, on) => {
  on('ui.render', { component: 'Pane' }, ($$, e) => {
    const k = makeKit($$.ui.resolve(e) as unknown as Elements, e.surface)
    return everything(k, () => undefined) as never
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    expect(await ui.find({ type: 'Svg' }))[surface === 'desktop' ? 'toBeDefined' : 'toBeUndefined']()
    expect(await ui.find({ type: 'Text', text: 'Claude touched 3 files' })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(3)
    await ui.unmount()
  }
})

// ------------------------------------------------------------------ kit v2 rules, on both surfaces

const THEME_KEYS = ['suggestion', 'success', 'warning', 'error', 'claude', 'inactive']
const NAMED_COLORS = ['blue', 'green', 'red', 'magenta', 'inactive']
/** The colors the tone table may produce (plus `inactive`, the quiet color, which is also a tone). */
const ALLOWED = new Set(PALETTE === 'named' ? NAMED_COLORS : THEME_KEYS)

/** One of each helper that draws text or boxes, by name, to scan one at a time. */
function each(k: Kit): Record<string, unknown> {
  const onPress = () => undefined
  return {
    hero: k.hero({ kicker: 'right now', title: 'Reading x', sub: 'in tests', icon: '◉', tone: 'warn' }),
    heroPlain: k.hero({ title: 'Reading x' }),
    card: k.card({ title: 'recon · haiku', right: '0:40', tone: 'ok', children: [k.kv('ctx', '4%', 'danger')] }),
    cardPlain: k.card({ children: [k.text('x')] }),
    section: k.section('Claude touched', '3 files'),
    tiles: k.tiles([
      { label: 'Cost', value: '≈$1.2', tone: 'accent' },
      { label: 'Tokens', value: '18k' },
      { label: 'Time', value: '4:20', tone: 'muted' },
    ]),
    badge: k.badge('edited', 'warn'),
    badgeMuted: k.badge('idle'),
    legend: k.legend([
      { tone: 'info', label: 'read' },
      { tone: 'warn', label: 'edited' },
      { tone: 'danger', label: 'lost' },
      { tone: 'accent', label: 'new' },
    ]),
    bar: k.bar(0.4, { tone: 'ok' }),
    row: k.row({ left: ['a.ts', k.badge('b', 'info')], right: ['src', 'x'] }),
    kv: k.kv('ctx', '4%', 'info'),
    buttons: k.buttons([{ key: 'a', label: 'A', hotkey: 'a', onPress }, { key: 'b', label: 'B', plain: true, onPress }]),
    line: k.line('worker', [k.badge('busy', 'info'), { text: '3 tasks', tone: 'ok' }], ['≈$1.2', '18k tok']),
  }
}

/** Every value of a `color` or `borderColor` prop in a tree. */
function colorsIn(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== 'object') return out
  const n = node as Node
  for (const key of ['color', 'borderColor']) {
    if (typeof n.props?.[key] === 'string') out.push(n.props[key] as string)
  }
  for (const c of n.children ?? []) colorsIn(c, out)
  return out
}

/** Every Text and Box in a tree, depth first. */
function walk(node: unknown, out: Node[] = []): Node[] {
  if (!node || typeof node !== 'object') return out
  const n = node as Node
  out.push(n)
  for (const c of n.children ?? []) walk(c, out)
  return out
}

for (const surface of SURFACES) {
  test(`${surface}: every color is a tone-table color; nothing dims, fills or uses a forbidden color`, () => {
    const k = makeKit(fakeElements(), surface)
    const trees = each(k)
    expect(Object.keys(trees)).toHaveLength(14)
    for (const [name, tree] of Object.entries(trees)) {
      for (const c of colorsIn(tree)) expect(`${name}:${ALLOWED.has(c) ? c : 'NOT ALLOWED ' + c}`).toBe(`${name}:${c}`)
      const json = JSON.stringify(tree)
      expect(json).not.toMatch(/dimColor|backgroundColor/)
      expect(json).not.toMatch(/yellow|white|gray|grey|black|subtle/i)
    }
    if (PALETTE === 'theme') expect(Object.values(TONES).map(t => t.fg).sort()).toEqual(['claude', 'error', 'inactive', 'success', 'suggestion', 'warning'])
    else expect(Object.values(TONES).some(t => t.fg === 'yellow')).toBe(false)
  })

  test(`${surface}: hero and card draw a round frame with paddingX 1; tiles draw single boxes, label over a bold value`, () => {
    const k = makeKit(fakeElements(), surface)
    const trees = each(k) as Record<string, Node>
    for (const name of ['hero', 'heroPlain', 'card', 'cardPlain']) {
      expect(trees[name]!.type).toBe('Box')
      expect(trees[name]!.props).toMatchObject({ flexDirection: 'column', borderStyle: 'round', paddingX: 1 })
      expect(trees[name]!.props.paddingY).toBeUndefined()
    }
    expect(trees.hero!.props.borderColor).toBe(TONES.warn.fg)
    expect(trees.heroPlain!.props.borderColor).toBe('inactive')
    expect(trees.card!.props.borderColor).toBe(TONES.ok.fg)
    const boxes = trees.tiles!.children as Node[]
    expect(trees.tiles!.props).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, rowGap: 1 })
    expect(boxes).toHaveLength(3)
    for (const box of boxes) {
      expect(box.props).toMatchObject({ flexDirection: 'column', borderStyle: 'single', borderColor: 'inactive', flexGrow: 1, paddingX: 1 })
      const [label, value] = box.children as Node[]
      expect(label!.props.color).toBe('inactive')
      expect(label!.props.bold).toBeUndefined()
      expect(value!.props.bold).toBe(true)
    }
    const [cost, tokens, time] = boxes.map(b => (b.children as Node[])[1]!)
    expect(cost!.props.color).toBe(TONES.accent.fg)
    expect(tokens!.props.color).toBeUndefined()
    expect(time!.props.color).toBe(TONES.muted.fg)
  })

  test(`${surface}: badge is a ● chip, bold unless muted; secondary text is inactive`, () => {
    const k = makeKit(fakeElements(), surface)
    for (const tone of ['info', 'ok', 'warn', 'danger', 'accent'] as const) {
      const b = k.badge('x', tone) as Node
      expect(textOf(b)).toBe('● x')
      expect(b.props).toMatchObject({ color: TONES[tone].fg, bold: true })
    }
    const muted = k.badge('x') as Node
    expect(muted.props.color).toBe('inactive')
    expect(muted.props.bold).toBeUndefined()
    const kv = k.kv('ctx', '4%') as Node
    expect((kv.children[0] as Node).props.color).toBe('inactive')
    expect((kv.children[1] as Node).props.bold).toBe(true)
    const hero = k.hero({ kicker: 'k', title: 't', sub: 's' }) as Node
    const [kicker, title, sub] = hero.children as Node[]
    expect(kicker!.props.color).toBe('inactive')
    expect(title!.props.bold).toBe(true)
    expect(sub!.props.color).toBe('inactive')
    const bar = k.bar(0.5, { width: 4 }) as Node
    expect((bar.children[1] as Node).props.color).toBe('inactive')
  })

  test(`${surface}: line() is one row: bold label, up to four chips two columns apart, quiet right side`, () => {
    const k = makeKit(fakeElements(), surface)
    const chips = ['a', 'b', { text: 'c', tone: 'ok' as Tone }, { text: 'd', tone: 'danger' as Tone }, 'e-not-drawn']
    const line = k.line('map', chips, ['x', '', 'y']) as Node
    expect(line.props).toMatchObject({ flexDirection: 'row', justifyContent: 'space-between', columnGap: 2 })
    const [left, right] = line.children as Node[]
    expect(left!.props).toMatchObject({ flexDirection: 'row', columnGap: 2, flexShrink: 1 })
    const [label, ...drawn] = left!.children as Node[]
    expect(label!.props.bold).toBe(true)
    expect(label!.props.color).toBeUndefined()
    expect(drawn.map(textOf)).toEqual(['● a', '● b', '● c', '● d'])
    expect(drawn[2]!.props).toMatchObject({ color: TONES.ok.fg, bold: true })
    expect(drawn[0]!.props.bold).toBeUndefined()
    expect(textOf(right)).toBe('x · y')
    expect(right!.props).toMatchObject({ color: 'inactive', wrap: 'truncate' })
    expect(((k.line('map', []) as Node).children as unknown[]).length).toBe(1)
    expect(((k.line('map', [], '') as Node).children as unknown[]).length).toBe(1)
  })
}

// ------------------------------------------------------------------ mounted: validation and text

/** The band line this test's own hook drew, out of a prompt band that also holds the concerns' bands. */
function ownLine(tree: unknown): Node {
  const found = walk(tree).find(
    n => n.props?.justifyContent === 'space-between' && n.props?.columnGap === 2 && textOf(n).startsWith('worker'),
  )
  if (!found) throw new Error('no kit line in the drawn band')
  return found
}

/** The pane the snapshot pins: hero, tiles and card, one blank line apart. */
function pane(k: Kit): unknown {
  return k.stack(
    [
      k.hero({ kicker: 'right now', title: 'Reading client.test.js', sub: 'in tests', tone: 'info' }),
      k.tiles([
        { label: 'Cost', value: money(1.2), tone: 'accent' },
        { label: 'Tokens', value: tokensShort(18_000) },
        { label: 'Time', value: clock(260_000) },
      ]),
      k.card({ title: 'recon · haiku', right: clock(40_000), tone: 'ok', children: [k.kv('ctx', pct(0.04))] }),
    ],
    1,
  )
}

const PANE_AFTER = [
  '╭──────────────────────────────────────────╮',
  '│ right now                                │',
  '│ Reading client.test.js                   │',
  '│ in tests                                 │',
  '╰──────────────────────────────────────────╯',
  '',
  '┌────────────┐ ┌─────────────┐ ┌───────────┐',
  '│ Cost       │ │ Tokens      │ │ Time      │',
  '│ ≈$1.2      │ │ 18k         │ │ 4:20      │',
  '└────────────┘ └─────────────┘ └───────────┘',
  '',
  '╭──────────────────────────────────────────╮',
  '│ recon · haiku                       0:40 │',
  '│ ctx 4%                                   │',
  '╰──────────────────────────────────────────╯',
].join('\n')

test('a mounted pane of hero, tiles and card renders to the pinned text, the same on both surfaces', async ($, on) => {
  on('ui.render', { component: 'Pane' }, ($$, e) => pane(makeKit($$.ui.resolve(e) as unknown as Elements, e.surface)) as never)
  const seen: string[] = []
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    const tree = await ui.drawn()
    seen.push(render(tree, 44))
    expect(JSON.stringify(tree)).not.toMatch(/dimColor|backgroundColor|yellow|white|gray|grey|black|subtle/i)
    await ui.unmount()
  }
  expect(seen[0]).toBe(PANE_AFTER)
  expect(seen[1]).toBe(PANE_AFTER)
})

test('a mounted band line renders as `label  ● a  ● b   right · text` in one row on both surfaces', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const k = makeKit($$.ui.resolve(e) as unknown as Elements, e.surface)
    return k.line('worker', [k.badge('busy', 'info'), k.badge('3 tasks', 'ok')], ['≈$1.2', '18k tok']) as never
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, component: 'AbovePrompt', props: {}, surface } as never)
    // the other concerns' stub bands share the prompt band: take the line this test drew
    const tree = ownLine(await ui.drawn())
    expect(render(tree, 58)).toBe('worker  ● busy  ● 3 tasks                  ≈$1.2 · 18k tok')
    expect(render(tree, 58).split('\n')).toHaveLength(1)
    // a narrow band truncates the right side and keeps one row
    expect(render(tree, 40).split('\n')).toHaveLength(1)
    expect(render(tree, 40)).toMatch(/^worker {2}● busy {2}● 3 tasks/)
    await ui.unmount()
  }
})

test('every helper, line included, validates in a Pane and in the prompt band on both surfaces', async ($, on) => {
  on('ui.render', {}, ($$, e) => {
    const k = makeKit($$.ui.resolve(e) as unknown as Elements, e.surface)
    return (e.component === 'AbovePrompt' ? (each(k) as Record<string, unknown>).line : everything(k, () => undefined)) as never
  })
  for (const surface of SURFACES) {
    for (const component of ['Pane', 'AbovePrompt']) {
      const props = component === 'Pane' ? PANE.props : {}
      const ui = await $.ui.mount({ ...PANE, component, props, surface } as never)
      const whole = await ui.drawn()
      const tree = component === 'Pane' ? whole : ownLine(whole)
      expect(walk(tree).length).toBeGreaterThan(3)
      const json = JSON.stringify(tree)
      const stripped = json.replace(/"source":"[^"]*"/g, '')
      expect(stripped).not.toMatch(/dimColor|backgroundColor|yellow|white|gray|grey|black|subtle/i)
      await ui.unmount()
    }
  }
})

// ------------------------------------------------------------------ kit v3 additions

const ICON_NAMES: IconName[] = [
  'eye', 'pencil', 'plus', 'branch', 'search', 'folder', 'folder-open', 'file', 'shield', 'flag', 'check', 'dot', 'clock',
]
const ICON_GLYPH_LIST = ['◉', '✎', '+', '⎇', '⌕', '▸', '▾', '·', '⛨', '⚑', '✓', '●', '◷']
const PILL_TONES: PillTone[] = ['info', 'ok', 'warn', 'danger', 'accent', 'muted', 'violet']
const PILL_KEYS: Record<PillTone, string> = {
  info: 'suggestion', ok: 'success', warn: 'claude', danger: 'error', accent: 'claude', muted: 'inactive', violet: 'permission',
}
const FORBIDDEN = /dimColor|yellow|white|gray|grey|black|subtle/i

/** The mobile app's table: Svg, but no Input or Select. */
function mobileElements(): Elements {
  const out = fakeElements()
  delete out.Input
  delete out.Select
  return out
}

/** One of each v3 export, by name. */
function eachV3(k: Kit): Record<string, unknown> {
  const onPress = () => undefined
  const out: Record<string, unknown> = {
    header: k.header('Files', '3 changed'),
    headerPlain: k.header('Recent'),
    typeBadge: k.typeBadge('client.test.js'),
    typeBadgeOther: k.typeBadge('model.blend'),
    progress: k.progress(0.4, { tone: 'ok' }),
    progressWide: k.progress(0.75, { width: 120, tone: 'danger' }),
    buttons: k.buttons([
      { key: 'cards', label: 'Cards', variant: 'primary', onPress },
      { key: 'list', label: 'List', variant: 'secondary', onPress },
      { key: 'skip', label: 'Skip', plain: false, onPress },
    ]),
  }
  for (const t of PILL_TONES) out['pill-' + t] = k.pill('Reading', t)
  for (const n of ICON_NAMES) out['icon-' + n] = k.icon(n, n === 'dot' ? 'violet' : undefined)
  return out
}

test('kit v3: KIT_VERSION is 3.1.0, PILL is svg, TONE_HEX has a hex per tone plus violet', () => {
  expect(KIT_VERSION).toBe('3.1.0')
  expect(PILL).toBe('svg')
  expect(TONE_HEX).toEqual({
    info: '#3B82F6', ok: '#22A35A', warn: '#D97757', danger: '#E5484D', accent: '#D97757', muted: '#8A8F98', violet: '#8B5CF6',
  })
})

// The WCAG contrast ratio of white text on a hex fill
function contrastOnWhite(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const lin = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : Math.pow((c / 255 + 0.055) / 1.055, 2.4))
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  return 1.05 / (l + 0.05)
}

test('kit v3: CHIP_HEX has a pill fill per tone plus violet, each at least 4.5:1 against white text', () => {
  expect(CHIP_HEX).toEqual({
    info: '#2563EB', ok: '#15803D', warn: '#C2410C', danger: '#B91C1C', accent: '#C2410C', muted: '#5B6170', violet: '#7C3AED',
  })
  expect(Object.keys(CHIP_HEX).sort()).toEqual(Object.keys(TONE_HEX).sort())
  for (const hex of Object.values(CHIP_HEX)) expect(contrastOnWhite(hex)).toBeGreaterThanOrEqual(4.5)
})

test('kit v3: extOf reads a lower-case extension; shortPath shortens inside the root, the home and elsewhere', () => {
  expect(extOf('a.ts')).toBe('ts')
  expect(extOf('src/a.test.TSX')).toBe('tsx')
  expect(extOf('/path/to/dir.d/Makefile')).toBe('')
  expect(extOf('.gitignore')).toBe('')
  expect(extOf('notes.')).toBe('')
  expect(extOf('')).toBe('')
  const root = '/home/tester/project'
  const home = '/home/tester'
  expect(shortPath('/home/tester/project/src/a.ts', root, home)).toBe('src/a.ts')
  expect(shortPath('/home/tester/project', root, home)).toBe('.')
  expect(shortPath('/home/tester/project/', root + '/', home + '/')).toBe('.')
  expect(shortPath('/home/tester/project/src/', root, home)).toBe('src')
  expect(shortPath('/home/tester/notes/todo.md', root, home)).toBe('~/notes/todo.md')
  expect(shortPath('/home/tester/project2/a.ts', root, home)).toBe('~/project2/a.ts')
  expect(shortPath('/home/tester', root, home)).toBe('~')
  expect(shortPath('/etc/nginx/sites/default', root, home)).toBe('…/sites/default')
  expect(shortPath('/etc/hosts', root, home)).toBe('…/etc/hosts')
  expect(shortPath('src/a.ts', root, home)).toBe('src/a.ts')
})

test('kit v3: pill is a fully rounded Svg chip on Svg surfaces (alt = the text, width and height), a ● chip on the terminal', () => {
  for (const surface of ['desktop', 'mobile'] as const) {
    const k = makeKit(surface === 'mobile' ? mobileElements() : fakeElements(), surface)
    for (const t of PILL_TONES) {
      const n = k.pill('Reading', t) as Node
      expect(n.type).toBe('Svg')
      expect(n.props.alt).toBe('Reading')
      expect(n.props.source).toBe(pillSvg('Reading', t))
      expect(n.props.height).toBe(18)
      expect(String(n.props.source)).toContain(`viewBox="0 0 ${n.props.width} 18" width="${n.props.width}" height="18"`)
      expect(String(n.props.source)).toContain('rx="9"')
      expect(n.props.backgroundColor).toBeUndefined()
    }
    expect((k.pill('x') as Node).props.source).toBe(pillSvg('x', 'muted'))
    expect((k.pill('') as Node).props.width).toBe(18)
    expect((k.pill('Not committed') as Node).props.width).toBeGreaterThan((k.pill('p0') as Node).props.width as number)
  }
  // The terminal draws the same `● text` chip in either mode (the fill test below pins it per tone).
  const term = makeKit(fakeElements(), 'terminal')
  const termFill = makeKit(fakeElements(), 'terminal', { pill: 'fill' })
  for (const t of PILL_TONES) expect(term.pill('Opened', t)).toEqual(termFill.pill('Opened', t))
  expect(textOf(term.pill('Opened', 'ok'))).toBe('● Opened')
})

test('kit v3: the fill path (pill: fill) fills with the tone key under inverseText on Svg surfaces, a ● chip on the terminal', () => {
  for (const surface of ['desktop', 'mobile'] as const) {
    const k = makeKit(surface === 'mobile' ? mobileElements() : fakeElements(), surface, { pill: 'fill' })
    for (const t of PILL_TONES) {
      const n = k.pill('Reading', t) as Node
      expect(n.type).toBe('Text')
      expect(n.props).toEqual({ backgroundColor: PILL_KEYS[t], color: 'inverseText', bold: true, wrap: 'truncate' })
      expect(textOf(n)).toBe(' Reading ')
    }
    expect((k.pill('x') as Node).props.backgroundColor).toBe('inactive')
  }
  const term = makeKit(fakeElements(), 'terminal', { pill: 'fill' })
  for (const t of PILL_TONES) {
    const n = term.pill('Opened', t) as Node
    expect(n.type).toBe('Text')
    expect(textOf(n)).toBe('● Opened')
    expect(n.props.backgroundColor).toBeUndefined()
    expect(n.props.color).toBe(t === 'violet' ? 'permission' : TONES[t as Tone].fg)
    expect(n.props.bold === true).toBe(t !== 'muted')
  }
  expect(term.pill('Opened', 'warn')).toEqual(term.badge('Opened', 'warn'))
})

test("kit v3: pillSvg is a fully rounded rect (rx = h/2) in the tone's chip fill with white text, escaped, cached per input", () => {
  for (const t of PILL_TONES) {
    const s = pillSvg('Reading', t)
    expect(s.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(s).toContain(`fill="${CHIP_HEX[t]}"`)
    expect(s).not.toContain(`fill="${TONE_HEX[t]}"`)
    expect(s).toContain('height="18" rx="9"')
    expect(s).toContain('fill="#FFFFFF"')
    expect(s).toContain('>Reading</text>')
    expect(s).not.toMatch(FORBIDDEN)
  }
  expect(pillSvg('a<b & "c"', 'ok')).toContain('>a&lt;b &amp; &quot;c&quot;</text>')
  expect(pillSvg('x', 'nope' as PillTone)).toContain(`fill="${CHIP_HEX.muted}"`)
  expect(pillSvg('Opened', 'info')).toBe(pillSvg('Opened', 'info'))
  expect(pillSvg('Opened', 'info')).not.toBe(pillSvg('Opened', 'ok'))
})

test('kit v3: header upper-cases its label and right side, bold and quiet, in one row', () => {
  for (const surface of SURFACES) {
    const k = makeKit(fakeElements(), surface)
    const n = k.header('Recent files', '3 changed') as Node
    expect(n.type).toBe('Box')
    expect(n.props).toEqual({ flexDirection: 'row', justifyContent: 'space-between', columnGap: 1 })
    const [label, right] = n.children as Node[]
    expect(textOf(label)).toBe('RECENT FILES')
    expect(label.props).toEqual({ bold: true, color: 'inactive', wrap: 'truncate' })
    expect(textOf(right)).toBe('3 CHANGED')
    expect(right.props).toEqual({ color: 'inactive', wrap: 'truncate' })
    expect((k.header('Recent') as Node).children).toHaveLength(1)
  }
})

test('kit v3: icon is a 16×16 stroked Svg with alt on Svg surfaces and one glyph in the tone on the terminal', () => {
  const desk = makeKit(fakeElements(), 'desktop')
  const term = makeKit(fakeElements(), 'terminal')
  ICON_NAMES.forEach((name, i) => {
    const n = desk.icon(name) as Node
    expect(n.type).toBe('Svg')
    expect(n.props.alt).toBe(name)
    expect([n.props.width, n.props.height]).toEqual([16, 16])
    const src = String(n.props.source)
    expect(src).toContain('viewBox="0 0 16 16"')
    expect(src).toContain('stroke="#6B7280"')
    expect(src).toContain('stroke-width="1.8"')
    expect(src).toContain('stroke-linecap="round"')
    expect(String((desk.icon(name, 'violet') as Node).props.source)).toContain(`stroke="${TONE_HEX.violet}"`)
    const g = term.icon(name, 'ok') as Node
    expect(g.type).toBe('Text')
    expect(textOf(g)).toBe(ICON_GLYPH_LIST[i])
    expect(g.props.color).toBe(TONES.ok.fg)
    expect((term.icon(name) as Node).props.color).toBe('inactive')
  })
  expect((desk.icon('nope' as IconName) as Node).props.alt).toBe('dot')
})

test('kit v3: typeBadge maps extensions to a label, a fill and a terminal tone; null without an extension', () => {
  const cases: [string, string, string, Tone][] = [
    ['client.test.js', 'JS', '#F0C419', 'accent'], ['a.jsx', 'JS', '#F0C419', 'accent'], ['b.mjs', 'JS', '#F0C419', 'accent'],
    ['c.cjs', 'JS', '#F0C419', 'accent'], ['kit.ts', 'TS', '#3178C6', 'info'], ['App.tsx', 'TS', '#3178C6', 'info'],
    ['report.PDF', 'PDF', '#E5484D', 'danger'], ['README.md', 'MD', '#4A7BD0', 'info'], ['page.mdx', 'MD', '#4A7BD0', 'info'],
    ['spec.docx', 'DOC', '#2B579A', 'info'], ['old.doc', 'DOC', '#2B579A', 'info'], ['data.csv', 'CSV', '#22A35A', 'ok'],
    ['package.json', 'JSON', '#64748B', 'muted'], ['ci.yml', 'YML', '#64748B', 'muted'], ['ci.yaml', 'YML', '#64748B', 'muted'],
    ['index.html', 'HTML', '#E8743B', 'accent'], ['site.css', 'CSS', '#4A7BD0', 'info'], ['tool.py', 'PY', '#3776AB', 'info'],
    ['run.sh', 'SH', '#64748B', 'muted'], ['a.png', 'IMG', '#8B5CF6', 'accent'], ['b.jpg', 'IMG', '#8B5CF6', 'accent'],
    ['c.jpeg', 'IMG', '#8B5CF6', 'accent'], ['d.gif', 'IMG', '#8B5CF6', 'accent'], ['e.svg', 'IMG', '#8B5CF6', 'accent'],
    ['f.webp', 'IMG', '#8B5CF6', 'accent'], ['notes.txt', 'TXT', '#64748B', 'muted'], ['model.blend', 'BLE', '#64748B', 'muted'],
    ['lib.rs', 'RS', '#64748B', 'muted'],
  ]
  const desk = makeKit(fakeElements(), 'desktop')
  const term = makeKit(fakeElements(), 'terminal')
  for (const [file, label, fill, tone] of cases) {
    const n = desk.typeBadge(file) as Node
    expect(n.type).toBe('Svg')
    expect(n.props.alt).toBe(label)
    expect([n.props.width, n.props.height]).toEqual([label.length * 7 + 8, 16])
    const src = String(n.props.source)
    expect(src).toContain(`fill="${fill}"`)
    expect(src).toContain('rx="3"')
    expect(src).toContain(`fill="${label === 'JS' ? '#1A1A1A' : '#FFFFFF'}"`)
    expect(src).toContain(`>${label}</text>`)
    const t = term.typeBadge(file) as Node
    expect(t.type).toBe('Text')
    expect(textOf(t)).toBe(label)
    expect(t.props).toEqual({ bold: true, color: TONES[tone].fg })
  }
  for (const none of ['Makefile', '.env', 'notes.', '']) {
    expect(desk.typeBadge(none)).toBe(null)
    expect(term.typeBadge(none)).toBe(null)
  }
})

test('kit v3: progress is the v2 bar on the terminal and a rounded Svg track and fill elsewhere', () => {
  const term = makeKit(fakeElements(), 'terminal')
  expect(term.progress(0.4, { width: 12, tone: 'ok' })).toEqual(term.bar(0.4, { width: 12, tone: 'ok' }))
  expect(term.progress(0.4)).toEqual(term.bar(0.4))
  const desk = makeKit(fakeElements(), 'desktop')
  const n = desk.progress(0.4, { tone: 'ok' }) as Node
  expect(n.type).toBe('Svg')
  expect(n.props.alt).toBe('40%')
  expect(n.props.width).toBeUndefined()
  expect(n.props.height).toBe(6)
  const src = String(n.props.source)
  expect(src).toContain('width="100%"')
  expect(src).toContain('preserveAspectRatio="none"')
  expect(src).toContain('viewBox="0 0 100 6"')
  expect(src).toContain('<rect width="100" height="6" rx="3" fill="#8A8F98" opacity="0.25"/>')
  expect(src).toContain(`<rect width="40" height="6" rx="3" fill="${TONE_HEX.ok}"/>`)
  const wide = desk.progress(0.75, { width: 120, tone: 'danger' }) as Node
  expect([wide.props.width, wide.props.height]).toEqual([120, 6])
  expect(String(wide.props.source)).not.toContain('100%')
  expect(String(wide.props.source)).toContain(`<rect width="90" height="6" rx="3" fill="${TONE_HEX.danger}"/>`)
  expect(String((desk.progress(0) as Node).props.source).match(/<rect/g)).toHaveLength(1)
  expect(String((desk.progress(3) as Node).props.source)).toContain(`<rect width="100" height="6" rx="3" fill="${TONE_HEX.info}"/>`)
  // each distinct drawing is built once: the same input returns the cached string
  expect((desk.progress(0.4, { tone: 'ok' }) as Node).props.source).toBe(src)
  expect((desk.icon('eye') as Node).props.source).toBe((makeKit(mobileElements(), 'mobile').icon('eye') as Node).props.source)
  expect((desk.typeBadge('a.ts') as Node).props.source).toBe((desk.typeBadge('b.tsx') as Node).props.source)
})

test('kit v3: buttons pass a variant only when set and leave plain out unless true', () => {
  const k = makeKit(fakeElements(), 'desktop')
  const onPress = () => undefined
  const row = k.buttons([
    { key: 'a', label: 'A', variant: 'primary', onPress },
    { key: 'b', label: 'B', variant: 'secondary', plain: true, onPress },
    { key: 'c', label: 'C', onPress },
    { key: 'd', label: 'D', plain: false, onPress },
  ]) as Node
  const [a, b, c, d] = row.children as Node[]
  expect(a.props.variant).toBe('primary')
  expect('plain' in a.props).toBe(false)
  expect(b.props.variant).toBe('secondary')
  expect(b.props.plain).toBe(true)
  for (const n of [c, d]) {
    expect('variant' in n.props).toBe(false)
    expect('plain' in n.props).toBe(false)
  }
})

test('kit v3: a mobile table (Svg, no Input) gets Svg; a table without Svg falls back to text', () => {
  const k = makeKit(mobileElements(), 'mobile')
  for (const n of [k.icon('folder'), k.typeBadge('a.pdf'), k.progress(0.5)] as Node[]) {
    expect(n.type).toBe('Svg')
    expect(String(n.props.alt).trim().length).toBeGreaterThan(0)
  }
  const bare = fakeElements()
  delete bare.Svg
  const noSvg = makeKit(bare, 'vscode')
  expect((noSvg.icon('folder') as Node).type).toBe('Text')
  expect((noSvg.typeBadge('a.pdf') as Node).type).toBe('Text')
  expect(noSvg.progress(0.5)).toEqual(noSvg.bar(0.5))
  expect(textOf(noSvg.pill('Reading', 'info'))).toBe('● Reading')
})

for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
  test(`kit v3, ${surface}: no forbidden color word in any prop or Svg source; no fill, and on the fill path only a pill fills`, () => {
    for (const pill of ['svg', 'fill'] as const) {
      const k = makeKit(surface === 'mobile' ? mobileElements() : fakeElements(), surface, { pill })
      for (const [name, tree] of Object.entries(eachV3(k))) {
        const json = JSON.stringify(tree)
        expect(`${name} ${json}`).not.toMatch(FORBIDDEN)
        if (pill === 'svg') expect(json).not.toContain('backgroundColor')
        for (const n of walk(tree)) {
          if (n.props?.backgroundColor === undefined) continue
          expect(name.startsWith('pill-')).toBe(true)
          expect(n.props.color).toBe('inverseText')
          expect(Object.values(PILL_KEYS)).toContain(n.props.backgroundColor)
        }
        for (const n of walk(tree)) if (n.type === 'Svg') expect(String(n.props.alt).trim().length).toBeGreaterThan(0)
        if (surface === 'terminal') expect(json).not.toContain('"Svg"')
      }
    }
  })
}

test('kit v3: every addition validates in a Pane: text on the terminal, Svg with alt elsewhere (pills too; theme-key pills on the fill path)', { timeoutMs: 20_000 }, async ($, on) => {
  let pill: 'fill' | 'svg' = 'svg'
  on('ui.render', { component: 'Pane' }, ($$, e) => {
    const k = makeKit($$.ui.resolve(e) as unknown as Elements, e.surface, { pill })
    return k.stack(Object.values(eachV3(k)), 0) as never
  })
  for (const mode of ['svg', 'fill'] as const) {
    pill = mode
    for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface } as never)
      const tree = await ui.drawn()
      const nodes = walk(tree)
      const svgs = nodes.filter(n => n.type === 'Svg')
      const json = JSON.stringify(tree)
      expect(json.replace(/"source":"[^"]*"/g, '')).not.toMatch(FORBIDDEN)
      expect(await ui.find({ type: 'Text', text: 'FILES' })).toBeDefined()
      expect(await ui.findAll({ type: 'Button' })).toHaveLength(3)
      if (surface === 'terminal') {
        expect(svgs).toHaveLength(0)
        expect(await ui.find({ type: 'Text', text: '● Reading' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: 'JS' })).toBeDefined()
        expect(json).not.toContain('backgroundColor')
      } else if (mode === 'svg') {
        // 13 icons, 2 type badges, 2 progress bars, one chip per pill tone
        expect(svgs).toHaveLength(17 + PILL_TONES.length)
        for (const s of svgs) expect(String(s.props.alt).trim().length).toBeGreaterThan(0)
        const chips = svgs.filter(s => s.props.alt === 'Reading')
        expect(chips.map(c => c.props.source)).toEqual(PILL_TONES.map(t => pillSvg('Reading', t)))
        for (const c of chips) expect(c.props.height).toBe(18)
        expect(json).not.toContain('backgroundColor')
      } else {
        // 13 icons, 2 type badges, 2 progress bars
        expect(svgs).toHaveLength(17)
        for (const s of svgs) expect(String(s.props.alt).trim().length).toBeGreaterThan(0)
        const pills = nodes.filter(n => n.type === 'Text' && n.props?.backgroundColor !== undefined)
        expect(pills).toHaveLength(PILL_TONES.length)
        for (const p of pills) expect(p.props.color).toBe('inverseText')
        expect(pills.map(p => p.props.backgroundColor)).toEqual(PILL_TONES.map(t => PILL_KEYS[t]))
      }
      await ui.unmount()
    }
  }
})

// ------------------------------------------------------------------ kit v3: nav

const NAV_ITEMS = (pressed: string[]) => [
  { key: 'hub', label: 'Hub', hotkey: '0', onPress: () => pressed.push('hub') },
  { key: 'stage', label: 'Stage', hotkey: '1', onPress: () => pressed.push('stage') },
  { key: 'gates', label: 'Gates', hotkey: '2', onPress: () => pressed.push('gates') },
  { key: 'later', label: 'Later' },
]

test('kit v3: nav draws the current item as bold accent Text and the others as plain Buttons with their hotkeys', () => {
  for (const surface of SURFACES) {
    const k = makeKit(fakeElements(), surface)
    const row = k.nav(NAV_ITEMS([]), 'stage') as Node
    expect(row.type).toBe('Box')
    expect(row.props).toMatchObject({ key: 'nav', flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, rowGap: 1 })
    const [hub, stage, gates, later] = row.children as Node[]
    expect(hub.type).toBe('Button')
    expect(hub.props).toMatchObject({ key: 'hub', label: 'Hub', hotkey: '0', plain: true })
    expect('variant' in hub.props).toBe(false)
    expect(stage.type).toBe('Text')
    expect(textOf(stage)).toBe('Stage')
    expect(stage.props).toMatchObject({ bold: true, color: TONES.accent.fg })
    expect(gates.props).toMatchObject({ key: 'gates', hotkey: '2', plain: true })
    // an item with nothing to press is quiet Text
    expect(later.type).toBe('Text')
    expect(later.props.color).toBe('inactive')
    expect(JSON.stringify(row)).not.toMatch(FORBIDDEN)
  }
  // no current key among the items: every pressable item is a Button
  const all = makeKit(fakeElements(), 'terminal').nav(NAV_ITEMS([]).slice(0, 3), 'files') as Node
  expect((all.children as Node[]).map(n => n.type)).toEqual(['Button', 'Button', 'Button'])
})

test('kit v3: a mounted nav validates on both surfaces, reads `0: Hub  Stage  2: Gates` and a press reaches its handler', { timeoutMs: 20_000 }, async ($, on) => {
  const pressed: string[] = []
  on('ui.render', { component: 'Pane' }, ($$, e) => {
    const k = makeKit($$.ui.resolve(e) as unknown as Elements, e.surface)
    return k.nav(NAV_ITEMS(pressed).slice(0, 3), 'stage') as never
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    const tree = await ui.drawn()
    expect(render(tree, 60)).toBe('0: Hub  Stage  2: Gates')
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
    await ui.press({ key: 'gates' })
    await ui.press({ key: 'hub' })
    await ui.unmount()
  }
  expect(pressed).toEqual(['gates', 'hub', 'gates', 'hub'])
})

// ------------------------------------------------------------------ kit 3.1: spacing

test('kit 3.1: wrapped rows get rowGap 1, buttons columnGap 2 (autoFocus only when true); page and list are spaced columns that drop nulls; stack is unchanged', () => {
  for (const surface of SURFACES) {
    const k = makeKit(fakeElements(), surface)
    const press = () => undefined
    const buttons = k.buttons([
      { key: 'a', label: 'A', onPress: press, autoFocus: true },
      { key: 'b', label: 'B', onPress: press, autoFocus: false },
    ]) as Node
    expect(buttons.props).toEqual({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, rowGap: 1 })
    // autoFocus is passed only when true
    expect((buttons.children as Node[]).map(b => b.props.autoFocus)).toEqual([true, undefined])
    const tiles = k.tiles([{ label: 'Cost', value: '$1' }]) as Node
    expect(tiles.props).toEqual({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, rowGap: 1 })
    const nav = k.nav([{ key: 'hub', label: 'Hub', onPress: press }], 'stage') as Node
    expect(nav.props).toEqual({ key: 'nav', flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, rowGap: 1 })
    for (const make of [k.page, k.list]) {
      const col = make([k.text('a'), null, undefined, false, k.text('b')]) as Node
      expect(col.type).toBe('Box')
      expect(col.props).toEqual({ flexDirection: 'column', rowGap: 1 })
      expect(col.children.map(textOf)).toEqual(['a', 'b'])
      expect((make([]) as Node).children).toEqual([])
    }
    expect((k.stack([k.text('x')]) as Node).props).toEqual({ flexDirection: 'column' })
    expect((k.stack([k.text('x')], 1) as Node).props).toEqual({ flexDirection: 'column', rowGap: 1 })
  }
})

test('kit 3.1: a page of a list of cards validates on both surfaces with one row between blocks and cards', { timeoutMs: 20_000 }, async ($, on) => {
  on('ui.render', { component: 'Pane' }, ($$, e) => {
    const k = makeKit($$.ui.resolve(e) as unknown as Elements, e.surface)
    return k.page([
      k.header('Agents', '2'),
      k.list([
        k.card({ title: 'one', children: [k.kv('ctx', '4%')] }),
        null,
        k.card({ title: 'two', children: [k.kv('ctx', '9%')] }),
      ]),
      k.buttons([{ key: 'refresh', label: 'Refresh', hotkey: 'r', onPress: () => undefined }]),
    ]) as never
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    const tree = await ui.drawn()
    const nodes = walk(tree)
    const spaced = nodes.filter(n => n.type === 'Box' && n.props?.flexDirection === 'column' && n.props?.rowGap === 1)
    expect(spaced).toHaveLength(2)
    expect(await ui.find({ type: 'Text', text: 'two' })).toBeDefined()
    expect(render(tree, 40).split('\n')).toEqual([
      'AGENTS                                 2',
      '',
      '╭──────────────────────────────────────╮',
      '│ one                                  │',
      '│ ctx 4%                               │',
      '╰──────────────────────────────────────╯',
      '',
      '╭──────────────────────────────────────╮',
      '│ two                                  │',
      '│ ctx 9%                               │',
      '╰──────────────────────────────────────╯',
      '',
      '[ Refresh ]',
    ])
    await ui.unmount()
  }
})
