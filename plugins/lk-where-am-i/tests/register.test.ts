import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const NOW = Date.parse('2026-10-09T12:00:00Z')
const MIN = 60_000
const COMMIT_AT = Math.floor(NOW / 1000) - 14 * 60

type Run = { exitCode: number; stdout: string; stderr: string }
type Git = Record<string, Run>

const ok = (stdout: string): Run => ({ exitCode: 0, stdout, stderr: '' })
const fail = (code = 128): Run => ({ exitCode: code, stdout: '', stderr: 'fatal' })

const WT_LIST = [
  'worktree /work/acme-repo',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/master',
  '',
  'worktree /work/wt/feat-x',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/feat-x',
  '',
].join('\n')

/** git answers for a linked worktree of "acme-repo" on feat-x. */
function linkedRepo(over: Git = {}): Git {
  return {
    'rev-parse --absolute-git-dir --git-common-dir --show-toplevel': ok(
      '/work/acme-repo/.git/worktrees/feat-x\n/work/acme-repo/.git\n/work/wt/feat-x\n',
    ),
    'symbolic-ref --short -q HEAD': ok('feat-x\n'),
    'rev-parse --short HEAD': ok('2222222\n'),
    '--no-optional-locks status --porcelain': ok(' M a.ts\n?? b.ts\nA  c.ts\n'),
    'rev-parse --abbrev-ref --symbolic-full-name @{upstream}': ok('origin/feat-x\n'),
    'rev-list --count @{upstream}..HEAD': ok('2\n'),
    'log -1 --format=%ct%x00%s': ok(`${COMMIT_AT}\u0000Add the band\n`),
    'symbolic-ref --short refs/remotes/origin/HEAD': ok('origin/master\n'),
    'worktree list --porcelain': ok(WT_LIST),
    ...over,
  }
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

type World = {
  toasts: string[]
  saved: Map<string, unknown>
  closed: string[]
  opened: string[]
  calls: string[][]
  inits: Array<{ cwd?: string; timeoutMs?: number }>
  clock: ReturnType<typeof mock.clock>
}

function world(
  on: On,
  opts: { git?: Git | 'throw'; usage?: unknown; config?: unknown; cwd?: string } = {},
): World {
  const w: World = { toasts: [], saved: new Map(), closed: [], opened: [], calls: [], inits: [], clock: mock.clock(on, { now: NOW }) }
  const cwd = opts.cwd ?? '/work/wt/feat-x'
  on('process.run', ($, e) => {
    const argv = (e.argv ?? []) as string[]
    w.calls.push([...argv])
    w.inits.push((e.init ?? {}) as { cwd?: string; timeoutMs?: number })
    if (opts.git === 'throw') return { deny: 'git is not installed' }
    const key = argv.slice(1).join(' ')
    return { value: (opts.git ?? {})[key] ?? fail() }
  })
  on('session.cwd', () => ({ value: cwd }))
  on('session.usage', () => ({ value: opts.usage ?? { context: { window: 200_000 }, rateLimits: [] } }))
  on('store.get', ($, e) => ({ value: w.saved.get(e.key) }))
  on('store.set', ($, e) => {
    w.saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/tester' : undefined }))
  on('fs.exists', ($, e) => ({ value: opts.config !== undefined && String(e.path).endsWith('/home/tester/.claude/where-am-i.json') }))
  on('fs.read', () => ({ value: JSON.stringify(opts.config ?? {}) }))
  on('command.register', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    w.closed.push(e.id)
    return { value: undefined }
  })
  on('session.start', () => ({ cwd }))
  on('classic.SessionStart', () => ({}))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'ok' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return w
}

async function start($: Engine, cwd = '/work/wt/feat-x') {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd })
  // /where refresh waits for the background refresh session.start began.
  await $.command.run({ command: 'where', args: 'refresh' })
}

async function step($: Engine, agentId?: string) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-test', messageCount: 1, ...(agentId ? { agentId } : {}) })
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
}

async function measure($: Engine, rateLimits: unknown[], usd?: number) {
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits,
    ...(usd === undefined ? {} : { cost: { usd } }),
    changed: ['rateLimits'],
  } as never)
}

type Leaf = { text: string; props: Record<string, unknown> }

/** The Texts that hold only strings, in order: the band's label, chips and right side. */
function leaves(node: unknown): Leaf[] {
  const n = node as { type?: string; props?: Record<string, unknown>; children?: unknown[] } | null
  if (!n || typeof n !== 'object') return []
  const kids = Array.isArray(n.children) ? n.children : []
  if (n.type === 'Text' && kids.every(k => typeof k === 'string')) return [{ text: kids.join(''), props: n.props ?? {} }]
  return kids.flatMap(leaves)
}

/** The band as `label  ● chip  ● chip  right`, with its leaf Texts and Claude Code's own content. */
async function band($: Engine, bodyColumns = 138) {
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns }, surface: 'terminal' })
  const line = await ui.find({ key: 'where-am-i-band' })
  const theirs = await ui.find({ type: 'Text', text: 'drawn by Claude Code' })
  const texts = leaves(line)
  await ui.unmount()
  return { line, text: texts.map(t => t.text).join('  '), theirs, texts }
}

test('band shows repo, branch, linked worktree, dirty, ahead, age, usage and cache', async ($, on) => {
  const w = world(on, { git: linkedRepo() })
  await start($)
  await step($)
  await measure($, [
    { kind: 'five_hour', percentUsed: 34, resetsAt: new Date(NOW + 2 * 3600_000).toISOString() },
    { kind: 'seven_day', percentUsed: 12 },
  ])
  await w.clock.advance(19 * MIN)
  const b = await band($)
  expect(b.text).toBe('acme-repo@feat-x ⑂wt:feat-x  ● 5h 34%  ● 7d 12%  ● cache 41m  3 dirty · 2↑ · 33m since commit')
  // Claude Code's own content stays, under the band
  expect(b.theirs).toBeDefined()
  // every git call is capped and runs in the session's cwd
  expect(w.inits.every(i => i.timeoutMs === 2000 && i.cwd === '/work/wt/feat-x')).toBe(true)
  expect(w.calls.every(c => c[0] === 'git')).toBe(true)
})

test('band chips are muted by default; usage turns warn at 80 and danger at 95', async ($, on) => {
  world(on, { git: linkedRepo() })
  await start($)
  await measure($, [{ kind: 'five_hour', percentUsed: 40 }])
  let b = await band($)
  expect(b.texts.find(t => t.text === '● 5h 40%')!.props.color).toBe('inactive')
  // the quiet right side
  expect(b.texts.find(t => t.text.startsWith('3 dirty'))!.props.color).toBe('inactive')
  await measure($, [{ kind: 'five_hour', percentUsed: 81 }, { kind: 'seven_day', percentUsed: 96 }])
  b = await band($)
  const five = b.texts.find(t => t.text === '● 5h 81%')!
  const seven = b.texts.find(t => t.text === '● 7d 96%')!
  const repo = b.texts.find(t => t.text.startsWith('acme-repo@'))!
  expect(five.props).toMatchObject({ color: 'warning', bold: true })
  expect(seven.props).toMatchObject({ color: 'error', bold: true })
  expect(repo.props.bold).toBe(true)
  // a window at danger: the right side turns to the default text color
  expect(b.texts.find(t => t.text.startsWith('3 dirty'))!.props.color).toBeUndefined()
  expect(JSON.stringify(b.line)).not.toMatch(/dimColor|backgroundColor|"yellow"|"white"|"gray"|"grey"|"black"|subtle/i)
})

test('one toast per window at 90% from session.measure, plus cost', async ($, on) => {
  const w = world(on, { git: linkedRepo() })
  await start($)
  await measure($, [{ kind: 'five_hour', percentUsed: 85 }])
  expect(w.toasts).toEqual([])
  await measure($, [{ kind: 'five_hour', percentUsed: 91, resetsAt: new Date(NOW + 80 * MIN).toISOString() }], 1.25)
  await measure($, [{ kind: 'five_hour', percentUsed: 93 }])
  await measure($, [{ kind: 'five_hour', percentUsed: 99 }])
  expect(w.toasts).toEqual(['5h usage window at 91%, resets in 1h20'])
  await measure($, [{ kind: 'seven_day', percentUsed: 90 }])
  expect(w.toasts.length).toBe(2)
  const out = await $.command.run({ command: 'where', args: 'text' })
  expect(String(out.text)).toContain('Session cost    $1.25')
})

test('falls back to $.session.usage() for the windows', async ($, on) => {
  world(on, { git: linkedRepo(), usage: { context: { window: 1 }, rateLimits: [{ kind: 'five_hour', percentUsed: 40 }] } })
  await start($)
  expect((await band($)).text).toContain('5h 40%')
})

test('cache clock: muted, warn under 5 minutes, cold after the TTL; subagent steps ignored', async ($, on) => {
  const w = world(on, { git: linkedRepo() })
  await start($)
  expect((await band($)).text).not.toContain('cache')
  await step($)
  await w.clock.advance(19 * MIN)
  let b = await band($)
  expect(b.texts.find(t => t.text === '● cache 41m')!.props.color).toBe('inactive')
  await w.clock.advance(37 * MIN)
  b = await band($)
  expect(b.texts.find(t => t.text === '● cache 4m')!.props.color).toBe('warning')
  await step($, 'agent-1')
  await w.clock.advance(5 * MIN)
  expect((await band($)).text).toContain('cache cold')
})

test('cache TTL from ~/.claude/where-am-i.json, then /where cache', async ($, on) => {
  const w = world(on, { git: linkedRepo(), config: { cacheTtlMin: 5 } })
  await start($)
  await step($)
  await w.clock.advance(2 * MIN)
  expect((await band($)).text).toContain('cache 3m')
  const r = await $.command.run({ command: 'where', args: 'cache 60' })
  expect(r.text).toBe('Prompt-cache TTL set to 60 minutes.')
  expect(w.saved.get('settings')).toEqual({ cacheTtlMin: 60 })
  expect((await band($)).text).toContain('cache 58m')
  expect((await $.command.run({ command: 'where', args: 'cache soon' })).text).toContain('minutes')
})

test('detached HEAD with no upstream in the main checkout', async ($, on) => {
  world(on, {
    cwd: '/work/acme-repo',
    git: linkedRepo({
      'rev-parse --absolute-git-dir --git-common-dir --show-toplevel': ok('/work/acme-repo/.git\n.git\n/work/acme-repo\n'),
      'symbolic-ref --short -q HEAD': fail(1),
      'rev-parse --short HEAD': ok('a1b2c3d\n'),
      '--no-optional-locks status --porcelain': ok(''),
      'rev-parse --abbrev-ref --symbolic-full-name @{upstream}': fail(),
      'rev-list --count @{upstream}..HEAD': fail(),
    }),
  })
  await start($, '/work/acme-repo')
  expect((await band($)).text).toBe('acme-repo@(a1b2c3d)  clean · 14m since commit')
  const t = String((await $.command.run({ command: 'where', args: 'text' })).text)
  expect(t).toContain('detached at a1b2c3d')
  expect(t).toContain('main checkout')
  expect(t).toContain('no upstream')
})

test('a branch with no upstream says so', async ($, on) => {
  world(on, {
    git: linkedRepo({
      'rev-parse --abbrev-ref --symbolic-full-name @{upstream}': fail(),
      'rev-list --count @{upstream}..HEAD': fail(),
    }),
  })
  await start($)
  expect((await band($)).text).toContain('3 dirty · no upstream · ')
})

test('non-git folder shows the folder name only', async ($, on) => {
  world(on, { cwd: '/home/tester/notes', git: { 'rev-parse --absolute-git-dir --git-common-dir --show-toplevel': fail() } })
  await start($, '/home/tester/notes')
  expect((await band($)).text).toBe('notes (no git)')
  expect(String((await $.command.run({ command: 'where', args: 'text' })).text)).toContain('not a git repository')
})

test('refresh never throws when $.process.run fails', async ($, on) => {
  world(on, { cwd: '/w/app', git: 'throw' })
  await start($, '/w/app')
  await $.turn.complete({ turnId: 't', answer: 'done', durationMs: 1, isAborted: false, usage: null })
  const r = await $.command.run({ command: 'where', args: 'refresh' })
  expect(r.text).toBe('where-am-i: checked again.')
  expect((await band($)).text).toBe('app (no git)')
})

test('band stays one truncating row at any bodyColumns', async ($, on) => {
  world(on, { git: linkedRepo() })
  await start($)
  const b = await band($, 24)
  // the kit line truncates its label and right side instead of wrapping
  const label = b.texts.find(t => t.text.startsWith('acme-repo@'))!
  expect(label.props.wrap).toBe('truncate')
  expect(b.texts.find(t => t.text.startsWith('3 dirty'))!.props.wrap).toBe('truncate')
})

test('/where band off hides the band and leaves Claude Code content', async ($, on) => {
  const w = world(on, { git: linkedRepo() })
  await start($)
  expect((await $.command.run({ command: 'where', args: 'band off' })).text).toBe('Band hidden.')
  const b = await band($)
  expect(b.line).toBeUndefined()
  expect(b.theirs).toBeDefined()
  expect(w.saved.get('settings')).toEqual({ band: false })
  expect((await $.command.run({ command: 'where', args: 'band on' })).text).toBe('Band shown above the prompt.')
  expect((await band($)).line).toBeDefined()
})

test('the 60 s tick refreshes git while idle, not during a turn', async ($, on) => {
  const w = world(on, { git: linkedRepo() })
  await start($)
  await $.turn.start({ turnId: 't', prompt: 'hi' } as never)
  const before = w.calls.length
  await w.clock.advance(60_000)
  expect(w.calls.length).toBe(before)
  await $.turn.complete({ turnId: 't', answer: 'done', durationMs: 1, isAborted: false, usage: null })
  await $.command.run({ command: 'where', args: 'refresh' })
  const after = w.calls.length
  expect(after).toBeGreaterThan(before)
  await w.clock.advance(60_000)
  await $.command.run({ command: 'where', args: 'refresh' })
  expect(w.calls.length).toBeGreaterThan(after)
})

test('/where opens the pane with worktrees and Refresh / Close buttons', async ($, on) => {
  const w = world(on, { git: linkedRepo() })
  await start($)
  await $.command.run({ command: 'where', args: '' })
  expect(w.opened).toEqual(['where-am-i'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'WORKTREES' })).toBeDefined()
  expect(await ui.find({ key: 'wt-/work/wt/feat-x' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '●' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '/work/acme-repo' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Add the band/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /origin\/feat-x · 2 unpushed/ })).toBeDefined()
  const n = w.calls.length
  await ui.press({ key: 'refresh' })
  expect(w.calls.length).toBeGreaterThan(n)
  await ui.press({ key: 'close' })
  expect(w.closed).toEqual(['where-am-i'])
  await ui.unmount()
})

test('/where with an unknown word prints help', async ($, on) => {
  world(on, { git: linkedRepo() })
  await start($)
  expect(String((await $.command.run({ command: 'where', args: 'banana' })).text)).toContain('Usage: /where')
})

test('settings come back after /clear', async ($, on) => {
  const w = world(on, { git: linkedRepo() })
  w.saved.set('settings', { band: false })
  await $.classic.SessionStart({ source: 'clear', cwd: '/work/wt/feat-x' } as never)
  await $.command.run({ command: 'where', args: 'refresh' })
  expect((await band($)).line).toBeUndefined()
})
