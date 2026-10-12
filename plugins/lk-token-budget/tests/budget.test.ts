import { expect, test } from 'claude-code/testing'

import {
  DEFAULTS,
  applyStep,
  applyTurnComplete,
  bandText,
  countedOf,
  emptyTally,
  fmt,
  levelOf,
  mergeConfig,
  parseFraction,
  parseTokens,
  turnsLeft,
} from '../hooks/budget'

test('parses token counts with k and m suffixes', async () => {
  expect(parseTokens('500k')).toBe(500_000)
  expect(parseTokens('2m')).toBe(2_000_000)
  expect(parseTokens('1.5m')).toBe(1_500_000)
  expect(parseTokens('1500000')).toBe(1_500_000)
  expect(parseTokens('1,500,000')).toBe(1_500_000)
  expect(parseTokens('2M')).toBe(2_000_000)
  expect(parseTokens('0')).toBe(0)
  expect(parseTokens('lots')).toBe(null)
  expect(parseTokens('-5k')).toBe(null)
  expect(parseTokens('')).toBe(null)
})

test('parses warn fractions', async () => {
  expect(parseFraction('0.8')).toBe(0.8)
  expect(parseFraction('75%')).toBe(0.75)
  expect(parseFraction('0')).toBe(null)
  expect(parseFraction('1.5')).toBe(null)
})

test('merges defaults, saved settings and the project file, later wins', async () => {
  const cfg = mergeConfig({ session: 1_000_000, action: 'stop', warnAt: 'bad' }, { session: '3m', countCacheReads: true })
  expect(cfg).toEqual({ ...DEFAULTS, session: 3_000_000, action: 'stop', countCacheReads: true })
  expect(mergeConfig(null, null)).toEqual(DEFAULTS)
  expect(mergeConfig({ action: 'explode' }, 'nonsense').action).toBe('warn')
})

test('counts input, output and cache writes, and cache reads only when asked', async () => {
  const u = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 25, cache_read_input_tokens: 1000 }
  expect(countedOf(u, false)).toBe(175)
  expect(countedOf(u, true)).toBe(1175)
  expect(countedOf(null, true)).toBe(0)
  expect(countedOf({ input_tokens: 'x', output_tokens: -3 } as never, false)).toBe(0)
})

test('accumulates by model and agent, and keeps per-turn history', async () => {
  let t = emptyTally('s')
  t = applyStep(t, { input_tokens: 10, output_tokens: 5, model: 'opus' }, undefined, false, 'fallback')
  t = applyStep(t, { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 7 }, 'a1', false, 'sonnet')
  expect(t.total).toBe(35)
  expect(t.cacheRead).toBe(7)
  expect(t.byModel).toEqual({ opus: 15, sonnet: 20 })
  expect(t.byAgent).toEqual({ main: 15, a1: 20 })
  expect(t.requests).toBe(2)
  t = applyTurnComplete(t, 'a1')
  expect(t.turns).toBe(0)
  t = applyTurnComplete(t, undefined)
  expect(t.turns).toBe(1)
  expect(t.perTurn).toEqual([35])
  expect(turnsLeft(t, { ...DEFAULTS, session: 105 })).toBe(2)
})

test('levels and band text', async () => {
  const cfg = { ...DEFAULTS, session: 2_000_000 }
  expect(levelOf(1_000_000, cfg)).toBe('ok')
  expect(levelOf(1_600_000, cfg)).toBe('warn')
  expect(levelOf(2_000_000, cfg)).toBe('over')
  expect(levelOf(9e9, { ...cfg, session: 0 })).toBe('ok')
  const t = { ...emptyTally('s'), total: 1_200_000, byAgent: { main: 900_000, a: 300_000 } }
  expect(bandText(t, cfg, 41)).toBe('budget ▰▰▰▰▱▱▱▱ 1.2M / 2.0M 60% · main 0.9M · agents 0.3M · ctx 41%')
  expect(bandText(t, cfg, null)).toBe('budget ▰▰▰▰▱▱▱▱ 1.2M / 2.0M 60% · main 0.9M · agents 0.3M')
  expect(fmt(45_000)).toBe('45k')
  expect(fmt(812)).toBe('812')
})
