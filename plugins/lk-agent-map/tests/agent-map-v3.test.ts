// 0.3.0: spawn caps and the override ask, context cost of results, cards,
// team lanes, the lifecycle log, /agent-map cap, and the waiting grace.
import { expect, test } from 'claude-code/testing'

import { fmtClock } from '../hooks/format'
import { BAND, PANE, complete, mapText, setup, spawn, start } from './fixtures'

const CONC_DENY =
  'agent-map: concurrency cap reached (4/4). Wait for running subagents to return, or batch the work into fewer agents. The user can raise it with /agent-map cap concurrent <n>.'

const cmd = async ($: any, args: string) => (await $.command.run({ command: 'agent-map', args })).text as string
const bandLine = async ($: any) => {
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // The kit line's Texts joined by its two-space gap; the color is the state chip's
  const mine = String((await ui.find({ key: 'agent-map-band' }))?.text ?? '')
  const texts = ((await ui.findAll({ type: 'Text' })) as { text: string; props: Record<string, unknown> }[]).filter(t => t.text && mine.includes(t.text))
  const state = texts.find(t => /^● (ok|near cap|at cap)$/.test(t.text))
  await ui.unmount()
  return { text: texts.map(t => t.text).join('  '), color: state?.props?.color as string }
}
async function many($: any, n: number, from = 1, extra: Record<string, unknown> = {}) {
  const out: any[] = []
  for (let i = from; i < from + n; i++) out.push(await spawn($, { toolUseId: 'tu-' + i, description: 'job ' + i, type: 'general-purpose', model: 'sonnet', ...extra }))
  return out
}

test('the concurrency cap denies the fifth running agent and allows one again when a slot frees', async ($, on) => {
  const world = setup(on)
  await start($)
  const ok = await many($, 4)
  expect(ok.every(r => r.agentId)).toBe(true)
  const denied = await spawn($, { toolUseId: 'tu-5', description: 'job 5', type: 'general-purpose', model: 'sonnet' })
  expect(denied).toEqual({ deny: CONC_DENY })
  const band = await bandLine($)
  expect(band.text).toBe('agents  ● 4/4 running  ✓ 0 done  ✗ 0  ● at cap  0 tok')
  expect(band.color).toBe('error')
  expect(await cmd($, 'log')).toContain('denied job 5 · concurrent cap 4/4')

  await complete($, 'agent-tu-1', 1_000)
  const again = await spawn($, { toolUseId: 'tu-6', description: 'job 6', type: 'general-purpose', model: 'sonnet' })
  expect(again.agentId).toBe('agent-tu-6')
  expect(world.toasts.filter(t => t.includes('near the')).length).toBe(1)
})

test('the per-turn cap counts spawns this turn, leaves forks out, and resets on a new main turn', async ($, on) => {
  setup(on)
  await start($)
  await cmd($, 'cap concurrent 0')
  expect(await cmd($, 'cap turn 2')).toBe('agent-map: turn cap set to 2')
  await many($, 2)
  const fork = await spawn($, { toolUseId: 'tu-f', description: 'fork look', type: 'general-purpose', model: 'sonnet', fork: true })
  expect(fork.agentId).toBe('agent-tu-f')
  const denied = await spawn($, { toolUseId: 'tu-3', description: 'job 3', type: 'general-purpose', model: 'sonnet' })
  expect(denied.deny).toContain('agent-map: per-turn spawn cap reached (2/2).')
  expect(denied.deny).toContain('/agent-map cap turn <n>.')
  await $.turn.start({ text: 'next', turnId: 'turn-2' })
  expect((await spawn($, { toolUseId: 'tu-4', description: 'job 4', type: 'general-purpose', model: 'sonnet' })).agentId).toBe('agent-tu-4')
  expect((await bandLine($)).text).toBe('agents  ● 4 running  ✓ 0 done  ✗ 0  ● ok  0 tok')
})

test('the per-session cap holds across turns', async ($, on) => {
  setup(on)
  await start($)
  await cmd($, 'cap session 3')
  await many($, 2)
  await $.turn.start({ text: 'next', turnId: 'turn-2' })
  await many($, 1, 3)
  await $.turn.start({ text: 'again', turnId: 'turn-3' })
  const denied = await spawn($, { toolUseId: 'tu-9', description: 'job 9', type: 'general-purpose', model: 'sonnet' })
  expect(denied.deny).toContain('agent-map: per-session spawn cap reached (3/3).')
})

test('the near-cap toast goes out once per turn and the band chip goes from at cap back to ok', async ($, on) => {
  const world = setup(on)
  await start($)
  await many($, 2)
  expect(world.toasts.filter(t => t.includes('near the'))).toEqual([])
  await many($, 2, 3)
  expect(world.toasts.filter(t => t.includes('near the'))).toEqual(['agents 3/4 running, near the concurrency cap'])
  expect((await bandLine($)).color).toBe('error')
  await complete($, 'agent-tu-1', 1)
  await complete($, 'agent-tu-2', 1)
  await complete($, 'agent-tu-3', 1)
  await complete($, 'agent-tu-4', 1)
  // None running, 4 of 8 this turn: below warnAt, so ok
  expect((await bandLine($)).color).toBe('success')
})

for (const [answer, allowed, next] of [
  ['Allow this one', true, false],
  ['Allow the rest of the turn', true, true],
  ['Deny', false, false],
  [null, false, false],
] as const) {
  test('a [cap-override] spawn past the cap asks the user: ' + String(answer), async ($, on) => {
    const world = setup(on)
    world.askAnswer = answer
    await start($)
    await many($, 4)
    const r = await spawn($, { toolUseId: 'tu-o', description: '[cap-override: hotfix needs a reviewer] review', type: 'general-purpose', model: 'sonnet' })
    expect(world.asked.length).toBe(1)
    const q = world.asked[0].questions[0]
    expect(q.question).toBe('agent-map: hotfix needs a reviewer. Allow one more agent beyond the cap?')
    expect(q.options.map((o: any) => o.label ?? o)).toEqual(['Allow this one', 'Allow the rest of the turn', 'Deny'])
    if (allowed) {
      expect(r.agentId).toBe('agent-tu-o')
      // The marker is stripped from what the agent shows as
      expect(await mapText($)).toContain('● review  general-purpose')
    } else {
      expect(r.deny).toContain(CONC_DENY)
      expect(r.deny).toContain(answer === null ? 'No one could be asked about the override.' : 'The user declined the override.')
    }
    const plain = await spawn($, { toolUseId: 'tu-p', description: 'plain', type: 'general-purpose', model: 'sonnet' })
    expect(plain.agentId !== undefined).toBe(next)
    expect(world.asked.length).toBe(1)
    expect(await cmd($, 'log')).toContain('override review · hotfix needs a reviewer: ' + (answer ?? 'no one to ask, denied'))
  })
}

test('an Agent result is measured as returnedTokens, and the session total warns once', async ($, on) => {
  const world = setup(on)
  await start($)
  world.agentResults.set('tu-1', 'x'.repeat(152_000))
  world.agentResults.set('tu-2', 'y'.repeat(320_000))
  await spawn($, { toolUseId: 'tu-1', description: 'survey', type: 'Explore', model: 'haiku' })
  await complete($, 'agent-tu-1', 1_000)
  expect(await mapText($)).toContain('✓ survey  Explore  haiku  00:01  0 tools  0 tok  → 38k to main')
  let band = await bandLine($)
  expect(band.text).toBe('agents  ● 0/4 running  ✓ 1 done  ✗ 0  ● ok  0 tok · results 38k → main')
  expect(band.color).toBe('success')
  expect(world.toasts.filter(t => t.includes('/compact'))).toEqual([])

  await spawn($, { toolUseId: 'tu-2', description: 'deep read', type: 'Explore', model: 'haiku' })
  await complete($, 'agent-tu-2', 1_000)
  band = await bandLine($)
  expect(band.text).toBe('agents  ● 0/4 running  ✓ 2 done  ✗ 0  ● near cap  0 tok · results 118k → main')
  expect(band.color).toBe('claude')
  const warn = world.toasts.filter(t => t.includes('/compact'))
  expect(warn).toEqual(['agent-map: subagent results have put 118k tokens into the main context. Consider /compact, or a handoff to a fresh session.'])
  await spawn($, { toolUseId: 'tu-3', description: 'more', type: 'Explore', model: 'haiku' })
  expect(world.toasts.filter(t => t.includes('/compact')).length).toBe(1)
  expect(await cmd($, 'log')).toContain('done survey · in 00:01 · 0 tok · → 38k to main')
})

test('/agent-map cards lays out one bordered card per agent, running first', async ($, on) => {
  const world = setup(on)
  await start($)
  world.agentResults.set('tu-1', 'z'.repeat(4_000))
  await spawn($, { toolUseId: 'tu-1', description: 'finished first one', type: 'Explore', model: 'haiku' })
  await world.clock.advance(5_000)
  await complete($, 'agent-tu-1', 5_000)
  await spawn($, { toolUseId: 'tu-2', description: 'a running agent with a label longer than thirty-two', type: 'general-purpose', model: 'sonnet' })
  await $.tool.call({ tool: 'Bash', agentId: 'agent-tu-2', command: 'npm test' })
  await world.clock.advance(57_000)
  expect(await cmd($, 'cards')).toBe('Agent map: cards view')
  expect(world.store.get('view2')).toBe('cards')
  const lines = (await mapText($)).split('\n')
  const t0 = 1_000_000
  expect(lines.length).toBe(12)
  expect(lines[0]).toBe('╭' + '─'.repeat(118) + '╮')
  expect(lines[1].trimEnd()).toBe('│ a running agent with a label lon · general-purpose · sonnet ●' + ' '.repeat(56) + '│')
  expect(lines[2]).toContain('│ spawned ' + fmtClock(t0 + 5_000) + ' → running 00:57 ')
  expect(lines[3]).toContain('│ 1 tool · last Bash: npm test · 0 tok ')
  expect(lines[4]).toContain('│ from main  [Stop] ')
  expect(lines[8]).toContain('│ spawned ' + fmtClock(t0) + ' → running 00:05 → done ' + fmtClock(t0 + 5_000) + ' ')
  expect(lines[9]).toContain('│ 0 tools · 0 tok · → 1k to main ')
  expect(lines.every(l => Array.from(l).length === 120)).toBe(true)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 60 } })
  expect(await ui.find({ key: 'card-agent-tu-2' })).toBeDefined()
  expect(await ui.find({ key: 'stop-agent-tu-2' })).toBeDefined()
  expect(await ui.find({ key: 'stop-agent-tu-1' })).toBeUndefined()
  expect((await ui.find({ key: 'card-agent-tu-2' }))?.props?.width).toBe(60)
  await ui.unmount()
  expect(await cmd($, 'tree')).toBe('Agent map: tree view')
  expect(await mapText($)).toContain('├─ ✓ finished first one  Explore  haiku  00:05  0 tools  0 tok  → 1k to main')
})

test('/agent-map team groups agents by parent into lanes, teammates in their own', async ($, on) => {
  const world = setup(on)
  await start($)
  await spawn($, { toolUseId: 'tu-1', description: 'lead', type: 'general-purpose', model: 'opus' })
  await spawn($, { toolUseId: 'tu-2', description: 'helper a', type: 'Explore', model: 'haiku', caller: 'agent-tu-1' })
  await spawn($, { toolUseId: 'tu-3', description: 'helper b', type: 'Explore', model: 'haiku', caller: 'agent-tu-1' })
  await spawn($, { toolUseId: 'tu-4', description: 'solo', type: 'Plan', model: 'sonnet' })
  await complete($, 'agent-tu-3', 1_000)
  await complete($, 'agent-tu-4', 1_000)
  world.list = [{ id: 'tm-1', description: 'reviewer', type: 'teammate', status: 'running' }]
  await cmd($, 'team')
  const lines = (await mapText($)).split('\n')
  expect(lines[0]).toBe('team of main: 1 running · 1 done')
  expect(lines[1]).toMatch(/^ {2}● lead  general-purpose  opus/)
  expect(lines[2]).toMatch(/^ {2}✓ solo  Plan  sonnet/)
  expect(lines[3]).toBe('  team of lead: 1 running · 1 done')
  expect(lines[4]).toMatch(/^ {4}● helper a  Explore  haiku/)
  expect(lines[5]).toMatch(/^ {4}✓ helper b  Explore  haiku/)
  expect(lines[6]).toBe('teammates: 1 running · 0 done')
  expect(lines[7]).toMatch(/^ {2}● ◇ reviewer  teammate/)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^team of lead: 1 running · 1 done$/ })).toBeDefined()
  expect(await ui.find({ key: 'stop-agent-tu-2' })).toBeDefined()
})

test('the lifecycle log records spawn, first tool, waiting, resumed, stop and end; the pane toggles it', async ($, on) => {
  const world = setup(on)
  await start($)
  await spawn($, { toolUseId: 'tu-1', description: 'builder', type: 'general-purpose', model: 'sonnet', background: true })
  await $.tool.call({ tool: 'Read', agentId: 'agent-tu-1', file_path: '/src/a.ts' })
  world.verdicts.set('Bash', 'ask')
  world.callMs = 10_000
  const running = $.tool.call({ tool: 'Bash', agentId: 'agent-tu-1', tool_use_id: 'tu-b', command: 'make' })
  await world.clock.settle()
  await $.tool.check({ tool: 'Bash', input: { command: 'make' }, tool_use_id: 'tu-b' })
  await world.clock.advance(10_000)
  await running
  await $.tool.call({ tool: 'TaskStop', task_id: 'agent-tu-1' })
  await spawn($, { toolUseId: 'tu-2', description: 'checker', type: 'Explore', model: 'haiku' })
  await world.clock.advance(3_000)
  await complete($, 'agent-tu-2', 3_000, 'error')
  const log = (await cmd($, 'log')).split('\n').map(l => l.replace(/^\d\d:\d\d:\d\d /, ''))
  expect(log).toEqual([
    'spawned builder · general-purpose claude-sonnet-4-6 · running 1/4 · turn 1/8 · session 1/40',
    'first-tool builder · Read: /src/a.ts',
    'waiting builder · Bash',
    'resumed builder · after Bash',
    'stopped builder · by main',
    'spawned checker · Explore claude-haiku-4-5 · running 1/4 · turn 2/8 · session 2/40',
    'failed checker · in 00:03 · 0 tok',
  ])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /spawned builder/ })).toBeUndefined()
  await ui.press({ key: 'log' })
  expect(await ui.find({ type: 'Text', text: /^log \(last 7\)$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /failed checker · in 00:03/ })).toBeDefined()
  await ui.press({ key: 'log' })
  expect(await ui.find({ type: 'Text', text: /spawned builder/ })).toBeUndefined()
})

test('/agent-map cap shows, sets and saves caps over the config files', async ($, on) => {
  const world = setup(on)
  world.files.set('/home/tester/.claude/agent-map.json', JSON.stringify({ maxConcurrent: 6, maxPerTurn: 10 }))
  world.files.set('/work/.claude/agent-map.json', JSON.stringify({ maxPerTurn: 12, warnAt: 0.5 }))
  await start($)
  expect(await cmd($, 'cap')).toBe(
    'agent-map caps: concurrent 6 (now 0) · turn 12 (now 0) · session 40 (now 0) · returned 150k (now 0) · warn at 50% · waiting grace 4000 ms',
  )
  expect(await cmd($, 'cap concurrent 2')).toBe('agent-map: concurrent cap set to 2')
  expect(await cmd($, 'cap returned 200')).toBe('agent-map: returned cap set to 200k tok')
  expect(await cmd($, 'cap warn 0.9')).toBe('agent-map: warn cap set to 90%')
  expect(await cmd($, 'cap grace 1500')).toBe('agent-map: grace cap set to 1500 ms')
  expect(await cmd($, 'cap session 0')).toBe('agent-map: session cap set to off')
  expect(world.store.get('caps')).toEqual({ maxConcurrent: 2, maxReturnedTokens: 200_000, warnAt: 0.9, waitGraceMs: 1500, maxPerSession: 0 })
  expect(await cmd($, 'cap bogus 3')).toContain('Usage: /agent-map cap')
  expect(await cmd($, 'cap turn many')).toContain('Usage: /agent-map cap')
  await many($, 2)
  expect((await spawn($, { toolUseId: 'tu-3', description: 'x', type: 'Plan', model: 'opus' })).deny).toContain('concurrency cap reached (2/2)')
})

test('an ask auto-approved within the grace never shows as waiting', async ($, on) => {
  const world = setup(on)
  await start($)
  await spawn($, { toolUseId: 'tu-1', description: 'builder', type: 'general-purpose', model: 'sonnet' })
  world.verdicts.set('Bash', 'ask')
  world.callMs = 1_000
  const running = $.tool.call({ tool: 'Bash', agentId: 'agent-tu-1', tool_use_id: 'tu-b', command: 'ls' })
  await world.clock.settle()
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu-b' })
  await world.clock.advance(1_000)
  await running
  await world.clock.advance(10_000)
  expect(await mapText($)).not.toContain('waiting')
  expect(await cmd($, 'log')).not.toContain('waiting')
})

test('an outstanding ask shows after the grace, and at once when a permission dialog opens', async ($, on) => {
  const world = setup(on)
  await start($)
  await spawn($, { toolUseId: 'tu-1', description: 'builder', type: 'general-purpose', model: 'sonnet' })
  world.verdicts.set('Bash', 'ask')
  world.callMs = 60_000
  void $.tool.call({ tool: 'Bash', agentId: 'agent-tu-1', tool_use_id: 'tu-b', command: 'rm -rf x' })
  await world.clock.settle()
  await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf x' }, tool_use_id: 'tu-b' })
  await world.clock.advance(3_900)
  expect(await mapText($)).not.toContain('waiting')
  await world.clock.advance(200)
  expect(await mapText($)).toContain('⏸ waiting: Bash')

  void $.tool.call({ tool: 'Edit', agentId: 'agent-tu-1', tool_use_id: 'tu-e', file_path: '/a' })
  world.verdicts.set('Edit', 'ask')
  await world.clock.settle()
  await $.tool.check({ tool: 'Edit', input: { file_path: '/a' }, tool_use_id: 'tu-e' })
  expect(await mapText($)).not.toContain('waiting: Bash, Edit')
  await $.classic.PermissionRequest({ tool_name: 'Edit', tool_input: { file_path: '/a' }, agent_id: 'agent-tu-1', hook_event_name: 'PermissionRequest' })
  expect(await mapText($)).toContain('⏸ waiting: Bash, Edit')
})

test('once a permission dialog has been seen, a long auto-approved command never shows waiting', async ($, on) => {
  const world = setup(on)
  await start($)
  await spawn($, { toolUseId: 'tu-1', description: 'builder', type: 'general-purpose', model: 'sonnet' })
  world.verdicts.set('Bash', 'ask')
  world.callMs = 1_000
  // An earlier ask that did open a dialog: PermissionRequest is the signal from now on
  const first = $.tool.call({ tool: 'Bash', agentId: 'agent-tu-1', tool_use_id: 'tu-a', command: 'rm x' })
  await world.clock.settle()
  await $.tool.check({ tool: 'Bash', input: { command: 'rm x' }, tool_use_id: 'tu-a' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm x' }, agent_id: 'agent-tu-1', hook_event_name: 'PermissionRequest' })
  await world.clock.advance(1_000)
  await first

  world.callMs = 60_000
  const running = $.tool.call({ tool: 'Bash', agentId: 'agent-tu-1', tool_use_id: 'tu-b', command: 'npm run build' })
  await world.clock.settle()
  await $.tool.check({ tool: 'Bash', input: { command: 'npm run build' }, tool_use_id: 'tu-b' })
  // The classifier approved it without a dialog: it runs for a minute
  await world.clock.advance(30_000)
  expect(await mapText($)).not.toContain('waiting')
  await world.clock.advance(30_000)
  await running
  expect((await cmd($, 'log')).split('\n').filter(l => l.includes('waiting')).length).toBe(1)
})
