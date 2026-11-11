// stage-card.test.ts: the gate card above the prompt (lib/stageModel.ts gateCard; stage.ts gateCardNow, rejectGate and
// pressGateCard). A Validate plan gate that waits for the user, a Ship gate, a custom gate, a gate ahead that a move
// jumped past and a verifier that held a move each show a card: which gate, why, Approve, Reject and the command typed
// instead. Approve runs /lk approve's path (/lk waive's for a verifier), Reject runs /lk reject, and the card clears
// once answered. The gates' request cards are in gates-desktop.test.ts and stage-approve.test.ts.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { GATE_COMMANDS, GSD_STAGES, VERIFIER_COMMANDS, gateCard } from '../hooks/lib/stageModel.ts'
import type { GateCardState, Stage } from '../hooks/lib/stageModel.ts'
import { BAND, CWD, PROJECT_CONFIG, bash, lk, pressBand, start, texts, world } from './world.ts'
import type { World } from './world.ts'

const TOOL = 'mcp__loopkeeper__set_stage'
const GSD = 'loopkeeper:stage:preset:' + CWD
const SLOW = { timeoutMs: 20_000 }
const CARRY_ON = 'Carry on with the task from where you stopped.'
const OTHER = { kind: 'plugin', name: 'other' }
const validator = { tool: 'Agent', subagent_type: 'general-purpose', description: 'Plan validator: check the plan', prompt: 'x' }
const verifier = { tool: 'Agent', subagent_type: 'general-purpose', description: 'Verify the work against Done-when', prompt: 'x' }

const STAGE_PANE = {
  plugin: 'loopkeeper',
  component: 'Pane',
  requestId: 'loopkeeper-stage',
  surface: 'desktop',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Stage', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const REJECT_PLAN =
  'The user rejected the plan at the Validate plan gate. Do not move past it: ask the user what to change, revise the plan ' +
  'and have it validated again; only the user can approve it now.'

// ---- The model ----------------------------------------------------------------------------------------------------

// A large task of 13 planned files at the gsd Validate plan gate, in approval mode auto, nothing held
const at = (over: Partial<GateCardState> = {}): GateCardState => ({
  stages: GSD_STAGES,
  current: 'validate-plan',
  approved: [],
  size: 'large',
  planFiles: 13,
  budget: 0,
  approval: 'auto',
  hold: false,
  verified: [],
  waived: [],
  shipOk: false,
  shipGate: true,
  held: null,
  rejected: '',
  shipAsked: false,
  ...over,
})

const REVIEW: Stage[] = [{ id: 'build', label: 'Build' }, { id: 'review', label: 'Review', gate: true }, { id: 'release', label: 'Release' }]

test('gateCard: the Validate plan gate shows while it waits for the user, or after a refused move in auto mode', () => {
  // auto mode: the validator's verdict opens it, so nothing asks the user yet
  expect(gateCard(at())).toBeNull()
  expect(gateCard(at({ approval: 'ask' }))).toEqual({
    kind: 'gate',
    stage: 'validate-plan',
    title: 'loopkeeper · Validate plan gate',
    head: 'The plan · 13 files planned → Execute',
    why: 'plan approval is ask: every plan waits for your yes',
    approve: 'Approve plan · 13 files',
    reject: 'Reject',
    commands: GATE_COMMANDS,
  })
  expect(gateCard(at({ hold: true }))?.why).toBe('the plan waits for your own approval')
  const held = { stage: 'validate-plan', target: 'execute', reason: 'gate' as const }
  expect(gateCard(at({ held }))?.why).toBe('Claude tried to move on to Execute; no validator has found the plan consistent')
  expect(gateCard(at({ held, planFiles: null }))).toMatchObject({ head: 'The plan → Execute', approve: 'Approve plan' })
  // answered or rejected: none
  expect(gateCard(at({ approval: 'ask', approved: ['validate-plan'], budget: 23 }))).toBeNull()
  expect(gateCard(at({ approval: 'ask', rejected: 'validate-plan' }))).toBeNull()
  expect(GATE_COMMANDS).toBe('or type /lk approve · /lk reject')
})

test('gateCard: the Ship gate shows while it holds shipping, not with the ship gate off, ship ok, or a ship request asking', () => {
  const ship = at({ current: 'ship', approved: ['validate-plan'], budget: 23 })
  expect(gateCard(ship)).toEqual({
    kind: 'gate',
    stage: 'ship',
    title: 'loopkeeper · Ship gate',
    head: 'Commit, push or open a PR',
    why: 'the Ship gate holds shipping until you approve it',
    approve: 'Approve Ship gate',
    reject: 'Reject',
    commands: GATE_COMMANDS,
  })
  expect(gateCard({ ...ship, shipGate: false })).toBeNull()
  expect(gateCard({ ...ship, shipOk: true })).toBeNull()
  expect(gateCard({ ...ship, shipAsked: true })).toBeNull()
  expect(gateCard({ ...ship, approved: ['validate-plan', 'ship'] })).toBeNull()
  // a planned budget waits first: its own button asks, as /lk approve answers the budget first
  expect(gateCard({ ...ship, budget: 0 })).toBeNull()
})

test('gateCard: any other gate stage always waits for the user; a refused move says so', () => {
  const s = at({ stages: REVIEW, current: 'review', size: '', planFiles: null })
  expect(gateCard(s)).toEqual({
    kind: 'gate',
    stage: 'review',
    title: 'loopkeeper · Review gate',
    head: 'Review → Release',
    why: 'the Review gate holds the move to Release until you approve it',
    approve: 'Approve Review gate',
    reject: 'Reject',
    commands: GATE_COMMANDS,
  })
  expect(gateCard({ ...s, held: { stage: 'review', target: 'release', reason: 'gate' } })?.why).toBe(
    'Claude tried to move on to Release; the Review gate holds the move to Release until you approve it',
  )
  const last: Stage[] = [{ id: 'build', label: 'Build' }, { id: 'sign', label: 'Sign-off', gate: true }]
  expect(gateCard(at({ stages: last, current: 'sign', size: '', planFiles: null }))).toMatchObject({ head: 'Sign-off', why: 'the Sign-off gate waits for your approval' })
})

test('gateCard: a verifier that held a move out of the current stage; none once verified or rejected', () => {
  const v = at({ current: 'validate', approved: ['validate-plan'], budget: 23 })
  expect(gateCard(v)).toBeNull()
  const held = { stage: 'validate', target: 'qa', reason: 'agent' as const }
  expect(gateCard({ ...v, held })).toEqual({
    kind: 'verifier',
    stage: 'validate',
    title: 'loopkeeper · Validate verifier',
    head: 'Validate → QA',
    why: 'Claude tried to move on to QA before a verifier subagent checked the work',
    approve: 'Approve without a verifier',
    reject: 'Reject',
    commands: VERIFIER_COMMANDS,
  })
  expect(gateCard({ ...v, held, verified: ['validate'] })).toBeNull()
  expect(gateCard({ ...v, held, rejected: 'validate' })).toBeNull()
  expect(VERIFIER_COMMANDS).toBe('or type /lk waive · /lk reject')
})

test('gateCard: a move that jumped past the next stage’s gate shows the gate ahead, as /lk approve would open it', () => {
  const plan = at({ current: 'plan', held: { stage: 'validate-plan', target: 'execute', reason: 'gate' } })
  expect(gateCard(plan)).toEqual({
    kind: 'ahead',
    stage: 'validate-plan',
    title: 'loopkeeper · Validate plan gate',
    head: 'Plan → Execute',
    why: 'Claude tried to move past Validate plan; approving opens its gate and moves there',
    approve: 'Approve Validate plan gate',
    reject: 'Reject',
    commands: GATE_COMMANDS,
  })
  expect(gateCard({ ...plan, held: null })).toBeNull()
  expect(gateCard({ ...plan, rejected: 'validate-plan' })).toBeNull()
})

// ---- The hooks: the card on the desktop band ---------------------------------------------------------------------

// The shared world on the desktop, in the gsd preset unless `pipeline` gives the project's stages
function cardWorld(on: any, pipeline?: Record<string, unknown>): World {
  const files = pipeline ? { [PROJECT_CONFIG]: JSON.stringify({ pipeline }) } : {}
  const w = world(on, { now: 1_000_000, files, surfaces: ['desktop'] })
  if (!pipeline) w.store.set(GSD, 'gsd')
  return w
}

async function setStage($: Engine, input: Record<string, unknown>): Promise<{ result?: string; deny?: string }> {
  return (await $.tool.call({ tool: TOOL, ...input } as never)) as { result?: string; deny?: string }
}

/** The desktop band: every text drawn, and the gate card's Approve and Reject labels (null when not drawn). */
async function card($: Engine): Promise<{ texts: string[]; approve: string | null; reject: string | null }> {
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
  const tree = await ui.drawn()
  const a = (await ui.find({ key: 'stage-approve' })) as { props?: { label?: unknown } } | undefined
  const r = (await ui.find({ key: 'stage-reject' })) as { props?: { label?: unknown } } | undefined
  await ui.unmount()
  return { texts: texts(tree), approve: a ? String(a.props?.label) : null, reject: r ? String(r.props?.label) : null }
}

/** The prompts loopkeeper submitted after an answer, once its timers have run. */
async function sent(w: World): Promise<string[]> {
  await w.clock.advance(5_000)
  return w.submitted.filter(s => typeof s.text === 'string' && s.text.startsWith('The user ')).map(s => String(s.text))
}

/** A main turn starts and ends, so the next answer's carry-on prompt may go (one a turn). */
async function turnOver($: any, id: string): Promise<void> {
  await $.turn.start({ text: 'carry on', turnId: id })
  await $.turn.complete({ turnId: id, answer: 'done', durationMs: 10, isAborted: false, usage: null, reason: 'answer' })
}

const history = (w: World) => (w.state.get('stageHistory') ?? []) as Array<{ stage: string; by: string; note?: string; event?: string }>

// A large task of 13 planned files at the gsd Validate plan gate in approval mode ask, its validator done
async function askGate($: Engine): Promise<void> {
  await start($)
  await lk($, 'approval ask')
  await setStage($, { stage: 'plan', size: 'large', files: 13 })
  await $.tool.call(validator as never)
  await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
}

// A large task of 5 files, its plan validated (the gate opened by the verdict), now at Validate
async function atValidate($: Engine): Promise<void> {
  await start($)
  await setStage($, { stage: 'plan', size: 'large', files: 5 })
  await $.tool.call(validator as never)
  await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  await setStage($, { stage: 'execute' })
  expect((await setStage($, { stage: 'validate' })).result).toContain('Moved from Execute to Validate.')
}

test('Validate plan gate (ask): the card names the gate and why; Approve approves it as /lk approve does and clears', SLOW, async ($, on) => {
  const w = cardWorld(on)
  await askGate($)
  const c = await card($)
  expect(c.approve).toBe('Approve plan · 13 files')
  expect(c.reject).toBe('Reject')
  for (const t of ['loopkeeper · Validate plan gate', 'The plan · 13 files planned → Execute', 'plan approval is ask: every plan waits for your yes', GATE_COMMANDS]) {
    expect(c.texts).toContain(t)
  }
  await pressBand($, 'stage-approve')
  expect(w.state.get('stageApproved')).toEqual(['validate-plan'])
  expect(w.state.get('stageCurrent')).toBe('validate-plan')
  expect(w.state.get('stageBudget')).toBe(23)
  expect(await sent(w)).toEqual([
    'The user pressed Approve plan · 13 files. Approved the Validate plan gate; the pipeline may now move past it. File budget: 23 files a turn (13 planned + 10). ' +
      CARRY_ON,
  ])
  const after = await card($)
  expect([after.approve, after.reject]).toEqual([null, null])
  expect(after.texts).not.toContain('loopkeeper · Validate plan gate')
  expect((await setStage($, { stage: 'execute' })).result).toContain('Moved from Validate plan to Execute.')
})

test('Validate plan gate (ask): Reject keeps it closed and holds the plan, notes it and tells Claude; the card clears', SLOW, async ($, on) => {
  const w = cardWorld(on)
  await askGate($)
  await pressBand($, 'stage-reject')
  expect(w.state.get('stageApproved')).toEqual([])
  expect(w.state.get('stageCurrent')).toBe('validate-plan')
  expect(w.state.get('stageHoldPlan')).toBe(true)
  // the hold is worded as the rejection's, not a prompt's
  expect(await lk($, 'status')).toContain('Plan approval: held after your rejection')
  expect(history(w).at(-1)).toMatchObject({ stage: 'validate-plan', by: 'command', note: 'rejected by the user', event: 'rejected' })
  expect(w.toasts).toContain('Rejected the Validate plan gate; the plan waits for your approval (/lk approve).')
  expect(await sent(w)).toEqual([REJECT_PLAN])
  expect((await card($)).approve).toBeNull()
  // the Stage pane's history says so
  const pane = await $.ui.mount(STAGE_PANE as never)
  expect(texts(await pane.drawn()).some(t => t.includes('rejected'))).toBe(true)
  await pane.unmount()
  // the pipeline holds: the move is still refused, and that brings the card back
  expect((await setStage($, { stage: 'execute' })).deny).toContain('The Validate plan gate is not approved')
  const back = await card($)
  expect(back.approve).toBe('Approve plan · 13 files')
  expect(back.texts).toContain('Claude tried to move on to Execute; the plan waits for your own approval')
})

test('Validate plan gate (auto): a refused move shows the card; after Reject a consistent verdict no longer opens it, Approve does', SLOW, async ($, on) => {
  const w = cardWorld(on)
  await start($)
  await setStage($, { stage: 'plan', size: 'large', files: 13 })
  expect(await lk($, 'validate-plan')).toContain('to Validate plan')
  // waiting for the validator, not the user
  expect((await card($)).approve).toBeNull()
  expect((await setStage($, { stage: 'execute' })).deny).toContain('The Validate plan gate is not approved')
  const c = await card($)
  expect(c.approve).toBe('Approve plan · 13 files')
  expect(c.texts).toContain('Claude tried to move on to Execute; no validator has found the plan consistent')
  await pressBand($, 'stage-reject')
  expect(await sent(w)).toEqual([REJECT_PLAN])
  await turnOver($, 't1')
  // the revised plan validated: the rejection's hold keeps the gate for the user, and the card is back
  await $.tool.call(validator as never)
  expect((await setStage($, { stage: 'validate-plan', verdict: 'consistent' })).result).toContain(
    'The user approves plans themselves here (the user rejected this plan): ask them to run /lk approve.',
  )
  expect(w.state.get('stageApproved')).toEqual([])
  const again = await card($)
  expect(again.approve).toBe('Approve plan · 13 files')
  expect(again.texts).toContain('the plan waits for your own approval')
  await pressBand($, 'stage-approve')
  expect(w.state.get('stageApproved')).toEqual(['validate-plan'])
  expect(w.state.get('stageHoldPlan')).toBe(false)
  expect(w.state.get('stageHoldRejected')).toBe(false)
  expect((await sent(w)).at(-1)).toStartWith('The user pressed Approve plan · 13 files. Approved the Validate plan gate')
  expect((await card($)).approve).toBeNull()
})

test('a held Validate verifier: the card; Approve vouches for it as /lk waive does, Claude carries on and the move passes', SLOW, async ($, on) => {
  const w = cardWorld(on)
  await atValidate($)
  expect((await card($)).approve).toBeNull()
  expect((await setStage($, { stage: 'qa' })).deny).toContain('needs a verifier')
  const c = await card($)
  expect(c.approve).toBe('Approve without a verifier')
  expect(c.reject).toBe('Reject')
  for (const t of ['loopkeeper · Validate verifier', 'Validate → QA', 'Claude tried to move on to QA before a verifier subagent checked the work', VERIFIER_COMMANDS]) {
    expect(c.texts).toContain(t)
  }
  await pressBand($, 'stage-approve')
  expect(w.state.get('stageVerified')).toContain('validate')
  expect(await sent(w)).toEqual(['The user pressed Approve without a verifier. Marked the Validate verifier as satisfied by the user. ' + CARRY_ON])
  expect((await card($)).approve).toBeNull()
  expect((await setStage($, { stage: 'qa' })).result).toContain('Moved from Validate to QA.')
})

test('a held Validate verifier: Reject keeps the verifier required and asks Claude for one; a verifier then lets it move', SLOW, async ($, on) => {
  const w = cardWorld(on)
  await atValidate($)
  await setStage($, { stage: 'qa' })
  await pressBand($, 'stage-reject')
  expect(w.state.get('stageVerified') ?? []).not.toContain('validate')
  expect(history(w).at(-1)).toMatchObject({ stage: 'validate', event: 'rejected' })
  expect(w.toasts).toContain('Kept the Validate verifier: a verifier subagent checks the work before the pipeline moves on.')
  expect(await sent(w)).toEqual([
    "The user did not approve moving past Validate without a verifier: spawn a verifier subagent (a reviewer, validator or critic with fresh context) to check the work against the plan's Done-when, then try again.",
  ])
  expect((await card($)).approve).toBeNull()
  await $.tool.call(verifier as never)
  expect((await setStage($, { stage: 'qa' })).result).toContain('Moved from Validate to QA.')
})

// At QA with the work verified, the Validate plan gate opened by its verdict
async function atQa($: Engine): Promise<void> {
  await atValidate($)
  await $.tool.call(verifier as never)
  expect((await setStage($, { stage: 'qa' })).result).toContain('Moved from Validate to QA.')
}

test('the Ship gate: the card at Ship; Approve opens shipping with the merge credit, as /lk approve at Ship does', SLOW, async ($, on) => {
  const w = cardWorld(on)
  await atQa($)
  expect((await setStage($, { stage: 'ship' })).result).toContain('Moved from QA to Ship.')
  const c = await card($)
  expect(c.approve).toBe('Approve Ship gate')
  for (const t of ['loopkeeper · Ship gate', 'Commit, push or open a PR', 'the Ship gate holds shipping until you approve it', GATE_COMMANDS]) {
    expect(c.texts).toContain(t)
  }
  await pressBand($, 'stage-approve')
  expect(w.state.get('stageApproved')).toContain('ship')
  expect(w.state.get('stageShipOpen')).toBe(true)
  expect(w.state.get('gateMergeCredit')).toBe(true)
  expect(await sent(w)).toEqual(['The user pressed Approve Ship gate. Approved the Ship gate; the pipeline may now move past it. ' + CARRY_ON])
  expect((await card($)).approve).toBeNull()
  expect(((await $.tool.check(bash('git commit -m x') as never)) as { decision: string }).decision).toBe('allow')
})

test('the Ship gate: a ship request’s own card asks while it waits; then the stage card is back and Reject holds shipping', SLOW, async ($, on) => {
  const w = cardWorld(on)
  await atQa($)
  await setStage($, { stage: 'ship' })
  await $.turn.start({ text: 'commit it', turnId: 't1' })
  expect(((await $.tool.check(bash('git commit -m x') as never)) as { decision: string }).decision).toBe('deny')
  await $.turn.complete({ turnId: 't1', answer: 'held', durationMs: 10, isAborted: false, usage: null, reason: 'answer' })
  let c = await card($)
  expect(c.approve).toBeNull()
  expect(c.texts).toContain('loopkeeper · ship gate')
  const id = ((w.state.get('gateRequests') ?? []) as Array<{ id: string }>)[0]?.id
  await pressBand($, 'gate-request-' + id + '-deny')
  c = await card($)
  expect(c.approve).toBe('Approve Ship gate')
  await turnOver($, 't2')
  await pressBand($, 'stage-reject')
  expect(w.state.get('stageApproved')).not.toContain('ship')
  expect((await sent(w)).at(-1)).toBe('The user rejected the Ship gate. Do not commit, push or open a PR; ask the user what to change first.')
  expect((await card($)).approve).toBeNull()
  expect(((await $.tool.check(bash('git commit -m y') as never)) as { decision: string }).decision).toBe('deny')
})

const CUSTOM = { stages: REVIEW }

test('a custom gate stage: the card; Approve approves it as /lk approve does and the move passes', SLOW, async ($, on) => {
  const w = cardWorld(on, CUSTOM)
  await start($)
  expect(await lk($, 'review')).toContain('to Review')
  const c = await card($)
  expect(c.approve).toBe('Approve Review gate')
  for (const t of ['loopkeeper · Review gate', 'Review → Release', 'the Review gate holds the move to Release until you approve it', GATE_COMMANDS]) {
    expect(c.texts).toContain(t)
  }
  await pressBand($, 'stage-approve')
  expect(w.state.get('stageApproved')).toEqual(['review'])
  expect(await sent(w)).toEqual(['The user pressed Approve Review gate. Approved the Review gate; the pipeline may now move past it. ' + CARRY_ON])
  expect((await card($)).approve).toBeNull()
  expect((await setStage($, { stage: 'release' })).result).toContain('Moved from Review to Release.')
})

test('a custom gate stage: Reject holds the move and tells Claude; a refused move brings the card back', SLOW, async ($, on) => {
  const w = cardWorld(on, CUSTOM)
  await start($)
  await lk($, 'review')
  await pressBand($, 'stage-reject')
  expect(w.state.get('stageApproved') ?? []).toEqual([])
  expect(await sent(w)).toEqual(['The user rejected the Review gate. Do not move past it; ask the user what to change.'])
  expect((await card($)).approve).toBeNull()
  expect((await setStage($, { stage: 'release' })).deny).toContain('The Review gate is not approved')
  expect((await card($)).texts).toContain('Claude tried to move on to Release; the Review gate holds the move to Release until you approve it')
})

test('a move that jumps past the next stage’s gate: the card opens it and moves there, as /lk approve from Plan does', SLOW, async ($, on) => {
  const w = cardWorld(on)
  await start($)
  await setStage($, { stage: 'plan', size: 'large', files: 13 })
  expect((await card($)).approve).toBeNull()
  expect((await setStage($, { stage: 'execute' })).deny).toContain('The Validate plan gate is not approved')
  const c = await card($)
  expect(c.approve).toBe('Approve Validate plan gate')
  expect(c.texts).toContain('Plan → Execute')
  expect(c.texts).toContain('Claude tried to move past Validate plan; approving opens its gate and moves there')
  await pressBand($, 'stage-approve')
  expect(w.state.get('stageCurrent')).toBe('validate-plan')
  expect(w.state.get('stageApproved')).toEqual(['validate-plan'])
  expect(await sent(w)).toEqual([
    'The user pressed Approve Validate plan gate. Approved the Validate plan gate and moved to Validate plan; Claude may start Execute. ' +
      'File budget: 23 files a turn (13 planned + 10). ' +
      CARRY_ON,
  ])
  expect((await card($)).approve).toBeNull()
})

test('/lk reject typed: as the card’s Reject, with the note; refused from another plugin; says when nothing waits', SLOW, async ($, on) => {
  const w = cardWorld(on)
  await start($)
  expect(await lk($, 'reject')).toBe('Nothing at Plan waits for your answer.')
  await lk($, 'approval ask')
  await setStage($, { stage: 'plan', size: 'large', files: 13 })
  await $.tool.call(validator as never)
  await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  const other = (await $.command.run({ command: 'lk', args: 'reject', origin: OTHER } as never)) as { text?: string }
  expect(other.text).toBe('Only the person can reject a gate.')
  expect((await card($)).approve).toBe('Approve plan · 13 files')
  expect(await lk($, 'reject   Too broad: split the   API work')).toBe('Rejected the Validate plan gate; the plan waits for your approval (/lk approve).')
  expect(history(w).at(-1)).toMatchObject({ stage: 'validate-plan', note: 'rejected by the user: Too broad: split the API work', event: 'rejected' })
  expect(await sent(w)).toEqual([REJECT_PLAN + ' Their note: Too broad: split the API work'])
  expect((await card($)).approve).toBeNull()
  expect(await lk($, 'reject')).toBe('Nothing at Validate plan waits for your answer.')
  // /lk approve still approves the gate, and clears the rejection's hold
  expect(await lk($, 'approve')).toStartWith('Approved the Validate plan gate')
  expect(w.state.get('stageHoldPlan')).toBe(false)
})

test('the card shows with the stage band off; answered by the command while drawn, its buttons go with it', SLOW, async ($, on) => {
  const w = cardWorld(on)
  await askGate($)
  expect(await lk($, 'band stage off')).toContain('The stage band is off.')
  const c = await card($)
  expect(c.approve).toBe('Approve plan · 13 files')
  expect(c.texts.some(t => t.startsWith('stage '))).toBe(false)
  // drawn, then answered by /lk approve before the press: the redrawn band has no Reject to press (a press the host
  // still delivers from the old drawing finds no card and says "That gate is no longer waiting.")
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
  await ui.drawn()
  expect(await lk($, 'approve')).toStartWith('Approved the Validate plan gate')
  let refused = ''
  await ui.press({ key: 'stage-reject' }).catch((err: unknown) => {
    refused = String(err)
  })
  await ui.unmount()
  expect(refused).toContain('no Button of loopkeeper keyed "stage-reject"')
  expect(w.state.get('stageApproved')).toEqual(['validate-plan'])
  expect(history(w).some(h => h.event === 'rejected')).toBe(false)
})
