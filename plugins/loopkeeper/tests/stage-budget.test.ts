// stage-budget.test.ts: the file budget (ADR 0011) as the stage concern owns it. set_stage's `files` records the
// planned count; approving the plan (a validator's verdict in auto mode, a plan review pass, /lk approve, the band
// button) approves planned + planSlack; a validator approves at most autoBudgetMax planned files; the band shows the
// button and the budget in force; every path that clears the plan's approval clears the budget.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { TONES } from '../hooks/lib/kit.ts'
import { BAND as WORLD_BAND, CWD, PROJECT_CONFIG, start, tool, world } from './world.ts'
import type { World } from './world.ts'

const TOOL = 'mcp__loopkeeper__set_stage'
const key = (k: string) => 'loopkeeper:stage:' + k
const PROJECT = key('project:' + CWD)
const PRESET = key('preset:' + CWD)
const GSD = { [PRESET]: 'gsd' }

// The shared band request, wide enough for the gsd stepper with its budget
const BAND = { ...WORLD_BAND, props: { ...WORLD_BAND.props, bodyColumns: 120 } }

const validator = { tool: 'Agent', subagent_type: 'general-purpose', description: 'Plan validator: check the plan', prompt: 'x' }

const REFUSED = 'Pass `files` as a whole number from 1: how many files the plan touches.'

// The two atoms the budget lives in, as the stage concern last wrote them: the test's state.set hook sits beneath
// every plugin and above the kit's $.state, so it sees each write and passes it on unchanged
type Atoms = { planFiles: () => number | null; budget: () => number }

function watchAtoms(on: any): Atoms {
  const last = new Map<string, unknown>()
  on('state.set', ($: unknown, e: { plugin?: string; key?: string; value?: unknown }, next: (e: unknown) => unknown) => {
    if (e?.plugin === 'loopkeeper' && typeof e.key === 'string') last.set(e.key, e.value)
    return next(e)
  })
  return {
    planFiles: () => (last.has('stagePlanFiles') ? (last.get('stagePlanFiles') as number | null) : null),
    budget: () => (last.has('stageBudget') ? (last.get('stageBudget') as number) : 0),
  }
}

// The shared world in the gsd preset, with a changeControl section when given (null for no config file), and the
// budget atoms watched
function budgetWorld(on: any, cc: Record<string, unknown> | null = null, store: Record<string, unknown> = GSD): { w: World; atoms: Atoms } {
  const files = cc === null ? {} : { [PROJECT_CONFIG]: JSON.stringify({ changeControl: cc }) }
  const w = world(on, { now: 1_000_000, files })
  for (const [k, v] of Object.entries(store)) w.store.set(k, v)
  return { w, atoms: watchAtoms(on) }
}

async function cmd($: Engine, args: string): Promise<string> {
  const out = (await $.command.run({ command: 'lk', args })) as { text?: string }
  return out?.text ?? ''
}

async function setStage($: Engine, input: Record<string, unknown>): Promise<{ result?: string; deny?: string }> {
  return (await $.tool.call({ tool: TOOL, ...input } as never)) as { result?: string; deny?: string }
}

// Every string inside a drawn element, in order
function textIn(node: unknown): string {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  const n = node as { children?: unknown[]; props?: { children?: unknown[] } }
  return (n.children ?? n.props?.children ?? []).map(textIn).join('')
}

async function bandLine($: Engine): Promise<string> {
  const ui = await $.ui.mount(BAND)
  const line = textIn(await ui.find({ key: 'stage-band' }))
  await ui.unmount()
  return line
}

// The label of the band's approve button, or null when it draws none
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

// Size the task large (with a planned count when given) and have a plan validator complete during Plan
async function planned($: Engine, files?: number): Promise<{ result?: string; deny?: string }> {
  const r = await setStage($, { stage: 'plan', size: 'large', ...(files === undefined ? {} : { files }) })
  await $.tool.call(validator as never)
  return r
}

test('approving the plan through ExitPlanMode leaves the file budget to the band button', { timeoutMs: 20_000 }, async ($, on) => {
  const { atoms } = budgetWorld(on, null, {})
  await start($)
  await setStage($, { stage: 'plan', size: 'large', files: 13 })
  await $.tool.call({ tool: 'ExitPlanMode', plan: 'p' } as never)
  expect(await cmd($, 'status')).not.toContain('Stage: Plan')
  expect(atoms.budget()).toBe(0)
  expect(await buttonLabel($)).toBe('Approve budget · 13 files')
  await pressButton($)
  expect(atoms.budget()).toBe(23)
  expect(await buttonLabel($)).toBe(null)
  const gates = (await $.command.run({ command: 'lk', args: 'gates text' })) as { text?: string }
  expect(gates.text).toContain('Files per turn: 23')
})

// ---- set_stage `files`: recorded, replaced before approval, refused when bad ----------------------------------

test('set_stage plan large with files 13 records the count and says what approving it will approve', { timeoutMs: 20_000 }, async ($, on) => {
  const { w, atoms } = budgetWorld(on)
  await start($)
  const out = await setStage($, { stage: 'plan', size: 'large', files: 13 })
  expect(out.result).toContain('The plan touches 13 files: approving it approves a file budget of 23 files a turn.')
  expect(atoms.planFiles()).toBe(13)
  expect(atoms.budget()).toBe(0)
  expect(await cmd($, 'status')).toContain('File budget: 13 planned, approved with the plan (until then 10)')
  expect(w.store.get(PROJECT)).toMatchObject({ size: 'large', planFiles: 13, budget: 0 })
})

test('re-planning before approval replaces the planned count', { timeoutMs: 20_000 }, async ($, on) => {
  const { atoms } = budgetWorld(on)
  await start($)
  await setStage($, { stage: 'plan', size: 'large', files: 13 })
  const again = await setStage($, { stage: 'plan', size: 'large', files: 20 })
  expect(again.result).toContain('The plan touches 20 files: approving it approves a file budget of 30 files a turn.')
  expect(atoms.planFiles()).toBe(20)
  expect(atoms.budget()).toBe(0)
  // re-planning without a count drops the old one rather than keeping it
  const none = await setStage($, { stage: 'plan', size: 'large' })
  expect(none.result).toContain('Pass `files` (how many files the plan touches) with size large')
  expect(none.result).toContain('without one the limit stays 10.')
  expect(atoms.planFiles()).toBe(null)
})

test('a bad files value is refused and nothing is recorded or guessed', { timeoutMs: 20_000 }, async ($, on) => {
  const { atoms } = budgetWorld(on)
  await start($)
  await setStage($, { stage: 'plan', size: 'large', files: 13 })
  for (const files of [0, -3, 2.5, 'lots', '12 files', true, [13], 10_001, Number.NaN]) {
    expect((await setStage($, { stage: 'plan', size: 'large', files })).deny).toBe(REFUSED)
    expect(atoms.planFiles()).toBe(13)
  }
  expect(atoms.budget()).toBe(0)
  expect(await cmd($, 'status')).toContain('Size: large')
})

test('files counts only with stage plan and size large', { timeoutMs: 20_000 }, async ($, on) => {
  const { atoms } = budgetWorld(on)
  await start($)
  const small = await setStage($, { stage: 'plan', size: 'small', files: 2 })
  expect(small.result).toContain('`files` counts only with stage plan and size large; it was not recorded.')
  expect(atoms.planFiles()).toBe(null)
  await setStage($, { stage: 'plan', size: 'large', files: 13 })
  const moved = await setStage($, { stage: 'validate-plan', files: 40 })
  expect(moved.result).toContain('it was not recorded.')
  expect(atoms.planFiles()).toBe(13)
})

// ---- Approving the plan approves the budget: planned + planSlack, on every approval path -----------------------

const APPROVED_GATE = 'Approved the Validate plan gate; the pipeline may now move past it.'

test("the validator's consistent verdict in auto mode approves 13 + 10 = 23", { timeoutMs: 20_000 }, async ($, on) => {
  const { w, atoms } = budgetWorld(on)
  await start($)
  await planned($, 13)
  const out = await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  expect(out.result).toBe(
    'Moved from Plan to Validate plan. Plan validated by general-purpose: Plan validator: check the plan; the Validate plan gate is open (approval mode auto). Continue with set_stage execute. File budget: 23 files a turn (13 planned + 10).',
  )
  expect(atoms.budget()).toBe(23)
  expect(atoms.planFiles()).toBe(13)
  const status = await cmd($, 'status')
  expect(status).toContain('Gates: Validate plan approved')
  expect(status).toContain('File budget: 23 files a turn (13 planned + 10)')
  expect(w.store.get(PROJECT)).toMatchObject({ planFiles: 13, budget: 23 })
  expect(await buttonLabel($)).toBe(null)
  // the budget stays in force past the gate
  expect((await setStage($, { stage: 'execute' })).result).toContain('Moved from Validate plan to Execute')
  expect(atoms.budget()).toBe(23)
})

test('planSlack comes from the changeControl section: 13 + 5 = 18 by the verdict and by /lk approve', async ($, on) => {
  const { atoms } = budgetWorld(on, { planSlack: 5 })
  await start($)
  await planned($, 13)
  expect((await setStage($, { stage: 'validate-plan', verdict: 'consistent' })).result).toContain(
    'File budget: 18 files a turn (13 planned + 5).',
  )
  expect(atoms.budget()).toBe(18)
  // a new task in ask mode, approved by the user
  await cmd($, 'approval ask')
  await planned($, 13)
  expect(atoms.budget()).toBe(0)
  await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  expect(atoms.budget()).toBe(0)
  expect(await cmd($, 'approve')).toContain(APPROVED_GATE + ' File budget: 18 files a turn (13 planned + 5).')
  expect(atoms.budget()).toBe(18)
})

test('a review_cycle pass of kind plan with no open p0/p1 in auto mode approves the budget', async ($, on) => {
  const { atoms } = budgetWorld(on)
  await start($)
  await planned($, 13)
  // an open p1 item: the plan review is not done, so nothing is recorded
  const open = await tool($, 'review_cycle', { subject: 'cache plan', kind: 'plan', items: [{ text: 'name the cache dir', priority: 'p1' }] })
  expect(String(open.result)).not.toContain('loopkeeper stage:')
  expect(atoms.budget()).toBe(0)
  expect(await cmd($, 'status')).toContain('Gates: Validate plan pending')
  // the item closed: the pass is done by review-loop's rule and records the consistent verdict
  const done = await tool($, 'review_cycle', {
    subject: 'cache plan',
    items: [{ text: 'name the cache dir', priority: 'p1', done: true }, { text: 'mention the TTL', priority: 'p2' }],
  })
  const text = String(done.result)
  expect(text).toContain('loopkeeper stage: Moved from Plan to Validate plan. Plan validated by general-purpose: Plan validator: check the plan')
  expect(text).toContain('File budget: 23 files a turn (13 planned + 10).')
  expect(atoms.budget()).toBe(23)
  expect(await cmd($, 'status')).toContain('Gates: Validate plan approved')
})

test('/lk approve in approval mode ask approves the plan and its budget', { timeoutMs: 20_000 }, async ($, on) => {
  const { atoms } = budgetWorld(on)
  await start($)
  await cmd($, 'approval ask')
  await planned($, 13)
  const out = await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  expect(out.result).toContain('ask them to run /lk approve.')
  expect(out.result).not.toContain('File budget')
  expect(atoms.budget()).toBe(0)
  expect(await cmd($, 'status')).toContain('File budget: 13 planned, approved with the plan (until then 10)')
  expect(await cmd($, 'approve')).toContain(APPROVED_GATE + ' File budget: 23 files a turn (13 planned + 10).')
  expect(atoms.budget()).toBe(23)
  expect(await cmd($, 'status')).toContain('Gates: Validate plan approved')
  // approving again changes nothing
  expect(await cmd($, 'approve')).toContain('The Validate plan gate is already approved.')
  expect(atoms.budget()).toBe(23)
})

test('the band button approves the plan and its budget as /lk approve does', async ($, on) => {
  const { w, atoms } = budgetWorld(on)
  await start($)
  await cmd($, 'approval ask')
  await planned($, 13)
  await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  expect(await buttonLabel($)).toBe('Approve plan · 13 files')
  await pressButton($)
  expect(atoms.budget()).toBe(23)
  expect(await cmd($, 'status')).toContain('Gates: Validate plan approved')
  expect(w.store.get(PROJECT)).toMatchObject({ planFiles: 13, budget: 23 })
  expect(await buttonLabel($)).toBe(null)
  expect((await setStage($, { stage: 'execute' })).result).toContain('Moved from Validate plan to Execute')
})

// ---- The auto cap: a validator approves at most autoBudgetMax planned files -----------------------------------

const WAITS_41 =
  'The file budget (41 planned files) is over 40, the most a validator may approve, so it waits for the user: ask them to run /lk approve. Until then the limit stays 10.'

test('files 41 in auto mode: the verdict opens the plan gate but the budget waits; the band button approves 51', async ($, on) => {
  const { w, atoms } = budgetWorld(on)
  await start($)
  await planned($, 41)
  const out = await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  expect(out.result).toContain('the Validate plan gate is open (approval mode auto). Continue with set_stage execute. ' + WAITS_41)
  expect(atoms.budget()).toBe(0)
  expect(atoms.planFiles()).toBe(41)
  const status = await cmd($, 'status')
  expect(status).toContain('Gates: Validate plan approved')
  expect(status).toContain('File budget: 41 planned, waiting for /lk approve (until then 10)')
  // the gate is open: the stage machine may move on while the budget waits
  expect((await setStage($, { stage: 'execute' })).result).toContain('Moved from Validate plan to Execute')
  expect(await buttonLabel($)).toBe('Approve budget · 41 files')
  await pressButton($)
  expect(atoms.budget()).toBe(51)
  expect(w.store.get(PROJECT)).toMatchObject({ planFiles: 41, budget: 51 })
  expect(await buttonLabel($)).toBe(null)
  expect(await cmd($, 'status')).toContain('File budget: 51 files a turn (41 planned + 10)')
})

test('files 41 in auto mode: /lk approve approves the waiting budget, at the gate or past it', async ($, on) => {
  const { atoms } = budgetWorld(on)
  await start($)
  await planned($, 41)
  await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  expect(await buttonLabel($)).toBe('Approve budget · 41 files')
  expect(await cmd($, 'approve')).toContain('Approved the file budget. File budget: 51 files a turn (41 planned + 10).')
  expect(atoms.budget()).toBe(51)
  expect(await cmd($, 'approve')).toContain('The Validate plan gate is already approved.')
  // a new task, approved by the user from Execute, where there is no gate
  await planned($, 41)
  await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  await setStage($, { stage: 'execute' })
  expect(atoms.budget()).toBe(0)
  expect(await cmd($, 'approve')).toContain('Approved the file budget. File budget: 51 files a turn (41 planned + 10).')
  expect(atoms.budget()).toBe(51)
  expect(await cmd($, 'approve')).toContain('Execute has no gate to approve.')
})

test('autoBudgetMax comes from the changeControl section: 20 planned files are approved by the validator, 21 wait', async ($, on) => {
  const { atoms } = budgetWorld(on, { autoBudgetMax: 20 })
  await start($)
  await planned($, 20)
  expect((await setStage($, { stage: 'validate-plan', verdict: 'consistent' })).result).toContain(
    'File budget: 30 files a turn (20 planned + 10).',
  )
  expect(atoms.budget()).toBe(30)
  await planned($, 21)
  expect((await setStage($, { stage: 'validate-plan', verdict: 'consistent' })).result).toContain(
    'The file budget (21 planned files) is over 20, the most a validator may approve',
  )
  expect(atoms.budget()).toBe(0)
  expect(await buttonLabel($)).toBe('Approve budget · 21 files')
})

test('with the default cap a validator approves exactly 40 planned files', async ($, on) => {
  const { atoms } = budgetWorld(on)
  await start($)
  await planned($, 40)
  expect((await setStage($, { stage: 'validate-plan', verdict: 'consistent' })).result).toContain(
    'File budget: 50 files a turn (40 planned + 10).',
  )
  expect(atoms.budget()).toBe(50)
  expect(await buttonLabel($)).toBe(null)
})

// ---- The band button's labels -------------------------------------------------------------------------------

test('band button: Approve plan · N files while the gate waits in ask mode, plain without a count, none otherwise', async ($, on) => {
  budgetWorld(on)
  await start($)
  await cmd($, 'approval ask')
  await planned($, 13)
  // in Plan the gate is not reached yet
  expect(await buttonLabel($)).toBe(null)
  await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  expect(await buttonLabel($)).toBe('Approve plan · 13 files')
  // a large plan without a count
  await planned($)
  await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  expect(await buttonLabel($)).toBe('Approve plan')
  await cmd($, 'approve')
  expect(await buttonLabel($)).toBe(null)
  // a small task waives the gate: no button
  await setStage($, { stage: 'plan', size: 'small' })
  expect(await buttonLabel($)).toBe(null)
})

test('band button: a prompt that asks to wait holds the gate in auto mode and shows Approve plan · N files', async ($, on) => {
  const { atoms } = budgetWorld(on)
  await start($)
  await $.prompt.submit({ text: 'Add the cache, but wait for my approval before editing' } as never)
  await planned($, 13)
  expect((await setStage($, { stage: 'validate-plan', verdict: 'consistent' })).result).toContain('this prompt asked to wait')
  expect(atoms.budget()).toBe(0)
  expect(await buttonLabel($)).toBe('Approve plan · 13 files')
  await pressButton($)
  expect(atoms.budget()).toBe(23)
  expect(await buttonLabel($)).toBe(null)
})

// ---- The approval message states the budget ------------------------------------------------------------------

test('the approval message states the budget with its count, or says none was set and the limit stays the base', async ($, on) => {
  budgetWorld(on)
  await start($)
  // auto mode, a large plan without a count
  await planned($)
  expect((await setStage($, { stage: 'validate-plan', verdict: 'consistent' })).result).toContain(
    'Continue with set_stage execute. No file budget was set, so the limit stays 10.',
  )
  expect(await cmd($, 'status')).toContain('File budget: none (limit 10)')
  // ask mode, with and without a count
  await cmd($, 'approval ask')
  await planned($, 13)
  await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  expect(await cmd($, 'approve')).toContain(APPROVED_GATE + ' File budget: 23 files a turn (13 planned + 10).')
  await planned($)
  await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  expect(await cmd($, 'approve')).toContain(APPROVED_GATE + ' No file budget was set, so the limit stays 10.')
})

test('the limit the message names without a count is maxFilesPerTurn from config', async ($, on) => {
  const { atoms } = budgetWorld(on, { maxFilesPerTurn: 15 })
  await start($)
  await cmd($, 'approval ask')
  expect((await setStage($, { stage: 'plan', size: 'large' })).result).toContain('without one the limit stays 15.')
  await $.tool.call(validator as never)
  await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  expect(await cmd($, 'approve')).toContain(APPROVED_GATE + ' No file budget was set, so the limit stays 15.')
  expect(atoms.budget()).toBe(0)
  expect(await cmd($, 'status')).toContain('File budget: none (limit 15)')
})

// ---- Clearing: the budget goes whenever the plan's approval goes -----------------------------------------------

// A task with 13 planned files whose budget of 23 the validator approved, now in Execute
async function approved23($: Engine, atoms: Atoms): Promise<void> {
  await planned($, 13)
  await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  await setStage($, { stage: 'execute' })
  expect(atoms.budget()).toBe(23)
  expect(atoms.planFiles()).toBe(13)
}

async function expectCleared($: Engine, w: World, atoms: Atoms): Promise<void> {
  expect(atoms.budget()).toBe(0)
  expect(atoms.planFiles()).toBe(null)
  expect(w.store.get(PROJECT)).toMatchObject({ planFiles: null, budget: 0 })
  expect(await bandLine($)).not.toContain('budget')
}

test('moving back to Plan clears the budget and the planned count', async ($, on) => {
  const { w, atoms } = budgetWorld(on)
  await start($)
  await approved23($, atoms)
  expect((await setStage($, { stage: 'plan' })).result).toContain('Moved from Execute to Plan')
  await expectCleared($, w, atoms)
  expect(await cmd($, 'status')).toContain('File budget: none (limit 10)')
})

test('re-sizing the task clears the budget; a new count is planned, not approved', async ($, on) => {
  const { w, atoms } = budgetWorld(on)
  await start($)
  await approved23($, atoms)
  await cmd($, 'size large')
  await expectCleared($, w, atoms)
  await approved23($, atoms)
  await setStage($, { stage: 'plan', size: 'large', files: 5 })
  expect(atoms.budget()).toBe(0)
  expect(atoms.planFiles()).toBe(5)
  expect(w.store.get(PROJECT)).toMatchObject({ planFiles: 5, budget: 0 })
})

test('/lk reset clears the budget and the planned count', async ($, on) => {
  const { w, atoms } = budgetWorld(on)
  await start($)
  await approved23($, atoms)
  expect(await cmd($, 'reset')).toContain('Pipeline reset to Plan')
  await expectCleared($, w, atoms)
})

test('sizing a small task clears the budget and the planned count', async ($, on) => {
  const { w, atoms } = budgetWorld(on)
  await start($)
  await approved23($, atoms)
  expect((await setStage($, { stage: 'plan', size: 'small' })).result).toContain('Small task')
  await expectCleared($, w, atoms)
})

// ---- The band shows the budget in force ------------------------------------------------------------------------

test('the band shows budget 23 while a budget is in force, and nothing for a planned count alone', async ($, on) => {
  const { atoms } = budgetWorld(on)
  await start($)
  await planned($, 13)
  expect(await bandLine($)).not.toContain('budget')
  await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  expect(await bandLine($)).toContain(' · budget 23')
  // the budget is part of the quiet right side, drawn in the muted tone like the time in the stage
  const ui = await $.ui.mount(BAND)
  expect(((await ui.find({ type: 'Text', text: ' · budget 23' })) as { props?: { color?: string } } | undefined)?.props?.color).toBe(TONES.muted.fg)
  await ui.unmount()
  await setStage($, { stage: 'execute' })
  expect(await bandLine($)).toContain(' · budget 23')
  expect(atoms.budget()).toBe(23)
  await cmd($, 'reset')
  expect(await bandLine($)).not.toContain('budget')
})

// ---- Between sessions: the budget is kept with the task ----------------------------------------------------------

const SAVED = {
  stage: 'execute',
  at: 999_000,
  approved: ['validate-plan'],
  verified: ['validate-plan'],
  size: 'large',
  planVerdict: { ok: true, by: 'general-purpose', at: 998_000 },
  waived: [],
  filesTouched: [],
}

test('a new session resumes the planned count and the approved budget; bad saved values are dropped', async ($, on) => {
  const { atoms } = budgetWorld(on, null, { ...GSD, [PROJECT]: { ...SAVED, planFiles: 13, budget: 23 } })
  await start($)
  expect(atoms.planFiles()).toBe(13)
  expect(atoms.budget()).toBe(23)
  expect(await bandLine($)).toContain(' · budget 23')
  expect(await cmd($, 'status')).toContain('File budget: 23 files a turn (13 planned + 10)')
})

test('a saved budget or count that is not a whole positive number resumes as none', async ($, on) => {
  const { atoms } = budgetWorld(on, null, { ...GSD, [PROJECT]: { ...SAVED, planFiles: 2.5, budget: '23' } })
  await start($)
  expect(atoms.planFiles()).toBe(null)
  expect(atoms.budget()).toBe(0)
  expect(await bandLine($)).not.toContain('budget')
  expect(await cmd($, 'status')).toContain('File budget: none (limit 10)')
})

// ---- The default preset (no plan gate): leaving Plan approves a waiting budget as a validator's verdict would ----

test('default preset: leaving Plan through set_stage approves 13 planned files as a budget of 23', { timeoutMs: 20_000 }, async ($, on) => {
  const { w, atoms } = budgetWorld(on, null, {})
  await start($)
  await setStage($, { stage: 'plan', size: 'large', files: 13 })
  expect(atoms.budget()).toBe(0)
  const out = await setStage($, { stage: 'build' })
  expect(out.result).toContain('Moved from Plan to Build. File budget: 23 files a turn (13 planned + 10).')
  expect(atoms.budget()).toBe(23)
  expect(w.store.get(PROJECT)).toMatchObject({ planFiles: 13, budget: 23 })
  expect(await buttonLabel($)).toBe(null)
})

test('default preset: an auto move out of Plan (an edit) approves the waiting budget too', { timeoutMs: 20_000 }, async ($, on) => {
  const { atoms } = budgetWorld(on, null, {})
  await start($)
  await setStage($, { stage: 'plan', size: 'large', files: 13 })
  await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' } as never)
  expect(await cmd($, 'status')).toContain('stage ● Build')
  expect(atoms.budget()).toBe(23)
})

test('default preset: 41 planned files still wait for the user on leaving Plan', { timeoutMs: 20_000 }, async ($, on) => {
  const { atoms } = budgetWorld(on, null, {})
  await start($)
  await setStage($, { stage: 'plan', size: 'large', files: 41 })
  const out = await setStage($, { stage: 'build' })
  expect(out.result).toContain('Moved from Plan to Build. ' + WAITS_41)
  expect(atoms.budget()).toBe(0)
  expect(await buttonLabel($)).toBe('Approve budget · 41 files')
})

test('default preset in approval mode ask: leaving Plan leaves the budget to the user', { timeoutMs: 20_000 }, async ($, on) => {
  const { atoms } = budgetWorld(on, null, {})
  await start($)
  await cmd($, 'approval ask')
  await setStage($, { stage: 'plan', size: 'large', files: 13 })
  const out = await setStage($, { stage: 'build' })
  expect(out.result).not.toContain('File budget')
  expect(atoms.budget()).toBe(0)
  expect(await buttonLabel($)).toBe('Approve budget · 13 files')
})

test('default preset with a hold (the prompt asked to wait): leaving Plan leaves the budget to the user', { timeoutMs: 20_000 }, async ($, on) => {
  const { atoms } = budgetWorld(on, null, {})
  await start($)
  await $.prompt.submit({ text: 'Add the cache, but wait for my approval before editing' } as never)
  await setStage($, { stage: 'plan', size: 'large', files: 13 })
  const out = await setStage($, { stage: 'build' })
  expect(out.result).toContain('Moved from Plan to Build.')
  expect(out.result).not.toContain('File budget: 23')
  expect(atoms.budget()).toBe(0)
  expect(await buttonLabel($)).toBe('Approve budget · 13 files')
})
