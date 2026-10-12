// Stubs that answer in Claude Code's place for the agent-map tests.
import { mock } from 'claude-code/testing'

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

export const usage = (input: number, output: number, cacheRead: number, cacheCreate: number, model: string): Usage => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheCreate,
  model,
})

export const BAND = {
  plugin: 'lk-agent-map',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: true, maxRows: 4, bodyColumns: 110, scroll: { offset: 0, bodyRows: 1 }, view: {} },
} as const

export const PANE = {
  plugin: 'lk-agent-map',
  component: 'Pane',
  requestId: 'agent-map',
  viewport: { columns: 160, rows: 40 },
  props: { title: 'Agent map', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

/** Registers every stub the mod needs. Call before the test's first call on $. */
export function setup(on: any) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const store = new Map<string, unknown>()
  const opened: unknown[] = []
  const toasts: string[] = []
  const usages = new Map<string, Usage>()
  /** Every tool call that reached the engine stub, in order. */
  const calls: any[] = []
  const world = {
    clock,
    store,
    opened,
    toasts,
    usages,
    calls,
    /** What $.agent.list() answers. */
    list: [] as any[],
    /** What $.session.messages({ agentId }) answers, by agent id. */
    transcripts: new Map<string, unknown>(),
    /** What TaskStop answers; the default stops the task. */
    stopAnswer: null as any,
    /** tool.check's verdict, by tool name; the default is allow. */
    verdicts: new Map<string, 'allow' | 'ask' | 'deny'>(),
    /** How long a tool call takes, so a test can look at it while it runs. */
    callMs: 0,
    /** What an Agent tool call returns to its caller, by tool_use_id (the default is empty). */
    agentResults: new Map<string, string>(),
    /** The answer to $.ui.ask (an AskUserQuestion call); null means no one can be asked. */
    askAnswer: null as string | null,
    /** Every question $.ui.ask put to the person. */
    asked: [] as any[],
    /** Files $.fs.read answers, by absolute path. */
    files: new Map<string, string>(),
    /** The /config rows $.config.list() answers; null makes the call fail, so the register options stand. */
    configRows: null as { key: string; value: unknown }[] | null,
  }
  on('session.start', () => ({ cwd: '/work' }))
  on('classic.SessionStart', () => ({}))
  on('classic.ConfigChange', () => ({}))
  on('config.list', () => (world.configRows ? { value: world.configRows } : { deny: 'no /config rows in this test' }))
  // The writer: a config.set no hook refused lands in the rows
  on('config.set', ($: any, e: any) => {
    const row = world.configRows?.find(r => r.key === e.key)
    if (!row) return { deny: 'no row ' + e.key }
    row.value = e.value
    return { value: e.value }
  })
  on('command.register', () => ({ value: undefined }))
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.open', ($: any, e: any) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  on('env.get', ($: any, e: any) => ({ value: e.name === 'HOME' ? '/home/tester' : undefined }))
  on('fs.read', ($: any, e: any) => {
    const p = String(e.path)
    for (const [k, v] of world.files) if (p === k || p.endsWith('/' + k.replace(/^\/+/, ''))) return { value: v }
    return { deny: 'ENOENT: ' + p }
  })
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId ?? 'turn' }))
  on('classic.PermissionRequest', () => ({}))
  on('classic.PreToolUse', () => ({}))
  on('tool.call', async ($: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      world.asked.push(e)
      if (world.askAnswer === null) return { deny: 'no one to ask in this run' }
      return { result: { answers: { [e.questions?.[0]?.question ?? '']: world.askAnswer } } }
    }
    calls.push(e)
    if (e.tool === 'Agent' || e.tool === 'Task') return { result: world.agentResults.get(e.tool_use_id) ?? '' }
    if (e.tool === 'TaskStop') {
      return world.stopAnswer ?? { result: { message: 'stopped', task_id: e.task_id, task_type: 'local_agent' } }
    }
    if (world.callMs > 0) await clock.sleep(world.callMs)
    return { result: 'ok' }
  })
  on('tool.check', ($: any, e: any) => ({ decision: world.verdicts.get(e.tool) ?? 'allow' }))
  on('agent.list', () => ({ value: world.list }))
  on('session.messages', ($: any, e: any) => ({ value: world.transcripts.get(e?.agentId) ?? { deny: 'no transcript for ' + e?.agentId } }))
  on('agent.spawn', ($: any, e: any) => ({
    model: e.model === 'haiku' ? 'claude-haiku-4-5' : e.model === 'opus' ? 'claude-opus-4-1' : 'claude-sonnet-4-6',
    agentId: 'agent-' + e.tool_use_id,
  }))
  on('turn.step', async function* ($: any, e: any) {
    yield { kind: 'text', index: 0, text: 'ok' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: usages.get(e.agentId ?? 'main') ?? null }
  })
  on('turn.complete', () => ({ text: '' }))
  on('session.send', () => ({ isDelivered: true }))
  on('session.receive', ($: any, e: any) => ({ text: e.text }))
  return world
}

export type World = ReturnType<typeof setup>

/** Fires one model request in a loop and reads its stream to the end. */
export async function step($: any, world: World, agentId: string | undefined, u: Usage) {
  world.usages.set(agentId ?? 'main', u)
  const input: Record<string, unknown> = { turnId: 't-' + (agentId ?? 'main'), index: 0, model: u.model, messageCount: 1 }
  if (agentId) input.agentId = agentId
  const stream = $.turn.step(input)
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
  return s.value
}

/** A model's Agent tool call followed by the spawn it causes. */
export async function spawn(
  $: any,
  opts: { toolUseId: string; description: string; type: string; model: string; prompt?: string; caller?: string; background?: boolean; fork?: boolean },
) {
  const call: Record<string, unknown> = {
    tool: 'Agent',
    tool_use_id: opts.toolUseId,
    description: opts.description,
    subagent_type: opts.type,
    model: opts.model,
    prompt: opts.prompt ?? 'Do the task: ' + opts.description,
    run_in_background: opts.background === true,
  }
  if (opts.caller) call.agentId = opts.caller
  await $.tool.call(call)
  const input: Record<string, unknown> = {
    tool_use_id: opts.toolUseId,
    prompt: call.prompt,
    description: opts.description,
    subagentType: opts.type,
    provider: { plugin: 'engine', tier: 'core' },
    model: opts.model,
    parentModel: 'claude-opus-4-1',
    background: opts.background === true,
    fork: opts.fork === true,
  }
  if (opts.caller) input.parentAgentId = opts.caller
  return $.agent.spawn(input)
}

export async function complete($: any, agentId: string, durationMs: number, reason: 'answer' | 'aborted' | 'error' = 'answer') {
  return $.turn.complete({ turnId: 't-' + agentId, agentId, answer: '', durationMs, isAborted: reason === 'aborted', reason, usage: null })
}

export async function mapText($: any): Promise<string> {
  const r = await $.command.run({ command: 'agent-map', args: 'text' })
  return r.text
}

export async function start($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}
