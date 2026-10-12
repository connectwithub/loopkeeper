import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const SYSTEM = '/usr/share/sounds/freedesktop/stereo/complete.oga'

type World = {
  saved: Map<string, unknown>
  toasts: string[]
  runs: string[][]
  audio: unknown[]
  opened: string[]
  closed: string[]
}

type Opts = {
  files?: Record<string, unknown>
  systemSound?: boolean
  /** Exit codes per program; a missing program rejects as not installed. */
  exits?: Record<string, number>
  audioFails?: boolean
  settings?: unknown
  /** The tool.call stub waits on this before it answers, so a test can fire tool.check mid-call. */
  hold?: Promise<void>
}

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

function ask(id: string, question = 'Which database?') {
  return {
    plugin: 'lk-attention',
    component: 'AskUserQuestion',
    requestId: id,
    viewport: { columns: 120, rows: 40 },
    props: { tool: 'AskUserQuestion', questions: [{ question, header: 'DB', options: [] }] },
  } as const
}

function world(on: On, o: Opts = {}) {
  const w: World = { saved: new Map(), toasts: [], runs: [], audio: [], opened: [], closed: [] }
  if (o.settings !== undefined) w.saved.set('settings', o.settings)
  const clock = mock.clock(on, { now: 1_000_000 })
  const files = o.files ?? {}
  const exits = o.exits ?? { 'notify-send': 0, paplay: 0, 'pw-play': 0 }
  on('store.get', ($, e) => ({ value: w.saved.get(e.key) }))
  on('store.set', ($, e) => {
    w.saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('env.get', () => ({ value: '/home/tester' }))
  on('fs.exists', ($, e) => ({ value: e.path === SYSTEM ? o.systemSound !== false : e.path in files }))
  on('fs.read', ($, e) => ({ value: JSON.stringify(files[e.path] ?? {}) }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
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
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    const code = exits[argv[0]]
    if (code === undefined) return { deny: 'spawn ' + argv[0] + ' ENOENT' }
    return { value: { exitCode: code, stdout: '', stderr: '' } }
  })
  on('audio.play', ($, e) => {
    w.audio.push(e)
    return o.audioFails ? { deny: 'no player' } : { value: undefined }
  })
  on('tool.call', async () => {
    if (o.hold) await o.hold
    return { result: 'ok' }
  })
  on('tool.check', () => ({ decision: 'ask' }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('agent.spawn', () => ({ model: 'claude-test', agentId: 'ag1' }))
  // The question dialog is core's own drawing (an engine node); other sites get a plain Text.
  on('ui.render', ($, e) =>
    (e.component === 'AskUserQuestion' ? { type: 'engine', ref: 0 } : { type: 'Text', props: {}, children: ['drawn by Claude Code'] }) as never,
  )
  return { w, clock }
}

async function start($: Engine) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

async function turn($: Engine, durationMs: number, extra: Record<string, unknown> = {}) {
  await $.turn.complete({ turnId: 't' + durationMs, answer: '## All tests pass\nDetails', durationMs, isAborted: false, reason: 'answer', usage: null, ...extra } as never)
}

async function text($: Engine): Promise<string> {
  return String((await $.command.run({ command: 'attention', args: 'text' })).text ?? '')
}

async function band($: Engine) {
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const found = await ui.find({ key: 'attention-band' })
  const theirs = await ui.find({ type: 'Text', text: 'drawn by Claude Code' })
  await ui.unmount()
  // The kit line's Text nodes: the label, the state chip and the quiet kinds.
  type N = { type: string; props: Record<string, unknown>; children: unknown[] }
  const texts = (n: unknown, out: N[] = []): N[] => {
    if (!n || typeof n !== 'object') return out
    if ((n as N).type === 'Text') out.push(n as N)
    else for (const c of (n as N).children ?? []) texts(c, out)
    return out
  }
  const [label, chip, kinds] = texts(found)
  if (!label || !chip || !kinds) return { text: null, color: undefined, stacked: theirs !== undefined }
  const s = (n: N) => String(n.children[0])
  return { text: `${s(label)} ${s(chip)}: ${s(kinds)}`, color: chip.props.color, stacked: theirs !== undefined }
}

const notifySends = (w: World) => w.runs.filter(r => r[0] === 'notify-send')

test('a long main-loop turn raises long-turn-done through every channel; a short one stays quiet', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await turn($, 5_000)
  await clock.settle()
  expect(w.toasts).toEqual([])
  await turn($, 42_000)
  await clock.settle()
  expect(w.toasts).toEqual(['Claude finished (42s)'])
  expect(notifySends(w)).toEqual([
    ['notify-send', '-a', 'Claude Code', '-i', 'dialog-information', 'Claude finished (42s)', 'All tests pass'],
  ])
  expect(w.runs.some(r => r[0] === 'paplay' && r[1] === SYSTEM)).toBe(true)
  expect(await text($)).toContain('● ')
  expect((await band($)).text).toBe('attention ● 1 new: done')
})

test('permission wait: tool.check ask raises once per tool_use_id, and the tool.call clears it', async ($, on) => {
  const { w, clock } = world(on, { settings: { permissionSignal: 'grace' } })
  await start($)
  await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'tu1' } as never)
  await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'tu1' } as never)
  await clock.advance(4_000)
  expect(w.toasts).toEqual(['Claude needs your OK: Bash'])
  expect(notifySends(w)[0]?.slice(-2)).toEqual(['Claude needs your OK: Bash', 'rm -rf build'])
  const b = await band($)
  expect(b.text).toBe('attention ● 1 waiting: permission (Bash)')
  expect(b.color).toBe('claude')
  expect(b.stacked).toBe(true)
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build', tool_use_id: 'tu1' } as never)
  expect((await band($)).text).toBe(null)
  expect(await text($)).toContain('○ ')
})

test('a query with no tool_use_id, an allow, or AskUserQuestion raises no permission wait', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
  await $.tool.check({ tool: 'AskUserQuestion', input: {}, tool_use_id: 'q1' } as never)
  await clock.settle()
  expect(w.toasts).toEqual([])
})

test('the turn ending clears an open permission wait', async ($, on) => {
  const { clock } = world(on, { settings: { permissionSignal: 'grace' } })
  await start($)
  await $.tool.check({ tool: 'Edit', input: { file_path: '/a.ts' }, tool_use_id: 'tu2' } as never)
  await clock.advance(4_000)
  expect((await band($)).text).toBe('attention ● 1 waiting: permission (Edit)')
  await turn($, 1_000)
  expect((await band($)).text).toBe(null)
})

test('question-waiting on the first AskUserQuestion render per tool call id', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  for (let i = 0; i < 2; i++) {
    const ui = await $.ui.mount({ ...ask('toolu_q'), surface: 'terminal' } as never)
    await ui.unmount()
  }
  await clock.settle()
  expect(w.toasts).toEqual(['Claude is asking you something'])
  expect(notifySends(w)[0]?.slice(-1)).toEqual(['Which database?'])
  expect((await band($)).text).toBe('attention ● 1 waiting: question')
  await $.tool.call({ tool: 'AskUserQuestion', questions: [], tool_use_id: 'toolu_q' } as never)
  expect((await band($)).text).toBe(null)
})

test('subagent-done uses the spawn label and the run time; a short subagent stays quiet', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await $.agent.spawn({ tool_use_id: 'tA', prompt: 'p', description: 'explore auth', subagentType: 'Explore', background: true } as never)
  await turn($, 10_000, { agentId: 'ag1', turnId: 'x1' })
  await clock.settle()
  expect(w.toasts).toEqual([])
  await turn($, 70_000, { agentId: 'ag1', turnId: 'x2' })
  await turn($, 70_000, { agentId: 'ag1', turnId: 'x2' })
  await clock.settle()
  expect(w.toasts).toEqual(['Subagent done: explore auth (1m 10s)'])
  expect((await band($)).text).toBe('attention ● 1 new: subagent')
})

test('an error turn raises failed in red; an interrupt is history only', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await turn($, 3_000, { isAborted: true, reason: 'aborted' })
  await clock.settle()
  expect(w.toasts).toEqual(['Turn interrupted after 3s'])
  expect(notifySends(w)).toEqual([])
  expect((await band($)).text).toBe(null)
  await turn($, 2_000, { reason: 'error', answer: '' })
  await clock.settle()
  expect(w.toasts[1]).toBe('Claude stopped on an error')
  expect(notifySends(w).length).toBe(1)
  const b = await band($)
  expect(b.text).toBe('attention ● 1 new: failed')
  expect(b.color).toBe('error')
})

test('rate limit: one native notification per kind per 10 s; toasts still show', async ($, on) => {
  const { w, clock } = world(on, { settings: { permissionSignal: 'grace' } })
  await start($)
  await turn($, 30_000)
  await clock.settle()
  await clock.advance(4_000)
  await turn($, 31_000)
  await clock.settle()
  expect(w.toasts.length).toBe(2)
  expect(notifySends(w).length).toBe(1)
  // Another kind is not limited by the first.
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu9' } as never)
  await clock.advance(4_000)
  expect(notifySends(w).length).toBe(2)
  await clock.advance(10_000)
  await turn($, 32_000)
  await clock.settle()
  expect(notifySends(w).length).toBe(3)
})

test('sound falls back from paplay to pw-play, then to the bundled ding', async ($, on) => {
  const { w, clock } = world(on, { exits: { 'notify-send': 0, 'pw-play': 0 } })
  await start($)
  await turn($, 25_000)
  await clock.settle()
  expect(w.runs.filter(r => r[0] !== 'notify-send')).toEqual([
    ['paplay', SYSTEM],
    ['pw-play', SYSTEM],
  ])
  expect(w.audio).toEqual([])
})

test('with no system sound the bundled asset plays through $.audio.play, then paplay', async ($, on) => {
  const { w, clock } = world(on, { systemSound: false, audioFails: true })
  await start($)
  const r = await $.command.run({ command: 'attention', args: 'test' })
  await clock.settle()
  expect(w.audio).toEqual([{ clip: { asset: 'assets/ding.wav' }, shouldLoop: false }])
  const players = w.runs.filter(x => x[0] === 'paplay')
  expect(players.length).toBe(1)
  expect(players[0][1]).toMatch(/\/assets\/ding\.wav$/)
  expect(String(r.text)).toContain('sound via paplay')
})

test('/attention test sends through every channel and reports each', async ($, on) => {
  const { w } = world(on)
  await start($)
  const r = await $.command.run({ command: 'attention', args: 'test' })
  expect(r.text).toBe(`Test sent: toast; native via notify-send; sound via paplay ${SYSTEM}.`)
  expect(w.toasts).toEqual(['attention test'])
  expect(notifySends(w)[0]).toEqual([
    'notify-send', '-a', 'Claude Code', '-i', 'dialog-information', 'attention test', 'If you can see and hear this, notifications work.',
  ])
  // A second test right away is not rate-limited.
  await $.command.run({ command: 'attention', args: 'test' })
  expect(notifySends(w).length).toBe(2)
})

test('prompt.submit marks the inbox seen; a task notification does not', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await turn($, 25_000)
  await clock.settle()
  await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' } } as never)
  expect((await band($)).text).toBe('attention ● 1 new: done')
  await $.prompt.submit({ text: 'thanks', wait: false, origin: { kind: 'composer' } } as never)
  expect((await band($)).text).toBe(null)
  expect(await text($)).toContain('0 unseen')
})

test('quiet period after the user prompt suppresses native and sound, not the toast', async ($, on) => {
  const { w, clock } = world(on, { files: { '/work/.claude/attention.json': { quietAfterPromptMs: 60_000 } } })
  await start($)
  await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } } as never)
  await clock.advance(30_000)
  await turn($, 30_000)
  await clock.settle()
  expect(w.toasts).toEqual(['Claude finished (30s)'])
  expect(w.runs).toEqual([])
})

test('config: user and project files merge, and /attention settings win', async ($, on) => {
  const { w, clock } = world(on, {
    files: {
      '/home/tester/.claude/attention.json': { longTurnMs: 60_000, sound: false, subagentMs: 120_000 },
      '/work/.claude/attention.json': { longTurnMs: 30_000 },
    },
  })
  await start($)
  expect(await text($)).toContain('sound off · band on · long turn 30s · subagent 2m')
  await turn($, 25_000)
  await clock.settle()
  expect(w.toasts).toEqual([])
  const r = await $.command.run({ command: 'attention', args: 'long 20s' })
  expect(r.text).toBe('Turns of 20s or more notify when they finish.')
  expect(w.saved.get('settings')).toEqual({ longTurnMs: 20_000 })
  await turn($, 25_000)
  await clock.settle()
  expect(w.toasts).toEqual(['Claude finished (25s)'])
  expect(w.runs.some(r => r[0] === 'paplay')).toBe(false)
})

test('switches: off raises nothing, native off and sound off skip their channel, band off hides the band', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await $.command.run({ command: 'attention', args: 'off' })
  await turn($, 25_000)
  await clock.settle()
  expect(w.toasts).toEqual([])
  await $.command.run({ command: 'attention', args: 'on' })
  await $.command.run({ command: 'attention', args: 'native off' })
  await $.command.run({ command: 'attention', args: 'sound off' })
  await turn($, 26_000)
  await clock.settle()
  expect(w.toasts).toEqual(['Claude finished (26s)'])
  expect(w.runs).toEqual([])
  expect((await band($)).text).toBe('attention ● 1 new: done')
  const r = await $.command.run({ command: 'attention', args: 'band off' })
  expect(r.text).toBe('Band off.')
  expect((await band($)).text).toBe(null)
  expect((await $.command.run({ command: 'attention', args: 'sound maybe' })).text).toBe('Use /attention sound on or /attention sound off.')
})

test('the pane lists the inbox newest first and Mark all seen clears the band', async ($, on) => {
  const { w, clock } = world(on, { settings: { permissionSignal: 'grace' } })
  await start($)
  expect((await $.command.run({ command: 'attention', args: '' })).text).toBeUndefined()
  expect(w.opened).toEqual(['attention'])
  await turn($, 25_000)
  await $.tool.check({ tool: 'Bash', input: { command: 'make' }, tool_use_id: 'tu5' } as never)
  await clock.advance(4_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'INBOX · 2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2 UNSEEN · NEWEST FIRST' })).toBeDefined()
  const out = await text($)
  expect(out.indexOf('permission')).toBeLessThan(out.indexOf('Claude finished'))
  await ui.press({ key: 'seen' })
  await ui.press({ key: 'close' })
  await ui.unmount()
  expect(w.closed).toEqual(['attention'])
  expect((await band($)).text).toBe(null)
})

test('the inbox keeps the last 50 events', async ($, on) => {
  const { clock } = world(on)
  await start($)
  for (let i = 0; i < 55; i++) await turn($, 21_000 + i * 1000)
  await clock.settle()
  expect(await text($)).toContain('Inbox: 50 events')
})

test('auto mode: a main-loop ask approved within the grace raises nothing', async ($, on) => {
  const { w, clock } = world(on, { settings: { permissionSignal: 'grace' } })
  await start($)
  await $.tool.check({ tool: 'Bash', input: { command: 'npm test' }, tool_use_id: 'auto1' } as never)
  await clock.advance(1_500)
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'auto1' } as never)
  await clock.advance(10_000)
  expect(w.toasts).toEqual([])
  expect(w.runs).toEqual([])
  expect((await band($)).text).toBe(null)
})

test('an ask still open past the grace raises once, not before', async ($, on) => {
  const { w, clock } = world(on, { settings: { permissionSignal: 'grace' } })
  await start($)
  await $.tool.check({ tool: 'Bash', input: { command: 'git push' }, tool_use_id: 'slow1' } as never)
  await clock.advance(3_900)
  expect(w.toasts).toEqual([])
  expect((await band($)).text).toBe(null)
  await clock.advance(200)
  await clock.advance(20_000)
  expect(w.toasts).toEqual(['Claude needs your OK: Bash'])
  expect(notifySends(w).length).toBe(1)
})

test('the turn ending or an interrupt cancels a held ask', async ($, on) => {
  const { w, clock } = world(on, { settings: { permissionSignal: 'grace' } })
  await start($)
  await $.tool.check({ tool: 'Bash', input: { command: 'a' }, tool_use_id: 'c1' } as never)
  await turn($, 1_000)
  await $.tool.check({ tool: 'Bash', input: { command: 'b' }, tool_use_id: 'c2' } as never)
  await turn($, 1_000, { isAborted: true, reason: 'aborted' })
  await clock.advance(10_000)
  expect(w.toasts).toEqual(['Turn interrupted after 1s'])
})

test('a subagent ask is ignored by default, and raised with /attention subagents on', async ($, on) => {
  // The subagent's tool.call is in flight while its tool.check runs, as in the engine.
  let release = () => {}
  const hold = new Promise<void>(r => {
    release = r
  })
  const { w, clock } = world(on, { hold, settings: { permissionSignal: 'grace' } })
  on('classic.PermissionRequest', () => ({}))
  await start($)
  await $.agent.spawn({ tool_use_id: 'tA', prompt: 'p', description: 'scan repo', subagentType: 'Explore', background: false } as never)
  const call = $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'sub1', agentId: 'ag1' } as never)
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'sub1' } as never)
  await clock.advance(10_000)
  expect(w.toasts).toEqual([])
  release()
  await call
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' }, agent_id: 'ag1' } as never)
  await clock.advance(10_000)
  expect(w.toasts).toEqual([])
  const r = await $.command.run({ command: 'attention', args: 'subagents on' })
  expect(r.text).toBe('Permission waits from subagents notify too.')
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' }, agent_id: 'ag1' } as never)
  await clock.settle()
  expect(w.toasts).toEqual(['Subagent scan repo needs your OK: Bash'])
})

test('classic.PermissionRequest raises at once and dedupes with the held tool.check ask', async ($, on) => {
  const { w, clock } = world(on, { settings: { permissionSignal: 'grace' } })
  on('classic.PermissionRequest', () => ({}))
  await start($)
  await $.tool.check({ tool: 'Write', input: { file_path: '/a.md' }, tool_use_id: 'd1' } as never)
  await clock.advance(500)
  await $.classic.PermissionRequest({ tool_name: 'Write', tool_input: { file_path: '/a.md' } } as never)
  await clock.settle()
  expect(w.toasts).toEqual(['Claude needs your OK: Write'])
  await clock.advance(10_000)
  expect(w.toasts.length).toBe(1)
  expect((await band($)).text).toBe('attention ● 1 waiting: permission (Write)')
  await $.tool.call({ tool: 'Write', file_path: '/a.md', content: '', tool_use_id: 'd1' } as never)
  expect((await band($)).text).toBe(null)
  // Once the dialog event is known, an ask it never reports (auto-approved) stays quiet.
  await $.tool.check({ tool: 'Bash', input: { command: 'make' }, tool_use_id: 'd2' } as never)
  await clock.advance(10_000)
  expect(w.toasts.length).toBe(1)
})

test('/attention grace and the config files set the grace and subagent switch', async ($, on) => {
  const { w, clock } = world(on, { files: { '/home/tester/.claude/attention.json': { permissionGraceMs: 1000, includeSubagents: true, permissionSignal: 'grace' } } })
  await start($)
  expect(await text($)).toContain('signal grace · grace 1s · subagent asks on')
  const r = await $.command.run({ command: 'attention', args: 'grace 8s' })
  expect(r.text).toBe('A permission ask notifies after 8s unanswered.')
  expect(w.saved.get('settings')).toEqual({ permissionGraceMs: 8000 })
  await $.tool.check({ tool: 'Bash', input: { command: 'x' }, tool_use_id: 'g1' } as never)
  await clock.advance(7_000)
  expect(w.toasts).toEqual([])
  await clock.advance(1_000)
  expect(w.toasts).toEqual(['Claude needs your OK: Bash'])
  expect((await $.command.run({ command: 'attention', args: 'grace soon' })).text).toBe('Use /attention grace <ms>, such as 4000 or 4s.')
})

test('an approved long-running tool (progress drawn within the grace) raises no wait though its call stays open', async ($, on) => {
  let release = () => {}
  const hold = new Promise<void>(r => {
    release = r
  })
  const { w, clock } = world(on, { hold, settings: { permissionSignal: 'grace' } })
  await start($)
  const call = $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'long1' } as never)
  await $.tool.check({ tool: 'Bash', input: { command: 'npm test' }, tool_use_id: 'long1' } as never)
  await clock.advance(2_000)
  const ui = await $.ui.mount({
    plugin: 'lk-attention',
    component: 'ToolProgress',
    requestId: 'long1',
    surface: 'terminal',
    props: { tool_use_id: 'long1', kind: 'background_hint', text: '(ctrl+b to run in background)' },
  } as never)
  await ui.unmount()
  await clock.advance(120_000)
  expect(w.toasts).toEqual([])
  expect((await band($)).text).toBe(null)
  release()
  await call
})

test('default dialog mode: a bare ask raises nothing; a shown dialog raises at once and its call clears it', async ($, on) => {
  let release = () => {}
  const hold = new Promise<void>(r => {
    release = r
  })
  const { w, clock } = world(on, { hold })
  on('classic.PermissionRequest', () => ({}))
  await start($)
  expect(await text($)).toContain('signal dialog')
  const call = $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'dlg1' } as never)
  await $.tool.check({ tool: 'Bash', input: { command: 'npm test' }, tool_use_id: 'dlg1' } as never)
  await clock.advance(120_000)
  expect(w.toasts).toEqual([])
  expect((await band($)).text).toBe(null)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' } } as never)
  await clock.settle()
  expect(w.toasts).toEqual(['Claude needs your OK: Bash'])
  expect((await band($)).text).toBe('attention ● 1 waiting: permission (Bash)')
  release()
  await call
  expect((await band($)).text).toBe(null)
})

test('/attention signal switches modes and the config files can set it', async ($, on) => {
  const { w, clock } = world(on, { files: { '/work/.claude/attention.json': { permissionSignal: 'grace' } } })
  await start($)
  expect(await text($)).toContain('signal grace')
  expect((await $.command.run({ command: 'attention', args: 'signal maybe' })).text).toBe('Use /attention signal dialog or /attention signal grace.')
  const r = await $.command.run({ command: 'attention', args: 'signal dialog' })
  expect(r.text).toBe('Permission waits notify only when a dialog is shown.')
  expect(w.saved.get('settings')).toEqual({ permissionSignal: 'dialog' })
  await $.tool.check({ tool: 'Bash', input: { command: 'x' }, tool_use_id: 's1' } as never)
  await clock.advance(10_000)
  expect(w.toasts).toEqual([])
})
