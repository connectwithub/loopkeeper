// stage-approve.test.ts: /lk approve from the stage before a gate (lib/stageModel.ts gateAhead, stage.ts openGateAhead).
// With no gate of its own waiting and no file budget waiting, /lk approve opens the next stage's gate and moves into it:
// at gsd Plan the Validate plan gate (its verifier vouched, the planned budget approved), at gsd QA the Ship gate. The
// band button, the Stage pane's Approve gate and the hub's `a` go through the same approveGate.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { DEFAULT_STAGES, GSD_STAGES, gateAhead } from '../hooks/lib/stageModel.ts'
import type { Stage } from '../hooks/lib/stageModel.ts'
import { CWD, PROJECT_CONFIG, bash, edit, lk, pressBand, pressPane, projectGates, startTurn, tool, world } from './world.ts'
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
// A whole main turn: ADR 0012 allows one continue prompt a turn
async function turnOver($: any, id: string): Promise<void> {
  await $.turn.start({ text: 'carry on', turnId: id })
  await $.turn.complete({ turnId: id, answer: 'done', durationMs: 10, isAborted: false, usage: null, reason: 'answer' })
}

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
  // the refused commit is a fresh request: the first /lk approve answers it and says the Ship gate still waits
  expect(await lk($, 'approve')).toBe('Allowed git commit once. The Ship gate is still waiting; /lk approve again to approve it.')
  expect(w.state.get('stageCurrent')).toBe('qa')
  expect(await continued(w)).toEqual(['The user allowed git commit once. Run the refused call again. ' + CARRY_ON])
  // one continue prompt a turn (ADR 0012): the second approval comes in the next turn
  await turnOver($, 't2')
  expect(await lk($, 'approve')).toBe(SHIP_OPENED)
  expect(w.state.get('stageCurrent')).toBe('ship')
  expect(w.state.get('stageApproved')).toContain('ship')
  expect(w.state.get('stageShipOpen')).toBe(true)
  expect((await continued(w)).slice(1)).toEqual(['The user ran /lk approve. ' + SHIP_OPENED + ' ' + CARRY_ON])
  await endTurn($, 't3')
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

// ---- Gate requests: cards, the Gates pane, /lk approve, /lk gates (plan 1.x, 2.1-2.3) ------------------------------

const DOCS = CWD + '/docs/decisions/a.md'
const DOCS_B = CWD + '/docs/decisions/b.md'
const PUSH = 'git push origin main'
const OTHER = { kind: 'plugin', name: 'other' }

// The desktop app: the refusal waits on the card above the prompt
function deskWorld(on: any, store?: string): World {
  const w = world(on, { now: 1_000_000, surfaces: ['desktop'], files: { [PROJECT_CONFIG]: JSON.stringify({ changeControl: { requirePlan: false } }) } })
  if (store) w.store.set(GSD, store)
  return w
}

const requests = (w: World): Array<{ id: string; kind: string; target: string }> => (w.state.get('gateRequests') as never) ?? []
const lkFrom = async ($: any, args: string): Promise<string> =>
  String(((await $.command.run({ command: 'lk', args, origin: OTHER } as never)) as { text?: string })?.text ?? '')

test('card: Allow all of the glob lets later edits pass and carries on once; the grant is added to, not replaced', { timeoutMs: 20_000 }, async ($, on) => {
  const w = deskWorld(on)
  await startTurn($)
  expect((await check($, edit(DOCS))).decision).toBe('deny')
  expect(requests(w).map(r => r.target)).toEqual([DOCS.slice(CWD.length + 1)])
  await endTurn($)
  await pressBand($, 'gate-request-r1-session')
  expect(requests(w)).toEqual([])
  expect(w.state.get('gateGlobGrants')).toEqual(['docs/decisions/**'])
  expect((await check($, edit(DOCS_B))).decision).toBe('allow')
  expect(await continued(w)).toEqual(['The user allowed all of docs/decisions/** for this session. Run the refused call again. ' + CARRY_ON])
  expect((w.state.get('gateLog') as Array<{ detail: string }>).at(-1)?.detail).toBe('allowed on the card')
  // a grant the stage wrote survives a later /lk gates allow
  await lk($, 'gates allow src/x.ts')
  expect(w.state.get('gateGlobGrants')).toEqual(['docs/decisions/**'])
})

test('card: Allow this file covers only that file; Deny keeps refusing and tells Claude not to retry', { timeoutMs: 20_000 }, async ($, on) => {
  const w = deskWorld(on)
  await startTurn($)
  await check($, edit(DOCS))
  await endTurn($)
  await pressBand($, 'gate-request-r1-allow')
  expect((await check($, edit(DOCS))).decision).toBe('allow')
  expect((await check($, edit(DOCS_B))).decision).toBe('deny')
  await lk($, 'gates allow docs/decisions/c.md')
  expect(w.state.get('gateGrants')).toEqual([DOCS.slice(CWD.length + 1), 'docs/decisions/c.md'])
  // one continue prompt a turn (ADR 0012): the card's answer went, /lk gates allow's did not
  expect((await continued(w)).length).toBe(1)
  // the request for b.md is waiting; Deny drops it
  expect(requests(w).map(r => r.id)).toEqual(['r2'])
  await turnOver($, 't2')
  await pressBand($, 'gate-request-r2-deny')
  expect(requests(w)).toEqual([])
  expect((await check($, edit(DOCS_B))).decision).toBe('deny')
  await w.clock.advance(5_000)
  expect(String(w.submitted.at(-1)?.text)).toBe('The user denied the edit to docs/decisions/b.md. Do not retry it; ask the user how to proceed.')
})

test('card: a push is allowed once or for the session; a ship command once, and not a different one', { timeoutMs: 20_000 }, async ($, on) => {
  const w = deskWorld(on)
  await startTurn($)
  expect((await check($, bash(PUSH))).decision).toBe('deny')
  await endTurn($)
  await pressBand($, 'gate-request-r1-allow')
  expect((await check($, bash(PUSH))).decision).toBe('allow')
  expect((await check($, bash(PUSH))).decision).toBe('deny')
  await pressBand($, 'gate-request-r2-session')
  expect(w.state.get('gateMergeSession')).toBe(true)
  expect((await check($, bash(PUSH))).decision).toBe('allow')
  expect((await check($, bash(PUSH))).decision).toBe('allow')
  expect((await continued(w)).length).toBeGreaterThanOrEqual(1)
})

test('card: Allow this ship command once lets that call through and not another; Open shipping opens it', { timeoutMs: 20_000 }, async ($, on) => {
  const w = deskWorld(on, 'gsd')
  await startTurn($)
  expect((await check($, bash('git commit -m x'))).decision).toBe('deny')
  await endTurn($)
  const id = requests(w)[0]!.id
  await pressBand($, 'gate-request-' + id + '-allow')
  expect(w.state.get('gateShipOnce')).toEqual(['git commit'])
  expect((await check($, bash('npm publish'))).decision).toBe('deny')
  expect((await check($, bash('git commit -m x'))).decision).toBe('allow')
  expect((await check($, bash('git commit -m y'))).decision).toBe('deny')
  await turnOver($, 't2')
  const open = requests(w).find(r => r.target === 'git commit')!.id
  await pressBand($, 'gate-request-' + open + '-session')
  expect(w.state.get('gateShipOk')).toBe(true)
  expect((await check($, bash('git commit -m z'))).decision).toBe('allow')
  expect((await continued(w)).length).toBe(2)
})

test('an unused once-grant goes with the stage it was given at, as the merge credit does', { timeoutMs: 20_000 }, async ($, on) => {
  const w = deskWorld(on, 'gsd')
  await startTurn($)
  expect((await check($, bash('git commit -m x'))).decision).toBe('deny')
  await endTurn($)
  await pressBand($, 'gate-request-' + requests(w)[0]!.id + '-allow')
  expect(w.state.get('gateShipOnce')).toEqual(['git commit'])
  await lk($, 'size small')
  expect(w.state.get('stageCurrent')).toBe('execute')
  expect(w.state.get('gateShipOnce')).toEqual([])
  expect((await check($, bash('git commit -m x'))).decision).toBe('deny')
})

test('the Gates pane answers a request like the card', { timeoutMs: 20_000 }, async ($, on) => {
  const w = deskWorld(on)
  await startTurn($)
  await check($, edit(DOCS))
  await endTurn($)
  await pressPane($, 'loopkeeper-gates', 'gate-request-r1-allow')
  expect(w.state.get('gateGrants')).toEqual([DOCS.slice(CWD.length + 1)])
  expect((await continued(w)).length).toBe(1)
})

test('/lk approve at Execute answers a fresh request first, naming it; an older one is answered when nothing else waits', { timeoutMs: 20_000 }, async ($, on) => {
  const w = deskWorld(on, 'gsd')
  await startTurn($)
  await lk($, 'size small')
  expect(w.state.get('stageCurrent')).toBe('execute')
  await check($, edit(DOCS))
  await endTurn($)
  expect(await lk($, 'approve')).toBe(`Allowed ${DOCS.slice(CWD.length + 1)} for this session.`)
  expect(w.state.get('gateGrants')).toEqual([DOCS.slice(CWD.length + 1)])
  expect((await continued(w)).length).toBe(1)
  // a question in between: the request is from an older turn, and Execute has no gate of its own
  await endTurn($, 't2')
  await check($, bash('git commit -m x'))
  await endTurn($, 't3')
  expect(requests(w).map(r => r.kind)).toEqual(['ship'])
  expect(await lk($, 'approve')).toBe('Allowed git commit once.')
  // with none pending, today's answer stays
  expect(await lk($, 'approve')).toBe('Execute has no gate to approve.')
})

test('requests expire on a stage move and after three main turns', { timeoutMs: 20_000 }, async ($, on) => {
  const w = deskWorld(on)
  await startTurn($)
  await check($, edit(DOCS))
  expect(requests(w).length).toBe(1)
  await lk($, 'size small')
  expect(requests(w)).toEqual([])
  await check($, edit(DOCS_B))
  expect(requests(w).length).toBe(1)
  await endTurn($)
  await endTurn($, 't2')
  expect(requests(w).length).toBe(1)
  await endTurn($, 't3')
  await endTurn($, 't4')
  expect(requests(w)).toEqual([])
  expect(await lk($, 'approve')).not.toContain('Allowed')
})

test('/lk gates allow | ship ok | merge ok | plan ok | max from the person carry on once each; from another plugin all five refuse', { timeoutMs: 30_000 }, async ($, on) => {
  const w = deskWorld(on)
  await startTurn($)
  await endTurn($)
  for (const words of ['gates allow docs/decisions/a.md', 'gates ship ok', 'gates merge ok', 'gates plan ok', 'gates max 7']) {
    expect(await lkFrom($, words)).toStartWith('Only the user')
  }
  expect(await continued(w)).toEqual([])
  const before = w.submitted.length
  expect(await lk($, 'gates merge ok')).toContain('allowed')
  const sent = await continued(w)
  expect(sent.length).toBe(1)
  expect(String(sent[0])).toBe('The user allowed the next push or merge to the default branch. Run the refused call again. ' + CARRY_ON)
  expect(w.submitted.length).toBe(before + 1)
  await lk($, 'gates max 7')
  await endTurn($, 't2')
  await endTurn($, 't2')
  expect((await continued(w)).length).toBeGreaterThanOrEqual(1)
})

test('the words that loosen a gate are the user\'s: from another plugin gates off, ship gate off and plan required off refuse; the on words do not', { timeoutMs: 20_000 }, async ($, on) => {
  const w = deskWorld(on, 'gsd')
  await startTurn($)
  await lk($, 'gates plan required on')
  for (const words of ['gates off', 'gates ship gate off', 'gates plan required off']) {
    expect(await lkFrom($, words)).toStartWith('Only the user')
  }
  expect(w.state.get('gateEnabled')).not.toBe(false)
  expect((await check($, bash('git commit -m x'))).decision).toBe('deny')
  expect((await check($, edit(DOCS))).decision).toBe('deny')
  expect(await lkFrom($, 'gates ship gate on')).toBe('shipGate is on for this session.')
  expect(await lkFrom($, 'gates on')).toStartWith('gates on')
  expect(await lk($, 'gates off')).toStartWith('gates off')
  expect(w.state.get('gateEnabled')).toBe(false)
})

// ---- Claude moving back re-gates (set_stage); the user's /lk back does not ----------------------------------------

const NEW_WORK =
  "If this is new work rather than a fix to the work being shipped, call set_stage {stage:'plan', size, files, note}: a new task starts at Plan."

test('set_stage execute from Ship drops the Ship approval and the merge credit, and says new work starts at Plan', { timeoutMs: 20_000 }, async ($, on) => {
  const w = approveWorld(on)
  await startTurn($)
  await lk($, 'size small')
  await lk($, 'ship')
  expect(await lk($, 'approve')).toContain('Approved the Ship gate')
  expect(w.state.get('stageApproved')).toContain('ship')
  expect(w.state.get('gateMergeCredit')).toBe(true)
  const r = await setStage($, { stage: 'execute' })
  expect(r.result).toContain('Moved from Ship to Execute.')
  expect(r.result).toContain(NEW_WORK)
  expect(r.result).toContain('The Ship approval was dropped.')
  expect(w.state.get('stageApproved')).not.toContain('ship')
  expect(w.state.get('gateMergeCredit')).toBe(false)
  expect(w.state.get('stageShipUsed')).toBe(false)
  expect(w.state.get('stageShipOpen')).toBe(false)
})

test('set_stage back from QA without a Ship approval has the new-work sentence only', { timeoutMs: 20_000 }, async ($, on) => {
  approveWorld(on)
  await startTurn($)
  await lk($, 'size small')
  await lk($, 'waive')
  await lk($, 'qa')
  const r = await setStage($, { stage: 'execute' })
  expect(r.result).toContain(NEW_WORK)
  expect(r.result).not.toContain('The Ship approval was dropped.')
})

test('set_stage plan with no size from Execute drops the Validate plan approval; at Plan it is still "Already in Plan."', { timeoutMs: 20_000 }, async ($, on) => {
  const w = approveWorld(on)
  await startTurn($)
  await setStage($, { stage: 'plan', size: 'large', files: 13 })
  await lk($, 'approve')
  await lk($, 'execute')
  expect(w.state.get('stageCurrent')).toBe('execute')
  expect(w.state.get('stageApproved')).toContain('validate-plan')
  const r = await setStage($, { stage: 'plan' })
  expect(r.result).toContain('Moved from Execute to Plan.')
  expect(r.result).not.toContain(NEW_WORK)
  expect(w.state.get('stageApproved')).not.toContain('validate-plan')
  expect((await setStage($, { stage: 'plan' })).result).toContain('Already in Plan.')
})

test('/lk back keeps the approvals', { timeoutMs: 20_000 }, async ($, on) => {
  const w = approveWorld(on)
  await startTurn($)
  await lk($, 'size small')
  await lk($, 'ship')
  await lk($, 'approve')
  expect(await lk($, 'back')).toContain('to QA')
  expect(w.state.get('stageApproved')).toContain('ship')
})
