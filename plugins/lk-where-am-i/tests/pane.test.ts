// pane.test.ts: the /where pane and the band, drawn with the kit, on both surfaces.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { TONES } from '../hooks/kit'

type Node = { type: string; props: Record<string, unknown>; children: unknown[] }
type Run = { exitCode: number; stdout: string; stderr: string }

const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.parse('2026-10-09T12:00:00Z')
const MIN = 60_000
const COMMIT_AT = Math.floor(NOW / 1000) - 14 * 60

const ok = (stdout: string): Run => ({ exitCode: 0, stdout, stderr: '' })
const fail = (): Run => ({ exitCode: 128, stdout: '', stderr: 'fatal' })

// The linked worktree "feat-x" of "acme-repo", as in tests/register.test.ts.
const GIT: Record<string, Run> = {
  'rev-parse --absolute-git-dir --git-common-dir --show-toplevel': ok('/work/acme-repo/.git/worktrees/feat-x\n/work/acme-repo/.git\n/work/wt/feat-x\n'),
  'symbolic-ref --short -q HEAD': ok('feat-x\n'),
  'rev-parse --short HEAD': ok('2222222\n'),
  '--no-optional-locks status --porcelain': ok(' M a.ts\n?? b.ts\nA  c.ts\n'),
  'rev-parse --abbrev-ref --symbolic-full-name @{upstream}': ok('origin/feat-x\n'),
  'rev-list --count @{upstream}..HEAD': ok('2\n'),
  'log -1 --format=%ct%x00%s': ok(`${COMMIT_AT}\u0000Add the band\n`),
  'symbolic-ref --short refs/remotes/origin/HEAD': ok('origin/master\n'),
  'worktree list --porcelain': ok(
    [
      'worktree /work/acme-repo',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/master',
      '',
      'worktree /work/wt/feat-x',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feat-x',
      'locked',
      '',
    ].join('\n'),
  ),
}

const BAND = {
  plugin: 'lk-where-am-i',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 140, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 138, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const

const PANE = {
  plugin: 'lk-where-am-i',
  component: 'Pane',
  requestId: 'where-am-i',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Where am I', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

function world(on: On) {
  const w = { calls: 0, closed: [] as string[], clock: mock.clock(on, { now: NOW }) }
  on('process.run', ($, e) => {
    w.calls++
    const argv = (e.argv ?? []) as string[]
    return { value: GIT[argv.slice(1).join(' ')] ?? fail() }
  })
  on('session.cwd', () => ({ value: '/work/wt/feat-x' }))
  on('session.usage', () => ({ value: { context: { window: 200_000 }, rateLimits: [] } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/tester' : undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: '{}' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', ($, e) => {
    w.closed.push(e.id)
    return { value: undefined }
  })
  on('session.start', () => ({ cwd: '/work/wt/feat-x' }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }) as never)
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'ok' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return w
}

/** Session start, one main-loop request, two usage windows and a cost, then 19 minutes. */
async function fill($: Engine, w: ReturnType<typeof world>) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/wt/feat-x' })
  await $.command.run({ command: 'where', args: 'refresh' })
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-test', messageCount: 1 })
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 81, resetsAt: new Date(NOW + 2 * 3600_000).toISOString() },
      { kind: 'seven_day', percentUsed: 12 },
    ],
    cost: { usd: 1.25 },
    changed: ['rateLimits'],
  } as never)
  await w.clock.advance(19 * MIN)
}

test('the pane draws where you are as the hero, the tiles, headers with counts, pills and the buttons', async ($, on) => {
  const w = world(on)
  await fill($, w)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'where you are' })).toBeDefined()
    const title = (await ui.find({ type: 'Text', text: 'acme-repo@feat-x ⑂wt:feat-x' })) as Node | undefined
    expect(title?.props.color).toBe(TONES.info.fg)
    expect(await ui.find({ type: 'Text', text: '3 dirty · 2↑ · 33m since commit' })).toBeDefined()
    // Tiles: Changed · Unpushed · Cache · Cost.
    for (const t of ['Changed', 'Unpushed', 'Cache', 'Cost', '41m left', '$1.25']) expect(await ui.find({ type: 'Text', text: t })).toBeDefined()
    // Kit v3 headers: the label upper-cased, bold and quiet, the count on the right.
    for (const h of ['LOCATION', 'USAGE', 'PROMPT CACHE', 'WORKTREES']) {
      expect(((await ui.find({ type: 'Text', text: h })) as Node | undefined)?.props).toMatchObject({ bold: true, color: 'inactive' })
    }
    expect(await ui.find({ type: 'Text', text: '9' })).toBeDefined()
    // A usage bar in the warn tone at 81%, with its reset time on the quiet right.
    expect(await ui.find({ type: 'Text', text: ' 81%' })).toBeDefined()
    expect(((await ui.find({ type: 'Text', text: /^━+╌+$/ })) as Node | undefined)?.props.color).toBe(TONES.warn.fg)
    expect(((await ui.find({ type: 'Text', text: 'resets in 1h41' })) as Node | undefined)?.props.color).toBe('inactive')
    expect(((await ui.find({ type: 'Text', text: 'TTL 60m from default' })) as Node | undefined)?.props.color).toBe('inactive')
    // The location rows keep their text; the current worktree has a pill, its lock a warn pill:
    // a `● here` chip on the terminal, an Svg pill (alt = the text, no fill) on the desktop.
    expect(await ui.find({ type: 'Text', text: 'origin/feat-x · 2 unpushed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '33m ago · Add the band' })).toBeDefined()
    if (surface === 'terminal') {
      expect(((await ui.find({ type: 'Text', text: '● here' })) as Node | undefined)?.props.color).toBe(TONES.info.fg)
      expect(((await ui.find({ type: 'Text', text: '● locked' })) as Node | undefined)?.props.color).toBe(TONES.warn.fg)
    } else {
      const pills = ((await ui.findAll({ type: 'Svg' })) as Node[]).map(n => n.props.alt)
      expect(pills).toContain('here')
      expect(pills).toContain('locked')
    }
    expect(JSON.stringify(await ui.drawn())).not.toMatch(/dimColor|backgroundColor|"yellow"|"white"|"gray"|"grey"|"black"|subtle/i)
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
    await ui.unmount()
  }
})

test('Refresh reads git again and Close closes the pane, on both surfaces', async ($, on) => {
  const w = world(on)
  await fill($, w)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const n = w.calls
    await ui.press({ key: 'refresh' })
    expect(w.calls).toBeGreaterThan(n)
    await ui.press({ key: 'close' })
    await ui.unmount()
  }
  expect(w.closed).toEqual(['where-am-i', 'where-am-i'])
})

test('the pane is a page: hero, tiles, each section and the buttons one row apart, the rows of a section tight', async ($, on) => {
  const w = world(on)
  await fill($, w)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const root = (await ui.drawn()) as Node
    expect(root.props).toMatchObject({ flexDirection: 'column', rowGap: 1 })
    const blocks = root.children as Node[]
    // hero, tiles, Location, Usage, Prompt cache, Worktrees, buttons
    expect(blocks).toHaveLength(7)
    for (const section of blocks.slice(2, 6)) expect(section.props).toEqual({ flexDirection: 'column' })
    expect(blocks[6].props).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, rowGap: 1 })
    await ui.unmount()
  }
})

test('before the first refresh the hero says Nothing known yet on both surfaces', async ($, on) => {
  world(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Nothing known yet' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'no rate-limit reading yet' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'no request yet' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'WORKTREES' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the band is a kit line on both surfaces and stacks Claude Code content under it', async ($, on) => {
  const w = world(on)
  await fill($, w)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const line = (await ui.find({ key: 'where-am-i-band' })) as (Node & { text?: string }) | undefined
    expect(line?.text).toBe('acme-repo@feat-x ⑂wt:feat-x● 5h 81%● 7d 12%● cache 41m3 dirty · 2↑ · 33m since commit')
    expect(((await ui.find({ type: 'Text', text: 'acme-repo@feat-x ⑂wt:feat-x' })) as Node | undefined)?.props.bold).toBe(true)
    expect(((await ui.find({ type: 'Text', text: '● 5h 81%' })) as Node | undefined)?.props).toMatchObject({ color: TONES.warn.fg, bold: true })
    expect(((await ui.find({ type: 'Text', text: '● 7d 12%' })) as Node | undefined)?.props.color).toBe('inactive')
    expect(((await ui.find({ type: 'Text', text: '3 dirty · 2↑ · 33m since commit' })) as Node | undefined)?.props.color).toBe('inactive')
    expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
    expect(JSON.stringify(await ui.drawn())).not.toMatch(/dimColor|backgroundColor|"yellow"|"white"|"gray"|"grey"|"black"|subtle/i)
    await ui.unmount()
  }
})
