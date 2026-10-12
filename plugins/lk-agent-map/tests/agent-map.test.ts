import { expect, test } from 'claude-code/testing'

import { buildRows, rowText } from '../hooks/format'
import { BAND, PANE, complete, mapText, setup, spawn, start, step, usage } from './fixtures'

/** The band as one string: the Texts of agent-map's line joined by two spaces (the kit line's gap). */
async function bandLine(ui: any): Promise<string> {
  const mine = String((await ui.find({ key: 'agent-map-band' }))?.text ?? '')
  const texts = (await ui.findAll({ type: 'Text' })) as { text: string }[]
  return texts.filter(t => t.text && mine.includes(t.text)).map(t => t.text).join('  ')
}

/** Main asks for one agent, which asks for a nested one; tokens flow through turn.step. */
async function twoAgents($: any, world: any) {
  await start($)
  await step($, world, undefined, usage(1000, 500, 8000, 500, 'claude-opus-4-1'))
  await spawn($, {
    toolUseId: 'tu-1',
    description: 'survey projects across the whole repo',
    type: 'general-purpose',
    model: 'sonnet',
    prompt: 'Look at every project folder and list what each one builds.',
    background: true,
  })
  await step($, world, 'agent-tu-1', usage(20000, 5000, 60000, 0, 'claude-sonnet-4-6'))
  await spawn($, { toolUseId: 'tu-2', description: 'explore', type: 'Explore', model: 'haiku', caller: 'agent-tu-1' })
  for (const tool of ['Read', 'Read', 'Read', 'Bash']) {
    await $.tool.call({ tool, agentId: 'agent-tu-2', file_path: 'x', command: 'ls' })
  }
  await step($, world, 'agent-tu-2', usage(10000, 2000, 0, 0, 'claude-haiku-4-5'))
}

test('the tree nests the explore agent under its caller, with glyphs and token totals', async ($, on) => {
  const world = setup(on)
  await twoAgents($, world)
  await world.clock.advance(20_000)
  await complete($, 'agent-tu-2', 20_000)
  await world.clock.advance(37_000)
  await complete($, 'agent-tu-1', 57_000, 'aborted')

  const text = await mapText($)
  const lines = text.split('\n')
  expect(lines[0]).toBe('main (orchestrator) · 10k tok · 1 tools')
  expect(lines[1]).toBe('└─ ○ survey projects across t  general-purpose  sonnet  00:57  1 tools  85k tok')
  expect(lines[2]).toBe('    └─ ✓ explore  Explore  haiku  00:20  4 tools  12k tok')
  expect(lines.length).toBe(3)
})

test('the first spawn opens the pane once, without focus', async ($, on) => {
  const world = setup(on)
  await twoAgents($, world)
  expect(world.opened.length).toBe(1)
  expect(world.opened[0]).toEqual({ id: 'agent-map', title: 'Agent map' })
})

test('a running agent counts up live on the one-second timer', async ($, on) => {
  const world = setup(on)
  await start($)
  await spawn($, { toolUseId: 'tu-9', description: 'build-x', type: 'general-purpose', model: 'opus' })
  await world.clock.advance(5_000)
  expect(await mapText($)).toContain('├─ ● build-x  general-purpose  opus  00:05  0 tools  0 tok'.replace('├─', '└─'))
  await world.clock.advance(65_000)
  expect(await mapText($)).toContain('● build-x  general-purpose  opus  01:10')
})

test('an API error ends an agent as failed', async ($, on) => {
  const world = setup(on)
  await start($)
  await spawn($, { toolUseId: 'tu-1', description: 'build-x', type: 'general-purpose', model: 'opus' })
  await spawn($, { toolUseId: 'tu-2', description: 'research-docs', type: 'claude-code-guide', model: 'opus' })
  await complete($, 'agent-tu-1', 70_000, 'error')
  const text = await mapText($)
  expect(text).toContain('├─ ✗ build-x  general-purpose  opus  01:10')
  expect(text).toContain('└─ ● research-docs  claude-code-guide  opus')
})

test('the band is hidden until an agent spawns, then shows one line of chips', async ($, on) => {
  const world = setup(on)
  await start($)
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'agent-map-band' })).toBeUndefined()
  await ui.unmount()

  await twoAgents($, world)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await bandLine(ui)).toBe('agents  ● 2/4 running  ✓ 0 done  ✗ 0  ● ok  97k tok')
  expect((await ui.find({ type: 'Text', text: '● 2/4 running' }))?.props.color).toBe('suggestion')
  expect((await ui.find({ type: 'Text', text: '● ok' }))?.props.color).toBe('success')
  await ui.unmount()

  await complete($, 'agent-tu-2', 20_000)
  await complete($, 'agent-tu-1', 57_000, 'aborted')
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await bandLine(ui)).toBe('agents  ● 0/4 running  ✓ 1 done  ✗ 0  ● ok  ○ 1 aborted · 97k tok')
  expect((await ui.find({ type: 'Text', text: '● 0/4 running' }))?.props.color).toBe('inactive')
  expect((await ui.find({ type: 'Text', text: '✓ 1 done' }))?.props.color).toBe('success')
  expect((await ui.find({ type: 'Text', text: /aborted/ }))?.props.color).toBe('inactive')
})

test('/agent-map band off hides the band and saves the switch', async ($, on) => {
  const world = setup(on)
  await twoAgents($, world)
  const r = await $.command.run({ command: 'agent-map', args: 'band off' })
  expect(r.text).toBe('Agent band off')
  expect(world.store.get('band')).toBe(false)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^agents / })).toBeUndefined()
})

test('/agent-map clear removes only finished agents', async ($, on) => {
  const world = setup(on)
  await start($)
  await spawn($, { toolUseId: 'tu-1', description: 'done-one', type: 'Explore', model: 'haiku' })
  await spawn($, { toolUseId: 'tu-2', description: 'still-running', type: 'general-purpose', model: 'sonnet' })
  await spawn($, { toolUseId: 'tu-3', description: 'aborted-one', type: 'Plan', model: 'opus' })
  await complete($, 'agent-tu-1', 1_000)
  await complete($, 'agent-tu-3', 2_000, 'aborted')
  const r = await $.command.run({ command: 'agent-map', args: 'clear' })
  expect(r.text).toBe('Cleared 2 finished agents')
  const text = await mapText($)
  expect(text).toContain('still-running')
  expect(text).not.toContain('done-one')
  expect(text).not.toContain('aborted-one')
})

test('messages between main and agents draw under the sender', async ($, on) => {
  const world = setup(on)
  await twoAgents($, world)
  await $.session.send({ to: 'agent-tu-1', text: 'status?', origin: { kind: 'model' } })
  await $.session.send({ to: 'agent-tu-2', text: 'look in src', origin: { kind: 'model' }, agentId: 'agent-tu-1' })
  const lines = (await mapText($)).split('\n')
  expect(lines[1]).toBe('│   → msg to survey projects across t')
  // A running agent's last activity draws under its row, then its messages
  expect(lines[3]).toBe('    ⋯ Agent: explore')
  expect(lines[4]).toBe('    → msg to explore')
})

test('the pane draws a row button per agent that toggles its details', async ($, on) => {
  const world = setup(on)
  await twoAgents($, world)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'row-agent-tu-1' })).toBeDefined()
  expect(await ui.find({ key: 'row-agent-tu-2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^prompt: Look at every project/ })).toBeUndefined()
  await ui.press({ key: 'row-agent-tu-1' })
  expect(await ui.find({ type: 'Text', text: /^prompt: Look at every project/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^tokens: in 20k · out 5k · cache read 60k · cache write 0$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^tools: Agent 1/ })).toBeDefined()
  await ui.press({ key: 'row-agent-tu-1' })
  expect(await ui.find({ type: 'Text', text: /^prompt: / })).toBeUndefined()
  expect(await ui.find({ key: 'clear' })).toBeDefined()
  expect(await ui.find({ key: 'close' })).toBeDefined()
})

test('the pane keeps every row within bodyColumns', async ($, on) => {
  const world = setup(on)
  await twoAgents($, world)
  await spawn($, {
    toolUseId: 'tu-3',
    description: 'a very long description that goes on and on',
    type: 'general-purpose',
    model: 'claude-sonnet-4-6',
    caller: 'agent-tu-2',
  })
  const narrow = { ...PANE, props: { ...PANE.props, bodyColumns: 50 } }
  const ui = await $.ui.mount({ ...narrow, surface: 'terminal' })
  for (const id of ['agent-tu-1', 'agent-tu-2', 'agent-tu-3']) {
    const b = await ui.find({ key: 'row-' + id })
    expect(b).toBeDefined()
  }
  const text = (await $.command.run({ command: 'agent-map', args: 'text' })).text as string
  expect(text).toContain('└─ ● a very long description  general-purpose  sonnet')
})

test('rows laid out for a narrow pane fit its width', () => {
  const now = 100_000
  const agent = (id: string, parent: string, description: string) => ({
    id, name: 'general-purpose', description, prompt: 'p'.repeat(400), model: 'claude-sonnet-4-6', parent,
    isTeammate: false, isBackground: false, isSpawned: true, startedAt: 0, runStartedAt: 0,
    status: 'running' as const, requests: 1, toolCalls: 3, toolsByName: { Read: 3 }, lastTool: 'Read',
    tokens: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 }, messages: [{ to: 'b', at: 1 }],
  })
  const agents = {
    a: agent('a', 'main', 'a very long description that goes on and on'),
    b: agent('b', 'a', 'nested agent with a long label too'),
    c: agent('c', 'b', 'deeper still'),
  }
  for (const columns of [30, 50, 80]) {
    const rows = buildRows(agents, ['a', 'b', 'c'], { now, columns, expanded: ['a', 'b', 'c'] })
    for (const r of rows) expect(Array.from(rowText(r)).length <= columns).toBe(true)
  }
})

test('the pane and the band also draw on the Desktop app', async ($, on) => {
  const world = setup(on)
  await twoAgents($, world)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'row-agent-tu-2' })
  expect(await pane.find({ type: 'Text', text: /^description: explore$/ })).toBeDefined()
  await pane.press({ key: 'clear' })
  await pane.unmount()
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: '● 2/4 running' })).toBeDefined()
  expect(await band.find({ type: 'Svg' })).toBeUndefined()
})
