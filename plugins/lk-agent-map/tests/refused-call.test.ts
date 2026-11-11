// An Agent call refused before it starts an agent is no spawn: it leaves the Planned list and puts
// nothing into the caller's context. From Claude Code 2.1.312 the engine's permission check runs
// inside tool.call and refuses with an errored result (isError, the reason its text), no longer a
// deny; 2.1.294 runs no check in a test. Every assertion here holds on both.
//
// In the engine, agent.spawn fires inside the Agent call. A test's tool.call stub can't raise it
// (the host only lets a stub make the calls the hooks module makes), so the agent that started
// below is spawned just before its call instead: either way it is recorded before the call settles.
import { expect, test } from 'claude-code/testing'

import { PANE, mapText, setup, spawn, start } from './fixtures'

const cmd = async ($: any, args: string) => (await $.command.run({ command: 'lk-agents', args })).text as string
/** The tokens subagent results have put into the main context, as /lk-agents cap shows them. */
const returnedNow = async ($: any) => /returned \S+ \(now ([^)]+)\)/.exec(await cmd($, 'cap'))?.[1]
const call = (toolUseId: string, description: string) => ({
  tool: 'Agent',
  tool_use_id: toolUseId,
  description,
  subagent_type: 'general-purpose',
  model: 'sonnet',
  prompt: 'Do the task: ' + description,
})
async function planned($: any, toolUseId: string): Promise<boolean> {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const found = (await ui.find({ key: 'planned-' + toolUseId })) !== undefined
  await ui.unmount()
  return found
}

test('an Agent call the permission check refuses, with no check before it, puts no tokens into the main context', async ($, on) => {
  const world = setup(on)
  world.verdicts.set('Agent', 'deny')
  await start($)
  const r = await $.tool.call(call('tu-r', 'refused by the rules'))
  // 2.1.312+: refused inside the call (isError), so it leaves the plan. 2.1.294: no check, the call reaches the stub and stays planned.
  expect(await planned($, 'tu-r')).toBe(r.isError !== true)
  expect(await returnedNow($)).toBe('0')
  expect(await cmd($, 'log')).not.toContain('returned')
})

test('an errored Agent call that started no agent leaves the plan and counts nothing returned', async ($, on) => {
  const world = setup(on)
  await start($)
  world.agentAnswers.set('tu-e', { result: 'Error: ' + 'n'.repeat(4_000), text: 'n'.repeat(4_000), isError: true })
  const r = await $.tool.call(call('tu-e', 'errored before it started'))
  expect(r.isError).toBe(true)
  expect(await planned($, 'tu-e')).toBe(false)
  expect(await returnedNow($)).toBe('0')
  // A later agent counts only its own result
  world.agentResults.set('tu-ok', 'k'.repeat(4_000))
  await spawn($, { toolUseId: 'tu-ok', description: 'started fine', type: 'general-purpose', model: 'sonnet' })
  expect(await returnedNow($)).toBe('1k')
})

test("an agent that started and then failed still counts what its error put into the caller's context", async ($, on) => {
  const world = setup(on)
  await start($)
  world.agentAnswers.set('tu-f', { result: 'Error: ' + 'f'.repeat(4_000), text: 'f'.repeat(4_000), isError: true })
  const s = await $.agent.spawn({
    tool_use_id: 'tu-f',
    prompt: 'Do the task: started then failed',
    description: 'started then failed',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    model: 'sonnet',
    parentModel: 'claude-opus-4-1',
    background: false,
    fork: false,
  })
  expect(s.agentId).toBe('agent-tu-f')
  const r = await $.tool.call(call('tu-f', 'started then failed'))
  expect(r.isError).toBe(true)
  expect(await planned($, 'tu-f')).toBe(false)
  expect(await returnedNow($)).toBe('1k')
  expect(await mapText($)).toContain('→ 1k to main')
})
