import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const CWD = '/work'
const HOME = '/home/tester'
const BRAIN = '/work/.claude/brain'

const GOOD = `## Status
The verifier works and 12 tests pass.

## Next steps
- Wire the verifier into the webhook route.

## Dead ends
- HMAC over the parsed body; use the raw body.

## Open questions
- None.

## Decisions
- Raw-body HMAC, see docs/adr/0004.md

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

type Opts = {
  ctx?: number
  files?: Record<string, string>
  store?: Record<string, unknown>
  fork?: string | null
  complete?: string | null
  answer?: string
  messages?: unknown[]
}

type World = {
  ctx: { percent: number }
  files: Map<string, string>
  saved: Map<string, unknown>
  toasts: string[]
  commands: string[]
  prompts: string[]
  asks: string[]
  ran: string[]
  forks: number
  completes: number
  order: string[]
  clock: ReturnType<typeof mock.clock>
}

const MSGS = [
  { role: 'user', text: 'finish the webhook verifier', toolUses: [] },
  { role: 'assistant', text: 'The verifier is done; wiring is next.', toolUses: [{ tool: 'Edit', input: { file_path: '/work/src/verify.ts' }, result: 'ok' }] },
]

function world(on: On, o: Opts = {}): World {
  const w: World = {
    ctx: { percent: o.ctx ?? 41 },
    files: new Map(Object.entries(o.files ?? {})),
    saved: new Map(Object.entries(o.store ?? {})),
    toasts: [],
    commands: [],
    prompts: [],
    asks: [],
    ran: [],
    forks: 0,
    completes: 0,
    order: [],
    clock: mock.clock(on, { now: new Date(2026, 9, 9, 14, 2).getTime() }),
  }
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
    w.order.push('write ' + e.path.replace(BRAIN + '/', ''))
    return { value: undefined }
  })
  on('env.get', () => ({ value: HOME }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.usage', () => ({
    value: { context: { tokens: w.ctx.percent * 2000, window: 200_000, percent: w.ctx.percent }, rateLimits: [] },
  }))
  on('session.messages', () => ({ value: o.messages ?? MSGS }))
  on('process.run', ($, e) => {
    const argv = e.argv.join(' ')
    if (argv.includes('rev-parse')) return { value: { exitCode: 0, stdout: 'main\n', stderr: '' } }
    if (argv.includes('log')) return { value: { exitCode: 0, stdout: 'abc1234 add webhook verifier\ndef5678 scaffold', stderr: '' } }
    return { value: { exitCode: 1, stdout: '', stderr: '' } }
  })
  on('model.fork', () => {
    w.forks += 1
    if (o.fork === null || o.fork === undefined) return { value: { isAnswered: false, reason: 'nothing-to-fork' } }
    return { value: { isAnswered: true, text: o.fork, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('model.complete', () => {
    w.completes += 1
    if (o.complete === null || o.complete === undefined) return { value: { isAnswered: false, reason: 'empty-reply' } }
    return { value: { isAnswered: true, text: o.complete, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('command.register', () => ({ value: undefined }))
  on('command.run', ($, e) => {
    w.commands.push(e.command)
    w.order.push('command ' + e.command)
    return {}
  })
  on('prompt.submit', ($, e) => {
    w.prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('tool.call', ($, e) => {
    if (e.tool === 'AskUserQuestion') {
      const q = e.questions[0]
      w.asks.push(q.question)
      return { result: { answers: { [q.question]: o.answer ?? 'Handoff now' } } }
    }
    w.ran.push(e.tool)
    return { result: 'ran' }
  })
  on('session.start', () => ({ cwd: CWD }))
  on('classic.SessionStart', () => ({}))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.compact', ($, e) => {
    w.order.push('compact')
    return { messages: e.messages }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'ok' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return w
}

async function start($: Engine) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: CWD })
}

async function complete($: Engine) {
  await $.turn.complete({ turnId: 't', answer: 'done', durationMs: 10, isAborted: false, usage: null })
}

async function step($: Engine, index: number) {
  const stream = $.turn.step({ turnId: 't', index, model: 'claude-test', messageCount: 3 })
  let s = await stream.next()
  const pieces: unknown[] = []
  while (s.done !== true) {
    pieces.push(s.value)
    s = await stream.next()
  }
  return { result: s.value as { answer: string; stopReason: string }, pieces }
}

/** Lets fire-and-forget calls ($.command.run, $.prompt.submit) reach their stubs. */
async function settle(w: World) {
  for (let i = 0; i < 5; i++) await w.clock.advance(100)
  for (let i = 0; i < 20; i++) await w.clock.settle()
}

async function bandText($: Engine): Promise<string> {
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const flat = (n: unknown): string => {
    if (typeof n === 'string') return n
    if (!n || typeof n !== 'object') return ''
    const kids = (n as { children?: unknown[]; props?: { children?: unknown[] } }).children ?? (n as { props?: { children?: unknown[] } }).props?.children ?? []
    return (Array.isArray(kids) ? kids : [kids]).map(flat).join('')
  }
  const found = await ui.find({ key: 'handoff-guard-band' })
  await ui.unmount()
  // The kit line's Text nodes, one space apart: `handoff ● ctx 41% last 14:02`.
  const texts = (n: unknown): string[] => {
    if (!n || typeof n !== 'object') return []
    const node = n as { type?: string; children?: unknown[] }
    if (node.type === 'Text') return [flat(node)]
    return (node.children ?? []).flatMap(texts)
  }
  return texts(found).join(' ')
}

test('band: an ok chip below warnAt, a warn chip plus one toast at warnAt, danger at handoffAt in off mode', async ($, on) => {
  const w = world(on, { ctx: 41, store: { settings: { mode: 'off' } } })
  await start($)
  expect(await bandText($)).toContain('handoff ● ctx 41%')
  expect(w.toasts).toEqual([])
  w.ctx.percent = 72
  await complete($)
  expect(await bandText($)).toContain('handoff ● ctx 72% /handoff at a stopping point')
  expect(w.toasts).toEqual(['context 72%: run /handoff when you reach a stopping point'])
  w.ctx.percent = 74
  await complete($)
  expect(w.toasts.length).toBe(1)
  w.ctx.percent = 90
  await complete($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const chip = await ui.find({ type: 'Text', text: '● ctx 90%' })
  expect(chip && chip.props.color).toBe('error')
  await ui.unmount()
  // Off mode: no question, no handoff.
  expect(w.asks).toEqual([])
  expect(w.commands).toEqual([])
})

test('ask mode, "Handoff now": writes the brain files, then clears', async ($, on) => {
  const w = world(on, { ctx: 86, fork: GOOD, answer: 'Handoff now' })
  await start($)
  await complete($)
  await settle(w)
  expect(w.asks).toEqual(['Context at 86%. Write the handoff and clear now?'])
  const project = w.files.get(BRAIN + '/project.md') ?? ''
  expect(project).toContain('## Status today\n\nThe verifier works and 12 (unverified) tests pass.')
  expect(project).toContain('## Next\n\n- Wire the verifier into the webhook route.')
  expect(project).toContain('## Dead ends\n\n- HMAC over the parsed body; use the raw body.')
  expect(project).toContain('updated: 2026-10-09')
  expect(w.files.get(BRAIN + '/log.md')).toContain('- 2026-10-09 — Added the webhook verifier. Next: wire it into the route.')
  expect(w.files.get(BRAIN + '/decisions.md')).toContain('- 2026-10-09 — Raw-body HMAC, see docs/adr/0004.md')
  expect(w.files.has(BRAIN + '/questions.md')).toBe(false)
  expect(w.forks).toBe(1)
  expect(w.completes).toBe(0)
  expect(w.commands).toEqual(['clear'])
  expect(w.order.indexOf('command clear')).toBeGreaterThan(w.order.indexOf('write project.md'))
  expect(w.toasts.some(t => t.startsWith('Handoff written: .claude/brain/project.md'))).toBe(true)
  expect((w.saved.get('pending:/work') as { when: string }).when).toBe('2026-10-09 14:02')
})

test('ask mode, "Later": no handoff now, asks again at 92%, then stops asking', async ($, on) => {
  const w = world(on, { ctx: 86, answer: 'Later (ask at 92%)' })
  await start($)
  await complete($)
  expect(w.asks.length).toBe(1)
  w.ctx.percent = 88
  await complete($)
  expect(w.asks.length).toBe(1)
  w.ctx.percent = 93
  await complete($)
  expect(w.asks.length).toBe(2)
  w.ctx.percent = 97
  await complete($)
  expect(w.asks.length).toBe(2)
  expect(w.commands).toEqual([])
  expect(w.files.size).toBe(0)
})

test('ask mode, "Off this session": no more questions this session', async ($, on) => {
  const w = world(on, { ctx: 86, answer: 'Off this session' })
  await start($)
  await complete($)
  w.ctx.percent = 95
  await complete($)
  expect(w.asks.length).toBe(1)
  expect(w.commands).toEqual([])
  expect(w.toasts.some(t => t.includes('off for this session'))).toBe(true)
})

test('auto mode: hands off without asking, clears, and seeds the fresh session after /clear', async ($, on) => {
  const w = world(on, { ctx: 87, store: { settings: { mode: 'auto' } }, fork: GOOD })
  await start($)
  await complete($)
  await settle(w)
  expect(w.asks).toEqual([])
  expect(w.commands).toEqual(['clear'])
  expect(w.files.has(BRAIN + '/project.md')).toBe(true)
  // The engine runs /clear: $.state resets and classic.SessionStart fires with source clear.
  w.ctx.percent = 4
  await $.classic.SessionStart({ source: 'clear', cwd: CWD, session_id: 'session-2', hook_event_name: 'SessionStart' } as never)
  await settle(w)
  expect(w.prompts).toEqual(['Resume from the handoff in .claude/brain/project.md (written 2026-10-09 14:02); read it first.'])
  expect(w.saved.has('pending:/work')).toBe(false)
  // A second clear does not seed again.
  await $.classic.SessionStart({ source: 'clear', cwd: CWD } as never)
  await settle(w)
  expect(w.prompts.length).toBe(1)
})

test('auto mode mid-turn: turn.step ends the turn and hands off; past 95% tool calls are refused', async ($, on) => {
  const w = world(on, { ctx: 50, store: { settings: { mode: 'auto' } }, complete: GOOD })
  await start($)
  w.ctx.percent = 96
  const out = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect('deny' in out && String(out.deny)).toContain('[handoff-guard] Not run')
  expect(w.ran).toEqual([])
  const { result } = await step($, 2)
  await settle(w)
  expect(result.answer).toBe('')
  expect(result.stopReason).toBe('end_turn')
  expect(w.forks).toBe(1)
  expect(w.completes).toBe(1)
  expect(w.commands).toEqual(['clear'])
  expect(w.files.get(BRAIN + '/project.md')).toContain('Wire the verifier')
})

test('turn.step at the first request of a turn only measures', async ($, on) => {
  const w = world(on, { ctx: 90, store: { settings: { mode: 'auto' } } })
  await start($)
  const { result } = await step($, 0)
  expect(result.answer).toBe('ok')
  expect(w.commands).toEqual([])
})

test('compact interception writes the handoff first, then lets compaction run', async ($, on) => {
  const w = world(on, { ctx: 60, fork: GOOD })
  await start($)
  const r = await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
  expect('skip' in (r as object)).toBe(false)
  expect(w.order[0]).toBe('write project.md')
  expect(w.order[w.order.length - 1]).toBe('compact')
  expect(w.commands).toEqual([])
})

test('compact after a /handoff in the same session does not write again', async ($, on) => {
  const w = world(on, { ctx: 60, fork: GOOD })
  await start($)
  await $.command.run({ command: 'handoff', args: '' })
  const writes = w.order.filter(x => x.startsWith('write')).length
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
  expect(w.order.filter(x => x.startsWith('write')).length).toBe(writes)
  expect(w.order[w.order.length - 1]).toBe('compact')
})

test('facts-only brief when neither model reply has the headings', async ($, on) => {
  const w = world(on, { ctx: 50, fork: 'Sure, here is a summary.', complete: 'Nothing to add.' })
  await start($)
  const out = await $.command.run({ command: 'handoff', args: '' })
  expect(String(out.text)).toContain('(facts)')
  const project = w.files.get(BRAIN + '/project.md') ?? ''
  expect(project).toContain('facts only')
  expect(project).toContain('abc1234 add webhook verifier')
  expect(project).toContain('Last request: "finish the webhook verifier"')
  expect(w.files.get(BRAIN + '/log.md')).toContain('— (handoff-guard, facts only) Handed off at 50% context')
  expect(w.commands).toEqual([])
})

test('an existing project.md keeps its other sections and frontmatter', async ($, on) => {
  const existing = '---\ntype: project\nname: "demo"\nupdated: 2026-10-01\n---\n\n## What it is\n\nA toolkit.\n\n## Status today\n\nOld.\n\n## Next\n\n- old step\n\n## Milestones\n\n- M1\n'
  const w = world(on, { ctx: 50, fork: GOOD, files: { [BRAIN + '/project.md']: existing, [BRAIN + '/log.md']: '# Log\n\n- 2026-10-08 — before.\n' } })
  await start($)
  await $.command.run({ command: 'handoff', args: '' })
  await $.command.run({ command: 'handoff', args: '' })
  const project = w.files.get(BRAIN + '/project.md') ?? ''
  expect(project).toContain('name: "demo"')
  expect(project).toContain('## What it is\n\nA toolkit.')
  expect(project).toContain('## Milestones\n\n- M1')
  expect(project).not.toContain('Old.')
  // Two handoffs in one session leave one log line for it.
  const log = w.files.get(BRAIN + '/log.md') ?? ''
  expect(log.split('\n').filter(l => l.startsWith('- 2026-10-09')).length).toBe(1)
  expect(log).toContain('- 2026-10-08 — before.')
})

test('/handoff commands: status, mode, at, warn, band, show, clear, help', async ($, on) => {
  const w = world(on, { ctx: 41, fork: GOOD, files: { [HOME + '/.claude/handoff-guard.json']: '{"warnAt": 0.6}' } })
  await start($)
  let out = await $.command.run({ command: 'handoff', args: 'status' })
  expect(String(out.text)).toContain('Context 41%')
  expect(String(out.text)).toContain('warn 60%')
  expect(String(out.text)).toContain('Last handoff: none')
  out = await $.command.run({ command: 'handoff', args: 'mode auto' })
  expect(out.text).toBe('Mode set to auto.')
  out = await $.command.run({ command: 'handoff', args: 'mode loud' })
  expect(out.text).toBe('Mode must be ask, auto or off.')
  out = await $.command.run({ command: 'handoff', args: 'at 0.8' })
  expect(out.text).toBe('Warning at 60%, handoff at 80%.')
  out = await $.command.run({ command: 'handoff', args: 'warn 50%' })
  expect(out.text).toBe('Warning at 50%, handoff at 80%.')
  expect(w.saved.get('settings')).toEqual({ mode: 'auto', handoffAt: 0.8, warnAt: 0.5 })
  out = await $.command.run({ command: 'handoff', args: 'band off' })
  expect(out.text).toBe('Band hidden.')
  expect(await bandText($)).toBe('')
  await $.command.run({ command: 'handoff', args: 'band on' })
  out = await $.command.run({ command: 'handoff', args: 'show' })
  expect(out).toEqual({})
  out = await $.command.run({ command: 'handoff', args: 'clear' })
  await settle(w)
  expect(String(out.text)).toContain('Clearing')
  expect(w.commands).toEqual(['clear'])
  out = await $.command.run({ command: 'handoff', args: 'status' })
  expect(String(out.text)).toContain('Last handoff: 2026-10-09 14:02 (fork) at /work/.claude/brain/project.md')
  out = await $.command.run({ command: 'handoff', args: 'what' })
  expect(String(out.text)).toContain('/handoff clear')
})

test('pane shows the last brief and the readings', async ($, on) => {
  const w = world(on, { ctx: 72, fork: GOOD })
  await start($)
  await complete($)
  await $.command.run({ command: 'handoff', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Context 72%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'LAST HANDOFF' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2026-10-09 14:02' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '● fork' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()
  await ui.unmount()
  expect(w.files.size).toBeGreaterThan(0)
})

test('a queued resume is picked up on load when the clear signal was missed', async ($, on) => {
  const at = new Date(2026, 9, 9, 14, 1).getTime()
  const w = world(on, { ctx: 3, messages: [], store: { 'pending:/work': { at, when: '2026-10-09 14:01', path: BRAIN + '/project.md', from: 'old' } } })
  await start($)
  await settle(w)
  expect(w.prompts).toEqual(['Resume from the handoff in .claude/brain/project.md (written 2026-10-09 14:01); read it first.'])
  expect(await bandText($)).toContain('resumed from handoff')
})

test('edits seen on tool.call reach the facts', async ($, on) => {
  const w = world(on, { ctx: 50, messages: [] })
  await start($)
  await $.tool.call({ tool: 'Write', file_path: '/work/src/new.ts', content: 'x' })
  await $.command.run({ command: 'handoff', args: '' })
  expect(w.ran).toEqual(['Write'])
  expect(w.files.get(BRAIN + '/project.md')).toContain('src/new.ts')
})
