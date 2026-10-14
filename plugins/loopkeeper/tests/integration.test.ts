// integration.test.ts: every concern live at once (stage, gates, files, routing, review, decisions) through the shared
// fixture. One long session walks the GSD loop end to end: /lk on, a small task's growth guard, a large task with a
// file budget, the plan gate and plan material, a plan review that opens the gate, the budget and its Raise, the
// verifier at Validate, routing by role, a bounded review loop, the ship and merge gates, /files, the decision log and
// the watch. A second session holds the plan gate for the user (a prompt that asks to wait, then approval mode ask).
// Every step asserts on state or text.
import { expect, test } from 'claude-code/testing'

import { TONES } from '../hooks/lib/kit.ts'
import { BAND, CWD, bash, edit, lineOf, linePlain, lk, startTurn, texts, tool, world } from './world.ts'

/** The decision log's clock: record_decision names its entries by the minute. */
const NOW = new Date(2026, 9, 8, 14, 5, 0).getTime()
const ASK = (n: number) => `loopkeeper: this turn already touched ${n} files. Allow more?`
const MERGE_Q = 'Merge now? (loopkeeper: push to the default branch)'
const SCRATCH_PLAN = '/tmp/claude-1000/x/y/scratchpad/plan.html'
const PRESET_KEY = `loopkeeper:stage:preset:${CWD}`
const DECISION_LOG = `${CWD}/.claude/decisions.jsonl`
const APPROVED_PLAN = 'Approved the Validate plan gate; the pipeline may now move past it.'
const src = (from: number, to: number, dir = 'src') => Array.from({ length: to - from + 1 }, (_, i) => `${CWD}/${dir}/f${from + i}.ts`)

const validator = { tool: 'Agent', subagent_type: 'general-purpose', description: 'Plan validator: check the plan', prompt: 'x' }
const verifier = { tool: 'Agent', subagent_type: 'general-purpose', description: 'Verify the work against Done-when', prompt: 'x' }

type Verdict = { decision: string; reason?: string }
const check = async ($: any, call: unknown): Promise<Verdict> => (await $.tool.check(call)) as Verdict
const setStage = async ($: any, input: Record<string, unknown>): Promise<{ result?: string; deny?: string }> => tool($, 'set_stage', input)
const reviewCycle = async ($: any, input: Record<string, unknown>): Promise<string> => String((await tool($, 'review_cycle', input)).result)

async function editAll($: any, paths: string[]): Promise<string[]> {
  const out: string[] = []
  for (const p of paths) out.push((await check($, edit(p))).decision)
  return out
}

/** The changeControl block the gates add to the context. */
async function gatesBlock($: any): Promise<string> {
  const ctx = (await $.prompt.context({ blocks: [] } as never)) as { blocks: Array<{ name: string; text: string }> }
  return ctx.blocks.find(b => b.name === 'changeControl')?.text ?? ''
}

/** Every option label of every question asked, captured beside the AskUserQuestion shim. */
function optionsLog(): { opts: string[][]; tool: (e: any) => undefined } {
  const opts: string[][] = []
  return {
    opts,
    tool: (e: any) => {
      if (e?.tool === 'AskUserQuestion') opts.push((e.questions?.[0]?.options ?? []).map((o: any) => (typeof o === 'string' ? o : o?.label)))
      return undefined
    },
  }
}

/** A spawn as the Agent tool raises it. */
const spawnOf = (description: string, prompt = 'Do the task.') =>
  ({
    tool_use_id: 'toolu_1',
    prompt,
    description,
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-main-model',
    background: false,
    fork: false,
  }) as any

test('one GSD session end to end: every concern live, each step asserted', { timeoutMs: 60_000 }, async ($, on) => {
  const log = optionsLog()
  const w = world(on, { now: NOW, answers: ['Raise to 33 for this session', 'Stop', 'Merge'], tool: log.tool })
  await startTurn($)

  // 1. /lk on: the stage on preset gsd, the gates on plan required, routing on; one reply, in that order
  expect(await lk($, 'status')).toContain('preset default')
  const onReply = await lk($, 'on')
  const at = ['Pipeline preset gsd', 'gates: plan required on', 'GSD orchestrator mode on'].map(t => onReply.indexOf(t))
  expect(at.every(i => i >= 0)).toBe(true)
  expect([...at].sort((a, b) => a - b)).toEqual(at)
  const onStatus = await lk($, 'status')
  expect(onStatus).toContain('preset gsd')
  expect(onStatus).toContain('plan ✗')
  expect(onStatus).toContain('routing ● on')
  expect(w.store.get(PRESET_KEY)).toBe('gsd')
  expect(w.store.get('loopkeeper:routing:mode')).toBe(true)
  // the loop rules and the gates' block both reach the model
  const ctx = (await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'x' }], instructionFiles: [] } as never)) as {
    blocks: Array<{ name: string; text: string }>
    instructionFiles?: Array<{ content: string }>
  }
  expect(ctx.instructionFiles?.[0]?.content).toContain('/lk approve')
  expect(ctx.blocks.find(b => b.name === 'changeControl')?.text).toContain('At most 10 distinct files')

  // 2. a small task: plan gate and verifier waived, three files pass, the fourth is refused and the task goes back to Plan
  expect((await setStage($, { stage: 'plan', size: 'small', note: 'fix the typo' })).result).toBe(
    'Small task: the plan gate and the verifier are waived; in Execute. A small task may touch at most 3 files; past that it is pushed back to Plan.',
  )
  expect(w.state.get('stagePlanDone')).toBe(true)
  expect(await editAll($, [`${CWD}/src/a.ts`, `${CWD}/src/b.ts`, `${CWD}/src/c.ts`])).toEqual(['allow', 'allow', 'allow'])
  expect(await lk($, 'status')).toContain('Size: small (3/3 files)')
  const grown = await check($, edit(`${CWD}/src/d.ts`))
  expect(grown.decision).toBe('deny')
  expect(grown.reason).toContain('this task was sized small but would now touch a 4th file (src/d.ts)')
  expect(w.state.get('stageCurrent')).toBe('plan')
  expect(w.state.get('stagePlanDone')).toBe(false)
  expect(await lk($, 'status')).toContain('Size: unsized')
  // the refused fourth file is not one the turn touched
  expect(await lk($, 'gates text')).toContain('Files touched this turn (3/10):')

  // 3. a large task sized with the files it touches
  const large = await setStage($, { stage: 'plan', size: 'large', files: 13, note: 'add the cache' })
  expect(large.result).toContain('The plan touches 13 files: approving it approves a file budget of 23 files a turn.')
  expect(w.state.get('stagePlanFiles')).toBe(13)
  expect(w.state.get('stageBudget') ?? 0).toBe(0)

  // 4. the plan gate: a source edit is refused; plan material (the scratchpad, .claude/plans/) is allowed
  const refused = await check($, edit(`${CWD}/src/cache.ts`))
  expect(refused.decision).toBe('deny')
  expect(refused.reason).toContain('edits are refused until a plan is approved in this session (requirePlan is on)')
  expect(refused.reason).toContain("/lk approve opens the pipeline's Validate plan gate (from Plan or Validate plan), or /lk gates plan ok allows edits for this session without it.")
  expect((await check($, edit(SCRATCH_PLAN, 'Write'))).decision).toBe('allow')
  expect((await check($, edit(`${CWD}/.claude/plans/x.md`, 'Write'))).decision).toBe('allow')
  expect(w.asked).toEqual([])

  // 5. a plan review: an open p1 records nothing; once it is closed the pass opens the gate in auto mode with the budget
  await $.tool.call(validator as never)
  expect(w.state.get('stageCurrent')).toBe('plan')
  const open = await reviewCycle($, { subject: 'cache plan', kind: 'plan', items: [{ text: 'name the cache dir', priority: 'p1' }] })
  expect(open).not.toContain('loopkeeper stage:')
  expect(await lk($, 'status')).toContain('Gates: Validate plan pending')
  const passed = await reviewCycle($, { subject: 'cache plan', items: [{ text: 'name the cache dir', priority: 'p1', done: true }] })
  expect(passed).toContain(
    'loopkeeper stage: Moved from Plan to Validate plan. Plan validated by general-purpose: Plan validator: check the plan; the Validate plan gate is open (approval mode auto).',
  )
  expect(passed).toContain('File budget: 23 files a turn (13 planned + 10).')
  expect(w.state.get('stageBudget')).toBe(23)
  expect(w.state.get('stagePlanDone')).toBe(true)
  expect(await lk($, 'status')).toContain('Gates: Validate plan approved')

  // 6. the budget of 23 is in force, for the gates and in what the model reads
  expect((await setStage($, { stage: 'execute' })).result).toContain('Moved from Validate plan to Execute')
  expect(await lk($, 'gates text')).toContain("Files per turn: 23 (the approved plan's budget: 13 planned + 10)")
  expect(await gatesBlock($)).toContain('At most 23 distinct files')

  // 7. a new turn: files 1-23 pass, the 24th asks with four options, Raise to 33 is taken, the 33rd passes, the 34th asks
  await $.turn.start({ text: 'build the cache', turnId: 't2' })
  expect(await editAll($, src(1, 23))).toEqual(Array(23).fill('allow'))
  expect(w.asked).toEqual([])
  expect((await check($, edit(`${CWD}/src/f24.ts`))).decision).toBe('allow')
  expect(w.asked).toEqual([ASK(23)])
  expect(log.opts[0]).toEqual(['Allow 1 more', 'Allow rest of turn', 'Raise to 33 for this session', 'Stop'])
  expect(w.state.get('gateSessionRaise')).toBe(33)
  expect(await lk($, 'gates text')).toContain('Files per turn: 33 (raised for this session)')
  expect(await editAll($, src(25, 33))).toEqual(Array(9).fill('allow'))
  expect(w.asked).toEqual([ASK(23)])
  const stopped = await check($, edit(`${CWD}/src/f34.ts`))
  expect(stopped.decision).toBe('deny')
  expect(stopped.reason).toContain('would exceed the limit of 33 files per turn (the user chose Stop)')
  expect(w.asked).toEqual([ASK(23), ASK(33)])
  await w.clock.advance(250)
  expect(w.aborted).toEqual(['t2'])

  // 8. Validate needs a verifier Agent; 9. its spawn, and a survey's, are routed by role
  await $.turn.start({ text: 'check the work', turnId: 't3' })
  expect((await setStage($, { stage: 'validate' })).result).toContain('Moved from Execute to Validate')
  const unverified = await setStage($, { stage: 'qa' })
  expect(unverified.deny).toContain('spawn a verifier subagent (a reviewer, validator or critic with fresh context)')
  await $.agent.spawn(spawnOf('Verify the work against Done-when'))
  await $.agent.spawn(spawnOf('Survey the repo layout'))
  expect(w.spawned.map(s => s.model)).toEqual(['sonnet', 'haiku'])
  await $.tool.call(verifier as never)
  expect(await lk($, 'status')).toContain('Validate satisfied')
  expect((await setStage($, { stage: 'qa' })).result).toContain('Moved from Validate to QA')

  // 10. a bounded review loop: kind qa stops at 3 rounds and refuses the 4th; it records no plan verdict
  const first = await reviewCycle($, { subject: 'unit tests', kind: 'qa', items: [{ text: 'cache test is flaky', priority: 'p0' }] })
  expect(first).not.toContain('loopkeeper stage:')
  await reviewCycle($, { subject: 'unit tests' })
  await reviewCycle($, { subject: 'unit tests' })
  expect(w.toasts).toContain('review unit tests: not converging after 3/3 rounds (1 open p0/p1)')
  expect(await reviewCycle($, { subject: 'unit tests' })).toContain('Not recorded: round 4 is past the limit of 3 for unit tests.')
  expect(w.state.get('stageCurrent')).toBe('qa')

  // 11. the ship hold: git commit is refused at QA and at Ship until the user approves Ship
  const commit = bash('git commit -m "add the cache"')
  const atQa = await check($, commit)
  expect(atQa.decision).toBe('deny')
  expect(atQa.reason).toBe(
    'loopkeeper: shipping is gated (git commit). The pipeline is at QA. Ask the user to review the work and run /lk approve at QA or Ship ' +
      '(it opens the Ship gate; a waiting file budget comes first), or /lk gates ship ok.',
  )
  expect((await setStage($, { stage: 'ship' })).result).toContain('Moved from QA to Ship')
  expect((await check($, bash('git commit -m "add the cache"'))).reason).toContain('The pipeline is at Ship.')
  expect(w.state.get('stageShipOpen')).toBe(false)
  expect(await lk($, 'approve')).toContain('Approved the Ship gate; the pipeline may now move past it.')
  expect(w.state.get('stageShipOpen')).toBe(true)
  expect((await check($, bash('git commit -m "add the cache"'))).decision).toBe('allow')
  // the merge gate: the Ship approval covers the first git push origin main (no question, recorded); the next one
  // asks exactly once, and Merge lets it run
  const asked = w.asked.length
  expect((await check($, bash('git push origin main'))).decision).toBe('allow')
  expect(w.asked.slice(asked)).toEqual([])
  expect(await lk($, 'gates text')).toContain('merge allowed push to the default branch · covered by the Ship approval or /lk gates merge ok')
  expect((await check($, bash('git push origin main'))).decision).toBe('allow')
  expect(w.asked.slice(asked)).toEqual([MERGE_Q])

  // 12. /files opens the Files pane
  expect(await $.command.run({ command: 'files', args: '' } as never)).toEqual({})
  expect(w.panes).toEqual(['files'])

  // 13. record_decision writes one entry to the decision log
  const recorded = await tool($, 'record_decision', { decision: 'Cache in SQLite', why: 'one file, no server', tags: ['storage'] })
  expect(recorded.result).toBe('Recorded D-20261008-1405 in .claude/decisions.jsonl')
  const entries = w.writes.filter(x => x.path === DECISION_LOG)
  expect(entries.length).toBe(1)
  expect(JSON.parse(entries[0]?.text.trim() ?? '{}')).toMatchObject({ decision: 'Cache in SQLite', why: 'one file, no server', tags: ['storage'], by: 'claude' })

  // 14. the decision watch is off by default: a turn that names a decision makes no model.complete call
  expect(await lk($, 'watch status', 'decide')).toContain('Decision watch off')
  const prompt = 'Which store should the cache sit on? We talked about Redis and SQLite, and I would rather not run another server.'
  const answer = 'Then we go with SQLite for the cache: one file, no server. I named the table kv_cache and set the default TTL to 60 seconds.'
  w.chat.messages = [
    { role: 'user', text: prompt, toolUses: [] },
    { role: 'assistant', text: answer, toolUses: [] },
  ]
  await $.turn.start({ text: prompt, turnId: 't4' })
  await $.turn.complete({ turnId: 't4', answer, durationMs: 1200, isAborted: false, usage: null, reason: 'answer' } as never)
  expect(w.calls).toEqual([])
  expect(w.store.has('loopkeeper:decisions:watch-calls')).toBe(false)

  // the band: one line per concern, in register order, each showing where this session ended
  const ui = await $.ui.mount(BAND)
  const tree = await ui.drawn()
  const band = texts(await ui.find({ type: 'Box' })).join(' ')
  await ui.unmount()
  const lines = ['● Ship', 'gates ● 0/33 files', 'routed 2', 'review ● unit tests round 3/3', 'decisions ● 1 this session'].map(t => band.indexOf(t))
  expect(lines.every(i => i >= 0)).toBe(true)
  expect([...lines].sort((a, b) => a - b)).toEqual(lines)
  expect(band).toContain('budget 23')
  // after the stage's stepper, each concern draws one kit line: a bold label, toned `● word` chips, a quiet right side
  const gates = lineOf(tree, 'gates')
  expect(gates?.label).toEqual({ text: 'gates', color: undefined, bold: true })
  expect(gates?.chips[0]).toEqual({ text: '● 0/33 files', color: TONES.ok.fg, bold: true })
  expect(gates?.right).toEqual({ text: 'raised 33', color: TONES.muted.fg, bold: undefined })
  expect(linePlain(lineOf(tree, 'routing'))).toMatch(/^routing {2}● on {2}● loop {3}recon→\w+ · .* · routed 2$/)
  const review = lineOf(tree, 'review')
  expect(linePlain(review)).toMatch(/^review {2}● unit tests round 3\/3 {2}● 1 open {3}1 p0 · not converging/)
  expect(review?.chips.map(c => c.color)).toEqual([TONES.danger.fg, TONES.warn.fg])
  expect(review?.right?.color).toBe(TONES.muted.fg)
  expect(linePlain(lineOf(tree, 'decisions'))).toBe('decisions  ● 1 this session')
})

test('a second session: the plan gate waits for the user (a prompt that asks to wait, then approval mode ask)', { timeoutMs: 60_000 }, async ($, on) => {
  const w = world(on, { now: NOW })
  await startTurn($)
  expect(await lk($, 'on')).toContain('Pipeline preset gsd')

  // the hold phrase in the prompt: a clean plan review records the verdict but the gate stays closed
  await $.prompt.submit({ text: 'Add the cache, but wait for my approval before editing' } as never)
  expect(w.toasts).toContain('loopkeeper: plan approval will wait for you (asked in the prompt)')
  await setStage($, { stage: 'plan', size: 'large', files: 13 })
  await $.tool.call(validator as never)
  const held = await reviewCycle($, { subject: 'cache plan', kind: 'plan', items: [{ text: 'mention the TTL', priority: 'p2' }] })
  expect(held).toContain('loopkeeper stage: Moved from Plan to Validate plan.')
  expect(held).toContain('The user approves plans themselves here (this prompt asked to wait): ask them to run /lk approve.')
  expect(w.state.get('stagePlanDone')).toBe(false)
  expect(w.state.get('stageBudget') ?? 0).toBe(0)
  expect(await lk($, 'status')).toContain('Gates: Validate plan pending')
  const closed = await check($, edit(`${CWD}/src/cache.ts`))
  expect(closed.decision).toBe('deny')
  expect(closed.reason).toContain("/lk approve opens the pipeline's Validate plan gate (from Plan or Validate plan), or /lk gates plan ok allows edits for this session without it.")
  expect((await setStage($, { stage: 'execute' })).deny).toContain('/lk approve')
  // /lk approve opens it with the budget, and the edit goes through
  expect(await lk($, 'approve')).toContain(APPROVED_PLAN + ' File budget: 23 files a turn (13 planned + 10).')
  expect(w.state.get('stagePlanDone')).toBe(true)
  expect(w.state.get('stageBudget')).toBe(23)
  expect((await check($, edit(`${CWD}/src/cache.ts`))).decision).toBe('allow')
  expect((await setStage($, { stage: 'execute' })).result).toContain('Moved from Validate plan to Execute')

  // approval mode ask: the next task's clean review also waits, and /lk approve opens it with that task's budget
  expect(await lk($, 'approval ask')).toContain('Plan approval: ask')
  await $.turn.start({ text: 'now the eviction', turnId: 't2' })
  await setStage($, { stage: 'plan', size: 'large', files: 5 })
  expect(w.state.get('stageBudget')).toBe(0)
  await $.tool.call(validator as never)
  const asking = await reviewCycle($, { subject: 'eviction plan', kind: 'plan' })
  expect(asking).toContain('The user approves plans themselves here (approval mode ask): ask them to run /lk approve.')
  expect(w.state.get('stagePlanDone')).toBe(false)
  expect((await check($, edit(`${CWD}/src/evict.ts`))).decision).toBe('deny')
  expect(await lk($, 'approve')).toContain(APPROVED_PLAN + ' File budget: 15 files a turn (5 planned + 10).')
  expect(w.state.get('stageBudget')).toBe(15)
  expect((await check($, edit(`${CWD}/src/evict.ts`))).decision).toBe('allow')
  expect(w.asked).toEqual([])
})
