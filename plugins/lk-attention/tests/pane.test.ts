// pane.test.ts: the /attention pane and the band, drawn with the kit, on both surfaces.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { TONES, pillSvg } from '../hooks/kit'

type Node = { type: string; props: Record<string, unknown>; children: unknown[] }

const SURFACES = ['terminal', 'desktop'] as const

const BAND = {
  plugin: 'lk-attention',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 118, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const

const PANE = {
  plugin: 'lk-attention',
  component: 'Pane',
  requestId: 'attention',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Attention', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

/** The stubs of tests/register.test.ts that these drawings need; grace mode so a tool.check ask raises a wait. */
function world(on: On) {
  const w = { saved: new Map<string, unknown>([['settings', { permissionSignal: 'grace' }]]), closed: [] as string[] }
  const clock = mock.clock(on, { now: 1_000_000 })
  on('store.get', ($, e) => ({ value: w.saved.get(e.key) }))
  on('store.set', ($, e) => {
    w.saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('env.get', () => ({ value: '/home/tester' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: '{}' }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', ($, e) => {
    w.closed.push(e.id)
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('audio.play', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ok' }))
  on('tool.check', () => ({ decision: 'ask' }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }) as never)
  return { w, clock }
}

async function turn($: Engine, durationMs: number, extra: Record<string, unknown> = {}) {
  await $.turn.complete({ turnId: 't' + durationMs, answer: '## All tests pass\nDetails', durationMs, isAborted: false, reason: 'answer', usage: null, ...extra } as never)
}

/** A long turn done a minute ago, an interrupt (seen), an error turn, then a Bash ask past the grace. */
async function fill($: Engine, clock: ReturnType<typeof mock.clock>) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, 25_000)
  await clock.advance(60_000)
  await turn($, 3_000, { isAborted: true, reason: 'aborted' })
  await turn($, 2_000, { reason: 'error', answer: '' })
  await $.tool.check({ tool: 'Bash', input: { command: 'make' }, tool_use_id: 'tu1' } as never)
  await clock.advance(4_000)
  await clock.settle()
}

/** Every element of a drawn tree with this type, children and elements passed as props alike. */
function nodesOf(tree: unknown, type: string, out: Node[] = []): Node[] {
  if (!tree || typeof tree !== 'object') return out
  const node = tree as Node
  if (node.type === type && node.props) out.push(node)
  for (const v of Object.values(tree)) nodesOf(v, type, out)
  return out
}

/** The kit pill drawn as an Svg chip whose alt text is `text`. */
function svgPill(tree: unknown, text: string): Node | undefined {
  return nodesOf(tree, 'Svg').find(n => n.props.alt === text)
}

/** The Text nodes under a node, in order. */
function texts(n: unknown, out: Node[] = []): Node[] {
  if (!n || typeof n !== 'object') return out
  const node = n as Node
  if (node.type === 'Text') out.push(node)
  else for (const c of node.children ?? []) texts(c, out)
  return out
}

/** The band as one string (label, chip and kinds of its kit line), the chip's and the kinds' colors
 *  (the kinds are quiet unless urgent), and whether the label is bold. */
async function band($: Engine, surface: (typeof SURFACES)[number]) {
  const ui = await $.ui.mount({ ...BAND, surface })
  const found = await ui.find({ key: 'attention-band' })
  const theirs = await ui.find({ type: 'Text', text: 'drawn by Claude Code' })
  await ui.unmount()
  const [label, chip, kinds] = texts(found)
  if (!label || !chip || !kinds) return { text: null, color: undefined, kinds: undefined, stacked: theirs !== undefined }
  const s = (n: Node) => String(n.children[0])
  expect(label.props.bold).toBe(true)
  return { text: `${s(label)} ${s(chip)}: ${s(kinds)}`, color: chip.props.color, kinds: kinds.props.color, stacked: theirs !== undefined }
}

test('the pane draws the newest unseen event as the hero, tiles, the inbox section with kind badges, and the buttons', async ($, on) => {
  const { clock } = world(on)
  await fill($, clock)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'attention' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Claude needs your OK: Bash' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'permission · 0s ago · make' })).toBeDefined()
    // Tiles: 3 unseen (the interrupt is history only), 1 ask, 1 done, 2 failed.
    for (const label of ['Unseen', 'Asks', 'Done', 'Failed']) expect(await ui.find({ type: 'Text', text: label })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'INBOX · 4' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '3 UNSEEN · NEWEST FIRST' })).toBeDefined()
    // The ask's kind pill, a `● permission` chip in the terminal, a fully rounded Svg pill in the
    // Desktop app, both in the Claude orange (the accent tone), never the warning color.
    if (surface === 'terminal') {
      const badge = (await ui.find({ type: 'Text', text: '● permission' })) as Node | undefined
      expect(badge?.props.color).toBe('claude')
      expect(await ui.find({ type: 'Text', text: '● failed' })).toBeDefined()
    } else {
      const tree: unknown = await ui.drawn()
      expect(svgPill(tree, 'permission')?.props.source).toBe(pillSvg('permission', 'accent'))
      expect(svgPill(tree, 'failed')?.props.source).toBe(pillSvg('failed', 'danger'))
    }
    expect(await ui.find({ type: 'Text', text: '1m 4s ago' })).toBeDefined()
    expect(await ui.find({ key: 'seen' })).toBeDefined()
    expect(await ui.find({ key: 'close' })).toBeDefined()
    await ui.unmount()
  }
})

test('Mark all seen clears the band and the hero says Nothing waiting; Close closes the pane', async ($, on) => {
  const { w, clock } = world(on)
  await fill($, clock)
  expect((await band($, 'desktop')).text).not.toBe(null)
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'seen' })
  await ui.unmount()
  expect((await band($, 'terminal')).text).toBe(null)
  for (const surface of SURFACES) {
    ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Nothing waiting' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '4 events in the inbox, all seen' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'NEWEST FIRST' })).toBeDefined()
    await ui.press({ key: 'close' })
    await ui.unmount()
  }
  expect(w.closed).toEqual(['attention', 'attention'])
})

test('an empty inbox draws Nothing waiting and the hint on both surfaces', async ($, on) => {
  world(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Nothing waiting' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'INBOX · 0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Nothing yet. /attention test checks notify-send and the sound.' })).toBeDefined()
    await ui.unmount()
  }
})

test('the band is a kit line in the Claude orange (red after a failure) on both surfaces and stacks the band under it', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await turn($, 25_000)
  await clock.settle()
  for (const surface of SURFACES) {
    expect(await band($, surface)).toEqual({ text: 'attention ● 1 new: done', color: 'claude', kinds: TONES.muted.fg, stacked: true })
  }
  await turn($, 2_000, { reason: 'error', answer: '' })
  await $.tool.check({ tool: 'Bash', input: { command: 'make' }, tool_use_id: 'tu2' } as never)
  await clock.advance(4_000)
  await clock.settle()
  for (const surface of SURFACES) {
    // An ask waits and a turn failed: the kinds are urgent, drawn in the default text color.
    expect(await band($, surface)).toEqual({ text: 'attention ● 3 waiting: permission (Bash), failed, done', color: 'error', kinds: undefined, stacked: true })
  }
})

test('the drawn pane fills nothing; its pills are Svg chips in the Desktop app and ● chips in the terminal', async ($, on) => {
  const { clock } = world(on)
  await fill($, clock)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const tree: unknown = JSON.parse(JSON.stringify(await ui.drawn()))
    await ui.unmount()
    // No element anywhere in the tree (children, and elements passed as props) has a fill.
    const all = [...nodesOf(tree, 'Text'), ...nodesOf(tree, 'Box')]
    expect(all.filter(n => n.props.backgroundColor !== undefined)).toEqual([])
    // The settings and kind pills: the kit's own Svg chip in the Desktop app, none in the terminal.
    const pills: Record<string, string> = { on: 'ok', permission: 'accent', failed: 'danger', done: 'ok' }
    for (const [text, tone] of Object.entries(pills)) {
      if (surface === 'terminal') expect(svgPill(tree, text)).toBeUndefined()
      else expect(svgPill(tree, text)?.props.source).toBe(pillSvg(text, tone as Parameters<typeof pillSvg>[1]))
    }
  }
})

test('the pane root is a page: a column with one row between blocks; the inbox section stays tight and the buttons are spaced', async ($, on) => {
  const { clock } = world(on)
  await fill($, clock)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const root = (await ui.drawn()) as Node
    await ui.unmount()
    const kids = (n: Node): Node[] => ((n.children ?? n.props?.children ?? []) as Node[]).filter(c => c && typeof c === 'object')
    expect(root.type).toBe('Box')
    expect(root.props).toMatchObject({ flexDirection: 'column', rowGap: 1 })
    // hero, tiles, settings, the inbox section (its header and rows, one line each, no gap), the buttons
    const blocks = kids(root)
    expect(blocks).toHaveLength(5)
    expect(blocks[3]!.props.rowGap).toBeUndefined()
    expect(blocks[4]!.props).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, rowGap: 1 })
  }
})
