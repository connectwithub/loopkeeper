import { expect, test } from 'claude-code/testing'

import {
  DEFAULTS,
  bandParts,
  buildSections,
  extractFromMessages,
  factsBlock,
  itemsOf,
  levelOf,
  markUnverifiedFigures,
  mergeConfig,
  parseBrief,
  parseFraction,
  readingOf,
  replaceSection,
  setFrontmatter,
  upsertLogLine,
  appendLine,
} from '../hooks/logic'
import type { Facts } from '../hooks/logic'

const FACTS: Facts = {
  cwd: '/work',
  when: '2026-10-09 14:02',
  branch: 'main',
  commits: ['abc1234 add webhook verifier'],
  editedTurn: ['/work/src/a.ts'],
  editedSession: ['/work/src/a.ts', '/work/src/b.ts'],
  lastPrompt: 'finish the verifier',
  lastAnswer: 'Done with step one.',
  openQuestions: [],
  stage: '',
  ctxPercent: 86,
  ctxTokens: 172000,
  ctxWindow: 200000,
}

const GOOD = `## Status
The verifier works; 12 tests pass.

## Next steps
- Wire the verifier into the webhook route.

## Dead ends
- Tried HMAC over the parsed body; signatures differ, use the raw body.

## Open questions
- Should replays older than 5 minutes be rejected?

## Decisions
- Raw-body HMAC, see docs/adr/0004.md

## Log
Added the webhook verifier. Next: wire it into the route.`

test('config merge: defaults, user file, project file, store, later wins', async () => {
  const cfg = mergeConfig({ warnAt: 0.6, mode: 'auto' }, { handoffAt: 0.8, model: 'sonnet' }, { mode: 'off', band: false })
  expect(cfg.warnAt).toBe(0.6)
  expect(cfg.handoffAt).toBe(0.8)
  expect(cfg.mode).toBe('off')
  expect(cfg.model).toBe('sonnet')
  expect(cfg.band).toBe(false)
  expect(cfg.maxBriefTokens).toBe(2000)
})

test('config merge drops bad values and keeps levels in order', async () => {
  const cfg = mergeConfig({ warnAt: 2, handoffAt: 'x', mode: 'loud', maxBriefTokens: 'many' }, null, [1, 2])
  expect(cfg).toEqual(DEFAULTS)
  const odd = mergeConfig({ warnAt: 0.9, handoffAt: 0.8 })
  expect(odd.warnAt).toBe(0.8)
})

test('parseFraction takes 0.8, 80 and 80%', async () => {
  expect(parseFraction('0.8')).toBe(0.8)
  expect(parseFraction('80')).toBe(0.8)
  expect(parseFraction('80%')).toBe(0.8)
  expect(parseFraction('0')).toBe(null)
  expect(parseFraction('abc')).toBe(null)
  expect(parseFraction('150')).toBe(null)
})

test('thresholds and band colors from a usage reading', async () => {
  const r41 = readingOf({ tokens: 82_000, window: 200_000, percent: 41 }, 0, 'complete')
  const r72 = readingOf({ percent: 72 }, 0, 'complete')
  const r86 = readingOf({ tokens: 172_000, window: 200_000 }, 0, 'step')
  expect(r41 && levelOf(r41.frac, DEFAULTS)).toBe('ok')
  expect(r72 && levelOf(r72.frac, DEFAULTS)).toBe('warn')
  expect(r86 && levelOf(r86.frac, DEFAULTS)).toBe('due')
  expect(bandParts(r41, DEFAULTS)).toEqual({ chip: 'ctx 41%', tone: 'ok', right: [], urgent: false })
  const warn = bandParts(r72, DEFAULTS)
  expect([warn.tone, warn.urgent]).toEqual(['accent', false])
  expect(warn.right).toEqual(['/handoff at a stopping point'])
  const due = bandParts(r86, DEFAULTS)
  expect([due.tone, due.urgent]).toEqual(['danger', true])
  expect(due.chip).toBe('ctx 86%')
  expect(bandParts(r86, { ...DEFAULTS, mode: 'off' }).right).toEqual(['handoff due · guard off'])
  expect(bandParts(null, DEFAULTS, { lastWhen: '2026-10-09 14:02', resumed: 'x' })).toEqual({ chip: 'ctx --', tone: 'muted', right: ['last 2026-10-09 14:02'], urgent: false })
  expect(readingOf({}, 0, 'x')).toBe(null)
  // Tool output not measured yet adds to the step's projection.
  const projected = readingOf({ tokens: 160_000, window: 200_000 }, 0, 'step', 20_000)
  expect(projected && Math.round(projected.frac * 100)).toBe(90)
})

test('facts from messages: last prompt, answer, unanswered questions, edits', async () => {
  const x = extractFromMessages([
    { role: 'user', text: 'build the verifier', toolUses: [] },
    {
      role: 'assistant',
      text: 'Working on it.',
      toolUses: [
        { tool: 'Edit', input: { file_path: '/work/a.ts' }, result: 'ok' },
        { tool: 'Write', input: { file_path: '/work/b.ts' }, isError: true },
        { tool: 'AskUserQuestion', input: { questions: [{ question: 'Which port?' }] } },
        { tool: 'AskUserQuestion', input: { questions: [{ question: 'Use TLS?' }] }, result: { answers: {} } },
      ],
    },
    { role: 'user', text: '<system-reminder>noise</system-reminder>', toolUses: [] },
  ])
  expect(x.lastPrompt).toBe('build the verifier')
  expect(x.lastAnswer).toBe('Working on it.')
  expect(x.edited).toEqual(['/work/a.ts'])
  expect(x.openQuestions).toEqual(['Which port?'])
})

test('a reply with every heading parses; one missing a heading does not', async () => {
  const p = parseBrief(GOOD)
  expect(p).toBeDefined()
  expect(p && p.Status).toContain('verifier works')
  expect(parseBrief('Sure! Here is a summary of the session.')).toBe(null)
  expect(parseBrief(GOOD.replace('## Dead ends', '## Dead-ish'))).toBe(null)
  expect(itemsOf('None.')).toEqual([])
  expect(itemsOf('- a\n- b')).toEqual(['a', 'b'])
})

test('facts-only fallback when the reply lacks headings', async () => {
  const s = buildSections(parseBrief('I could not do that.'), FACTS)
  expect(s.status).toContain('facts only')
  expect(s.status).toContain('abc1234 add webhook verifier')
  expect(s.deadEnds).toBe(null)
  expect(s.log.startsWith('(handoff-guard, facts only)')).toBe(true)
  expect(s.decisions).toEqual([])
})

test('markUnverifiedFigures flags numbers the facts do not hold', async () => {
  const facts = factsBlock(FACTS)
  const out = markUnverifiedFigures('Context hit 86% at 172000 tokens; 12 tests pass and latency is 340 ms, about 93k. See `port 8080` on 2026-10-09.', facts)
  expect(out.flagged).toEqual(['12', '340', '93k'])
  expect(out.text).toContain('86% at 172000 tokens')
  expect(out.text).toContain('12 (unverified) tests')
  expect(out.text).toContain('340 (unverified) ms')
  expect(out.text).toContain('93k (unverified)')
  expect(out.text).toContain('`port 8080`')
  // 172k is within rounding of a fact.
  expect(markUnverifiedFigures('about 172k', facts).flagged).toEqual([])
  // Small counts are not claims worth flagging.
  expect(markUnverifiedFigures('step 3 of the plan', facts).flagged).toEqual([])
})

test('model sections land in the brain shapes; unverified figures are marked', async () => {
  const facts = factsBlock(FACTS)
  const checked = markUnverifiedFigures(GOOD, facts)
  const s = buildSections(parseBrief(checked.text), FACTS)
  expect(s.status).toContain('12 (unverified) tests pass')
  expect(s.next).toBe('- Wire the verifier into the webhook route.')
  expect(s.deadEnds).toContain('raw body')
  expect(s.decisions).toEqual(['Raw-body HMAC, see docs/adr/0004.md'])
  expect(s.questions).toEqual(['Should replays older than 5 minutes be rejected?'])
  expect(s.log).toBe('Added the webhook verifier. Next: wire it into the route.')
})

test('replaceSection rewrites one section and keeps the rest', async () => {
  const doc = '---\ntype: project\nupdated: 2026-10-01\n---\n\n## What it is\n\nA thing.\n\n## Status today\n\nOld status.\n\n## Next\n\n- old\n\n## Milestones\n\n- M1\n'
  let out = replaceSection(doc, 'Status today', 'New status.')
  out = replaceSection(out, 'Next', '- new')
  out = setFrontmatter(out, 'updated', '2026-10-09')
  expect(out).toContain('## Status today\n\nNew status.\n\n## Next\n\n- new\n\n## Milestones\n\n- M1')
  expect(out).toContain('A thing.')
  expect(out).not.toContain('Old status.')
  expect(out).toContain('updated: 2026-10-09')
  expect(replaceSection('# x\n', 'Dead ends', '- y')).toBe('# x\n\n## Dead ends\n\n- y\n')
})

test('log lines: one per session, replaced while still last; other files dedupe', async () => {
  const doc = '# Log\n\n- 2026-10-08 — earlier.\n'
  const first = upsertLogLine(doc, '- 2026-10-09 — first try.', undefined)
  expect(first).toBe('# Log\n\n- 2026-10-08 — earlier.\n- 2026-10-09 — first try.\n')
  const second = upsertLogLine(first, '- 2026-10-09 — better.', '- 2026-10-09 — first try.')
  expect(second).toBe('# Log\n\n- 2026-10-08 — earlier.\n- 2026-10-09 — better.\n')
  expect(appendLine(second, '- 2026-10-08 — earlier.').added).toBe(false)
})
