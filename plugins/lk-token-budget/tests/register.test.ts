import type { CommandRunInput, On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

type World = {
  saved: Map<string, unknown>
  toasts: string[]
  closed: string[]
  opened: string[]
  pending: { usage: Usage | null }
  ran: string[]
  spawned: number
}

const BAND = {
  plugin: 'lk-token-budget',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 118, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const

const PANE = {
  plugin: 'lk-token-budget',
  component: 'Pane',
  requestId: 'token-budget',
  viewport: { columns: 120, rows: 40 },
  props: {
    title: 'Token budget',
    isFocused: true,
    bodyColumns: 100,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

function usage(input: number, output = 0, cacheRead = 0, cacheWrite = 0, model = 'claude-test'): Usage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    model,
  }
}

/** Stubs everything the mod asks of Claude Code. Call before the first $ call. */
function world(on: On, opts: { settings?: unknown; project?: unknown; ctx?: number } = {}): World {
  const w: World = { saved: new Map(), toasts: [], closed: [], opened: [], pending: { usage: null }, ran: [], spawned: 0 }
  if (opts.settings !== undefined) w.saved.set('settings', opts.settings)
  on('store.get', ($, e) => ({ value: w.saved.get(e.key) }))
  on('store.set', ($, e) => {
    w.saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: opts.project !== undefined && e.path.endsWith('.claude/token-budget.json') }))
  on('fs.read', () => ({ value: JSON.stringify(opts.project ?? {}) }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 82_000, window: 200_000, percent: opts.ctx ?? 41 }, rateLimits: [] },
  }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
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
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', ($, e) => {
    w.ran.push(e.tool)
    return { result: 'ran' }
  })
  on('agent.spawn', () => {
    w.spawned += 1
    return { model: 'claude-test' }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'ok' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: w.pending.usage }
  })
  return w
}

async function start($: Engine) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

/** Fires one model request whose response reports `u`, as the main loop or a subagent. */
async function step($: Engine, w: World, u: Usage | null, agentId?: string) {
  w.pending.usage = u
  const input = { turnId: 't', index: 0, model: 'claude-test', messageCount: 1, ...(agentId ? { agentId } : {}) }
  const stream = $.turn.step(input)
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
  return s.value
}

/** A /budget command input as the composer sends it. */
function cmd(args: string): CommandRunInput {
  return { command: 'budget', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } }
}

async function complete($: Engine, agentId?: string) {
  await $.turn.complete({
    turnId: 't',
    answer: 'done',
    durationMs: 10,
    isAborted: false,
    reason: 'answer',
    ...(agentId ? { agentId } : {}),
  })
}

async function text($: Engine): Promise<string> {
  const r = await $.command.run(cmd('text'))
  return String(r.text ?? '')
}

type Found = { props: Record<string, unknown>; children: unknown[] } | undefined

async function bandLine($: Engine) {
  // The band is a kit line: the bold label, then the budget chip `● ▰▱▱▱ used / limit n%` in the level's tone.
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const label = (await ui.find({ type: 'Text', text: /^budget$/ })) as Found
  const head = (await ui.find({ type: 'Text', text: /^● [▰▱]/ })) as Found
  const cache = (await ui.find({ type: 'Text', text: /^● cache / })) as Found
  const right = (await ui.find({ type: 'Text', text: /^main / })) as Found
  await ui.unmount()
  return { label, head, cache, right }
}

test('accumulates main and subagent requests from turn.step', async ($, on) => {
  const w = world(on)
  await start($)
  await step($, w, usage(1000, 200, 5000, 300, 'opus'))
  await step($, w, usage(400, 100, 0, 0, 'sonnet'), 'agent-a')
  await step($, w, null)
  await complete($)
  const out = await text($)
  expect(out).toContain('budget ▱▱▱▱▱▱▱▱ 2k / 2.0M 0% · main 2k · agents 500')
  expect(out).toContain('By model: opus 2k, sonnet 500')
  expect(out).toContain('Top agents: agent-a 500')
  expect(out).toContain('2 requests · 1 turns')
  expect(out).toContain('cache reads 5k (not counted)')
  expect(out).toContain('ctx 41%')
})

test('counts cache reads only when countCacheReads is on', async ($, on) => {
  const w = world(on, { project: { countCacheReads: true } })
  await start($)
  await step($, w, usage(1000, 0, 9000, 0))
  const out = await text($)
  expect(out).toContain('budget ▱▱▱▱▱▱▱▱ 10k / 2.0M')
  expect(out).toContain('(counted)')
})

test('cache reads are left out by default', async ($, on) => {
  const w = world(on)
  await start($)
  await step($, w, usage(1000, 0, 9000, 0))
  expect(await text($)).toContain('budget ▱▱▱▱▱▱▱▱ 1k / 2.0M')
})

test('the warn threshold turns the band\'s budget chip warn and toasts once', async ($, on) => {
  const w = world(on, { settings: { session: 10_000 } })
  await start($)
  await step($, w, usage(5000))
  const first = await bandLine($)
  expect(first.label?.props.bold).toBe(true)
  expect(first.head?.props.color).toBe('success')
  expect(w.toasts).toEqual([])
  await step($, w, usage(3500))
  expect((await bandLine($)).head?.props.color).toBe('warning')
  await step($, w, usage(100))
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toContain('85% of the session budget used')
})

test('over budget turns the band\'s budget chip danger and warn mode toasts on each turn.complete', async ($, on) => {
  const w = world(on, { settings: { session: 1000 } })
  await start($)
  await step($, w, usage(1500))
  expect((await bandLine($)).head?.props.color).toBe('error')
  const before = w.toasts.length
  await complete($)
  await complete($)
  expect(w.toasts.length).toBe(before + 2)
})

test('deny-agents allows a spawn before the budget is spent and denies it after', async ($, on) => {
  const w = world(on, { settings: { session: 1000, action: 'deny-agents' } })
  await start($)
  const spawn = { tool_use_id: 'tu1', prompt: 'p', description: 'd', subagentType: 'general-purpose' }
  const allowed = await $.agent.spawn(spawn as never)
  expect(allowed.deny).toBeUndefined()
  expect(w.spawned).toBe(1)
  await step($, w, usage(1200))
  const denied = await $.agent.spawn(spawn as never)
  expect(denied.deny).toBe(
    'token-budget: session budget spent (1k of 1k). No new subagents; finish with what you have, or the user can raise it with /budget set <n>.',
  )
  expect(w.spawned).toBe(1)
  // Tool calls still run under deny-agents.
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(r.deny).toBeUndefined()
})

test('stop denies every tool call except the mod’s own tools', async ($, on) => {
  const w = world(on, { settings: { session: 1000, action: 'stop' } })
  await start($)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
  await step($, w, usage(1000))
  const r = await $.tool.call({ tool: 'Read', file_path: 'README.md' })
  expect(r.deny).toBe(
    'token-budget: session budget spent (1k of 1k). Stop and report to the user; they can run /budget set <n> or /budget action warn to continue.',
  )
  const own = await $.tool.call({ tool: 'mcp__lk-token-budget__status' } as never)
  expect(own.deny).toBeUndefined()
  expect(w.ran).toEqual(['Bash', 'mcp__lk-token-budget__status'])
})

test('/budget off counts but never enforces', async ($, on) => {
  const w = world(on, { settings: { session: 1000, action: 'stop' } })
  await start($)
  await $.command.run(cmd('off'))
  await step($, w, usage(5000))
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
  expect(await text($)).toContain('enforcement off')
})

test('the per-agent limit denies only that agent', async ($, on) => {
  const w = world(on, { settings: { perAgent: 1000 } })
  await start($)
  await step($, w, usage(1500), 'greedy')
  await step($, w, usage(200), 'modest')
  await step($, w, usage(5000))
  const greedy = await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'greedy' } as never)
  expect(greedy.deny).toBe('token-budget: this subagent used 2k tokens (limit 1k); wrap up and return your result now.')
  const modest = await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'modest' } as never)
  expect(modest.deny).toBeUndefined()
  const main = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(main.deny).toBeUndefined()
})

test('reset clears the counts and keeps the lifetime total', async ($, on) => {
  const w = world(on)
  await start($)
  await step($, w, usage(3000), 'a')
  await complete($)
  expect(w.saved.get('lifetime:/work')).toBe(3000)
  const r = await $.command.run(cmd('reset'))
  expect(r.text).toContain('reset')
  const out = await text($)
  expect(out).toContain('budget ▱▱▱▱▱▱▱▱ 0 / 2.0M 0% · main 0 · agents 0')
  expect(out).toContain('Lifetime in this project: 3k')
})

test('the pane Reset button clears and Close closes', async ($, on) => {
  const w = world(on)
  await start($)
  await step($, w, usage(7000, 0, 0, 0, 'opus'))
  await $.command.run(cmd(''))
  expect(w.opened).toEqual(['token-budget'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /opus/ })).toBeDefined()
  await ui.press({ key: 'reset' })
  await ui.press({ key: 'close' })
  expect(w.closed).toEqual(['token-budget'])
  await ui.unmount()
  expect(await text($)).toContain('budget ▱▱▱▱▱▱▱▱ 0 / 2.0M')
})

type Node = { type: string; props: Record<string, unknown>; children: unknown[] }
const textOf = (n: unknown): string =>
  typeof n === 'string' ? n : n && typeof n === 'object' ? ((n as Node).children ?? []).map(textOf).join('') : ''

test('the pane is a page: the tiles, one tight block per section and the buttons, one row apart', async ($, on) => {
  const w = world(on)
  await start($)
  await step($, w, usage(7000, 0, 0, 0, 'opus'))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const root = (await ui.drawn()) as Node
    expect(root.props).toMatchObject({ flexDirection: 'column', rowGap: 1 })
    const blocks = root.children as Node[]
    expect(blocks).toHaveLength(7)
    expect(blocks[0].props).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap', rowGap: 1 })
    // each section is a separate child of the page, its header and rows tight together
    const sections = blocks.slice(1, 6)
    expect(sections.map(b => textOf(b.children[0]))).toEqual([
      expect.stringMatching(/^Budget/),
      expect.stringMatching(/^Prompt cache/),
      expect.stringMatching(/^By model/),
      expect.stringMatching(/^Agents/),
      'Projection',
    ])
    for (const b of sections) {
      expect(b.props.flexDirection).toBe('column')
      expect(b.props.rowGap).toBeUndefined()
      expect(b.children.length).toBeGreaterThan(1)
    }
    expect(textOf(sections[2])).toContain('opus')
    expect(blocks[6].props).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, rowGap: 1 })
    await ui.unmount()
  }
})

test('commands save settings and the band can be turned off', async ($, on) => {
  const w = world(on)
  await start($)
  expect((await $.command.run(cmd('set 1.5m'))).text).toBe('Session budget set to 1.5M.')
  expect((await $.command.run(cmd('agent 500k'))).text).toBe('Per-agent budget set to 0.5M.')
  expect((await $.command.run(cmd('action deny-agents'))).text).toBe('Action set to deny-agents.')
  expect((await $.command.run(cmd('warn 0.5'))).text).toBe('Warning at 50% of the session budget.')
  expect((await $.command.run(cmd('set lots'))).text).toContain('Not a token count')
  expect(w.saved.get('settings')).toEqual({ session: 1_500_000, perAgent: 500_000, action: 'deny-agents', warnAt: 0.5 })
  expect((await bandLine($)).head).toBeDefined()
  await $.command.run(cmd('band off'))
  expect((await bandLine($)).head).toBeUndefined()
})

test('the project file overrides saved settings', async ($, on) => {
  world(on, { project: { session: '3m' } })
  await start($)
  const r = await $.command.run(cmd('set 1m'))
  expect(r.text).toBe('Session budget saved as 1.0M, but .claude/token-budget.json overrides it: 3.0M.')
})

test('band text matches the documented format', async ($, on) => {
  const w = world(on, { ctx: 41 })
  await start($)
  await step($, w, usage(900_000))
  await step($, w, usage(300_000), 'agent-x')
  await complete($)
  const { label, head, cache, right } = await bandLine($)
  expect(label?.children).toEqual(['budget'])
  expect(head?.children).toEqual(['● ▰▰▰▰▱▱▱▱ 1.2M / 2.0M 60%'])
  expect(head?.props).toMatchObject({ color: 'success', bold: true })
  expect(String(cache?.children[0])).toMatch(/^● cache warm \d+:\d\d left$/)
  // the quiet right side: main, agents, ctx, then the cache's cold-resend cost when the model is priced
  expect(String(right?.children[0])).toMatch(/^main 0\.9M · agents 0\.3M · ctx 41%/)
  expect(right?.props.color).toBe('inactive')
})

test('a second session.start for the same session (a hot reload) keeps the counts', async ($, on) => {
  const w = world(on)
  await start($)
  await step($, w, usage(4000))
  await start($)
  expect(await text($)).toContain('budget ▱▱▱▱▱▱▱▱ 4k / 2.0M')
})
