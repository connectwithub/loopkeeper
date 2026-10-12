// gates-core.test.ts: the gates' core, proven quickly. The file budget limit (10 with no plan, planned + slack once
// the stage approved a plan), the four-option limit question and its Raise, the ship gate on the stage atoms
// (ADR 0004), one question for `git push origin main`, fail-closed and the kill switch, and the rules block.
import { expect, test } from 'claude-code/testing'

import { TONES } from '../hooks/lib/kit.ts'
import { bandLineOf, bash, edit, linePlain, lk, startTurn, world } from './world.ts'

const ASK = (n: number) => `loopkeeper: this turn already touched ${n} files. Allow more?`
const files = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `/work/project/src/f${from + i}.ts`)

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

async function editAll($: any, paths: string[]): Promise<string[]> {
  const out: string[] = []
  for (const p of paths) out.push(((await $.tool.check(edit(p))) as { decision: string }).decision)
  return out
}

test('with no plan the limit is 10: ten files pass, the 11th asks and Stop denies and aborts the turn', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, { answers: ['Stop'] })
  await startTurn($)
  expect(await editAll($, files(1, 10))).toEqual(Array(10).fill('allow'))
  expect(w.asked).toEqual([])
  const r = (await $.tool.check(edit('/work/project/src/f11.ts'))) as { decision: string; reason: string }
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('would exceed the limit of 10 files per turn')
  expect(w.asked).toEqual([ASK(10)])
  await w.clock.advance(250)
  expect(w.aborted).toEqual(['t1'])
})

test('an approved plan of 13 files gives 23: the stage budget raises the limit', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, { answers: ['Stop'] })
  await startTurn($)
  // as the stage leaves them once it approved a plan of 13 files (planSlack 10)
  w.atoms.stagePlanFiles = 13
  w.atoms.stageBudget = 23
  expect(await editAll($, files(1, 23))).toEqual(Array(23).fill('allow'))
  expect(w.asked).toEqual([])
  expect(((await $.tool.check(edit('/work/project/src/f24.ts'))) as { decision: string }).decision).toBe('deny')
  expect(w.asked).toEqual([ASK(23)])
  expect(await lk($, 'gates text')).toContain("Files per turn: 23 (the approved plan's budget: 13 planned + 10)")
})

test('the limit question has four options; Raise sets gateSessionRaise to limit + slack and the label matches', { timeoutMs: 20_000 }, async ($, on) => {
  const log = optionsLog()
  const w = world(on, { answers: ['Raise to 20 for this session', 'Stop'], tool: log.tool })
  await startTurn($)
  expect(await editAll($, files(1, 11))).toEqual(Array(11).fill('allow'))
  expect(log.opts[0]).toEqual(['Allow 1 more', 'Allow rest of turn', 'Raise to 20 for this session', 'Stop'])
  expect(w.state.get('gateSessionRaise')).toBe(20)
  expect(await lk($, 'gates text')).toContain('Files per turn: 20 (raised for this session)')
  // the raise lasts the session: 20 files pass this turn, the 21st asks again with the next figure
  expect(await editAll($, files(12, 20))).toEqual(Array(9).fill('allow'))
  expect(w.asked.length).toBe(1)
  expect(((await $.tool.check(edit('/work/project/src/f21.ts'))) as { decision: string }).decision).toBe('deny')
  expect(log.opts[1]?.[2]).toBe('Raise to 30 for this session')
})

test('the ship gate holds at Plan and opens with stageShipOpen (no fallback question)', async ($, on) => {
  const w = world(on)
  await startTurn($)
  w.atoms.stageShipOpen = false
  const held = (await $.tool.check(bash('git commit -m "work"'))) as { decision: string; reason: string }
  expect(held.decision).toBe('deny')
  expect(held.reason).toBe(
    // the default stages gate no Ship stage, so /lk approve cannot open shipping: only ship ok is named
    'loopkeeper: shipping is gated (git commit). The pipeline is at Plan. Ask the user to review the work and run /lk gates ship ok.',
  )
  expect(w.asked).toEqual([])
  w.atoms.stageShipOpen = true
  expect(((await $.tool.check(bash('git commit -m "work"'))) as { decision: string }).decision).toBe('allow')
  expect(w.asked).toEqual([])
})

test('git push origin main asks exactly once: the merge gate, never a ship question too', async ($, on) => {
  const w = world(on, { answers: ['Merge'] })
  await startTurn($)
  // the default stages gate no ship stage, so shipping is open and only the merge gate asks
  expect(((await $.tool.check(bash('git push origin main'))) as { decision: string }).decision).toBe('allow')
  expect(w.asked).toEqual(['Merge now? (loopkeeper: push to the default branch)'])
  // with shipping held, the ship gate refuses without asking anything
  w.atoms.stageShipOpen = false
  expect(((await $.tool.check(bash('git push origin main'))) as { decision: string }).decision).toBe('deny')
  expect(w.asked.length).toBe(1)
})

test('a hook error fails closed naming CLAUDE_MODS_DISABLE=loopkeeper, for edits and for Bash', async ($, on) => {
  world(on, { breakCwd: true })
  await startTurn($)
  for (const call of [edit('/work/project/src/a.ts'), bash('touch b.txt')]) {
    const r = (await $.tool.check(call)) as { decision: string; reason: string }
    expect(r.decision).toBe('deny')
    expect(r.reason).toContain('loopkeeper: the gates failed (')
    expect(r.reason).toContain('they can run /lk gates off, or set CLAUDE_MODS_DISABLE=loopkeeper.')
  }
})

test('CLAUDE_MODS_DISABLE=loopkeeper: no limit, the band says so, /lk gates still answers', async ($, on) => {
  const w = world(on, { env: { CLAUDE_MODS_DISABLE: 'loopkeeper' } })
  await startTurn($)
  expect(await editAll($, files(1, 12))).toEqual(Array(12).fill('allow'))
  expect(w.asked).toEqual([])
  expect(await lk($, 'gates text')).toContain('Status: OFF (CLAUDE_MODS_DISABLE names loopkeeper')
  const l = await bandLineOf($, 'gates')
  expect(linePlain(l)).toBe('gates  ● off (CLAUDE_MODS_DISABLE)')
  expect(l?.label).toEqual({ text: 'gates', color: undefined, bold: true })
  expect(l?.chips[0]?.color).toBe(TONES.muted.fg)
})

test('the changeControl rules block names the limit in force, the base and the plan budget', async ($, on) => {
  world(on)
  await startTurn($)
  const before = (await $.prompt.context({ blocks: [] } as never)) as { blocks: Array<{ name: string; text: string }> }
  const block = before.blocks.find(b => b.name === 'changeControl')
  expect(block?.text).toContain('At most 10 distinct files')
  expect(block?.text).toContain("an approved plan's file budget (its planned files plus 10) raises it")
  await lk($, 'gates off')
  const after = (await $.prompt.context({ blocks: [] } as never)) as { blocks: Array<{ name: string }> }
  expect(after.blocks.some(b => b.name === 'changeControl')).toBe(false)
})
