// pane.test.ts: the /handoff show pane and the band, drawn with the kit, on both surfaces.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { TONES, pillSvg } from '../hooks/kit'

type Node = { type: string; props: Record<string, unknown>; children: unknown[] }

const SURFACES = ['terminal', 'desktop'] as const
const CWD = '/work'

const GOOD = `## Status
The verifier works.

## Next steps
- Wire the verifier into the webhook route.

## Dead ends
- None.

## Open questions
- None.

## Decisions
- None.

## Log
Added the webhook verifier. Next: wire it into the route.`

const BAND = {
  plugin: 'lk-handoff-guard',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 118, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const

const PANE = {
  plugin: 'lk-handoff-guard',
  component: 'Pane',
  requestId: 'handoff-guard',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Handoff guard', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const MSGS = [
  { role: 'user', text: 'finish the webhook verifier', toolUses: [] },
  { role: 'assistant', text: 'The verifier is done; wiring is next.', toolUses: [{ tool: 'Edit', input: { file_path: '/work/src/verify.ts' }, result: 'ok' }] },
]

/** The stubs of tests/register.test.ts that these drawings need. */
function world(on: On, o: { ctx: number; store?: Record<string, unknown> }) {
  const w = {
    ctx: { percent: o.ctx },
    files: new Map<string, string>(),
    saved: new Map<string, unknown>(Object.entries(o.store ?? {})),
    toasts: [] as string[],
    commands: [] as string[],
    closed: [] as string[],
  }
  mock.clock(on, { now: new Date(2026, 9, 9, 14, 2).getTime() })
  on('store.get', ($, e) => ({ value: w.saved.get(e.key) }))
  on('store.set', ($, e) => {
    w.saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    w.saved.delete(e.key)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) }))
  on('fs.read', ($, e) => (w.files.has(e.path) ? { value: w.files.get(e.path) } : { deny: 'ENOENT' }))
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('env.get', () => ({ value: '/home/tester' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.usage', () => ({
    value: { context: { tokens: w.ctx.percent * 2000, window: 200_000, percent: w.ctx.percent }, rateLimits: [] },
  }))
  on('session.messages', () => ({ value: MSGS }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('model.fork', () => ({
    value: { isAnswered: true, text: GOOD, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }))
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply' } }))
  on('command.register', () => ({ value: undefined }))
  on('command.run', ($, e) => {
    w.commands.push(e.command)
    return {}
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', ($, e) => {
    w.closed.push(e.id)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: 'ran' }))
  on('session.start', () => ({ cwd: CWD }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }) as never)
  return w
}

async function start($: Engine) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
}

async function complete($: Engine) {
  await $.turn.complete({ turnId: 't', answer: 'done', durationMs: 10, isAborted: false, usage: null })
}

/** Every element of a drawn tree with this type, children and elements passed as props alike. */
function nodesOf(tree: unknown, type: string, out: Node[] = []): Node[] {
  if (!tree || typeof tree !== 'object') return out
  const node = tree as Node
  if (node.type === type && node.props) out.push(node)
  for (const v of Object.values(tree)) nodesOf(v, type, out)
  return out
}

/** The kit pill drawn as an Svg chip whose alt text, trimmed, is `text`. */
function svgPill(tree: unknown, text: string): Node | undefined {
  return nodesOf(tree, 'Svg').find(n => String(n.props.alt).trim() === text)
}

function flat(n: unknown): string {
  if (typeof n === 'string') return n
  if (!n || typeof n !== 'object') return ''
  const kids = (n as Node).children ?? []
  return (Array.isArray(kids) ? kids : [kids]).map(flat).join('')
}

async function band($: Engine, surface: (typeof SURFACES)[number]) {
  const ui = await $.ui.mount({ ...BAND, surface })
  const found = (await ui.find({ key: 'handoff-guard-band' })) as Node | undefined
  const theirs = await ui.find({ type: 'Text', text: 'drawn by Claude Code' })
  await ui.unmount()
  // The kit line's Text nodes: the bold label, the chip, and the right side when there is one (quiet,
  // or in the default text color once the handoff is due).
  const texts = (n: unknown, out: Node[] = []): Node[] => {
    if (!n || typeof n !== 'object') return out
    if ((n as Node).type === 'Text') out.push(n as Node)
    else for (const c of (n as Node).children ?? []) texts(c, out)
    return out
  }
  const [label, chip, right] = texts(found)
  expect(label?.props.bold).toBe(true)
  return { texts: texts(found).map(flat), chip: chip?.props.color, right: right?.props.color, stacked: theirs !== undefined }
}

const written = (w: { toasts: string[] }) => w.toasts.filter(t => t.startsWith('Handoff written: ')).length

test('the pane draws the handoff state as the hero, tiles, readings with level badges and the last brief', async ($, on) => {
  const w = world(on, { ctx: 41 })
  await start($)
  w.ctx.percent = 72
  await complete($)
  await $.command.run({ command: 'handoff', args: '' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'handoff guard' })).toBeDefined()
    // The warn level draws in the Claude orange (the accent tone), never the warning color: the hero
    // title and the Warn at tile's value.
    const title = (await ui.find({ type: 'Text', text: 'Context 72% · /handoff at a stopping point' })) as Node | undefined
    expect(title?.props.color).toBe(TONES.accent.fg)
    expect(((await ui.find({ type: 'Text', text: '70%' })) as Node | undefined)?.props.color).toBe(TONES.accent.fg)
    expect(await ui.find({ type: 'Text', text: '144k of 200k tokens · mode ask · last handoff 2026-10-09 14:02' })).toBeDefined()
    for (const label of ['Context', 'Warn at', 'Handoff at', 'Mode']) expect(await ui.find({ type: 'Text', text: label })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^READINGS · \d+$/ })).toBeDefined()
    // A warn-level reading's pill: a `● warn` chip in the terminal, a fully rounded Svg pill in the
    // Desktop app, both the accent tone (the Claude orange, not the warning color).
    const tree: unknown = await ui.drawn()
    if (surface === 'terminal') {
      const badge = (await ui.find({ type: 'Text', text: '● warn' })) as Node | undefined
      expect(badge?.props.color).toBe(TONES.accent.fg)
      expect(await ui.find({ type: 'Text', text: '● fork' })).toBeDefined()
    } else {
      expect(svgPill(tree, 'warn')?.props.source).toBe(pillSvg('warn', 'accent'))
      expect(svgPill(tree, 'fork')?.props.source).toBe(pillSvg('fork', 'ok'))
    }
    expect(await ui.find({ type: 'Text', text: 'LAST HANDOFF' })).toBeDefined()
    expect(await ui.find({ type: 'Markdown' })).toBeDefined()
    expect(await ui.find({ key: 'write' })).toBeDefined()
    await ui.unmount()
  }
})

test('Write handoff writes another handoff without clearing; Close closes the pane', async ($, on) => {
  const w = world(on, { ctx: 50 })
  await start($)
  for (const surface of SURFACES) {
    const before = written(w)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'write' })
    await ui.press({ key: 'close' })
    await ui.unmount()
    expect(written(w)).toBe(before + 1)
  }
  expect(w.files.has('/work/.claude/brain/project.md')).toBe(true)
  expect(w.commands).toEqual([])
  expect(w.closed).toEqual(['handoff-guard', 'handoff-guard'])
})

test('a due reading in off mode, and no handoff yet, draw on both surfaces', async ($, on) => {
  const w = world(on, { ctx: 41, store: { settings: { mode: 'off' } } })
  await start($)
  w.ctx.percent = 90
  await complete($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const title = (await ui.find({ type: 'Text', text: 'Context 90% · handoff due · guard off' })) as Node | undefined
    expect(title?.props.color).toBe(TONES.danger.fg)
    if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: '● due ' })).toBeDefined()
    else expect(svgPill(await ui.drawn(), 'due')?.props.source).toBe(pillSvg('due ', 'danger'))
    expect(await ui.find({ type: 'Text', text: 'No handoff written for this project yet. /handoff writes one.' })).toBeDefined()
    await ui.unmount()
  }
})

test('the band is a kit line with the context chip in the level tone on both surfaces and stacks the band under it', async ($, on) => {
  const w = world(on, { ctx: 41, store: { settings: { mode: 'off' } } })
  await start($)
  for (const surface of SURFACES) {
    expect(await band($, surface)).toEqual({ texts: ['handoff', '● ctx 41%'], chip: TONES.ok.fg, right: undefined, stacked: true })
  }
  w.ctx.percent = 72
  await complete($)
  for (const surface of SURFACES) {
    expect(await band($, surface)).toEqual({ texts: ['handoff', '● ctx 72%', '/handoff at a stopping point'], chip: TONES.accent.fg, right: TONES.muted.fg, stacked: true })
  }
  w.ctx.percent = 90
  await complete($)
  for (const surface of SURFACES) {
    // Due: the right side is urgent, so it takes the default text color (no color prop).
    expect(await band($, surface)).toEqual({ texts: ['handoff', '● ctx 90%', 'handoff due · guard off'], chip: TONES.danger.fg, right: undefined, stacked: true })
  }
})

test('the drawn pane fills nothing; its pills are Svg chips in the Desktop app and ● chips in the terminal', async ($, on) => {
  const w = world(on, { ctx: 41 })
  await start($)
  w.ctx.percent = 72
  await complete($)
  w.ctx.percent = 90
  await complete($)
  await $.command.run({ command: 'handoff', args: '' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const tree: unknown = JSON.parse(JSON.stringify(await ui.drawn()))
    await ui.unmount()
    // No element anywhere in the tree (children, and elements passed as props) has a fill.
    const all = [...nodesOf(tree, 'Text'), ...nodesOf(tree, 'Box')]
    expect(all.filter(n => n.props.backgroundColor !== undefined)).toEqual([])
    // The level and source pills: the kit's own Svg chip in the Desktop app, none in the terminal.
    for (const text of ['ok', 'warn', 'due', 'fork']) {
      if (surface === 'terminal') expect(svgPill(tree, text)).toBeUndefined()
      else expect(svgPill(tree, text)?.props.source).toMatch(/^<svg /)
    }
  }
})

test('the pane root is a page: a column with one row between blocks; the readings and the brief stay tight and the buttons are spaced', async ($, on) => {
  const w = world(on, { ctx: 41 })
  await start($)
  w.ctx.percent = 72
  await complete($)
  await $.command.run({ command: 'handoff', args: '' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const root = (await ui.drawn()) as Node
    await ui.unmount()
    const kids = (n: Node): Node[] => ((n.children ?? n.props?.children ?? []) as Node[]).filter(c => c && typeof c === 'object')
    expect(root.type).toBe('Box')
    expect(root.props).toMatchObject({ flexDirection: 'column', rowGap: 1 })
    // hero, tiles, the context bar, the readings section, the last-handoff section, the buttons
    const blocks = kids(root)
    expect(blocks).toHaveLength(6)
    for (const section of blocks.slice(3, 5)) expect(section.props.rowGap).toBeUndefined()
    expect(blocks[5]!.props).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, rowGap: 1 })
  }
})
