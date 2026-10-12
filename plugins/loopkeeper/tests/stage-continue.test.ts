// stage-continue.test.ts: continue after approval (ADR 0012). A user's approval that changed something (/lk approve,
// the band's button, the Stage pane's Approve gate) submits one framed prompt so the model carries on: at once when
// the session is idle, at the main turn's end when a turn runs (after the turn's next-step line). Model-side
// approvals, an approval that changed nothing, pipeline.continueOnApprove false, a session with no person at the prompt
// and no app surface attached, and the kill switch never submit. Also the
// hold rule: only a prompt the person sent can make the plan gate wait.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { BAND as WORLD_BAND, CWD, PROJECT_CONFIG, USER_CONFIG, start, tool, world } from './world.ts'
import type { World, WorldOptions } from './world.ts'

const TOOL = 'mcp__loopkeeper__set_stage'
const GSD = { ['loopkeeper:stage:preset:' + CWD]: 'gsd' }
const BAND = { ...WORLD_BAND, props: { ...WORLD_BAND.props, bodyColumns: 120 } }
const PANE = {
  plugin: 'loopkeeper',
  component: 'Pane',
  requestId: 'loopkeeper-stage',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Stage', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const validator = { tool: 'Agent', subagent_type: 'general-purpose', description: 'Plan validator: check the plan', prompt: 'x' }

const CARRY_ON = 'Carry on with the task from where you stopped.'
const APPROVED_GATE = 'Approved the Validate plan gate; the pipeline may now move past it. File budget: 23 files a turn (13 planned + 10).'

type Options = { store?: Record<string, unknown>; files?: Record<string, string>; env?: Record<string, string>; fail?: number; surfaces?: string[] }

// The shared world, in the gsd preset unless the test brings its own store. `fail` refuses that many of the continue
// prompts the plugin submits, the first ones (a test's own prompts still go through); `refused` counts them.
// `surfaces` is what $.session.surfaces resolves to (the shared world's default: ['terminal']).
function continueWorld(on: any, opts: Options = {}): World & { refused: () => number } {
  let refused = 0
  // above the shared world's prompt.submit stub, so it is asked first (the empty matcher: the stub has none)
  if (opts.fail) {
    on('prompt.submit', {}, ($: unknown, e: any, next: (e: unknown) => unknown) => {
      if (String(e?.text ?? '').endsWith(CARRY_ON) && refused < (opts.fail ?? 0)) {
        refused += 1
        throw new Error('submit refused')
      }
      return next(e)
    })
  }
  const w = world(on, { now: 1_000_000, files: opts.files ?? {}, env: opts.env, surfaces: opts.surfaces } as WorldOptions)
  for (const [k, v] of Object.entries(opts.store ?? GSD)) w.store.set(k, v)
  return Object.assign(w, { refused: () => refused })
}

// The prompts loopkeeper submitted to carry on. /lk approve submits from a short timer (the host refuses a submit
// from a command.run hook) and a refused submit is tried again for up to 2.6 s, so the clock moves on 5 s first.
async function continued(w: World): Promise<Array<{ text: unknown; origin: unknown; asUser: unknown }>> {
  await w.clock.advance(5_000)
  return w.submitted.filter(s => typeof s.text === 'string' && s.text.endsWith(CARRY_ON))
}

async function cmd($: Engine, args: string): Promise<string> {
  const out = (await $.command.run({ command: 'lk', args })) as { text?: string }
  return out?.text ?? ''
}

async function setStage($: Engine, input: Record<string, unknown>): Promise<{ result?: string; deny?: string }> {
  return (await $.tool.call({ tool: TOOL, ...input } as never)) as { result?: string; deny?: string }
}

// A large task of 13 planned files (or `files`) at the Validate plan gate, moved there by the command: the gate waits
async function atGate($: Engine, files = 13): Promise<void> {
  await start($)
  await setStage($, { stage: 'plan', size: 'large', files })
  await cmd($, 'validate-plan')
}

// A large task whose plan validator completed in Plan
async function planned($: Engine, files: number): Promise<void> {
  await setStage($, { stage: 'plan', size: 'large', files })
  await $.tool.call(validator as never)
}

async function buttonLabel($: Engine): Promise<string | null> {
  const ui = await $.ui.mount(BAND)
  const el = (await ui.find({ key: 'stage-approve' })) as { props?: { label?: unknown } } | undefined
  await ui.unmount()
  return el ? String(el.props?.label) : null
}

async function pressButton($: Engine): Promise<void> {
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'stage-approve' })
  await ui.unmount()
}

let turnNo = 0
async function turnStart($: any): Promise<string> {
  turnNo += 1
  const turnId = 'turn-' + turnNo
  await $.turn.start({ turnId, text: 'build it' })
  return turnId
}

async function turnComplete($: any, turnId: string, opts: { agentId?: string; reason?: string } = {}): Promise<void> {
  const reason = opts.reason ?? 'answer'
  const done: Record<string, unknown> = { turnId, answer: 'done', durationMs: 1200, isAborted: reason === 'aborted', usage: null, reason }
  if (opts.agentId) done.agentId = opts.agentId
  await $.turn.complete(done)
}

// ---- Idle: the approval submits one framed prompt at once ----------------------------------------------------------

test('/lk approve at the gsd Validate plan gate, idle: one framed prompt; the reply is unchanged', { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on)
  await atGate($)
  expect(await cmd($, 'approve')).toBe(APPROVED_GATE)
  const sent = await continued(w)
  expect(sent.length).toBe(1)
  expect(sent[0].text).toBe('The user ran /lk approve. ' + APPROVED_GATE + ' ' + CARRY_ON)
  expect(String(sent[0].text).startsWith('The user ran /lk approve. Approved the Validate plan gate')).toBe(true)
  // framed as the plugin's message, never as the person's own words
  expect(sent[0].asUser).not.toBe(true)
  // approving again changes nothing and submits nothing
  expect(await cmd($, 'approve')).toContain('The Validate plan gate is already approved.')
  expect((await continued(w)).length).toBe(1)
})

test('the band button "Approve plan · 13 files", idle: one prompt that names the button', { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on)
  await start($)
  await cmd($, 'approval ask')
  await planned($, 13)
  await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  // the verdict in approval mode ask leaves the gate to the user: nothing submitted yet
  expect((await continued(w)).length).toBe(0)
  expect(await buttonLabel($)).toBe('Approve plan · 13 files')
  await pressButton($)
  const sent = await continued(w)
  expect(sent.length).toBe(1)
  expect(String(sent[0].text).startsWith('The user pressed Approve plan · 13 files. Approved the Validate plan gate')).toBe(true)
  expect(String(sent[0].text).endsWith(CARRY_ON)).toBe(true)
})

test('the band button "Approve budget · 41 files", idle: one prompt; the validator opening the gate submitted none', { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on)
  await start($)
  await planned($, 41)
  await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  expect((await continued(w)).length).toBe(0)
  expect(await buttonLabel($)).toBe('Approve budget · 41 files')
  await pressButton($)
  const sent = await continued(w)
  expect(sent.length).toBe(1)
  expect(sent[0].text).toBe(
    'The user pressed Approve budget · 41 files. Approved the file budget. File budget: 51 files a turn (41 planned + 10). ' + CARRY_ON,
  )
})

test('a budget-only approval during a running turn submits nothing, then or at the turn end', { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on)
  await start($)
  await planned($, 41)
  await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  const turn = await turnStart($)
  await pressButton($)
  expect(await buttonLabel($)).toBe(null)
  expect((await continued(w)).length).toBe(0)
  await turnComplete($, turn)
  expect((await continued(w)).length).toBe(0)
})

test('the Stage pane Approve gate, idle: one prompt', { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on)
  await atGate($)
  const ui = await $.ui.mount(PANE as never)
  await ui.press({ key: 'approve' })
  await ui.unmount()
  const sent = await continued(w)
  expect(sent.length).toBe(1)
  expect(sent[0].text).toBe('The user pressed Approve gate. ' + APPROVED_GATE + ' ' + CARRY_ON)
})

// ---- Never: approvals that changed nothing, model-side approvals, and the switches -----------------------------

test('no prompt: a stage with no gate, and no current approval to make', { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on, { store: {} })
  await start($)
  expect(await cmd($, 'approve')).toBe('Plan has no gate to approve.')
  expect((await continued(w)).length).toBe(0)
})

test('no prompt: pipeline.continueOnApprove false in the project config', { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on, { files: { [PROJECT_CONFIG]: JSON.stringify({ pipeline: { continueOnApprove: false } }) } })
  await atGate($)
  expect(await cmd($, 'approve')).toBe(APPROVED_GATE)
  expect((await continued(w)).length).toBe(0)
})

test('no prompt: no person at the prompt and no app surface attached (a plain -p run)', { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on, { surfaces: [] })
  await $.session.start({ cwd: CWD, surface: null, isInteractive: false } as never)
  await setStage($, { stage: 'plan', size: 'large', files: 13 })
  await cmd($, 'validate-plan')
  expect(await cmd($, 'approve')).toBe(APPROVED_GATE)
  expect((await continued(w)).length).toBe(0)
})

test('the desktop hosting Claude Code through the SDK (isInteractive false, a desktop surface): one prompt', { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on, { surfaces: ['desktop'] })
  await $.session.start({ cwd: CWD, surface: null, isInteractive: false } as never)
  await setStage($, { stage: 'plan', size: 'large', files: 13 })
  await cmd($, 'validate-plan')
  expect(await cmd($, 'approve')).toBe(APPROVED_GATE)
  const sent = await continued(w)
  expect(sent.length).toBe(1)
  expect(sent[0].text).toBe('The user ran /lk approve. ' + APPROVED_GATE + ' ' + CARRY_ON)
})

test('no prompt: the kill switch (CLAUDE_MODS_DISABLE=loopkeeper)', { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on, { env: { CLAUDE_MODS_DISABLE: 'loopkeeper' } })
  await atGate($)
  expect(await cmd($, 'approve')).toBe(APPROVED_GATE)
  expect((await continued(w)).length).toBe(0)
})

test('no prompt: a validator verdict, a review_cycle plan pass and ExitPlanMode', { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on)
  await start($)
  // a validator's consistent verdict opens the gate in auto mode, with the budget
  await planned($, 13)
  expect((await setStage($, { stage: 'validate-plan', verdict: 'consistent' })).result).toContain('File budget: 23 files a turn')
  // a review_cycle plan pass that is done records the same verdict for a new task
  await planned($, 13)
  const done = await tool($, 'review_cycle', { subject: 'cache plan', kind: 'plan', items: [{ text: 'name the dir', priority: 'p2' }] })
  expect(String(done.result)).toContain('loopkeeper stage: Moved from Plan to Validate plan.')
  // ExitPlanMode moves on by itself
  await setStage($, { stage: 'plan', size: 'large', files: 13 })
  await $.tool.call({ tool: 'ExitPlanMode', plan: 'p' } as never)
  expect((await continued(w)).length).toBe(0)
})

// ---- A running main turn: the approval waits for the turn's end -------------------------------------------------

test('an approval during a running turn submits at the main turn end when the stage is unchanged', { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on)
  await atGate($)
  const turn = await turnStart($)
  expect(await cmd($, 'approve')).toBe(APPROVED_GATE)
  expect((await continued(w)).length).toBe(0)
  // a subagent's turn end changes nothing: the main turn still runs and the approval still waits
  await turnComplete($, 'sub-1', { agentId: 'agent-1' })
  expect((await continued(w)).length).toBe(0)
  await turnComplete($, turn)
  const sent = await continued(w)
  expect(sent.length).toBe(1)
  expect(sent[0].text).toBe('The user ran /lk approve. ' + APPROVED_GATE + ' ' + CARRY_ON)
  // taken once: a later turn end submits nothing more
  await turnComplete($, await turnStart($))
  expect((await continued(w)).length).toBe(1)
})

test("a held approval's prompt goes after the main turn's next-step line, once", { timeoutMs: 20_000 }, async ($, on) => {
  const order: string[] = []
  // above the shared world's stubs (the empty matcher: they have none), so each call is seen as it is made
  on('ui.log', {}, ($: unknown, e: any, next: (e: unknown) => unknown) => {
    if (String(e?.text ?? '').startsWith('loopkeeper · ')) order.push('line')
    return next(e)
  })
  on('prompt.submit', {}, ($: unknown, e: any, next: (e: unknown) => unknown) => {
    if (String(e?.text ?? '').endsWith(CARRY_ON)) order.push('prompt')
    return next(e)
  })
  const w = continueWorld(on)
  await atGate($)
  const turn = await turnStart($)
  expect(await cmd($, 'approve')).toBe(APPROVED_GATE)
  await turnComplete($, turn)
  expect((await continued(w)).length).toBe(1)
  expect(order).toEqual(['line', 'prompt'])
})

test('an approval during a running turn is dropped when the stage moved on before the turn ended', { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on)
  await atGate($)
  const turn = await turnStart($)
  await cmd($, 'approve')
  expect((await setStage($, { stage: 'execute' })).result).toContain('Moved from Validate plan to Execute')
  await turnComplete($, turn)
  expect((await continued(w)).length).toBe(0)
})

test("an 'aborted' main turn end clears running: a later approval submits at once", { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on)
  await atGate($)
  await turnComplete($, await turnStart($), { reason: 'aborted' })
  await cmd($, 'approve')
  expect((await continued(w)).length).toBe(1)
})

test('a failing $.prompt.submit is tried three more times, then given up; the approval and the reply stand', { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on, { fail: 99 })
  await atGate($)
  expect(await cmd($, 'approve')).toBe(APPROVED_GATE)
  expect(await cmd($, 'status')).toContain('Gates: Validate plan approved')
  expect((await continued(w)).length).toBe(0)
  expect(w.refused()).toBe(4)
})

test('a submit refused once is tried again and sent once', { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on, { fail: 1 })
  await atGate($)
  expect(await cmd($, 'approve')).toBe(APPROVED_GATE)
  const sent = await continued(w)
  expect(w.refused()).toBe(1)
  expect(sent.length).toBe(1)
  expect(sent[0].text).toBe('The user ran /lk approve. ' + APPROVED_GATE + ' ' + CARRY_ON)
})

test('a refused submit is dropped when a main turn started before the retry', { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on, { fail: 1 })
  await atGate($)
  await cmd($, 'approve')
  // the first try (100 ms after the command) is refused; a turn starts before the retry 100 ms later
  await w.clock.advance(150)
  expect(w.refused()).toBe(1)
  await turnStart($)
  expect((await continued(w)).length).toBe(0)
})

// ---- /lk status --------------------------------------------------------------------------------------------------

test('/lk status says whether the model continues after an approval', { timeoutMs: 20_000 }, async ($, on) => {
  continueWorld(on)
  await start($)
  const status = await cmd($, 'status')
  expect(status).toContain('Continue after approval: on')
  expect(status.indexOf('Continue after approval: on')).toBeGreaterThan(status.indexOf('Plan approval: '))
})

test('/lk status says off when the config switches it off', { timeoutMs: 20_000 }, async ($, on) => {
  continueWorld(on, { files: { [PROJECT_CONFIG]: JSON.stringify({ pipeline: { continueOnApprove: false } }) } })
  await start($)
  expect(await cmd($, 'status')).toContain('Continue after approval: off')
})

// ---- The hold: only a prompt the person sent can make the plan gate wait ----------------------------------------

const HOLD_TEXT = 'Plan the cache, and wait for my approval before editing'

test("a plugin's, a peer's or a notification's prompt asking to wait leaves the hold off", { timeoutMs: 20_000 }, async ($, on) => {
  continueWorld(on)
  await start($)
  for (const origin of [{ kind: 'peer' }, { kind: 'task-notification' }, { kind: 'plugin', name: 'other' }]) {
    await $.prompt.submit({ text: HOLD_TEXT, origin } as never)
    expect(await cmd($, 'status')).toContain('Plan approval: auto')
  }
})

test("the person's prompt (composer, or no origin) asking to wait sets the hold", { timeoutMs: 20_000 }, async ($, on) => {
  continueWorld(on)
  await start($)
  await $.prompt.submit({ text: HOLD_TEXT, origin: { kind: 'composer' } } as never)
  expect(await cmd($, 'status')).toContain('Plan approval: held by this prompt')
})

test('a prompt with no origin asking to wait sets the hold', { timeoutMs: 20_000 }, async ($, on) => {
  continueWorld(on)
  await start($)
  await $.prompt.submit({ text: HOLD_TEXT } as never)
  expect(await cmd($, 'status')).toContain('Plan approval: held by this prompt')
})

// ---- Held, guarded and person-only approvals ---------------------------------------------------------------------

// The last value the stage wrote to one of its atoms: the test's state.set hook sees each write and passes it on
function watchAtoms(on: any): (key: string) => unknown {
  const last = new Map<string, unknown>()
  on('state.set', ($: unknown, e: { plugin?: string; key?: string; value?: unknown }, next: (e: unknown) => unknown) => {
    if (e?.plugin === 'loopkeeper' && typeof e.key === 'string') last.set(e.key, e.value)
    return next(e)
  })
  return key => last.get(key)
}

// Back at a waiting Validate plan gate after an approval: reset, plan again and move to the gate
async function regate($: Engine): Promise<void> {
  await cmd($, 'reset')
  await setStage($, { stage: 'plan', size: 'large', files: 13 })
  await cmd($, 'validate-plan')
}

async function paneApprove($: Engine): Promise<void> {
  const ui = await $.ui.mount(PANE as never)
  await ui.press({ key: 'approve' })
  await ui.unmount()
}

const PANE_SENT = 'The user pressed Approve gate. ' + APPROVED_GATE + ' ' + CARRY_ON
const COMMAND_SENT = 'The user ran /lk approve. ' + APPROVED_GATE + ' ' + CARRY_ON

test('no prompt: pipeline.continueOnApprove false in the user config', { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on, { files: { [USER_CONFIG]: JSON.stringify({ pipeline: { continueOnApprove: false } }) } })
  await atGate($)
  expect(await cmd($, 'approve')).toBe(APPROVED_GATE)
  expect((await continued(w)).length).toBe(0)
})

test('an approval held by a main turn that ends by interruption is cleared unsent, with running', { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on)
  const last = watchAtoms(on)
  await atGate($)
  const turn = await turnStart($)
  expect(await cmd($, 'approve')).toBe(APPROVED_GATE)
  expect(last('stageContinuePending')).toMatchObject({ stage: 'validate-plan' })
  await turnComplete($, turn, { reason: 'aborted' })
  expect(last('stageContinuePending')).toBe(null)
  expect(last('stageTurnRunning')).toBe(false)
  expect((await continued(w)).length).toBe(0)
  // nothing is left for a later turn end either
  await turnComplete($, await turnStart($))
  expect((await continued(w)).length).toBe(0)
})

test('a later approval during the same running turn replaces the held one: only its text goes', { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on)
  await atGate($)
  const turn = await turnStart($)
  await cmd($, 'approve')
  await regate($)
  await paneApprove($)
  await turnComplete($, turn)
  expect((await continued(w)).map(s => s.text)).toEqual([PANE_SENT])
})

test("/lk approve's timer drops the prompt when a main turn is running by then", { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on)
  await atGate($)
  expect(await cmd($, 'approve')).toBe(APPROVED_GATE)
  await turnStart($)
  expect((await continued(w)).length).toBe(0)
})

test("/lk approve's timer drops the prompt when a whole main turn ran before it fired", { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on)
  await atGate($)
  expect(await cmd($, 'approve')).toBe(APPROVED_GATE)
  await turnComplete($, await turnStart($))
  expect((await continued(w)).length).toBe(0)
})

test('one continue prompt until the next main turn starts: a second approval before it sends nothing', { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on)
  await atGate($)
  // queued by the timer, then a second approval before it fires; then a second one after it was sent
  await cmd($, 'approve')
  await regate($)
  await paneApprove($)
  expect((await continued(w)).map(s => s.text)).toEqual([COMMAND_SENT])
  await regate($)
  await paneApprove($)
  expect((await continued(w)).length).toBe(1)
  // a main turn started and ended: the next approval sends again
  await turnComplete($, await turnStart($))
  await regate($)
  await paneApprove($)
  expect((await continued(w)).map(s => s.text)).toEqual([COMMAND_SENT, PANE_SENT])
})

test('a continue prompt a hook drops starts no turn, so it frees the next approval', { timeoutMs: 20_000 }, async ($, on) => {
  let dropped = 0
  // above the world's stub: the first continue prompt is dropped, as a hook answering { drop } does
  on('prompt.submit', {}, ($: unknown, e: any, next: (e: unknown) => unknown) => {
    if (String(e?.text ?? '').endsWith(CARRY_ON) && dropped === 0) {
      dropped += 1
      return { drop: 'not now' }
    }
    return next(e)
  })
  const w = continueWorld(on)
  await atGate($)
  await paneApprove($)
  expect(dropped).toBe(1)
  expect((await continued(w)).length).toBe(0)
  // no main turn started, yet the next approval sends
  await regate($)
  await paneApprove($)
  expect((await continued(w)).map(s => s.text)).toEqual([PANE_SENT])
})

test("the person's prompt typed while idle clears a main turn still marked running; other prompts do not", { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on)
  const last = watchAtoms(on)
  await atGate($)
  // this turn's turn.complete never comes
  await turnStart($)
  await $.prompt.submit({ text: 'and the tests', origin: { kind: 'plugin', name: 'other' } } as never)
  await $.prompt.submit({ text: 'and the tests', origin: { kind: 'composer' }, turnId: 'turn-typed-over' } as never)
  expect(await cmd($, 'approve')).toBe(APPROVED_GATE)
  expect((await continued(w)).length).toBe(0)
  expect(last('stageContinuePending')).toMatchObject({ stage: 'validate-plan' })
  await $.prompt.submit({ text: 'and the tests', origin: { kind: 'composer' } } as never)
  expect(last('stageTurnRunning')).toBe(false)
  expect(last('stageContinuePending')).toBe(null)
  // idle now: the next approval goes at once
  await regate($)
  await paneApprove($)
  expect((await continued(w)).map(s => s.text)).toEqual([PANE_SENT])
})

test("another plugin's /lk approve is refused and changes nothing; the person's approves", { timeoutMs: 20_000 }, async ($, on) => {
  const w = continueWorld(on)
  await atGate($)
  for (const command of ['lk', 'loopkeeper']) {
    const out = (await $.command.run({ command, args: 'approve', origin: { kind: 'plugin', name: 'other' } } as never)) as { text?: string }
    expect(out?.text).toBe('Only the person can approve a gate.')
  }
  expect(await cmd($, 'status')).toContain('Gates: Validate plan pending')
  expect((await continued(w)).length).toBe(0)
  const out = (await $.command.run({ command: 'lk', args: 'approve', origin: { kind: 'composer' } } as never)) as { text?: string }
  expect(out?.text).toBe(APPROVED_GATE)
  expect((await continued(w)).map(s => s.text)).toEqual([COMMAND_SENT])
})
