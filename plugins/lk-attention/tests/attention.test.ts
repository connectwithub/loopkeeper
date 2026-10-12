// Unit tests for the pure helpers.
import { expect, test } from 'claude-code/testing'

import type { AttentionEvent } from '../types'
import { DEFAULTS, bandOf, firstLine, fmtDuration, mergeConfig, notifyArgv, parseMs, soundArgvs } from '../hooks/attention'

function ev(kind: AttentionEvent['kind'], extra: Partial<AttentionEvent> = {}): AttentionEvent {
  return { id: kind + Math.random(), at: 0, kind, title: 't', body: 'b', seen: false, ...extra }
}

test('mergeConfig layers user file, project file and saved settings, dropping bad fields', async () => {
  const cfg = mergeConfig(
    { longTurnMs: 30000, sound: false, soundFile: '/x.oga', native: 'yes' },
    { longTurnMs: 45000, subagentMs: -5, quietAfterPromptMs: 5000 },
    { sound: true },
  )
  expect(cfg).toEqual({ ...DEFAULTS, longTurnMs: 45000, sound: true, soundFile: '/x.oga', quietAfterPromptMs: 5000 })
  expect(mergeConfig(null, 'junk', [1])).toEqual(DEFAULTS)
})

test('band text lists waiting kinds in the accent tone, and turns danger for a failure', async () => {
  expect(bandOf([])).toBe(null)
  expect(bandOf([ev('permission-waiting', { tool: 'Bash' }), ev('question-waiting'), ev('long-turn-done', { seen: true })])).toEqual({
    text: 'attention ● 2 waiting: permission (Bash), question',
    state: '2 waiting',
    kinds: 'permission (Bash), question',
    tone: 'accent',
    urgent: true,
  })
  expect(bandOf([ev('long-turn-done'), ev('long-turn-done'), ev('failed')])).toEqual({
    text: 'attention ● 3 new: failed, done x2',
    state: '3 new',
    kinds: 'failed, done x2',
    tone: 'danger',
    urgent: true,
  })
  // Only finished turns: nothing is urgent, so the kinds stay quiet.
  expect(bandOf([ev('long-turn-done')])).toEqual({ text: 'attention ● 1 new: done', state: '1 new', kinds: 'done', tone: 'accent', urgent: false })
})

test('argv builders, durations and parsing', async () => {
  expect(notifyArgv('Claude finished (42s)', 'All  tests\npass')).toEqual([
    'notify-send', '-a', 'Claude Code', '-i', 'dialog-information', 'Claude finished (42s)', 'All tests pass',
  ])
  expect(soundArgvs('/s.oga')).toEqual([['paplay', '/s.oga'], ['pw-play', '/s.oga']])
  expect(fmtDuration(42_000)).toBe('42s')
  expect(fmtDuration(125_000)).toBe('2m 5s')
  expect(fmtDuration(3_780_000)).toBe('1h 3m')
  expect(parseMs('20s')).toBe(20000)
  expect(parseMs('2m')).toBe(120000)
  expect(parseMs('1500')).toBe(1500)
  expect(parseMs('soon')).toBe(null)
  expect(firstLine('\n## Done\n\nmore')).toBe('Done')
})
