// pane.test.ts: the /pr pane and the band, drawn with the kit, on both surfaces.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { TONES, barText, pillSvg } from '../hooks/kit'
import type { Tone } from '../hooks/kit'
import { MIXED, PR_VIEW, bandSeen, graphql, pass } from './fixtures'

type Node = { type: string; props: Record<string, unknown>; children: unknown[] }

/** Every element of a drawn tree, depth first. */
function* walk(n: unknown): Generator<Node> {
  if (n === null || typeof n !== 'object') return
  const d = n as Node
  yield d
  for (const c of Array.isArray(d.children) ? d.children : []) yield* walk(c)
}

const SURFACES = ['terminal', 'desktop'] as const
const FLAGS = { isStdoutTruncated: false, isStderrTruncated: false }

const BAND = {
  plugin: 'lk-pr-watch',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 118, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const

const PANE = {
  plugin: 'lk-pr-watch',
  component: 'Pane',
  requestId: 'pr-watch',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'PR watch', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

type World = { clock: MockClock; copied: string[]; closed: string[]; gql: Map<number, unknown> }

/** The stubs of tests/register.test.ts that these drawings need. */
function world(on: On, opts: { noPr?: boolean } = {}): World {
  const w: World = {
    clock: mock.clock(on, { now: 1_000_000 }),
    copied: [],
    closed: [],
    // the branch's PR: 3 passed, 1 failed, 1 running, changes requested; #7 merged and approved; #9 awaiting review, no checks
    gql: new Map<number, unknown>([
      [42, MIXED],
      [7, graphql({ number: 7, state: 'MERGED', reviewDecision: 'APPROVED', contexts: [pass('ci')] })],
      [9, graphql({ number: 9 })],
    ]),
  }
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    if (argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'view') {
      if (opts.noPr) return { value: { exitCode: 1, stdout: '', stderr: 'no pull requests found for branch "main"', ...FLAGS } }
      const n = /^\d+$/.test(argv[3] ?? '') ? Number(argv[3]) : 0
      const view = n ? { ...PR_VIEW, number: n, url: `https://github.com/acme/widgets/pull/${n}` } : PR_VIEW
      return { value: { exitCode: 0, stdout: JSON.stringify(view), stderr: '', ...FLAGS } }
    }
    if (argv[0] === 'gh' && argv[1] === 'api') {
      const n = Number((argv.find(a => a.startsWith('n=')) ?? 'n=0').slice(2))
      const body = w.gql.get(n)
      return body ? { value: { exitCode: 0, stdout: JSON.stringify(body), stderr: '', ...FLAGS } } : { value: { exitCode: 1, stdout: '', stderr: 'HTTP 404', ...FLAGS } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', ...FLAGS } }
  })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('env.get', () => ({ value: '/home/tester' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: '{}' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', ($, e) => {
    w.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    w.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('session.append', ($, e, next) => next(e))
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  return w
}

/** The branch's PR #42, then #7 and #9 added by number. */
async function fixture($: Engine, w: World): Promise<void> {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await w.clock.settle()
  await $.command.run({ command: 'pr', args: 'add 7' })
  await $.command.run({ command: 'pr', args: 'add 9' })
}

test('the pane draws the branch PR as the hero, tiles over every PR, and one card per PR', async ($, on) => {
  const w = world(on)
  await fixture($, w)
  await w.clock.advance(90_000)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const tree = await ui.drawn()
    // a pill: an Svg chip on the desktop (alt = its text), a `● text` chip in the tone on the terminal
    const pill = async (text: string, tone?: Tone) => {
      if (surface === 'desktop') {
        const svg = [...walk(tree)].find(n => n.type === 'Svg' && n.props.alt === text)
        if (tone) expect(svg?.props.source).toBe(pillSvg(text, tone))
        return svg
      }
      const chip = (await ui.find({ type: 'Text', text: `● ${text}` })) as Node | undefined
      if (tone) expect(chip?.props.color).toBe(TONES[tone].fg)
      return chip
    }
    expect(await ui.find({ type: 'Text', text: 'pull requests' })).toBeDefined()
    const title = (await ui.find({ type: 'Text', text: /^#42 Add the widget cache$/ })) as Node | undefined
    expect(title?.props.color).toBe(TONES.danger.fg)
    expect(await ui.find({ type: 'Text', text: 'failing · acme/widgets · this branch' })).toBeDefined()
    // tiles: #42 and #9 open; 3 of 5 plus 1 of 1 checks pass; 1 failing; #9 awaits review
    for (const [label, value] of [['Open', '2'], ['Checks passing', '4/6'], ['Failing', '1'], ['Awaiting review', '1']]) {
      expect(await ui.find({ type: 'Text', text: label })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: new RegExp(`^${value}$`) })).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: /^Watched · 3$/ })).toBeDefined()
    // state pills: failing in danger, merged in ok, open in info
    for (const [state, tone] of [['failing', 'danger'], ['merged', 'ok'], ['open', 'info']] as const) {
      expect(await pill(state, tone)).toBeDefined()
    }
    // the checks bars: 3/5 on #42, 1/1 on #7; #9 has none
    expect(await ui.find({ type: 'Text', text: barText(0.6, 20) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '3/5 checks' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: barText(1, 20) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'no checks reported' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 failing · 1 running' })).toBeDefined()
    // review badges and the age of the last poll
    expect(await pill('changes requested', 'danger')).toBeDefined()
    expect(await pill('approved', 'ok')).toBeDefined()
    expect(await pill('review required', 'warn')).toBeDefined()
    // no fills outside the kit's pills, no dimColor, no named colors
    expect(JSON.stringify(tree)).not.toMatch(/dimColor|backgroundColor|"(yellow|white|gray|grey|black|subtle)"/)
    expect(await ui.find({ type: 'Text', text: 'polled 1m ago' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'test' })).toBeDefined()
    for (const key of ['open-42', 'copy-7', 'rm-9', 'refresh', 'close']) expect(await ui.find({ key })).toBeDefined()
    await ui.unmount()
  }
})

test('the pane is a page: hero, tiles, the Watched block and the buttons one row apart; the header tight above a spaced list of cards', async ($, on) => {
  const w = world(on)
  await fixture($, w)
  await w.clock.advance(90_000)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const root = (await ui.drawn()) as Node
    expect(root.props).toMatchObject({ flexDirection: 'column', rowGap: 1 })
    const blocks = root.children as Node[]
    expect(blocks).toHaveLength(4)
    // the Watched block is one tight stack: the header, then the cards' list right under it
    const watched = blocks[2]
    expect(watched.props?.flexDirection).toBe('column')
    expect(watched.props?.rowGap).toBeUndefined()
    const [header, cards] = watched.children as Node[]
    expect(JSON.stringify(header)).toContain('Watched · 3')
    expect((watched.children as Node[])).toHaveLength(2)
    // the cards' parent keeps one row between cards
    expect(cards.props).toEqual({ flexDirection: 'column', rowGap: 1 })
    expect(cards.children).toHaveLength(3)
    expect(blocks[3].props).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, rowGap: 1 })
    await ui.unmount()
  }
})

test('Copy URL, Stop watching and Close keep their effect on both surfaces', async ($, on) => {
  const w = world(on)
  await fixture($, w)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'copy-42' })
    await w.clock.settle()
    await ui.press({ key: 'close' })
    await ui.unmount()
  }
  expect(w.copied).toEqual(['https://github.com/acme/widgets/pull/42', 'https://github.com/acme/widgets/pull/42'])
  expect(w.closed).toEqual(['pr-watch', 'pr-watch'])
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'rm-9' })
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Watched · 2$/ })).toBeDefined()
  expect(await ui.find({ key: 'rm-9' })).toBeUndefined()
  await ui.unmount()
})

test('no PR watched: a quiet hero and the refresh and close buttons', async ($, on) => {
  const w = world(on, { noPr: true })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await w.clock.settle()
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'No PR watched' })).toBeDefined()
    expect(((await ui.drawn()) as Node).props).toMatchObject({ flexDirection: 'column', rowGap: 1 })
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
    expect(await ui.find({ key: 'close' })).toBeDefined()
    await ui.unmount()
  }
})

test('the band is one kit line on both surfaces and stacks the band under it', async ($, on) => {
  const w = world(on)
  await fixture($, w)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    // a failed check and changes requested: urgent, so the right side is in the default text color
    expect(bandSeen(await ui.find({ key: 'pr-watch-band' }))).toEqual({
      text: 'PR #42  ● checks 3/5 ✓ 1 ✗ 1 …  ● changes requested  ● mergeable',
      tones: [TONES.danger.fg, TONES.danger.fg, TONES.ok.fg],
      right: '+2 more',
      rightColor: undefined,
    })
    expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
    expect(JSON.stringify(await ui.drawn())).not.toMatch(/dimColor|backgroundColor|"(yellow|white|gray|grey|black|subtle)"/)
    await ui.unmount()
  }
})
