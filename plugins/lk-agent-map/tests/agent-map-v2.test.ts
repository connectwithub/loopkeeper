// 0.2.0: Stop (and the mute fallback), reconcile with $.agent.list(),
// permission waits, the idle alert, last activity, fork and teammate markers.
import { expect, test } from 'claude-code/testing'

import { BAND, PANE, mapText, setup, spawn, start, step, usage } from './fixtures'

async function oneAgent($: any) {
  await start($)
  await spawn($, { toolUseId: 'tu-1', description: 'build-x', type: 'general-purpose', model: 'opus', background: true })
}

const stopLabel = async (ui: any, id: string) => (await ui.find({ key: 'stop-' + id }))?.props?.label

for (const surface of ['terminal', 'desktop'] as const) {
  test('Stop arms on the first press, disarms after 5 s, and stops with TaskStop on the second (' + surface + ')', async ($, on) => {
    const world = setup(on)
    await oneAgent($)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await stopLabel(ui, 'agent-tu-1')).toBe('Stop')

    await ui.press({ key: 'stop-agent-tu-1' })
    expect(await stopLabel(ui, 'agent-tu-1')).toBe('Confirm stop')
    expect(world.calls.some(c => c.tool === 'TaskStop')).toBe(false)

    await world.clock.advance(5_000)
    expect(await stopLabel(ui, 'agent-tu-1')).toBe('Stop')

    await ui.press({ key: 'stop-agent-tu-1' })
    await ui.press({ key: 'stop-agent-tu-1' })
    const stop = world.calls.find(c => c.tool === 'TaskStop')
    expect(stop?.task_id).toBe('agent-tu-1')
    expect(String(stop?.consent)).toContain('The user pressed "Stop" on the "general-purpose" agent agent-tu-1')
    expect(await ui.find({ key: 'stop-agent-tu-1' })).toBeUndefined()
    await ui.unmount()

    const text = await mapText($)
    expect(text).toContain('└─ ■ build-x  general-purpose  opus')
    expect(text).toContain('by you (agent map)')
    // The main loop's tool count leaves out the mod's own TaskStop
    expect(text.split('\n')[0]).toBe('main (orchestrator) · 0 tok · 1 tools')
    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ type: 'Text', text: /■ 1 stopped/ }))?.props?.color).toBe('inactive')
  })
}

test('a TaskStop the main model makes records main as the one who stopped the agent', async ($, on) => {
  setup(on)
  await oneAgent($)
  await $.tool.call({ tool: 'TaskStop', task_id: 'agent-tu-1' })
  expect(await mapText($)).toContain('■ build-x  general-purpose  opus  00:00  0 tools  0 tok  by main')
})

test('when TaskStop cannot stop an agent, it is muted and its next tool calls are refused', async ($, on) => {
  const world = setup(on)
  await oneAgent($)
  world.stopAnswer = { deny: 'No background task agent-tu-1' }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'stop-agent-tu-1' })
  await ui.press({ key: 'stop-agent-tu-1' })
  expect(world.toasts.some(t => t.startsWith('Could not stop build-x (No background task agent-tu-1). Muted it'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /⊘ muted/ })).toBeDefined()

  const before = world.calls.length
  const r = (await $.tool.call({ tool: 'Bash', agentId: 'agent-tu-1', command: 'npm test' })) as any
  expect(JSON.stringify(r)).toContain('return your result now')
  expect(world.calls.length).toBe(before)
  // Other loops are untouched
  const ok = (await $.tool.call({ tool: 'Bash', command: 'ls' })) as any
  expect(ok.deny).toBeUndefined()
  expect(await mapText($)).toContain('● build-x')
})

test('/agent-map merges $.agent.list(): missed forks and teammates appear, a parent loop is cut', async ($, on) => {
  const world = setup(on)
  await oneAgent($)
  world.list = [
    { id: 'agent-tu-1', description: 'build-x', type: 'general-purpose', status: 'running' },
    { id: 'fork-1', description: 'forked look', type: 'general-purpose', status: 'running', parentId: 'agent-tu-1' },
    { id: 'tm-1', description: 'reviewer', type: 'teammate', status: 'running' },
    { id: 'old-1', description: 'finished before', type: 'Explore', status: 'completed' },
    { id: 'c1', description: 'loop a', type: 'Plan', status: 'running', parentId: 'c2' },
    { id: 'c2', description: 'loop b', type: 'Plan', status: 'running', parentId: 'c1' },
  ]
  world.transcripts.set('fork-1', [
    { role: 'user', text: 'look', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'x', tool: 'Grep', input: { pattern: 'TODO' } }] },
  ])
  const lines = (await mapText($)).split('\n')
  expect(lines).toContain('│   └─ ● forked look  general-purpose  ?  00:00  0 tools  0 tok')
  expect(lines).toContain('│       ⋯ Grep: TODO')
  expect(lines.some(l => l.includes('● ◇ reviewer  teammate'))).toBe(true)
  expect(lines.some(l => l.includes('✓ finished before  Explore'))).toBe(true)
  // c2 would close a loop through c1, so it hangs off main; c1 nests under it
  expect(lines.some(l => /^[├└]─ ● loop b/.test(l))).toBe(true)
  expect(lines.some(l => /^ {4}└─ ● loop a|^│ {3}└─ ● loop a/.test(l))).toBe(true)

  // The list says build-x finished: the map ends it
  world.list = [{ id: 'agent-tu-1', description: 'build-x', type: 'general-purpose', status: 'completed' }]
  await world.clock.advance(1_000)
  expect(await mapText($)).toContain('✓ build-x')
})

test('a call put to the person shows ⏸ waiting on its agent until it runs', async ($, on) => {
  const world = setup(on)
  await oneAgent($)
  world.verdicts.set('Bash', 'ask')
  world.callMs = 10_000
  const running = $.tool.call({ tool: 'Bash', agentId: 'agent-tu-1', tool_use_id: 'tu-bash', command: 'rm -rf build' })
  await world.clock.settle()
  const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'tu-bash' })
  expect(verdict.decision).toBe('ask')
  // 0.3.0: the mark waits out the 4 s grace, so an auto-approved ask never flickers
  expect(await mapText($)).not.toContain('waiting')
  await world.clock.advance(4_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const flag = await ui.find({ type: 'Text', text: /⏸ waiting: Bash/ })
  expect(flag?.props?.color).toBe('claude')
  await ui.unmount()
  expect(await mapText($)).toContain('⋯ Bash: rm -rf build')

  await world.clock.advance(6_000)
  await running
  expect(await mapText($)).not.toContain('waiting')
})

test('a call the check allows never shows as waiting', async ($, on) => {
  setup(on)
  await oneAgent($)
  await $.tool.check({ tool: 'Read', input: { file_path: '/a' }, tool_use_id: 'tu-read' })
  await $.tool.call({ tool: 'Read', agentId: 'agent-tu-1', tool_use_id: 'tu-read', file_path: '/a' })
  expect(await mapText($)).not.toContain('waiting')
})

test('an agent idle past stuckAfterMs gets ⚠ idle and one toast', { options: { stuckAfterMs: 60_000 } }, async ($, on) => {
  const world = setup(on)
  await oneAgent($)
  await world.clock.advance(30_000)
  expect(await mapText($)).not.toContain('idle')
  await world.clock.advance(31_000)
  expect(await mapText($)).toContain('⚠ idle 1m')
  expect(world.toasts.filter(t => t.includes('idle')).length).toBe(1)
  expect(world.toasts.find(t => t.includes('idle'))).toBe('Agent build-x has been idle 1m: no tool call or model request')
  await world.clock.advance(120_000)
  expect(world.toasts.filter(t => t.includes('idle')).length).toBe(1)
  expect(await mapText($)).toContain('⚠ idle 3m')

  // Activity clears the note
  await $.tool.call({ tool: 'Read', agentId: 'agent-tu-1', file_path: '/src/index.ts' })
  const text = await mapText($)
  expect(text).not.toContain('idle')
  expect(text).toContain('⋯ Read: /src/index.ts')
})

test('the default idle threshold is five minutes', async ($, on) => {
  const world = setup(on)
  await oneAgent($)
  await world.clock.advance(299_000)
  expect(await mapText($)).not.toContain('idle')
  await world.clock.advance(2_000)
  expect(await mapText($)).toContain('⚠ idle 5m')
})

test('forks are marked ⑂ and each row shows the model the agent actually runs on', async ($, on) => {
  const world = setup(on)
  await oneAgent($)
  await spawn($, { toolUseId: 'tu-2', description: 'side look', type: 'general-purpose', model: 'sonnet', fork: true, caller: 'agent-tu-1' })
  let text = await mapText($)
  expect(text).toContain('└─ ● ⑂ side look  general-purpose  sonnet')
  await step($, world, 'agent-tu-2', usage(10, 10, 0, 0, 'claude-haiku-4-5'))
  text = await mapText($)
  expect(text).toContain('└─ ● ⑂ side look  general-purpose  haiku')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'row-agent-tu-2' })
  expect(await ui.find({ type: 'Text', text: /· fork/ })).toBeDefined()
})

test('a running row keeps room for its Stop button within bodyColumns', async ($, on) => {
  setup(on)
  await oneAgent($)
  await $.tool.call({ tool: 'Bash', agentId: 'agent-tu-1', command: 'a very long command line that goes on and on and on' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 50 } })
  expect(await ui.find({ key: 'stop-agent-tu-1' })).toBeDefined()
  expect(await mapText($)).toContain('⋯ Bash: a very long command line that goes on a')
})
