// stage-approve.test.ts: /lk approve from the stage before a gate (lib/stageModel.ts gateAhead, stage.ts openGateAhead).
// With no gate of its own waiting and no file budget waiting, /lk approve opens the next stage's gate and moves into it:
// at gsd Plan the Validate plan gate (its verifier vouched, the planned budget approved), at gsd QA the Ship gate. The
// band button, the Stage pane's Approve gate and the hub's `a` go through the same approveGate.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { DEFAULT_STAGES, GSD_STAGES, gateAhead } from '../hooks/lib/stageModel.ts'
import type { Stage } from '../hooks/lib/stageModel.ts'
import { CWD, PROJECT_CONFIG, bash, edit, lk, projectGates, startTurn, tool, world } from './world.ts'
import type { World } from './world.ts'

const TOOL = 'mcp__loopkeeper__set_stage'
const GSD = 'loopkeeper:stage:preset:' + CWD
const CARRY_ON = 'Carry on with the task from where you stopped.'
const PLAN_OPENED = 'Approved the Validate plan gate and moved to Validate plan; Claude may start Execute.'
const SHIP_OPENED = 'Approved the Ship gate and moved to Ship: Claude may commit, push or open a PR.'

const PANE = {
  plugin: 'loopkeeper',
  component: 'Pane',
  requestId: 'loopkeeper-stage',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Stage', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
const HUB = { ...PANE, requestId: 'loopkeeper-hub', props: { ...PANE.props, title: 'loopkeeper' } }

// A custom pipeline: a gate two stages ahead of the first stage
const FAR: Stage[] = [{ id: 'draft', label: 'Draft' }, { id: 'edit', label: 'Edit' }, { id: 'review', label: 'Review', gate: true }]

type Verdict = { decision: string; reason?: string }
const check = async ($: any, call: unknown): Promise<Verdict> => (await $.tool.check(call)) as Verdict

async function setStage($: Engine, input: Record<string, unknown>): Promise<{ result?: string; deny?: string }> {
  return (await $.tool.call({ tool: TOOL, ...input } as never)) as { result?: string; deny?: string }
}

// The shared world in the gsd preset (or with `pipeline` in the project config), the plan gate of the gates on
function approveWorld(on: any, pipeline?: Record<string, unknown>): World {
  const config = { changeControl: { requirePlan: true }, ...(pipeline ? { pipeline } : {}) }
  const w = world(on, { now: 1_000_000, files: { [PROJECT_CONFIG]: JSON.stringify(config) } })
  if (!pipeline) w.store.set(GSD, 'gsd')
  return w
}

// The prompts loopkeeper submitted to carry on, once its timers have run
async function continued(w: World): Promise<unknown[]> {
  await w.clock.advance(5_000)
  return w.submitted.filter(s => typeof s.text === 'string' && s.text.endsWith(CARRY_ON)).map(s => s.text)
}

// The main turn ends, so the session is idle and an approval's continue prompt goes at once; `next` starts another
async function endTurn($: any, next?: string): Promise<void> {
  if (!next) {
    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 10, isAborted: false, usage: null, reason: 'answer' })
    return
  }
  await $.turn.start({ text: 'carry on', turnId: next })
}

// gsd at QA: a small task waives the plan gate and the verifier, then /lk qa
async function atQa($: Engine): Promise<void> {
  await startTurn($)
  await lk($, 'size small')
  expect(await lk($, 'qa')).toContain('to QA')
}

// ---- gateAhead ----------------------------------------------------------------------------------------------------

test('gateAhead: the adjacent next stage when it has a gate and the current stage holds no gate of its own', () => {
  expect(gateAhead(GSD_STAGES, 'plan', [])?.id).toBe('validate-plan')
  expect(gateAhead(GSD_STAGES, 'qa', [])?.id).toBe('ship')
  // approved or not
  expect(gateAhead(GSD_STAGES, 'plan', ['validate-plan'])?.id).toBe('validate-plan')
  // the current stage's own gate waits: that one first
  expect(gateAhead(GSD_STAGES, 'validate-plan', [])).toBeUndefined()
  // the next stage has no gate, or there is none
  expect(gateAhead(GSD_STAGES, 'validate-plan', ['validate-plan'])).toBeUndefined()
  expect(gateAhead(GSD_STAGES, 'execute', [])).toBeUndefined()
  expect(gateAhead(GSD_STAGES, 'ship', ['ship'])).toBeUndefined()
  expect(gateAhead(DEFAULT_STAGES, 'qa', [])).toBeUndefined()
  // never two stages ahead, never from an unknown stage
  expect(gateAhead(FAR, 'draft', [])).toBeUndefined()
  expect(gateAhead(FAR, 'edit', [])?.id).toBe('review')
  expect(gateAhead(GSD_STAGES, 'gone', [])).toBeUndefined()
  // an approved gate followed by another gate
  const twice: Stage[] = [{ id: 'a', label: 'A', gate: true }, { id: 'b', label: 'B', gate: true }]
  expect(gateAhead(twice, 'a', ['a'])?.id).toBe('b')
  expect(gateAhead(twice, 'a', [])).toBeUndefined()
})

// ---- /lk approve ahead --------------------------------------------------------------------------------------------

test('gsd at Plan: /lk approve opens the plan gate, moves to Validate plan and approves the budget; edits and Execute follow', { timeoutMs: 20_000 }, async ($, on) => {
  const w = approveWorld(on)
  await startTurn($)
  await setStage($, { stage: 'plan', size: 'large', files: 13 })
  expect((await check($, edit(CWD + '/src/a.ts'))).decision).toBe('deny')
  await endTurn($)
  expect(await lk($, 'approve')).toBe(PLAN_OPENED + ' File budget: 23 files a turn (13 planned + 10).')
  expect(w.state.get('stageCurrent')).toBe('validate-plan')
  expect(w.state.get('stageApproved')).toEqual(['validate-plan'])
  expect(w.state.get('stageVerified')).toEqual(['validate-plan'])
  expect(w.state.get('stageBudget')).toBe(23)
  expect(w.state.get('stagePlanDone')).toBe(true)
  // one continue prompt
  expect(await continued(w)).toEqual(['The user ran /lk approve. ' + PLAN_OPENED + ' File budget: 23 files a turn (13 planned + 10). ' + CARRY_ON])
  await endTurn($, 't2')
  expect((await check($, edit(CWD + '/src/a.ts'))).decision).toBe('allow')
  // no validator verdict is needed to move on
  expect((await setStage($, { stage: 'execute' })).result).toContain('Moved from Validate plan to Execute.')
  expect(w.state.get('stageVerdict') ?? null).toBe(null)
})

// The case that showed the bug: two plan review rounds that did not converge leave the pipeline at Plan, and one
// /lk approve still opens the plan gate (no /lk gates plan ok needed)
test('gsd at Plan after two non-converging plan reviews: one /lk approve opens edits and Execute', { timeoutMs: 20_000 }, async ($, on) => {
  const w = approveWorld(on)
  await startTurn($)
  await setStage($, { stage: 'plan', size: 'large', files: 2 })
  const items = [{ text: 'tighten the Done-when', priority: 'p1' }]
  await tool($, 'review_cycle', { subject: 'site plan', kind: 'plan', verdict: 'iterate', items })
  const last = String((await tool($, 'review_cycle', { subject: 'site plan', verdict: 'iterate', items })).result)
  expect(last).toContain('not converging')
  expect(w.state.get('stageCurrent')).toBe('plan')
  expect((await check($, bash('echo x > notes.md'))).decision).toBe('deny')
  await endTurn($)
  expect(await lk($, 'approve')).toStartWith(PLAN_OPENED)
  await endTurn($, 't2')
  expect((await check($, bash('echo x > notes.md'))).decision).toBe('allow')
  expect((await setStage($, { stage: 'execute' })).result).toContain('Moved from Validate plan to Execute.')
})

test('gsd at QA: /lk approve opens the Ship gate and moves to Ship; shipping opens', { timeoutMs: 20_000 }, async ($, on) => {
  const w = approveWorld(on)
  await atQa($)
  expect((await check($, bash('git commit -m x'))).decision).toBe('deny')
  await endTurn($)
  expect(await lk($, 'approve')).toBe(SHIP_OPENED)
  expect(w.state.get('stageCurrent')).toBe('ship')
  expect(w.state.get('stageApproved')).toContain('ship')
  expect(w.state.get('stageShipOpen')).toBe(true)
  expect(await continued(w)).toEqual(['The user ran /lk approve. ' + SHIP_OPENED + ' ' + CARRY_ON])
  await endTurn($, 't2')
  expect((await check($, bash('git commit -m x'))).decision).toBe('allow')
})

test("the current stage's verifier is vouched for by the approval", { timeoutMs: 20_000 }, async ($, on) => {
  const w = approveWorld(on, {
    stages: [{ id: 'build', label: 'Build' }, { id: 'check', label: 'Check', requiresAgent: 'verif' }, { id: 'release', label: 'Release', gate: true }],
  })
  await startTurn($)
  await lk($, 'check')
  expect(await lk($, 'next')).toContain('needs a verifier')
  expect(await lk($, 'approve')).toBe('Approved the Release gate and moved to Release.')
  expect(w.state.get('stageCurrent')).toBe('release')
  expect(w.state.get('stageVerified')).toContain('check')
  expect(w.state.get('stageApproved')).toEqual(['release'])
})

test('a next stage with no gate: "has no gate to approve" as before, nothing moves and no prompt', { timeoutMs: 20_000 }, async ($, on) => {
  const w = approveWorld(on)
  await startTurn($)
  await lk($, 'size small')
  expect(await lk($, 'approve')).toBe('Execute has no gate to approve.')
  expect(w.state.get('stageCurrent')).toBe('execute')
  expect(await continued(w)).toEqual([])
})

test('a gate two stages ahead is not approved', { timeoutMs: 20_000 }, async ($, on) => {
  const w = approveWorld(on, { stages: FAR })
  await startTurn($)
  expect(await lk($, 'approve')).toBe('Draft has no gate to approve.')
  expect(w.state.get('stageCurrent') ?? 'draft').toBe('draft')
  expect(w.state.get('stageApproved') ?? []).toEqual([])
})

test('a waiting file budget still goes first: this /lk approve approves the budget, the next one the Ship gate', { timeoutMs: 20_000 }, async ($, on) => {
  const w = approveWorld(on)
  await startTurn($)
  await setStage($, { stage: 'plan', size: 'large', files: 41 })
  await $.tool.call({ tool: 'Agent', subagent_type: 'general-purpose', description: 'Plan validator: check the plan', prompt: 'x' } as never)
  // the verdict opens the plan gate; 41 planned files are over autoBudgetMax, so the budget waits
  await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  for (const step of ['execute', 'validate', 'waive', 'qa']) await lk($, step)
  expect(w.state.get('stageCurrent')).toBe('qa')
  expect(await lk($, 'approve')).toBe('Approved the file budget. File budget: 51 files a turn (41 planned + 10).')
  expect(w.state.get('stageCurrent')).toBe('qa')
  expect(w.state.get('stageApproved')).toEqual(['validate-plan'])
  expect(await lk($, 'approve')).toBe(SHIP_OPENED)
  expect(w.state.get('stageCurrent')).toBe('ship')
})

test('the next gate already approved (after /lk back): moved into it without approving it again', { timeoutMs: 20_000 }, async ($, on) => {
  const w = approveWorld(on)
  await startTurn($)
  await setStage($, { stage: 'plan', size: 'large', files: 13 })
  await lk($, 'approve')
  expect(await lk($, 'back')).toContain('to Plan')
  const again = await lk($, 'approve')
  expect(again).toContain('Moved to Validate plan; its gate was already approved.')
  expect(again).not.toContain('Approved the')
  expect(w.state.get('stageCurrent')).toBe('validate-plan')
  expect(w.state.get('stageApproved')).toEqual(['validate-plan'])
  expect(w.state.get('stageVerified')).toEqual(['validate-plan'])
})

test("the Stage pane's Approve gate at Plan does what /lk approve does, with one prompt", { timeoutMs: 20_000 }, async ($, on) => {
  const w = approveWorld(on)
  await startTurn($)
  await setStage($, { stage: 'plan', size: 'large', files: 13 })
  await endTurn($)
  const ui = await $.ui.mount(PANE as never)
  await ui.press({ key: 'approve' })
  await ui.unmount()
  expect(w.state.get('stageCurrent')).toBe('validate-plan')
  expect(w.state.get('stageApproved')).toEqual(['validate-plan'])
  expect(w.state.get('stageBudget')).toBe(23)
  expect(await continued(w)).toEqual(['The user pressed Approve gate. ' + PLAN_OPENED + ' File budget: 23 files a turn (13 planned + 10). ' + CARRY_ON])
})

test("the hub's a at QA opens the Ship gate; it shows while a task is in play and the next gate can be opened", { timeoutMs: 20_000 }, async ($, on) => {
  const w = approveWorld(on)
  await startTurn($)
  // a fresh session at Plan: nothing to approve yet
  const fresh = await $.ui.mount(HUB as never)
  expect(await fresh.find({ key: 'hub-approve' })).toBeUndefined()
  await fresh.unmount()
  await lk($, 'size small')
  expect(await lk($, 'qa')).toContain('to QA')
  await endTurn($)
  const ui = await $.ui.mount(HUB as never)
  await ui.press({ key: 'hub-approve' })
  await ui.unmount()
  expect(w.state.get('stageCurrent')).toBe('ship')
  expect(w.state.get('stageShipOpen')).toBe(true)
  expect(await continued(w)).toEqual(['The user pressed Approve gate. ' + SHIP_OPENED + ' ' + CARRY_ON])
})
