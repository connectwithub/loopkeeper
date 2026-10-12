// 0.4.0: the Agents cards (hooks/pane.ts): price table and cost, effort, TodoWrite progress,
// ctx %, session tiles, the cards on both surfaces with Collapse, Planned, view switching and
// the band. 0.5.0: the critter avatar, effort word, step line and bar; the view reset; band chips.
import { expect, test } from 'claude-code/testing'

import { money } from '../hooks/kit'
import { critterSvg, effortLook } from '../hooks/format'
import { applySpawn, applyStep, blankAgent, spawnFacts, todoOf } from '../hooks/model'
import { barRatio, ctxRatio, modelLabel, modelLine, progressText, roleOf, sessionTotals, statsText, stepText } from '../hooks/pane'
import { PRICES, costUsd, mergePrices, priceOf } from '../hooks/prices'
import { BAND, PANE, complete, setup, spawn, start, usage } from './fixtures'
import type { Usage, World } from './fixtures'

const SURFACES = ['terminal', 'desktop'] as const
/** Equal to a billionth of a dollar (float sums). */
const near = (x: number | null | undefined, y: number) => typeof x === 'number' && Math.abs(x - y) < 1e-9
const cmd = async ($: any, args: string) => (await $.command.run({ command: 'agent-map', args })).text as string

/** fixtures.step with the request's effort on the turn.step input. */
async function stepWith($: any, world: World, agentId: string, u: Usage, effort?: string) {
  world.usages.set(agentId, u)
  const input: Record<string, unknown> = { turnId: 't-' + agentId, index: 0, model: u.model, messageCount: 1, agentId }
  if (effort) input.effort = effort
  const stream = $.turn.step(input)
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
  return s.value
}

/** A 1M-token session window, so ctx % reads against it. */
function window1M(on: any) {
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 1_000_000, percent: 0 }, rateLimits: [] } }))
}

const TODOS = [
  { content: 'Plan the form', status: 'completed', activeForm: 'Planning the form' },
  { content: 'Write the fields', status: 'completed', activeForm: 'Writing the fields' },
  { content: 'Validate input', status: 'completed', activeForm: 'Validating input' },
  { content: 'Style it', status: 'completed', activeForm: 'Styling it' },
  { content: 'Sign up', status: 'in_progress', activeForm: 'Signup' },
]

/** One builder on Sonnet at low effort: 10k in, 1k out, 25k cache read, 5k cache write; 40 s in. */
async function builder($: any, world: World) {
  await start($)
  await spawn($, { toolUseId: 'tu-1', description: 'build the signup form', type: 'general-purpose', model: 'sonnet', background: true })
  await stepWith($, world, 'agent-tu-1', usage(10_000, 1_000, 25_000, 5_000, 'claude-sonnet-4-6'), 'low')
  await $.tool.call({ tool: 'Bash', agentId: 'agent-tu-1', command: 'npm test' })
  await world.clock.advance(40_000)
}

test('priceOf matches the longest family a model id contains; costUsd sums the four rates per million', () => {
  expect(PRICES.length).toBe(9)
  expect(priceOf('claude-opus-5-5')?.family).toBe('opus-5-5')
  expect(priceOf('claude-opus-5')?.family).toBe('opus-5')
  expect(priceOf('claude-opus-4-1')?.family).toBe('opus-4')
  expect(priceOf('claude-sonnet-5-5-20261001')?.family).toBe('sonnet-5-5')
  expect(priceOf('claude-sonnet-4-6')?.family).toBe('sonnet')
  expect(priceOf('claude-haiku-4-5')?.family).toBe('haiku')
  expect(priceOf('claude-fable-5-1[1m]')?.family).toBe('fable-5-1')
  expect(priceOf('CLAUDE-OPUS-4.5')?.family).toBe('opus-4')
  expect(priceOf('gpt-x')).toBe(null)
  expect(priceOf('')).toBe(null)

  expect(costUsd({ input: 1_000_000, output: 0, cacheRead: 0, cacheCreate: 0 }, 'claude-opus-5-5')).toBe(4)
  // 10k×4 + 2k×20 + 100k×0.2 + 5k×8 = 140,000 micro-dollars
  expect(near(costUsd({ input: 10_000, output: 2_000, cacheRead: 100_000, cacheCreate: 5_000 }, 'claude-opus-5-5'), 0.14)).toBe(true)
  expect(near(costUsd({ input: 10_000, output: 1_000, cacheRead: 25_000, cacheCreate: 5_000 }, 'claude-sonnet-4-6'), 0.0825)).toBe(true)
  expect(costUsd({ input: 5, output: 5, cacheRead: 5, cacheCreate: 5 }, 'mystery-model')).toBe(null)
  expect(money(costUsd(undefined, 'mystery-model'))).toBe('—')

  const merged = mergePrices(PRICES, {
    'opus-5-5': [1, 2, 3, 4],
    'My-Model': { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 3 },
    bad: [1, 2],
    worse: { input: -1, output: 2, cacheRead: 0, cacheWrite: 0 },
  })
  expect(priceOf('claude-opus-5-5', merged)).toEqual({ family: 'opus-5-5', input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })
  expect(priceOf('my-model-x', merged)?.family).toBe('my-model')
  expect(priceOf('bad', merged)).toBe(null)
  expect(priceOf('worse', merged)).toBe(null)
  // The table itself is untouched
  expect(priceOf('claude-opus-5-5')?.input).toBe(4)
  expect(mergePrices(PRICES, 'nonsense')).toEqual(PRICES)
})

test('effort comes from the request, else the spawn; context size from the latest request; cost adds up per request', () => {
  const facts = spawnFacts({ tool_use_id: 'tu-1', description: 'd', subagentType: 'Explore', effort: 'high' }, { agentId: 'a1', model: 'claude-haiku-4-5' }, undefined)
  expect(facts.effort).toBe('high')
  let a = applySpawn(blankAgent('a1', 0), facts, 0)
  expect(a.effort).toBe('high')
  a = applyStep(a, usage(1_000, 100, 0, 0, 'claude-haiku-4-5'), undefined, 1, { effort: 'low' })
  expect(a.effort).toBe('low')
  expect(a.lastRequestTokens).toBe(1_000)
  expect(near(a.costUsd, 0.0015)).toBe(true)
  a = applyStep(a, usage(2_000, 0, 8_000, 500, 'claude-haiku-4-5'), undefined, 2, {})
  expect(a.effort).toBe('low')
  expect(a.lastRequestTokens).toBe(10_500)
  expect(near(a.costUsd, 0.0015 + 0.002 + 0.0008 + 0.001)).toBe(true)
  // A model the table lacks leaves the cost where it was
  a = applyStep(a, usage(5_000, 5_000, 0, 0, 'mystery-model'), undefined, 3, {})
  expect(near(a.costUsd, 0.0053)).toBe(true)
  expect(applySpawn(blankAgent('a2', 0), { ...facts, effort: '' }, 0).effort).toBe('')
})

test('todoOf reads a TodoWrite list on the event or its input', () => {
  expect(todoOf({ tool: 'TodoWrite', todos: TODOS })).toEqual({ done: 4, total: 5, current: 'Signup' })
  expect(todoOf({ input: { todos: [{ content: 'Ship it', status: 'in_progress' }, { content: 'x', status: 'pending' }] } })).toEqual({
    done: 0,
    total: 2,
    current: 'Ship it',
  })
  expect(todoOf({ todos: [] })).toBe(null)
  expect(todoOf({ command: 'ls' })).toBe(undefined)
})

test('roles, model labels, progress, ctx % and the session tiles', () => {
  expect(roleOf({ id: 'main' })).toBe('main')
  expect(roleOf({ name: 'Explore', description: 'look around' })).toBe('recon')
  expect(roleOf({ name: 'general-purpose', description: 'search the docs' })).toBe('recon')
  expect(roleOf({ name: 'general-purpose', description: 'verify step 1' })).toBe('verify')
  expect(roleOf({ name: 'general-purpose', description: 'code review of the diff' })).toBe('reviewer')
  expect(roleOf({ name: 'general-purpose', description: 'build it', model: 'claude-opus-5-5' })).toBe('hard')
  expect(roleOf({ name: 'general-purpose', description: 'build it', prompt: '[role:hard] Build step 1', model: 'sonnet' })).toBe('hard')
  expect(roleOf({ name: 'general-purpose', description: 'build it', model: 'claude-sonnet-4-6' })).toBe('execute')

  expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(modelLabel('claude-sonnet-4-20250514')).toBe('Sonnet 4')
  expect(modelLabel('opus')).toBe('Opus')
  expect(modelLabel('')).toBe('?')

  const a = { ...blankAgent('a', 0), isSpawned: true, lastRequestTokens: 8_000, toolCalls: 12, activity: 'Bash: npm test' }
  expect(ctxRatio(a, 200_000)).toBe(0.04)
  expect(ctxRatio(a, 0)).toBe(0.04)
  expect(progressText(a)).toBe('tools 12 · last: Bash npm test')
  expect(progressText({ ...a, todo: { done: 4, total: 5, current: 'Signup' } })).toBe('4/5 · Signup')
  const b = { ...a, tokens: { input: 30_000, output: 5_000, cacheRead: 6_000, cacheCreate: 0 }, costUsd: 0.08 }
  expect(statsText(b, 40_000, 200_000)).toBe('ctx 4% · 41k ≈$0.08 0:40')
  expect(stepText(a)).toBe('12 tools')
  expect(stepText({ ...a, todo: { done: 4, total: 5, current: 'Signup' } })).toBe('4/5 · Signup')
  expect(modelLine({ ...a, model: 'claude-opus-5-5', effort: 'low' })).toBe('Opus 5.5 · low')
  expect(modelLine({ ...a, model: 'claude-opus-5-5', effort: '' })).toBe('Opus 5.5')

  // Spans 0–40 s and 10–50 s overlap; 70–100 s (still running) adds 30 s: 1:20 in all
  const agents = {
    main: blankAgent('main', 0),
    x: { ...blankAgent('x', 0), isSpawned: true, status: 'done' as const, endedAt: 40_000, durationMs: 40_000, tokens: { input: 1_000, output: 0, cacheRead: 0, cacheCreate: 0 }, costUsd: 0.1 },
    y: { ...blankAgent('y', 10_000), isSpawned: true, status: 'done' as const, endedAt: 50_000, durationMs: 40_000, tokens: { input: 2_000, output: 0, cacheRead: 0, cacheCreate: 0 } },
    z: { ...blankAgent('z', 70_000), isSpawned: true, tokens: { input: 0, output: 500, cacheRead: 0, cacheCreate: 0 }, costUsd: 0.05 },
  }
  const t = sessionTotals(agents, 100_000)
  expect(t.timeMs).toBe(80_000)
  expect(t.tokens).toBe(3_500)
  expect(near(t.costUsd, 0.15)).toBe(true)
  expect(t.agents).toBe(3)
  expect(sessionTotals({ main: blankAgent('main', 0) }, 5).costUsd).toBe(0)
})

for (const surface of SURFACES) {
  test('a card draws the critter, effort word, step, stats, bar and status, and Collapse folds the bar (' + surface + ')', async ($, on) => {
    window1M(on)
    const world = setup(on)
    await builder($, world)
    const ui = await $.ui.mount({ ...PANE, surface })
    const desktop = surface === 'desktop'
    const svgs = async () => (await ui.findAll({ type: 'Svg' })) as { props: Record<string, unknown> }[]
    const critter = async (alt: string) => (await svgs()).find(s => s.props.alt === alt)
    expect(await ui.find({ key: 'card-agent-tu-1' })).toBeDefined()
    // The avatar: a critter Svg on the desktop (alt names role and state), the role glyph on the terminal
    if (desktop) {
      const c = await critter('execute running')
      expect(String(c?.props?.source)).toContain('#C96F4A')
      expect(String(c?.props?.source)).toContain('#22A35A')
      expect(c?.props?.width).toBe(44)
      expect(await critter('main running')).toBeDefined()
    } else {
      expect(await ui.find({ type: 'Svg' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: '▣' })).toBeDefined()
    }
    // Header tiles over the session's subagents: single border, no fill
    expect(await ui.find({ type: 'Text', text: 'Cost' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '≈$0.08' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '41k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '0:40' })).toBeDefined()
    const boxes = (await ui.findAll({ type: 'Box' })) as { props: Record<string, unknown> }[]
    expect(boxes.some(b => b.props.backgroundColor !== undefined)).toBe(false)
    expect(boxes.find(b => b.props.borderStyle === 'single')?.props?.borderColor).toBe('inactive')
    // A running card's frame is in the suggestion tone
    expect(boxes.some(b => b.props.borderStyle === 'round' && b.props.borderColor === 'suggestion')).toBe(true)
    // Line 1: the bold task and the status; line 2: effort word in its tone, then model · effort; line 3: step and stats
    expect((await ui.find({ type: 'Text', text: 'build the signup form' }))?.props?.bold).toBe(true)
    expect((await ui.find({ key: 'row-agent-tu-1' }))?.props?.label).toBe('▸')
    expect((await ui.find({ type: 'Text', text: '●' }))?.props?.color).toBe('success')
    expect((await ui.find({ key: 'stop-agent-tu-1' }))?.props?.label).toBe('Stop')
    expect((await ui.find({ type: 'Text', text: 'light' }))?.props?.color).toBe('success')
    expect((await ui.find({ type: 'Text', text: /^Sonnet 4\.6 · low$/ }))?.props?.color).toBe('inactive')
    expect(await ui.find({ type: 'Text', text: /^1 tools$/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^ctx 4% · 41k ≈\$0\.08 0:40$/ }))?.props?.color).toBe('inactive')
    // Line 4: the bar (the only agent is the longest: 100%)
    if (desktop) expect((await svgs()).some(s => s.props.alt === '100%')).toBe(true)
    else expect(await ui.find({ type: 'Text', text: /^━+$/ })).toBeDefined()

    await $.tool.call({ tool: 'TodoWrite', agentId: 'agent-tu-1', todos: TODOS })
    expect(await ui.find({ type: 'Text', text: /^4\/5 · Signup$/ })).toBeDefined()
    if (desktop) expect(String((await svgs()).find(s => s.props.alt === '80%')?.props?.source)).toContain('#22A35A')
    else expect(await ui.find({ type: 'Text', text: ' 80%' })).toBeDefined()

    // The disclosure adds the tools line and the full record
    expect(await ui.find({ type: 'Text', text: /^tools / })).toBeUndefined()
    await ui.press({ key: 'row-agent-tu-1' })
    expect((await ui.find({ key: 'row-agent-tu-1' }))?.props?.label).toBe('▾')
    expect((await ui.find({ type: 'Text', text: /^tools 2 · last: / }))?.props?.color).toBe('inactive')
    await ui.press({ key: 'row-agent-tu-1' })
    expect(await ui.find({ type: 'Text', text: /^tools / })).toBeUndefined()

    await ui.press({ key: 'collapse' })
    expect((await ui.find({ key: 'collapse' }))?.props?.label).toBe('Expand')
    expect(await ui.find({ type: 'Text', text: /^ctx 4% / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /80%/ })).toBeUndefined()
    if (desktop) expect((await svgs()).some(s => s.props.alt === '80%')).toBe(false)
    await ui.press({ key: 'collapse' })
    expect((await ui.find({ key: 'collapse' }))?.props?.label).toBe('Collapse')

    await complete($, 'agent-tu-1', 41_000)
    expect((await ui.find({ type: 'Text', text: '✓' }))?.props?.color).toBe('success')
    expect(await ui.find({ key: 'stop-agent-tu-1' })).toBeUndefined()
    if (desktop) expect(String((await critter('execute done'))?.props?.source)).toContain('opacity="0.8"')
    await ui.unmount()
  })
}

test('the card bar: todo items done over all, full once done without a list, else time over the longest', () => {
  const ran = { ...blankAgent('a', 0), isSpawned: true, durationMs: 20_000 }
  // A finished card without a todo list draws a full bar, not the share of the longest run.
  expect(barRatio({ ...ran, status: 'done' }, 60_000, 40_000)).toBe(1)
  expect(barRatio({ ...ran, status: 'done', todo: { done: 2, total: 4, current: 'x' } }, 60_000, 40_000)).toBe(0.5)
  // A failed card keeps the time it ran; a running one counts up against the longest sibling.
  expect(barRatio({ ...ran, status: 'failed' }, 60_000, 40_000)).toBe(0.5)
  expect(barRatio({ ...blankAgent('b', 0), isSpawned: true }, 10_000, 40_000)).toBe(0.25)
  expect(barRatio({ ...ran, status: 'failed' }, 60_000, 0)).toBe(0)
})

test('ctx % falls back to a 200k window, and a prices override in agent-map.json reprices requests', async ($, on) => {
  const world = setup(on)
  world.files.set('/home/tester/.claude/agent-map.json', JSON.stringify({ prices: { sonnet: [20, 100, 2, 40] } }))
  await builder($, world)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // 40k of 200k is 20%; 10k×20 + 1k×100 + 25k×2 + 5k×40 = $0.55
  expect(await ui.find({ type: 'Text', text: /^ctx 20% · 41k ≈\$0\.55 0:40$/ })).toBeDefined()
})

test('a request at a model the table lacks shows its cost as a dash', async ($, on) => {
  window1M(on)
  const world = setup(on)
  await start($)
  await spawn($, { toolUseId: 'tu-1', description: 'odd one', type: 'general-purpose', model: 'sonnet' })
  await stepWith($, world, 'agent-tu-1', usage(1_000, 0, 0, 0, 'mystery-model-2'))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^ctx 0% · 1k — 0:00$/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^mystery-model-2$/ }))?.props?.color).toBe('inactive')
})

test('the Planned section lists Agent calls not yet spawned; a refused spawn leaves it', async ($, on) => {
  setup(on)
  await start($)
  await cmd($, 'cap concurrent 1')
  await $.tool.call({ tool: 'Agent', tool_use_id: 'tu-p', description: 'review the plan', subagent_type: 'reviewer', model: 'opus', prompt: 'Review it' })
  await spawn($, { toolUseId: 'tu-1', description: 'build it', type: 'general-purpose', model: 'sonnet' })
  const denied = await spawn($, { toolUseId: 'tu-2', description: 'build more', type: 'general-purpose', model: 'sonnet' })
  expect(denied.deny).toContain('concurrency cap reached (1/1)')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'PLANNED · 1' })).toBeDefined()
    expect(await ui.find({ key: 'planned-tu-p' })).toBeDefined()
    expect(await ui.find({ key: 'planned-tu-2' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^review the plan$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'AGENTS · 1' })).toBeDefined()
    await ui.unmount()
  }
})

test('the view buttons switch between cards, tree and team, and the choice is saved', async ($, on) => {
  const world = setup(on)
  await start($)
  await spawn($, { toolUseId: 'tu-1', description: 'lead', type: 'general-purpose', model: 'opus' })
  // Nothing chosen: the pane draws cards, /agent-map text prints the tree
  expect((await cmd($, 'text')).split('\n')[0]).toBe('main (orchestrator) · 0 tok · 1 tools')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'card-agent-tu-1' })).toBeDefined()
  // The shown view's button is primary; none is dimmed
  expect((await ui.find({ key: 'view-cards' }))?.props?.variant).toBe('primary')
  expect((await ui.find({ key: 'view-tree' }))?.props?.variant).toBeUndefined()
  expect(((await ui.findAll({ type: 'Button' })) as { props: Record<string, unknown> }[]).some(b => b.props.dimColor !== undefined)).toBe(false)

  await ui.press({ key: 'view-tree' })
  expect(world.store.get('view2')).toBe('tree')
  expect((await ui.find({ key: 'view-tree' }))?.props?.variant).toBe('primary')
  expect(await ui.find({ key: 'card-agent-tu-1' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '└─ ' })).toBeDefined()
  expect(await ui.find({ key: 'collapse' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Cost' })).toBeDefined()

  await ui.press({ key: 'view-team' })
  expect(await ui.find({ type: 'Text', text: /^team of main: 1 running · 0 done$/ })).toBeDefined()
  await ui.press({ key: 'view-cards' })
  expect(await ui.find({ key: 'card-agent-tu-1' })).toBeDefined()
  expect(world.store.get('view2')).toBe('cards')
  await ui.unmount()

  expect(await cmd($, 'view team')).toBe('Agent map: team view')
  expect((await cmd($, 'text')).split('\n')[0]).toBe('team of main: 1 running · 0 done')
  expect(await cmd($, 'view')).toContain('Usage: /agent-map')
})

for (const [stored, shown] of [[{ view: 'tree' }, 'cards'], [{ view: 'cards', view2: 'team' }, 'team']] as const) {
  test('0.5.0 reads the chosen view from a new key: the old one is ignored, the new one kept (' + shown + ')', async ($, on) => {
    const world = setup(on)
    for (const [k, v] of Object.entries(stored)) world.store.set(k, v)
    await start($)
    await spawn($, { toolUseId: 'tu-1', description: 'lead', type: 'general-purpose', model: 'opus' })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ key: 'card-agent-tu-1' }))[shown === 'cards' ? 'toBeDefined' : 'toBeUndefined']()
    expect((await ui.find({ key: 'view-' + shown }))?.props?.variant).toBe('primary')
    await ui.unmount()
  })
}

test('effort words, and the critter: hat by effort, crown for main, pennant while running, X eyes when failed', () => {
  expect(['low', 'medium', 'high', 'xhigh', 'max', '', '8000'].map(e => effortLook(e).word)).toEqual(['light', 'medium', 'careful', 'thorough', 'max', '', ''])
  expect(['low', 'medium', 'high', 'xhigh', 'max'].map(e => effortLook(e).tone)).toEqual(['ok', 'info', 'accent', 'accent', 'danger'])
  expect(['low', 'medium', 'high', 'xhigh', 'max', ''].map(e => effortLook(e).hat)).toEqual(['#22A35A', '#3B82F6', '#D9901A', '#E5484D', '#E5484D', '#64748B'])
  const idle = critterSvg({ hat: '#3B82F6' })
  const running = critterSvg({ hat: '#3B82F6', state: 'running' })
  const failed = critterSvg({ hat: '#3B82F6', state: 'failed' })
  expect(idle).toContain('fill="#3B82F6"')
  expect(idle).toContain('fill="#1A1A1A"')
  expect(idle).not.toContain('opacity')
  expect(running.length).toBeGreaterThan(idle.length)
  expect(failed).toContain('stroke="#1A1A1A"')
  expect(failed).not.toContain('fill="#1A1A1A"')
  expect(critterSvg({ hat: '#3B82F6', state: 'done' })).toContain('opacity="0.8"')
  expect(critterSvg({ main: true, hat: '#3B82F6' })).toContain('fill="#8B5CF6"')
  expect(critterSvg({ main: true, hat: '#3B82F6' })).not.toContain('#3B82F6')
  expect(critterSvg({ hat: 'red' })).toContain('fill="#64748B"')
  // Hex colors only, no color words
  expect(/fill="[a-z]/i.test(running + failed + idle)).toBe(false)
})

for (const surface of SURFACES) {
  test('the band is one line of unfilled chips: counts, the cap state, tokens on the right (' + surface + ')', async ($, on) => {
    const world = setup(on)
    await builder($, world)
    let ui = await $.ui.mount({ ...BAND, surface })
    const texts = async () => {
      const mine = String((await ui.find({ key: 'agent-map-band' }))?.text ?? '')
      return ((await ui.findAll({ type: 'Text' })) as { text: string; props: Record<string, unknown> }[]).filter(t => t.text && mine.includes(t.text))
    }
    let parts = await texts()
    expect(parts.map(t => t.text)).toEqual(['agents', '● 1/4 running', '✓ 0 done', '✗ 0', '● ok', '41k tok'])
    expect(parts.map(t => t.props.color)).toEqual([undefined, 'suggestion', 'inactive', 'inactive', 'success', 'inactive'])
    expect(parts.some(t => t.props.backgroundColor !== undefined || t.props.dimColor !== undefined)).toBe(false)
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    await ui.unmount()

    await complete($, 'agent-tu-1', 41_000)
    ui = await $.ui.mount({ ...BAND, surface })
    parts = await texts()
    expect(parts.map(t => t.text)).toEqual(['agents', '● 0/4 running', '✓ 1 done', '✗ 0', '● ok', '41k tok'])
    expect(parts[2].props.color).toBe('success')
    await ui.unmount()
  })
}

test('the pane is a page: the header block spaces tiles, buttons and the main line, the cards sit one row apart, the tree and the log stay tight', async ($, on) => {
  setup(on)
  await start($)
  await spawn($, { toolUseId: 'tu-1', description: 'lead', type: 'general-purpose', model: 'opus' })
  await spawn($, { toolUseId: 'tu-2', description: 'second', type: 'general-purpose', model: 'sonnet' })
  type N = { type: string; props: Record<string, any>; children?: unknown[] }
  const kids = (n: N): N[] => ((n.children ?? n.props?.children ?? []) as N[]).filter(c => c && typeof c === 'object')
  const all = (n: N): N[] => [n, ...kids(n).flatMap(all)]
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    let root = (await ui.drawn()) as N
    expect(root.type).toBe('Box')
    expect(root.props).toMatchObject({ flexDirection: 'column', rowGap: 1 })
    // The header block (tiles, buttons, the main line, one row apart), the cards, the caps, the footer buttons
    let [head, body, caps, footer] = kids(root)
    expect(kids(root)).toHaveLength(4)
    expect(head!.props).toMatchObject({ flexDirection: 'column', rowGap: 1 })
    expect(kids(head!).map(n => n.props.key)).toEqual([undefined, undefined, 'main'])
    expect(footer!.props).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, rowGap: 1 })
    // The caps block is tight: its header, one row per cap, the hint
    expect(caps!.props.rowGap).toBeUndefined()
    expect(kids(caps!).map(n => n.props.key)).toEqual([undefined, 'cap-maxConcurrent', 'cap-maxPerTurn', 'cap-maxPerSession', 'cap-warnAt', 'cap-maxReturnedTokens', undefined])
    // The two cards share a parent that puts one row between them; inside a card the rows stay tight
    const parent = all(body!).find(n => kids(n).some(c => c.props?.key === 'card-agent-tu-1'))
    expect(parent?.props).toMatchObject({ flexDirection: 'column', rowGap: 1 })
    expect(kids(parent!).map(c => c.props.key).sort()).toEqual(['card-agent-tu-1', 'card-agent-tu-2'])

    // The tree view, the caps and the log: each one tight block, the main line on top of its tree
    await ui.press({ key: 'view-tree' })
    await ui.press({ key: 'log' })
    root = (await ui.drawn()) as N
    expect(kids(root)).toHaveLength(5)
    ;[head, body] = kids(root)
    expect(kids(head!)).toHaveLength(2)
    for (const block of kids(root).slice(1, 4)) {
      expect(block.props.flexDirection).toBe('column')
      expect(block.props.rowGap).toBeUndefined()
    }
    expect(kids(body!)[0]!.props.key).toBe('line-0')
    // No blank Text spacers: the page makes the gaps
    const textOf = (n: N) => ((n.children ?? n.props.children ?? []) as unknown[]).join('')
    expect(all(root).some(n => n.type === 'Text' && /^log \(last \d+\)$/.test(textOf(n)))).toBe(true)
    expect(all(root).filter(n => n.type === 'Text' && textOf(n) === ' ')).toEqual([])
    await ui.press({ key: 'log' })
    await ui.press({ key: 'view-cards' })
    await ui.unmount()
  }
})

test('the team view is a list of top-level lanes one row apart; each lane is a tight stack, nested lanes and indents kept', async ($, on) => {
  const world = setup(on)
  await start($)
  await spawn($, { toolUseId: 'tu-1', description: 'lead', type: 'general-purpose', model: 'opus' })
  await spawn($, { toolUseId: 'tu-2', description: 'helper a', type: 'Explore', model: 'haiku', caller: 'agent-tu-1' })
  await spawn($, { toolUseId: 'tu-3', description: 'solo', type: 'Plan', model: 'sonnet' })
  await complete($, 'agent-tu-3', 1_000)
  world.list = [{ id: 'tm-1', description: 'reviewer', type: 'teammate', status: 'running' }]
  type N = { type: string; props: Record<string, any>; children?: unknown[] }
  const kids = (n: N): N[] => ((n.children ?? n.props?.children ?? []) as N[]).filter(c => c && typeof c === 'object')
  const all = (n: N): N[] => [n, ...kids(n).flatMap(all)]
  // A row's words: its Texts and the agent's Button label
  const textOf = (n: N): string =>
    all(n).map(c => (c.type === 'Button' ? String(c.props.label) : c.type === 'Text' ? ((c.children ?? c.props.children ?? []) as unknown[]).join('') : '')).join('')
  // The command picks the team view and merges $.agent.list(), so the teammate appears
  expect((await $.command.run({ command: 'agent-map', args: 'team' })).text).toBe('Agent map: team view')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const [, body] = kids((await ui.drawn()) as N)
    // The lanes' parent puts one row between them; each lane's rows stay tight
    expect(body!.props).toMatchObject({ flexDirection: 'column', rowGap: 1 })
    const lanes = kids(body!)
    expect(lanes).toHaveLength(2)
    for (const lane of lanes) {
      expect(lane.props.flexDirection).toBe('column')
      expect(lane.props.rowGap).toBeUndefined()
    }
    // The main line leads the first lane; the nested team of lead stays inside team of main
    expect(kids(lanes[0]!).map(r => r.props.key)).toEqual(['line-0', 'line-1', 'line-2', 'line-3', 'line-4', 'line-5'])
    expect(textOf(kids(lanes[0]!)[1]!)).toBe('team of main: 1 running · 1 done')
    expect(textOf(kids(lanes[0]!)[4]!)).toBe('  team of lead: 1 running · 0 done')
    expect(textOf(kids(lanes[0]!)[5]!)).toMatch(/^ {4}● helper a/)
    expect(kids(lanes[1]!).map(r => r.props.key)).toEqual(['line-6', 'line-7'])
    expect(textOf(kids(lanes[1]!)[0]!)).toBe('teammates: 1 running · 0 done')
    expect(textOf(kids(lanes[1]!)[1]!)).toMatch(/^ {2}● ◇ reviewer/)
    await ui.unmount()
  }
})
