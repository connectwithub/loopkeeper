import { expect, test } from 'claude-code/testing'

import { BAND, lineOf, start, lk, texts, tool, world } from './world.ts'

test('/lk status combines stage, gates, files, routing, review and decisions in wiring order', { timeoutMs: 20_000 }, async ($, on) => {
  world(on)
  await start($)
  const text = await lk($, 'status')
  const order = ['stage ●', 'gates ●', 'files ●', 'routing ●', 'review ●', 'decisions ●'].map(w => text.indexOf(w))
  expect(order.every(i => i >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  // /loopkeeper is the same grammar
  expect(await lk($, 'status', 'loopkeeper')).toBe(text)
})

test('/lk gates is answered by gates only; an unknown sub-command gets one answer', { timeoutMs: 20_000 }, async ($, on) => {
  world(on)
  await start($)
  const g = await lk($, 'gates')
  expect(g).toContain('gates ●')
  expect(g).not.toContain('stage ●')
  expect(g).not.toContain('routing ●')
  const off = await lk($, 'gates off')
  expect(off).toContain('gates off')
  const unknown = await lk($, 'frobnicate')
  expect(unknown.match(/unknown sub-command/g)?.length).toBe(1)
  expect(unknown.split('\n').length).toBe(1)
})

test('stage words, routing words and shared status each belong to one concern', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  await start($)
  expect(await lk($, 'build')).toContain('Moved from Plan to Build.')
  expect(await lk($, 'on')).toContain('GSD orchestrator mode on')
  expect(await lk($, 'status')).toContain('routing ● on')
  expect(await lk($, 'routes')).toBe('')
  expect(w.panes).toContain('loopkeeper-routes')
})

// The plan gate exists in the gsd preset; a plan validator that completed while planning counts for the gate.
const VALIDATOR = { tool: 'Agent', subagent_type: 'general-purpose', description: 'Plan validator: check the plan', prompt: 'x' }

test('a plan review pass with no open p0 or p1 makes stage record the consistent verdict', { timeoutMs: 20_000 }, async ($, on) => {
  world(on)
  await start($)
  await lk($, 'preset gsd')
  await tool($, 'set_stage', { stage: 'plan', size: 'large' })
  await $.tool.call(VALIDATOR)
  expect(await lk($, 'status')).toContain('Plan verdict: none')
  await tool($, 'review_cycle', { subject: 'the plan', kind: 'plan', items: [{ text: 'minor wording', priority: 'p2' }] })
  const status = await lk($, 'status')
  expect(status).toContain('Plan verdict: consistent')
  expect(status).toContain('planDone true')
})

test('an open p1 leaves the verdict alone, and a non-plan kind never records one', { timeoutMs: 20_000 }, async ($, on) => {
  world(on)
  await start($)
  await lk($, 'preset gsd')
  await tool($, 'set_stage', { stage: 'plan', size: 'large' })
  await $.tool.call(VALIDATOR)
  await tool($, 'review_cycle', { subject: 'the plan', kind: 'plan', items: [{ text: 'wrong file', priority: 'p1' }] })
  expect(await lk($, 'status')).toContain('Plan verdict: none')
  await tool($, 'review_cycle', { subject: 'code', kind: 'review', items: [] })
  expect(await lk($, 'status')).toContain('Plan verdict: none')
  // closing the p1 on a later plan pass records it
  await tool($, 'review_cycle', { subject: 'the plan', items: [{ text: 'wrong file', done: true }] })
  expect(await lk($, 'status')).toContain('Plan verdict: consistent')
})

test('review_cycle keeps subjects in review-loop shape', async ($, on) => {
  world(on)
  await start($)
  await tool($, 'review_cycle', { subject: 'asset', kind: 'critic', score: 7.5, items: [{ text: 'tighten', priority: 'p0' }] })
  await tool($, 'review_item', { subject: 'asset', text: 'tighten', done: true, proof: 'abc' })
  const status = await lk($, 'status')
  expect(status).toContain('review ● 1 active of 1 subjects')
})

test('the band lists the six concerns in wiring order', async ($, on) => {
  world(on)
  await start($)
  // files, review and decisions draw a line only when there is something to show: give each one
  await $.tool.call({ tool: 'Read', file_path: '/work/project/README.md' })
  await tool($, 'review_cycle', { subject: 'smoke', kind: 'review', items: [{ text: 'a finding', priority: 'p2' }] })
  await tool($, 'record_decision', { decision: 'Keep one band line per concern', why: 'readability', tags: ['ui'] })
  const ui = await $.ui.mount(BAND)
  const top = await ui.find({ type: 'Box' })
  const first = texts(top).map(t => t.trim().split(/\s+/)[0])
  const order = first.filter(w => ['stage', 'gates', 'files', 'routing', 'review', 'decisions'].includes(w))
  expect([...new Set(order)]).toEqual(['stage', 'gates', 'files', 'routing', 'review', 'decisions'])
  // every concern after the stage draws the band grammar: a bold label in the default color, then `● word` chips
  const tree = await ui.drawn()
  for (const label of ['gates', 'files', 'routing', 'review', 'decisions']) {
    const line = lineOf(tree, label)
    expect(line?.label).toEqual({ text: label, color: undefined, bold: true })
    expect(line?.chips.length).toBeGreaterThan(0)
    expect(line?.chips.every(c => c.text.startsWith('● '))).toBe(true)
  }
  await ui.unmount()
})

test('only the commands we own are attempted, and a refusal is survived', async ($, on) => {
  const w = world(on, { refuse: ['files'] })
  await start($)
  const owned = ['lk', 'loopkeeper', 'reviews', 'decide', 'decisions', 'files']
  expect([...new Set(w.attempted)].sort()).toEqual([...owned].sort())
  expect(w.attempted).not.toContain('loop')
  expect(w.attempted).not.toContain('review')
  expect(w.registered).not.toContain('files')
  // the tools still registered after the refused command
  expect(w.tools.map(t => t.name).sort()).toEqual(['record_decision', 'review_cycle', 'review_item', 'review_status', 'set_stage'])
  expect(w.tools.every(t => t.isDeferred === false)).toBe(true)
})

test('config files are read through $.fs: project over user over defaults', async ($, on) => {
  world(on, {
    files: {
      '/home/tester/.claude/loopkeeper.json': JSON.stringify({ routing: { enabled: false }, pipeline: { approval: 'ask' } }),
      '/work/project/.claude/loopkeeper.json': JSON.stringify({ routing: { enabled: true } }),
    },
  })
  await start($)
  expect(await lk($, 'status')).toContain('routing ● on')
})

test('a broken config file is tolerated', async ($, on) => {
  world(on, { files: { '/work/project/.claude/loopkeeper.json': '{ nope' } })
  await start($)
  expect(await lk($, 'status')).toContain('stage ●')
})
