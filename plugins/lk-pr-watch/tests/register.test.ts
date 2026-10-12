import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { TONES } from '../hooks/kit'
import { MIXED, PR_VIEW, bandSeen, fail, graphql, pass, pending } from './fixtures'
import type { BandSeen } from './fixtures'

type World = {
  clock: MockClock
  saved: Map<string, unknown>
  toasts: string[]
  notes: string[]
  opened: string[]
  closed: string[]
  copied: string[]
  argvs: string[][]
  /** What `gh pr view` answers: a PR, or the stderr of a failure. */
  view: { pr: unknown; stderr: string }
  /** What `gh api graphql` answers for each PR number. */
  gql: Map<number, unknown>
  files: Map<string, unknown>
}

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
  props: { title: 'PR watch', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

function world(on: On, opts: { files?: Record<string, unknown>; noPr?: boolean } = {}): World {
  const w: World = {
    clock: mock.clock(on, { now: 1_000_000 }),
    saved: new Map(),
    toasts: [],
    notes: [],
    opened: [],
    closed: [],
    copied: [],
    argvs: [],
    view: opts.noPr ? { pr: null, stderr: 'no pull requests found for branch "main"' } : { pr: PR_VIEW, stderr: '' },
    gql: new Map([[42, graphql({ contexts: [pass('build'), pending('test')] })]]),
    files: new Map(Object.entries(opts.files ?? {})),
  }
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    w.argvs.push(argv)
    if (argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'view') {
      const n = /^\d+$/.test(argv[3] ?? '') ? Number(argv[3]) : 0
      if (n) return { value: { exitCode: 0, stdout: JSON.stringify({ ...PR_VIEW, number: n, url: `https://github.com/acme/widgets/pull/${n}` }), stderr: '', ...FLAGS } }
      if (!w.view.pr) return { value: { exitCode: 1, stdout: '', stderr: w.view.stderr, ...FLAGS } }
      return { value: { exitCode: 0, stdout: JSON.stringify(w.view.pr), stderr: '', ...FLAGS } }
    }
    if (argv[0] === 'gh' && argv[1] === 'api') {
      const n = Number((argv.find(a => a.startsWith('n=')) ?? 'n=0').slice(2))
      const body = w.gql.get(n)
      return body ? { value: { exitCode: 0, stdout: JSON.stringify(body), stderr: '', ...FLAGS } } : { value: { exitCode: 1, stdout: '', stderr: 'HTTP 404', ...FLAGS } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', ...FLAGS } }
  })
  on('store.get', ($, e) => ({ value: w.saved.get(e.key) }))
  on('store.set', ($, e) => {
    w.saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('env.get', () => ({ value: '/home/tester' }))
  on('fs.exists', ($, e) => ({ value: [...w.files.keys()].some(k => e.path.endsWith(k)) }))
  on('fs.read', ($, e) => {
    const k = [...w.files.keys()].find(k => e.path.endsWith(k))
    return { value: JSON.stringify(k ? w.files.get(k) : {}) }
  })
  on('command.register', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    w.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    w.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('session.append', ($, e, next) => {
    const block = e.message.content[0] as { text?: string }
    w.notes.push(String(block?.text ?? ''))
    return next(e)
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('classic.SessionStart', () => ({}))
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  return w
}

async function start($: Engine, w: World) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await w.clock.settle()
}

async function band($: Engine): Promise<BandSeen | undefined> {
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const root = await ui.find({ key: 'pr-watch-band' })
  await ui.unmount()
  return root ? bandSeen(root) : undefined
}

const gqlCalls = (w: World) => w.argvs.filter(a => a[1] === 'api').length

test('session start finds the branch PR, polls it and draws the band', async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(w.argvs[0]).toEqual(['gh', 'pr', 'view', '--json', 'number,url,title,state,isDraft,mergeable,reviewDecision,headRefName,baseRefName'])
  expect(gqlCalls(w)).toBe(1)
  const b = await band($)
  // one kit line: the label, then the checks, review and merge chips in their tones; nothing on the right
  expect(b).toEqual({
    text: 'PR #42  ● checks 1/2 ✓ 1 …  ● review required  ● mergeable',
    tones: [TONES.warn.fg, TONES.warn.fg, TONES.ok.fg],
  })
  // the band keeps what the mods after it draw
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  await ui.unmount()
})

test('no PR for the branch: no band', async ($, on) => {
  const w = world(on, { noPr: true })
  await start($, w)
  expect(gqlCalls(w)).toBe(0)
  expect(await band($)).toBeUndefined()
})

test('a newly failed check toasts and appends one note; it is not repeated', async ($, on) => {
  const w = world(on)
  await start($, w)
  w.gql.set(42, graphql({ contexts: [pass('build'), fail('test')] }))
  await $.command.run({ command: 'pr', args: 'refresh' })
  expect(w.toasts).toContain('PR #42: check "test" failed')
  expect(w.notes).toEqual([
    '[pr-watch: automated notice, not typed by the user] Check "test" failed on PR #42 (acme/widgets): https://github.com/acme/widgets/actions/runs/1/job/test',
  ])
  expect((await band($))?.tones[0]).toBe(TONES.danger.fg)
  // still failing on the next poll: no second note
  await $.command.run({ command: 'pr', args: 'refresh' })
  expect(w.notes.length).toBe(1)
  // two more checks fail at once: one note each
  w.gql.set(42, graphql({ contexts: [fail('build'), fail('test'), fail('lint')] }))
  await $.command.run({ command: 'pr', args: 'refresh' })
  expect(w.notes.length).toBe(3)
})

test('failed to green, review changes and merged toast; notifyOn filters them', async ($, on) => {
  const w = world(on, { files: { '/work/.claude/pr-watch.json': { notifyOn: ['green', 'merged'] } } })
  await start($, w)
  w.gql.set(42, graphql({ contexts: [pass('build'), fail('test')] }))
  await $.command.run({ command: 'pr', args: 'refresh' })
  // "failed" is not in notifyOn: no toast, but the note still goes to Claude
  expect(w.toasts).toEqual([])
  expect(w.notes.length).toBe(1)
  w.gql.set(42, graphql({ contexts: [pass('build'), pass('test')], reviewDecision: 'CHANGES_REQUESTED' }))
  await $.command.run({ command: 'pr', args: 'refresh' })
  expect(w.toasts).toEqual(['PR #42: all checks green'])
  w.gql.set(42, graphql({ contexts: [pass('build'), pass('test')], reviewDecision: 'APPROVED', state: 'MERGED' }))
  await $.command.run({ command: 'pr', args: 'refresh' })
  expect(w.toasts).toEqual(['PR #42: all checks green', 'PR #42 merged'])
})

test('review requested changes toasts under the default notifyOn', async ($, on) => {
  const w = world(on)
  await start($, w)
  w.gql.set(42, graphql({ contexts: [pass('build'), pending('test')], reviewDecision: 'CHANGES_REQUESTED' }))
  await $.command.run({ command: 'pr', args: 'refresh' })
  expect(w.toasts).toEqual(['PR #42: review changes requested'])
  expect(w.notes).toEqual([])
})

test('appendNoteOnFailure false sends no note', async ($, on) => {
  const w = world(on, { files: { '/home/tester/.claude/pr-watch.json': { appendNoteOnFailure: false } } })
  await start($, w)
  w.gql.set(42, graphql({ contexts: [pass('build'), fail('test')] }))
  await $.command.run({ command: 'pr', args: 'refresh' })
  expect(w.toasts).toContain('PR #42: check "test" failed')
  expect(w.notes).toEqual([])
})

test('a bare PR URL is consumed with { drop }; other prompts pass through', async ($, on) => {
  const w = world(on, { noPr: true })
  w.gql.set(7, graphql({ number: 7, contexts: [pass('ci')], reviewDecision: 'APPROVED' }))
  await start($, w)
  const r = await $.prompt.submit({ text: 'https://github.com/acme/widgets/pull/7' })
  expect(r).toEqual({ drop: 'pr-watch: watching acme/widgets#7' })
  await w.clock.settle()
  expect((await band($))?.text).toBe('PR #7  ● checks 1/1 ✓  ● approved  ● mergeable')
  // pasting it again is not a second watch
  expect(await $.prompt.submit({ text: ' https://github.com/acme/widgets/pull/7 ' })).toEqual({ drop: 'pr-watch: already watching acme/widgets#7' })
  // a prompt that mentions a URL among words is the user's
  const passed = await $.prompt.submit({ text: 'review https://github.com/acme/widgets/pull/7 please' })
  expect(passed).toEqual({ text: 'review https://github.com/acme/widgets/pull/7 please' })
  expect(await $.prompt.submit({ text: 'hello' })).toEqual({ text: 'hello' })
})

test('git push finds the PR and turns on the hot cadence while a check is pending', async ($, on) => {
  const w = world(on, { noPr: true })
  await start($, w)
  expect(gqlCalls(w)).toBe(0)
  w.view.pr = PR_VIEW
  await $.tool.call({ tool: 'Bash', command: 'git push -u origin feature/cache' })
  await w.clock.settle()
  expect(gqlCalls(w)).toBe(1)
  // the check is pending and the window is hot: a poll every 30 s
  await w.clock.advance(30_000)
  expect(gqlCalls(w)).toBe(2)
  await w.clock.advance(30_000)
  expect(gqlCalls(w)).toBe(3)
  // checks finish: back to every 120 s
  w.gql.set(42, graphql({ contexts: [pass('build'), pass('test')] }))
  await w.clock.advance(30_000)
  expect(gqlCalls(w)).toBe(4)
  await w.clock.advance(90_000)
  expect(gqlCalls(w)).toBe(4)
  await w.clock.advance(30_000)
  expect(gqlCalls(w)).toBe(5)
})

test('without a push the cadence is pollSec even while pending', async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(gqlCalls(w)).toBe(1)
  await w.clock.advance(110_000)
  expect(gqlCalls(w)).toBe(1)
  await w.clock.advance(10_000)
  expect(gqlCalls(w)).toBe(2)
  // other Bash commands change nothing
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  await w.clock.settle()
  expect(gqlCalls(w)).toBe(2)
})

test('gh pr merge looks again and the merge toasts', async ($, on) => {
  const w = world(on)
  await start($, w)
  w.gql.set(42, graphql({ contexts: [pass('build'), pass('test')], state: 'MERGED' }))
  await $.tool.call({ tool: 'Bash', command: 'gh pr merge 42 --squash' })
  await w.clock.settle()
  expect(w.toasts).toContain('PR #42 merged')
  expect((await band($))?.text).toBe('PR #42  ● checks 2/2 ✓  ● review required  ● merged')
})

test('/pr add, rm, band and text', async ($, on) => {
  const w = world(on, { noPr: true })
  w.gql.set(9, graphql({ number: 9, contexts: [fail('lint')] }))
  w.gql.set(5, graphql({ number: 5 }))
  await start($, w)
  expect((await $.command.run({ command: 'pr', args: 'add 9' })).text).toBe(
    'Watching acme/widgets#9: PR #9 ● checks 0/1 ✓ 1 ✗ · review: review required · mergeable',
  )
  expect(w.argvs.some(a => a.join(' ').startsWith('gh pr view 9 --json'))).toBe(true)
  expect((await $.command.run({ command: 'pr', args: 'add https://github.com/acme/widgets/pull/5' })).text).toContain('Watching acme/widgets#5')
  // a failed check makes the band urgent: the right side is drawn in the default text color
  expect(await band($)).toEqual({
    text: 'PR #9  ● checks 0/1 ✓ 1 ✗  ● review required  ● mergeable',
    tones: [TONES.danger.fg, TONES.warn.fg, TONES.ok.fg],
    right: '+1 more',
    rightColor: undefined,
  })
  const text = String((await $.command.run({ command: 'pr', args: 'text' })).text)
  expect(text).toContain('acme/widgets#9 https://github.com/acme/widgets/pull/9')
  expect(text).toContain('✗ lint fail 1m 23s https://github.com/acme/widgets/actions/runs/1/job/lint')
  expect((await $.command.run({ command: 'pr', args: 'rm 9' })).text).toBe('Stopped watching acme/widgets#9.')
  expect((await $.command.run({ command: 'pr', args: 'rm 9' })).text).toContain('no watched PR matches')
  expect((await $.command.run({ command: 'pr', args: 'band off' })).text).toBe('PR band hidden.')
  expect(w.saved.get('band')).toBe(false)
  expect(await band($)).toBeUndefined()
  await $.command.run({ command: 'pr', args: 'band on' })
  expect((await band($))?.text).toContain('PR #5')
  expect((await $.command.run({ command: 'pr', args: 'wat' })).text).toContain('Usage: /pr')
})

test('the pane lists checks with links and its buttons work', async ($, on) => {
  const w = world(on)
  w.gql.set(42, MIXED)
  await start($, w)
  await $.command.run({ command: 'pr', args: '' })
  expect(w.opened).toEqual(['pr-watch'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '#42 Add the widget cache' })).toBeDefined()
  expect(await ui.find({ type: 'Link', key: undefined } as never)).toBeDefined()
  // the review decision is a kit pill and the merge state a quiet line beside it (tests/pane.test.ts checks the rest)
  expect(await ui.find({ type: 'Text', text: '● changes requested' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'mergeable · blocked' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'fail · 1m 23s' })).toBeDefined()
  await ui.press({ key: 'copy-42' })
  await ui.press({ key: 'open-42' })
  await w.clock.settle()
  expect(w.copied).toEqual(['https://github.com/acme/widgets/pull/42'])
  expect(w.argvs.some(a => a[0] === 'xdg-open' && a[1] === 'https://github.com/acme/widgets/pull/42')).toBe(true)
  const before = gqlCalls(w)
  await ui.press({ key: 'refresh' })
  await w.clock.settle()
  expect(gqlCalls(w)).toBe(before + 1)
  await ui.press({ key: 'close' })
  expect(w.closed).toEqual(['pr-watch'])
  await ui.unmount()
  // the desktop app draws the same pane
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desk.find({ key: 'refresh' })).toBeDefined()
  await desk.unmount()
})

test('a gh failure is shown, never thrown', async ($, on) => {
  const w = world(on)
  w.gql.delete(42)
  await start($, w)
  // the failure chip in danger and gh's error on the right side, in the default text color (urgent)
  expect(await band($)).toEqual({ text: 'PR #42  ● gh failed', tones: [TONES.danger.fg], right: 'HTTP 404', rightColor: undefined })
  expect(String((await $.command.run({ command: 'pr', args: 'text' })).text)).toContain('gh failed: HTTP 404')
})

test('/clear reloads config and finds the PR again', async ($, on) => {
  const w = world(on)
  await $.classic.SessionStart({ source: 'clear', cwd: '/work' } as never)
  await w.clock.settle()
  expect(gqlCalls(w)).toBe(1)
  expect((await band($))?.text).toContain('PR #42')
})
