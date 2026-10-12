// gates-budget.test.ts: the file budget (ADR 0011) beyond what gates-core.test.ts proves. The limit per turn is the
// `/lk gates max <n>` override when set, otherwise max(base, stageBudget, gateSessionRaise); the Raise answer is the
// limit in force plus planSlack; the stage's budget comes and goes with plan approval (seeded here on the atoms, after
// the stage's own session start); subagents and the once-per-turn abort.
import { expect, test } from 'claude-code/testing'

import { CWD, edit, lk, projectGates, startTurn, world } from './world.ts'

const ASK = (n: number) => `loopkeeper: this turn already touched ${n} files. Allow more?`
/** These tests make dozens of guarded calls; under a loaded parallel run the 5 s default is too tight. */
const SLOW = { timeoutMs: 20_000 }
const files = (from: number, to: number, dir = 'src') => Array.from({ length: to - from + 1 }, (_, i) => `${CWD}/${dir}/f${from + i}.ts`)

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

async function editAll($: any, paths: string[], extra: Record<string, unknown> = {}): Promise<string[]> {
  const out: string[] = []
  for (const p of paths) out.push(((await $.tool.check({ ...edit(p), ...extra })) as { decision: string }).decision)
  return out
}

const decision = async ($: any, path: string): Promise<string> => ((await $.tool.check(edit(path))) as { decision: string }).decision

/** What the stage leaves on its atoms once it approved a plan of `planned` files (planSlack 10). */
const approvePlan = (w: { atoms: Record<string, unknown> }, planned: number, slack = 10) =>
  Object.assign(w.atoms, { stagePlanFiles: planned, stageBudget: planned + slack, stagePlanDone: true })
/** What the stage leaves once the budget it approved is cleared (a new task, a reset). */
const clearPlan = (w: { atoms: Record<string, unknown> }) => Object.assign(w.atoms, { stagePlanFiles: null, stageBudget: 0 })

test('the base is the limit with no plan: a configured base of 4 asks at the 5th, and gates text says why', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Stop'], files: projectGates({ maxFilesPerTurn: 4 }) })
  await startTurn($)
  expect(await editAll($, files(1, 4))).toEqual(Array(4).fill('allow'))
  expect(await decision($, `${CWD}/src/f5.ts`)).toBe('deny')
  expect(w.asked).toEqual([ASK(4)])
  expect(await lk($, 'gates text')).toContain('Files per turn: 4 (the base, maxFilesPerTurn)')
})

test('a base larger than the plan budget wins: base 30 over a budget of 23', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Stop'], files: projectGates({ maxFilesPerTurn: 30 }) })
  await startTurn($)
  approvePlan(w, 13)
  expect(await editAll($, files(1, 30))).toEqual(Array(30).fill('allow'))
  expect(w.asked).toEqual([])
  expect(await decision($, `${CWD}/src/f31.ts`)).toBe('deny')
  expect(w.asked).toEqual([ASK(30)])
  expect(await lk($, 'gates text')).toContain('Files per turn: 30 (the base, maxFilesPerTurn; plan budget 23)')
})

test('under a plan budget of 23 the question offers Raise to 33; choosing it lasts the session', SLOW, async ($, on) => {
  const log = optionsLog()
  const w = world(on, { answers: ['Raise to 33 for this session', 'Stop'], tool: log.tool })
  await startTurn($)
  approvePlan(w, 13)
  expect(await editAll($, files(1, 24))).toEqual(Array(24).fill('allow'))
  expect(log.opts).toEqual([['Allow 1 more', 'Allow rest of turn', 'Raise to 33 for this session', 'Stop']])
  expect(w.asked).toEqual([ASK(23)])
  expect(w.state.get('gateSessionRaise')).toBe(33)
  expect(await lk($, 'gates text')).toContain('Files per turn: 33 (raised for this session)')
  // a new turn: 33 pass, the 34th asks again
  await $.turn.start({ text: 'next', turnId: 't2' })
  expect(await editAll($, files(1, 33, 'lib'))).toEqual(Array(33).fill('allow'))
  expect(await decision($, `${CWD}/lib/f34.ts`)).toBe('deny')
  expect(w.asked).toEqual([ASK(23), ASK(33)])
})

test('planSlack from config sets the Raise figure: base 10 and slack 5 offer Raise to 15', SLOW, async ($, on) => {
  const log = optionsLog()
  const w = world(on, { answers: ['Raise to 15 for this session', 'Stop'], tool: log.tool, files: projectGates({ planSlack: 5 }) })
  await startTurn($)
  expect(await editAll($, files(1, 15))).toEqual(Array(15).fill('allow'))
  expect(log.opts[0]?.[2]).toBe('Raise to 15 for this session')
  expect(w.state.get('gateSessionRaise')).toBe(15)
  expect(await decision($, `${CWD}/src/f16.ts`)).toBe('deny')
  expect(log.opts[1]?.[2]).toBe('Raise to 20 for this session')
})

test('Raise, then a new larger plan: the larger budget wins by the max, in the same turn', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Raise to 20 for this session', 'Stop'] })
  await startTurn($)
  expect(await editAll($, files(1, 11))).toEqual(Array(11).fill('allow'))
  expect(w.state.get('gateSessionRaise')).toBe(20)
  approvePlan(w, 15)
  expect(await lk($, 'gates text')).toContain("Files per turn: 25 (the approved plan's budget: 15 planned + 10)")
  expect(await editAll($, files(12, 25))).toEqual(Array(14).fill('allow'))
  expect(w.asked).toEqual([ASK(10)])
  expect(await decision($, `${CWD}/src/f26.ts`)).toBe('deny')
  expect(w.asked).toEqual([ASK(10), ASK(25)])
})

test('Raise, then a smaller plan: the raise stays in force (the max, never the latest)', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Raise to 20 for this session', 'Stop'] })
  await startTurn($)
  expect(await editAll($, files(1, 11))).toEqual(Array(11).fill('allow'))
  approvePlan(w, 5)
  expect(await lk($, 'gates text')).toContain('Files per turn: 20 (raised for this session)')
  expect(await editAll($, files(12, 20))).toEqual(Array(9).fill('allow'))
  expect(await decision($, `${CWD}/src/f21.ts`)).toBe('deny')
  expect(w.asked).toEqual([ASK(10), ASK(20)])
})

test('the stage clears its budget: with no raise the limit falls back to the base', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Stop'] })
  await startTurn($)
  approvePlan(w, 13)
  expect(await lk($, 'gates text')).toContain('Files per turn: 23')
  clearPlan(w)
  expect(await lk($, 'gates text')).toContain('Files per turn: 10 (the base, maxFilesPerTurn)')
  expect(await editAll($, files(1, 10))).toEqual(Array(10).fill('allow'))
  expect(await decision($, `${CWD}/src/f11.ts`)).toBe('deny')
  expect(w.asked).toEqual([ASK(10)])
})

test('the stage clears its budget: a session raise outlives it, so the limit is max(base, raise)', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Raise to 20 for this session', 'Stop'] })
  await startTurn($)
  expect(await editAll($, files(1, 11))).toEqual(Array(11).fill('allow'))
  approvePlan(w, 20)
  expect(await lk($, 'gates text')).toContain("Files per turn: 30 (the approved plan's budget: 20 planned + 10)")
  clearPlan(w)
  expect(await lk($, 'gates text')).toContain('Files per turn: 20 (raised for this session)')
  await $.turn.start({ text: 'next', turnId: 't2' })
  expect(await editAll($, files(1, 20, 'lib'))).toEqual(Array(20).fill('allow'))
  expect(await decision($, `${CWD}/lib/f21.ts`)).toBe('deny')
  expect(w.asked).toEqual([ASK(10), ASK(20)])
})

test('/lk gates max <n> wins over the base, the plan budget and the session raise', SLOW, async ($, on) => {
  const log = optionsLog()
  const w = world(on, { answers: ['Raise to 20 for this session', 'Stop'], tool: log.tool })
  await startTurn($)
  expect(await editAll($, files(1, 11))).toEqual(Array(11).fill('allow'))
  approvePlan(w, 13)
  expect(await lk($, 'gates max 5')).toBe('maxFilesPerTurn is 5 for this session.')
  expect(await lk($, 'gates text')).toContain('Files per turn: 5 (/lk gates max, for this session)')
  await $.turn.start({ text: 'next', turnId: 't2' })
  expect(await editAll($, files(1, 5, 'lib'))).toEqual(Array(5).fill('allow'))
  expect(await decision($, `${CWD}/lib/f6.ts`)).toBe('deny')
  expect(w.asked).toEqual([ASK(10), ASK(5)])
  expect(log.opts[1]).toEqual(['Allow 1 more', 'Allow rest of turn', 'Raise to 15 for this session', 'Stop'])
})

test('Raise under a /lk gates max override raises the override too, so the label stays true', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Raise to 15 for this session', 'Stop'] })
  await startTurn($)
  await lk($, 'gates max 5')
  expect(await editAll($, files(1, 6))).toEqual(Array(6).fill('allow'))
  expect(w.asked).toEqual([ASK(5)])
  expect(w.store.get('loopkeeper:gates:overrides:sess-1')).toEqual({ maxFilesPerTurn: 15 })
  expect(w.state.get('gateSessionRaise')).toBe(15)
  const text = await lk($, 'gates text')
  expect(text).toContain('maxFilesPerTurn: 15  [session]')
  expect(text).toContain('Files per turn: 15 (/lk gates max, for this session)')
  expect(await editAll($, files(7, 15))).toEqual(Array(9).fill('allow'))
  expect(await decision($, `${CWD}/src/f16.ts`)).toBe('deny')
  expect(w.asked).toEqual([ASK(5), ASK(15)])
})

test('non-interactive under a plan budget: denies past 23 without asking, aborts the turn, raises nothing', SLOW, async ($, on) => {
  const w = world(on, { surfaces: [] })
  await startTurn($)
  approvePlan(w, 13)
  expect(await editAll($, files(1, 23))).toEqual(Array(23).fill('allow'))
  const r = (await $.tool.check(edit(`${CWD}/src/f24.ts`))) as { decision: string; reason: string }
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('would exceed the limit of 23 files per turn (no one to ask (non-interactive session))')
  expect(w.asked).toEqual([])
  await w.clock.advance(250)
  expect(w.aborted).toEqual(['t1'])
  expect(w.state.has('gateSessionRaise')).toBe(false)
})

const SUB = { agentId: 'agent-1' }

test('countSubagents off: subagent edits are not counted, and a subagent turn.start does not reset the count', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Stop'] })
  await startTurn($)
  expect(await editAll($, files(1, 10))).toEqual(Array(10).fill('allow'))
  await $.turn.start({ text: 'build it', turnId: 'sub-1', ...SUB })
  expect(await editAll($, files(1, 15, 'agent'), SUB)).toEqual(Array(15).fill('allow'))
  expect(w.asked).toEqual([])
  expect(await lk($, 'gates text')).toContain('Files touched this turn (10/10):')
  // the main loop is still at 10 of 10: its 11th file asks, and Stop aborts the main turn, not the subagent's
  expect(await decision($, `${CWD}/src/f11.ts`)).toBe('deny')
  expect(w.asked).toEqual([ASK(10)])
  await w.clock.advance(250)
  expect(w.aborted).toEqual(['t1'])
})

test('countSubagents on: subagent edits count against the main turn, and a subagent turn.start still does not reset it', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Stop'], files: projectGates({ countSubagents: true }) })
  await startTurn($)
  expect(await editAll($, files(1, 6))).toEqual(Array(6).fill('allow'))
  await $.turn.start({ text: 'build it', turnId: 'sub-1', ...SUB })
  expect(await editAll($, files(1, 4, 'agent'), SUB)).toEqual(Array(4).fill('allow'))
  expect(w.asked).toEqual([])
  expect(await editAll($, [`${CWD}/agent/f5.ts`], SUB)).toEqual(['deny'])
  expect(w.asked).toEqual([ASK(10)])
  expect(await lk($, 'gates text')).toContain('Files touched this turn (10/10):')
})

test('the 250 ms abort is scheduled once per turn: not before 250 ms, not twice, and again in the next turn', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Stop'] })
  await startTurn($)
  expect(await editAll($, files(1, 10))).toEqual(Array(10).fill('allow'))
  expect(await decision($, `${CWD}/src/f11.ts`)).toBe('deny')
  await w.clock.advance(249)
  expect(w.aborted).toEqual([])
  expect(await decision($, `${CWD}/src/f12.ts`)).toBe('deny')
  await w.clock.advance(1)
  expect(w.aborted).toEqual(['t1'])
  await w.clock.advance(500)
  expect(w.aborted).toEqual(['t1'])
  expect(w.asked.length).toBe(2)
  await $.turn.start({ text: 'next', turnId: 't2' })
  expect(await editAll($, files(1, 10, 'lib'))).toEqual(Array(10).fill('allow'))
  expect(await decision($, `${CWD}/lib/f11.ts`)).toBe('deny')
  await w.clock.advance(250)
  expect(w.aborted).toEqual(['t1', 't2'])
})

test('a dismissed limit question denies and aborts like Stop, and raises nothing', SLOW, async ($, on) => {
  const w = world(on, { answers: ['reject'] })
  await startTurn($)
  expect(await editAll($, files(1, 10))).toEqual(Array(10).fill('allow'))
  const r = (await $.tool.check(edit(`${CWD}/src/f11.ts`))) as { decision: string; reason: string }
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('(the question was dismissed)')
  await w.clock.advance(250)
  expect(w.aborted).toEqual(['t1'])
  expect(w.state.has('gateSessionRaise')).toBe(false)
})

test('the rules block names the limit in force as the raise and the budget move it, with the base beside it', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Raise to 20 for this session'] })
  await startTurn($)
  const block = async () =>
    ((await $.prompt.context({ blocks: [] } as never)) as { blocks: Array<{ name: string; text: string }> }).blocks.find(b => b.name === 'changeControl')?.text ?? ''
  expect(await editAll($, files(1, 11))).toEqual(Array(11).fill('allow'))
  expect(await block()).toContain('At most 20 distinct files may be changed per turn')
  expect(await block()).toContain('the base is 10')
  approvePlan(w, 23)
  expect(await block()).toContain('At most 33 distinct files')
  clearPlan(w)
  expect(await block()).toContain('At most 20 distinct files')
})
