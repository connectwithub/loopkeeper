import type { CommandRunInput, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { DEFAULTS, mergeConfig } from '../hooks/budget'
import {
  afterKeepWarm,
  afterRequest,
  autoArmed,
  autoWarmDue,
  autoWarmStatus,
  bandCache,
  bandChip,
  coldSendText,
  duePing,
  emptyCache,
  isCold,
  keepWarmText,
  mmss,
  pingText,
  refreshUsd,
  rewroteCache,
  timeLeftMs,
  usdText,
} from '../hooks/cache'
import type { CacheState } from '../hooks/cache'
import { PRICES, coldWriteUsd, priceOf, requestUsd, sanitizePrices } from '../hooks/prices'

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = 1_000_000_000
const CFG = { cacheTtlMinutes: 60, prices: {} }

function warm(at: number, extra: Partial<CacheState> = {}): CacheState {
  return { ...emptyCache(), lastRequestAt: at, model: 'claude-opus-5-5', contextTokens: 240_000, ...extra }
}

// ---------------------------------------------------------------- pure helpers

test('timeLeftMs and isCold follow the TTL from the last request', () => {
  const s = warm(T0)
  expect(timeLeftMs(emptyCache(), T0, HOUR)).toBe(null)
  expect(timeLeftMs(s, T0, HOUR)).toBe(HOUR)
  expect(timeLeftMs(s, T0 + 5 * MIN + 48_000, HOUR)).toBe(54 * MIN + 12_000)
  expect(timeLeftMs(s, T0 + 2 * HOUR, HOUR)).toBe(0)
  expect(isCold(emptyCache(), T0 + 2 * HOUR, HOUR)).toBe(false)
  expect(isCold(s, T0 + HOUR - 1, HOUR)).toBe(false)
  expect(isCold(s, T0 + HOUR, HOUR)).toBe(true)
  expect(isCold({ ...s, compacted: true }, T0 + 2 * HOUR, HOUR)).toBe(false)
  expect(mmss(HOUR)).toBe('60:00')
  expect(mmss(54 * MIN + 12_500)).toBe('54:12')
})

test('duePing fires each threshold once per warm window and resets on a new request', () => {
  const th = [15, 5, 1]
  let s = warm(T0)
  const fire = (now: number): number | null => {
    const due = duePing(s, now, HOUR, th)
    if (due !== null) s = { ...s, lastPing: due }
    return due
  }
  expect(fire(T0 + 44 * MIN)).toBe(null)
  expect(fire(T0 + 45 * MIN)).toBe(15)
  expect(fire(T0 + 45 * MIN + 30_000)).toBe(null)
  expect(fire(T0 + 50 * MIN)).toBe(null)
  expect(fire(T0 + 55 * MIN)).toBe(5)
  expect(fire(T0 + 56 * MIN)).toBe(null)
  expect(fire(T0 + 59 * MIN)).toBe(1)
  expect(fire(T0 + 59 * MIN + 30_000)).toBe(null)
  expect(fire(T0 + HOUR)).toBe(null) // cold: the cold toast is separate
  // A late tick fires only the most urgent threshold reached.
  s = warm(T0)
  expect(fire(T0 + 57 * MIN)).toBe(5)
  expect(fire(T0 + 57 * MIN + 30_000)).toBe(null)
  // A new request starts a new window.
  s = afterRequest(s, T0 + 58 * MIN, 'claude-opus-5-5')
  expect(s.lastPing).toBe(null)
  expect(fire(T0 + 58 * MIN + 45 * MIN)).toBe(15)
  // Thresholds at or past the TTL never fire; nothing fires after a compaction.
  expect(duePing(warm(T0), T0 + MIN, 10 * MIN, [15])).toBe(null)
  expect(duePing(warm(T0, { compacted: true }), T0 + 59 * MIN, HOUR, th)).toBe(null)
})

test('bandCache texts and tones: muted, ok, warn, danger, compacted', () => {
  expect(bandCache(emptyCache(), T0, CFG)).toEqual({ text: 'cache · no request yet', tone: 'muted' })
  const s = warm(T0)
  // 240k × $8/MTok (opus-5-5 1h write) = $1.92
  expect(bandCache(s, T0 + 5 * MIN + 48_000, CFG)).toEqual({ text: 'cache warm · 54:12 left · cold resend ≈ $1.92', tone: 'ok' })
  expect(bandCache(s, T0 + 56 * MIN, CFG)).toEqual({ text: 'cache warm · 4:00 left · cold resend ≈ $1.92', tone: 'warn' })
  expect(bandCache(s, T0 + 61 * MIN, CFG)).toEqual({ text: 'cache cold · resend ≈ $1.92', tone: 'danger' })
  expect(bandCache({ ...s, model: 'mystery-model' }, T0 + 61 * MIN, CFG)).toEqual({ text: 'cache cold', tone: 'danger' })
  expect(bandCache({ ...s, compacted: true }, T0 + 61 * MIN, CFG).tone).toBe('muted')
  expect(bandCache(s, T0 + 26 * MIN, { cacheTtlMinutes: 30, prices: {} })).toEqual({
    text: 'cache warm · 4:00 left · cold resend ≈ $1.92',
    tone: 'warn',
  })
})

test('bandChip: the band\'s chip, its tone and the note for the quiet right side', () => {
  expect(bandChip(emptyCache(), T0, CFG)).toEqual({ chip: 'cache: no request yet', tone: 'muted', note: '' })
  const s = warm(T0)
  expect(bandChip(s, T0 + 5 * MIN + 48_000, CFG)).toEqual({ chip: 'cache warm 54:12 left', tone: 'ok', note: 'cold resend ≈ $1.92' })
  expect(bandChip(s, T0 + 56 * MIN, CFG)).toEqual({ chip: 'cache warm 4:00 left', tone: 'warn', note: 'cold resend ≈ $1.92' })
  expect(bandChip(s, T0 + 61 * MIN, CFG)).toEqual({ chip: 'cache cold', tone: 'danger', note: 'resend ≈ $1.92' })
  expect(bandChip({ ...s, model: 'mystery-model' }, T0 + 61 * MIN, CFG)).toEqual({ chip: 'cache cold', tone: 'danger', note: '' })
  expect(bandChip({ ...s, compacted: true }, T0 + 61 * MIN, CFG)).toEqual({
    chip: 'cache compacted',
    tone: 'muted',
    note: 'next request starts fresh',
  })
})

test('ping, cold-send texts and money formatting', () => {
  const s = warm(T0)
  expect(pingText(s, T0 + 55 * MIN, 5, 1.92, HOUR)).toBe(
    'Prompt cache goes cold in 5 min; a resend after that costs ≈ $1.92 (240k tokens at $8/MTok). Keep warm: /budget keepwarm, or w on the band.',
  )
  expect(pingText(s, T0 + 57 * MIN, 5, null, HOUR)).toBe('Prompt cache goes cold in 3 min. Keep warm: /budget keepwarm, or w on the band.')
  expect(coldSendText(s, 1.92)).toBe('Cache cold: this prompt re-writes 240k tokens of context at the cache-write price, ≈ $1.92.')
  expect(coldSendText(emptyCache(), null)).toBe('Cache cold: this prompt re-writes the context.')
  expect(usdText(0.001)).toBe('<$0.01')
  expect(usdText(1.234)).toBe('$1.23')
  expect(usdText(250.4)).toBe('$250')
})

test('priceOf matches the longest family first; coldWriteUsd and requestUsd use it', () => {
  expect(PRICES.length).toBe(9)
  expect(priceOf('claude-opus-5-5')?.family).toBe('opus-5-5')
  expect(priceOf('claude-opus-5-20260101')?.family).toBe('opus-5')
  expect(priceOf('claude-opus-4-1')?.family).toBe('opus-4')
  expect(priceOf('claude-sonnet-5-5')?.family).toBe('sonnet-5-5')
  expect(priceOf('claude-sonnet-4-6')?.family).toBe('sonnet')
  expect(priceOf('claude-haiku-4-5')?.family).toBe('haiku')
  expect(priceOf('claude-fable-5-1')?.cacheWrite1h).toBe(20)
  expect(priceOf('gpt-something')).toBe(null)
  expect(priceOf(null)).toBe(null)
  expect(coldWriteUsd(1_000_000, 'claude-opus-5-5')).toBe(8)
  expect(coldWriteUsd(240_000, 'claude-sonnet-4-6')).toBe(1.44)
  expect(coldWriteUsd(1000, 'unknown')).toBe(null)
  // 1M in + 100k out + 2M read + 500k write at opus-5-5: 4 + 2 + 0.4 + 4
  const usd = requestUsd(
    { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 2_000_000, cache_creation_input_tokens: 500_000 },
    'claude-opus-5-5',
  )
  expect(Math.round((usd ?? 0) * 100) / 100).toBe(10.4)
  // An override replaces a family or adds one.
  expect(coldWriteUsd(1_000_000, 'claude-opus-5-5', { 'opus-5-5': [4, 20, 0.2, 10] })).toBe(10)
  expect(priceOf('claude-myth-1', { 'myth-1': [1, 2, 3, 4] })?.cacheWrite1h).toBe(4)
  expect(sanitizePrices({ 'opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite1h: 9 }, bad: [1, 2], neg: [1, 2, 3, -1] })).toEqual({
    'opus-5-5': [4, 20, 0.2, 9],
  })
})

test('the cache settings merge from the user file, saved settings and the project file', () => {
  expect(DEFAULTS.cacheTtlMinutes).toBe(60)
  expect(DEFAULTS.cacheWarnMinutes).toEqual([15, 5, 1])
  expect(DEFAULTS.cachePings).toBe(true)
  const cfg = mergeConfig(
    { cachePings: false },
    { cacheWarnMinutes: [2, 10], prices: { 'opus-5-5': [1, 1, 1, 1] } },
    { cacheTtlMinutes: 30, cacheWarnMinutes: 'bad', prices: { haiku: [1, 5, 0.1, 3] } },
  )
  expect(cfg.cacheTtlMinutes).toBe(30)
  expect(cfg.cacheWarnMinutes).toEqual([10, 2])
  expect(cfg.cachePings).toBe(false)
  expect(cfg.prices).toEqual({ haiku: [1, 5, 0.1, 3], 'opus-5-5': [1, 1, 1, 1] })
  expect(mergeConfig({ cacheTtlMinutes: -5 }, null).cacheTtlMinutes).toBe(60)
})

const AUTO = { autoKeepWarm: true, autoKeepWarmMinutes: 3, autoKeepWarmMax: 6 }

test('autoWarmDue fires once per warm window at the set minutes, under the cap, never running, compacted, halted or cold', () => {
  const s = warm(T0)
  expect(autoWarmDue(s, T0 + 57 * MIN, HOUR, { ...AUTO, autoKeepWarm: false })).toBe(false)
  expect(autoWarmDue(emptyCache(), T0 + 57 * MIN, HOUR, AUTO)).toBe(false)
  expect(autoWarmDue(s, T0 + 57 * MIN - 1, HOUR, AUTO)).toBe(false)
  expect(autoWarmDue(s, T0 + 57 * MIN, HOUR, AUTO)).toBe(true)
  expect(autoWarmDue(s, T0 + 59 * MIN, HOUR, AUTO)).toBe(true)
  expect(autoWarmDue(s, T0 + HOUR, HOUR, AUTO)).toBe(false) // cold: a keep-warm now would pay the full write
  expect(autoWarmDue({ ...s, autoTriedAt: T0 }, T0 + 58 * MIN, HOUR, AUTO)).toBe(false)
  expect(autoWarmDue({ ...s, turnRunning: true }, T0 + 58 * MIN, HOUR, AUTO)).toBe(false)
  expect(autoWarmDue({ ...s, compacted: true }, T0 + 58 * MIN, HOUR, AUTO)).toBe(false)
  expect(autoWarmDue({ ...s, autoHalted: true }, T0 + 58 * MIN, HOUR, AUTO)).toBe(false)
  expect(autoWarmDue({ ...s, autoWarms: 5 }, T0 + 58 * MIN, HOUR, AUTO)).toBe(true)
  expect(autoWarmDue({ ...s, autoWarms: 6 }, T0 + 58 * MIN, HOUR, AUTO)).toBe(false)
  // Minutes at or past the TTL never fire.
  expect(autoWarmDue(s, T0 + MIN, 3 * MIN, AUTO)).toBe(false)
  // Armed is the same test without the time: the timer skips pings while it holds.
  expect(autoArmed(s, HOUR, AUTO)).toBe(true)
  expect(autoArmed({ ...s, autoWarms: 6 }, HOUR, AUTO)).toBe(false)
  expect(autoArmed({ ...s, autoTriedAt: T0 }, HOUR, AUTO)).toBe(false)
  // State saved before the fields existed reads as zero refreshes, nothing tried.
  const old = { lastRequestAt: T0, model: 'claude-opus-5-5', contextTokens: 1, compacted: false, lastPing: null, cold: false } as unknown as CacheState
  expect(autoWarmDue(old, T0 + 58 * MIN, HOUR, AUTO)).toBe(true)
})

test('afterKeepWarm counts automatic refreshes only, a re-write halts, and a request keeps the count', () => {
  const s = warm(T0)
  const a = afterKeepWarm(s, T0 + 57 * MIN, true)
  expect([a.lastRequestAt, a.autoWarms, a.autoHalted, a.lastPing]).toEqual([T0 + 57 * MIN, 1, false, null])
  expect(afterKeepWarm(a, T0 + 60 * MIN, false).autoWarms).toBe(1)
  expect(afterRequest(a, T0 + 70 * MIN, 'claude-opus-5-5').autoWarms).toBe(1)
  const h = afterKeepWarm(s, T0 + 57 * MIN, true, true)
  expect([h.lastRequestAt, h.autoHalted]).toEqual([T0 + 57 * MIN, true])
  expect(rewroteCache({ cache_read_input_tokens: 82_000, cache_creation_input_tokens: 30 })).toBe(false)
  expect(rewroteCache({ cache_read_input_tokens: 0, cache_creation_input_tokens: 82_000 })).toBe(true)
  expect(rewroteCache(null)).toBe(false)
})

test('keep-warm log lines, the per-refresh estimate and the auto status', () => {
  const cfg = { cacheTtlMinutes: 60, prices: {}, autoKeepWarmMax: 6 }
  const u = { input_tokens: 12, output_tokens: 2, cache_read_input_tokens: 82_000, cache_creation_input_tokens: 30 }
  const s = warm(T0, { contextTokens: 82_000 })
  expect(keepWarmText(s, cfg, u, false)).toBe('keep-warm: cache refreshed for 60 min · read 82k · wrote 30 · ≈ $0.02')
  expect(keepWarmText({ ...s, autoWarms: 2 }, cfg, u, true)).toBe('auto keep-warm 2/6: cache refreshed for 60 min · read 82k · wrote 30 · ≈ $0.02')
  expect(keepWarmText({ ...s, autoWarms: 6 }, cfg, u, true)).toBe(
    'auto keep-warm 6/6: cache refreshed for 60 min · read 82k · wrote 30 · ≈ $0.02 · cap reached, no more until the next turn',
  )
  // 82k × $0.20/MTok (opus-5-5 cache read) ≈ $0.016
  expect(usdText(refreshUsd(s, cfg) ?? 0)).toBe('$0.02')
  expect(refreshUsd({ ...s, model: 'mystery-model' }, cfg)).toBe(null)
  expect(autoWarmStatus(s, HOUR, { ...AUTO, autoKeepWarm: false })).toBe('off')
  expect(autoWarmStatus({ ...s, autoWarms: 1 }, HOUR, AUTO)).toBe('on · at 3 min left · 1 of 6 this idle stretch')
  expect(autoWarmStatus({ ...s, turnRunning: true }, HOUR, AUTO)).toBe('on · at 3 min left · 0 of 6 this idle stretch · waits while a turn runs')
  expect(autoWarmStatus({ ...s, autoWarms: 6 }, HOUR, AUTO)).toContain('6 of 6 this idle stretch · cap reached until the next turn')
  expect(autoWarmStatus({ ...s, autoHalted: true }, HOUR, AUTO)).toContain('stopped: the last fork re-wrote the cache')
  expect(autoWarmStatus(s, HOUR, AUTO, true)).toContain('paused: session budget spent')
  expect(autoWarmStatus(s, 3 * MIN, AUTO)).toBe('on, but 3 min is not under the 3 min cache lifetime, so it never fires')
})

test('auto keep-warm settings: off by default, a project file can only turn it off, minutes at least 1', () => {
  expect([DEFAULTS.autoKeepWarm, DEFAULTS.autoKeepWarmMinutes, DEFAULTS.autoKeepWarmMax]).toEqual([false, 3, 6])
  // The user file and saved settings switch it on and tune it.
  const cfg = mergeConfig({ autoKeepWarm: true }, null, { autoKeepWarmMinutes: '5', autoKeepWarmMax: 10 })
  expect([cfg.autoKeepWarm, cfg.autoKeepWarmMinutes, cfg.autoKeepWarmMax]).toEqual([true, 5, 10])
  // A project file can't switch it on or raise it, but its false wins.
  const p = mergeConfig(null, { autoKeepWarm: true, autoKeepWarmMinutes: 50, autoKeepWarmMax: 1000 })
  expect([p.autoKeepWarm, p.autoKeepWarmMinutes, p.autoKeepWarmMax]).toEqual([false, 3, 6])
  expect(mergeConfig({ autoKeepWarm: true }, { autoKeepWarm: false }).autoKeepWarm).toBe(false)
  // Malformed values fall back to the defaults.
  const bad = mergeConfig({ autoKeepWarm: 'yes', autoKeepWarmMinutes: 0.5, autoKeepWarmMax: 2.5 }, null)
  expect([bad.autoKeepWarm, bad.autoKeepWarmMinutes, bad.autoKeepWarmMax]).toEqual([false, 3, 6])
  expect(mergeConfig({ autoKeepWarmMax: 0, autoKeepWarmMinutes: 'x' }, null).autoKeepWarmMax).toBe(6)
})

// ---------------------------------------------------------------- hooks

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

type World = {
  toasts: string[]
  logs: string[]
  forks: unknown[]
  saved: Map<string, unknown>
  pending: { usage: Usage | null }
  reply: { value: unknown }
}

const BAND = {
  plugin: 'lk-token-budget',
  component: 'AbovePrompt',
  requestId: 'band',
  viewport: { columns: 160, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 158, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const

const PANE = {
  plugin: 'lk-token-budget',
  component: 'Pane',
  requestId: 'token-budget',
  viewport: { columns: 160, rows: 50 },
  props: { title: 'Token budget', isFocused: true, bodyColumns: 150, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const FORK_USAGE = { input_tokens: 12, output_tokens: 2, cache_read_input_tokens: 82_000, cache_creation_input_tokens: 30 }

function opus(input: number): Usage {
  return { input_tokens: input, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
}

/** Stubs Claude Code around the mod, with a mock clock at T0. Call before the first $ call. */
type ForkStub = ($: unknown, e: unknown) => unknown

function world(on: On, opts: { user?: unknown; project?: unknown; usd?: number; fork?: ForkStub } = {}) {
  const clock = mock.clock(on, { now: T0 })
  const w: World = {
    toasts: [],
    logs: [],
    forks: [],
    saved: new Map(),
    pending: { usage: null },
    reply: { value: { isAnswered: true, text: 'ok', usage: FORK_USAGE } },
  }
  on('store.get', ($, e) => ({ value: w.saved.get(e.key) }))
  on('store.set', ($, e) => {
    w.saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('env.get', () => ({ value: opts.user === undefined ? undefined : '/home/tester' }))
  on('fs.exists', ($, e) => ({
    value:
      (opts.user !== undefined && e.path === '/home/tester/.claude/token-budget.json') ||
      (opts.project !== undefined && e.path === '/work/.claude/token-budget.json'),
  }))
  on('fs.read', ($, e) => ({ value: JSON.stringify((e.path === '/work/.claude/token-budget.json' ? opts.project : opts.user) ?? {}) }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.usage', () => ({
    value: {
      startedAt: T0,
      context: { tokens: 82_000, window: 200_000, percent: 41 },
      rateLimits: [],
      ...(opts.usd !== undefined ? { cost: { usd: opts.usd } } : {}),
    },
  }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('model.fork', (($: unknown, e: unknown) => {
    if (opts.fork) return opts.fork($, e)
    w.forks.push(e)
    return { value: w.reply.value }
  }) as never)
  on('session.start', () => ({ cwd: '/work' }))
  on('classic.SessionStart', () => ({}))
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'ok' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: w.pending.usage }
  })
  return { w, clock }
}

/** A /budget command input as the composer sends it. */
function cmd(args: string): CommandRunInput {
  return { command: 'budget', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } }
}

async function start($: Engine) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

async function step($: Engine, w: World, u: Usage | null, agentId?: string) {
  w.pending.usage = u
  const input = { turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1, ...(agentId ? { agentId } : {}) }
  const stream = $.turn.step(input)
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
  return s.value
}

/** One main-loop turn: a request, then turn.complete (which reads 82k context tokens). */
async function turn($: Engine, w: World) {
  await step($, w, opus(1000))
  await $.turn.complete({ turnId: 't', answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' })
}

/** A main-loop turn from its start: turn.start (a new idle stretch), then a request and turn.complete. */
async function fullTurn($: Engine, w: World) {
  await $.turn.start({ text: 'go on', turnId: 't' })
  await turn($, w)
}

async function budget($: Engine, args: string): Promise<string> {
  return String((await $.command.run(cmd(args))).text ?? '')
}

async function summary($: Engine): Promise<string> {
  return String((await $.command.run(cmd('text'))).text ?? '')
}

/** Every string inside a found element, in order. */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object') return ''
  const kids = (node as { children?: unknown[] }).children
  return Array.isArray(kids) ? kids.map(textOf).join('') : ''
}

// 82k context × $8/MTok = $0.656
const COLD_USD = '$0.66'

test('the timer pings at 15, 5 and 1 minutes, toasts once when cold, and a new request re-arms it', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await clock.advance(10 * MIN)
  expect(w.toasts).toEqual([]) // nothing before the first request
  await turn($, w)
  await step($, w, opus(500), 'agent-a') // a subagent's request doesn't touch the main cache
  await clock.advance(44 * MIN)
  expect(w.toasts).toEqual([])
  await clock.advance(MIN)
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toBe(
    `Prompt cache goes cold in 15 min; a resend after that costs ≈ ${COLD_USD} (82k tokens at $8/MTok). Keep warm: /budget keepwarm, or w on the band.`,
  )
  await clock.advance(10 * MIN)
  expect(w.toasts.length).toBe(2)
  expect(w.toasts[1]).toContain('goes cold in 5 min')
  await clock.advance(4 * MIN)
  expect(w.toasts[2]).toContain('goes cold in 1 min')
  await clock.advance(MIN)
  expect(w.toasts.length).toBe(4)
  expect(w.toasts[3]).toBe(`Prompt cache went cold. The next send re-writes the context, ≈ ${COLD_USD} (82k tokens at $8/MTok).`)
  await clock.advance(30 * MIN)
  expect(w.toasts.length).toBe(4)
  expect(await summary($)).toContain(`cache cold · resend ≈ ${COLD_USD}`)
  // A new request: a new window, and the 15-minute ping comes again.
  await turn($, w)
  expect(await summary($)).toContain(`cache warm · 60:00 left · cold resend ≈ ${COLD_USD}`)
  await clock.advance(45 * MIN)
  expect(w.toasts.length).toBe(5)
  expect(w.toasts[4]).toContain('goes cold in 15 min')
})

test('/budget pings off silences the toasts but the band still shows the cache', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  expect((await $.command.run(cmd('pings off'))).text).toBe('Cache pings off: the band still shows the cache.')
  await turn($, w)
  await clock.advance(2 * HOUR)
  expect(w.toasts).toEqual([])
  expect(await summary($)).toContain('cache cold')
})

test('/budget keepwarm sends one tiny fork, re-arms the timer and logs its cost', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await turn($, w)
  await clock.advance(50 * MIN)
  expect(await summary($)).toContain('cache warm · 10:00 left')
  const r = await $.command.run(cmd('keepwarm'))
  expect(w.forks.length).toBe(1)
  expect(w.forks[0]).toEqual({ prompt: 'Reply with the single word ok.' })
  // 12 in × $4 + 2 out × $20 + 82k read × $0.2 + 30 write × $8, per million: ≈ $0.02
  expect(r.text).toBe('keep-warm: cache refreshed for 60 min · read 82k · wrote 30 · ≈ $0.02')
  expect(w.logs).toEqual([String(r.text)])
  expect(await summary($)).toContain('cache warm · 60:00 left')
  // Auto keep-warm is off by default: time passing sends no fork.
  await clock.advance(3 * HOUR)
  expect(w.forks.length).toBe(1)
})

test('keep-warm handles a null or unanswered fork with a toast and leaves the timer alone', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await turn($, w)
  await clock.advance(50 * MIN)
  const before = w.toasts.length // the 15-minute ping came at 45
  w.reply.value = null
  expect((await $.command.run(cmd('keepwarm'))).text).toBe('keep-warm got no reply')
  w.reply.value = { isAnswered: false, reason: 'api-error', status: 529, usage: FORK_USAGE }
  expect((await $.command.run(cmd('keepwarm'))).text).toBe('keep-warm got no reply (api-error)')
  expect(w.toasts.slice(before)).toEqual(['keep-warm got no reply', 'keep-warm got no reply (api-error)'])
  expect(w.logs).toEqual([])
  expect(await summary($)).toContain('cache warm · 10:00 left')
})

test('keep-warm sends exactly one fork with the prompt alone', async ($, on) => {
  const forks: unknown[] = []
  const { w } = world(on, {
    fork: ($, e) => {
      forks.push(e)
      return { value: { isAnswered: true, text: 'ok', usage: FORK_USAGE } }
    },
  })
  await start($)
  await turn($, w)
  const r = await $.command.run(cmd('keepwarm'))
  expect(forks).toEqual([{ prompt: 'Reply with the single word ok.' }])
  expect(r.text).toContain('keep-warm: cache refreshed')
})

test('the band shows the cache as a kit chip on both surfaces and its Keep warm button forks', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  // Before the first request: a muted chip and no button.
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const chip = await ui.find({ type: 'Text', text: /^● cache: no request yet$/ })
    expect(chip?.props.color).toBe('inactive')
    expect(await ui.find({ key: 'keepwarm' })).toBeUndefined()
    await ui.unmount()
  }
  await turn($, w)
  await clock.advance(5 * MIN + 48_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    // The terminal's press re-arms the window, so the desktop draws a full hour.
    const left = surface === 'terminal' ? '54:12' : '60:00'
    const chip = await ui.find({ type: 'Text', text: /^● cache warm / })
    expect(textOf(chip)).toBe(`● cache warm ${left} left`)
    expect(chip?.props).toMatchObject({ color: 'success', bold: true })
    const right = await ui.find({ type: 'Text', text: /^main / })
    expect(textOf(right)).toContain(` · cold resend ≈ ${COLD_USD}`)
    expect(right?.props.color).toBe('inactive')
    const button = await ui.find({ key: 'keepwarm' })
    expect(button?.props.label).toBe('Keep warm')
    expect(button?.props.hotkey).toBe('w')
    await ui.press({ key: 'keepwarm' })
    await ui.unmount()
  }
  expect(w.forks.length).toBe(2)
  expect(w.logs.length).toBe(2)
  // Cold: a `● cache cold` chip in the danger tone, never a fill, and the resend cost in default text.
  await clock.advance(61 * MIN)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const chip = await ui.find({ type: 'Text', text: /^● cache cold$/ })
    expect(chip?.props).toMatchObject({ color: 'error', bold: true })
    expect(chip?.props.backgroundColor).toBeUndefined()
    const right = await ui.find({ type: 'Text', text: /^main / })
    expect(textOf(right)).toMatch(/ · resend ≈ \$0\.66$/)
    expect(right?.props.color).toBeUndefined()
    expect(JSON.stringify(await ui.drawn())).not.toMatch(/dimColor|backgroundColor|yellow|white|gray|grey|black|subtle/i)
    await ui.unmount()
  }
})

test('a prompt sent while the cache is cold is logged with its cost and never dropped', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await turn($, w)
  // Warm: nothing noted.
  await clock.advance(30 * MIN)
  const warmSend = await $.prompt.submit({ text: 'next step', wait: false } as never)
  expect(warmSend.drop).toBeUndefined()
  expect(w.logs).toEqual([])
  await clock.advance(31 * MIN)
  // A slash command isn't a resend of the conversation.
  await $.prompt.submit({ text: '/budget', wait: false } as never)
  expect(w.logs).toEqual([])
  const toastsBefore = w.toasts.length
  const r = await $.prompt.submit({ text: 'carry on', wait: false } as never)
  expect(r.drop).toBeUndefined()
  expect(r.text).toBe('carry on')
  const msg = `Cache cold: this prompt re-writes 82k tokens of context at the cache-write price, ≈ ${COLD_USD}.`
  expect(w.logs).toEqual([msg])
  expect(w.toasts.slice(toastsBefore)).toEqual([msg])
})

test('a compaction resets the window: no cold note, no pings, no Keep warm', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await turn($, w)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
  await clock.advance(2 * HOUR)
  expect(w.toasts).toEqual([])
  await $.prompt.submit({ text: 'go on', wait: false } as never)
  expect(w.logs).toEqual([])
  expect(await summary($)).toContain('cache · compacted, next request starts fresh')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'keepwarm' })).toBeUndefined()
  await ui.unmount()
  // The next request after it is a new warm window.
  await turn($, w)
  expect(await summary($)).toContain('cache warm · 60:00 left')
})

test('a resumed session seeds the cache from the SessionStart payload, and stays unknown without it', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await $.classic.SessionStart({ source: 'resume', session_id: 's', transcript_path: '/t', cwd: '/work' } as never)
  expect(await summary($)).toContain('cache · no request yet')
  await $.classic.SessionStart({
    source: 'resume',
    session_id: 's',
    transcript_path: '/t',
    cwd: '/work',
    model: 'claude-sonnet-5-5',
    seconds_since_last_response: 1200,
    context_tokens: 100_000,
  } as never)
  // 100k × $4/MTok (sonnet-5-5) = $0.40; 20 minutes ago leaves 40.
  expect(await summary($)).toContain('cache warm · 40:00 left · cold resend ≈ $0.40')
  await $.classic.SessionStart({
    source: 'fork',
    session_id: 's',
    transcript_path: '/t',
    cwd: '/work',
    model: 'claude-sonnet-5-5',
    seconds_since_last_response: 600,
    context_tokens: 100_000,
    prompt_cache_likely_expired: true,
  } as never)
  expect(await summary($)).toContain('cache cold · resend ≈ $0.40')
  // The restarted timer toasts the cold state once.
  await clock.advance(30_000)
  expect(w.toasts).toEqual(['Prompt cache went cold. The next send re-writes the context, ≈ $0.40 (100k tokens at $4/MTok).'])
})

test('the pane shows Context, Cache, Cold resend and Session cost tiles on both surfaces; Keep warm forks', async ($, on) => {
  const { w, clock } = world(on, { usd: 4.567, user: { prices: { 'opus-5-5': [4, 20, 0.2, 10] } } })
  await start($)
  await turn($, w)
  await clock.advance(10 * MIN)
  await $.command.run(cmd(''))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    for (const label of ['Context', 'Cache', 'Cold resend', 'Session cost']) {
      expect(await ui.find({ type: 'Text', text: label })).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: '82k · 41%' })).toBeDefined()
    // The terminal's press re-arms the window, so the desktop draws a full hour.
    expect(await ui.find({ type: 'Text', text: surface === 'terminal' ? 'warm 50:00' : 'warm 60:00' })).toBeDefined()
    // The user file's price override: 82k × $10/MTok
    expect(await ui.find({ type: 'Text', text: '≈ $0.82' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$4.57' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /opus-5-5/ })).toBeDefined()
    expect(await ui.find({ key: 'reset' })).toBeDefined()
    expect(await ui.find({ key: 'close' })).toBeDefined()
    await ui.press({ key: 'keepwarm' })
    await ui.unmount()
  }
  expect(w.forks.length).toBe(2)
})

// ---------------------------------------------------------------- auto keep-warm

const AUTO_LINE = 'cache refreshed for 60 min · read 82k · wrote 30 · ≈ $0.02'

test('auto keep-warm: one fork at 3 minutes left with a dim cost line, no pings while armed, at most 6 per idle stretch', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await fullTurn($, w)
  expect(await budget($, 'autowarm on')).toBe(
    'Auto keep-warm on: one tiny request when 3 min are left, at most 6 per idle stretch, each ≈ $0.02 at the current context (82k tokens). Saved for every session on this machine.',
  )
  expect(w.saved.get('settings')).toEqual({ autoKeepWarm: true })
  await clock.advance(57 * MIN - 30_000)
  expect(w.forks.length).toBe(0)
  expect(w.toasts).toEqual([]) // the 15- and 5-minute pings are skipped: auto keep-warm will act
  await clock.advance(30_000)
  expect(w.forks).toEqual([{ prompt: 'Reply with the single word ok.' }])
  expect(w.logs).toEqual([`auto keep-warm 1/6: ${AUTO_LINE}`])
  expect(await summary($)).toContain('cache warm · 60:00 left')
  expect(await summary($)).toContain('Auto keep-warm: on · at 3 min left · 1 of 6 this idle stretch')
  // Every 57 minutes after that, up to the cap.
  await clock.advance(5 * 57 * MIN)
  expect(w.forks.length).toBe(6)
  expect(w.logs[5]).toBe(`auto keep-warm 6/6: ${AUTO_LINE} · cap reached, no more until the next turn`)
  expect(w.toasts).toEqual([])
  // The last window: no seventh fork; the pings come back, then the cold toast.
  await clock.advance(HOUR)
  expect(w.forks.length).toBe(6)
  expect(w.toasts.length).toBe(4)
  expect(w.toasts[0]).toContain('goes cold in 15 min')
  expect(w.toasts[3]).toContain('Prompt cache went cold.')
  expect(await budget($, 'autowarm')).toBe('Auto keep-warm: on · at 3 min left · 6 of 6 this idle stretch · cap reached until the next turn')
  // A new turn starts a new idle stretch.
  await fullTurn($, w)
  await clock.advance(57 * MIN)
  expect(w.forks.length).toBe(7)
  expect(w.logs[6]).toBe(`auto keep-warm 1/6: ${AUTO_LINE}`)
  // Off again: no more forks.
  expect(await budget($, 'autowarm off')).toBe('Auto keep-warm off: the cache is refreshed only when you press Keep warm or run /budget keepwarm.')
  await clock.advance(3 * HOUR)
  expect(w.forks.length).toBe(7)
})

test('auto keep-warm waits while a turn runs and never fires after a compaction', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await budget($, 'autowarm on')
  // A turn that starts and makes a request, then runs on (a long tool call, a permission prompt).
  await $.turn.start({ text: 'go on', turnId: 't' })
  await step($, w, opus(1000))
  await clock.advance(58 * MIN)
  expect(w.forks.length).toBe(0)
  expect(await budget($, 'autowarm')).toContain('waits while a turn runs')
  // Not armed while it runs, so the 15- and 5-minute pings come as usual.
  expect(w.toasts.length).toBe(2)
  await $.turn.complete({ turnId: 't', answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' })
  await clock.advance(30_000)
  expect(w.forks.length).toBe(1)
  expect(w.logs).toEqual([`auto keep-warm 1/6: ${AUTO_LINE}`])
  // After a compaction there is nothing to keep warm.
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
  await clock.advance(3 * HOUR)
  expect(w.forks.length).toBe(1)
})

test('auto keep-warm pauses once the session budget is spent with enforcement on', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await budget($, 'set 1000')
  await budget($, 'autowarm on')
  await fullTurn($, w) // 1000 in + 100 out: over the 1k budget
  await clock.advance(58 * MIN)
  expect(w.forks.length).toBe(0)
  expect(await budget($, 'autowarm')).toBe('Auto keep-warm: on · at 3 min left · 0 of 6 this idle stretch · paused: session budget spent')
  // With enforcement off it runs again.
  await budget($, 'off')
  await clock.advance(30_000)
  expect(w.forks.length).toBe(1)
})

test('a failed automatic fork is not retried in that window; one that re-writes the cache stops auto until the next turn', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await budget($, 'autowarm on')
  await fullTurn($, w)
  w.reply.value = { isAnswered: false, reason: 'api-error', status: 529, usage: FORK_USAGE }
  await clock.advance(HOUR)
  expect(w.forks.length).toBe(1)
  const failed = 'auto keep-warm got no reply (api-error); no retry before the cache goes cold'
  expect(w.logs).toEqual([failed])
  // After the failed try the pings come back: the 5-minute one at 2:30 left, then 1, then cold.
  expect(w.toasts[0]).toBe(failed)
  expect(w.toasts[1]).toContain('goes cold in 3 min')
  expect(w.toasts[2]).toContain('goes cold in 1 min')
  expect(w.toasts[3]).toContain('Prompt cache went cold.')
  expect(w.toasts.length).toBe(4)
  // A fork that wrote the prefix afresh: the cache is warm again, but auto stops until the next turn.
  w.reply.value = {
    isAnswered: true,
    text: 'ok',
    usage: { input_tokens: 12, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 82_000 },
  }
  await fullTurn($, w)
  await clock.advance(57 * MIN)
  expect(w.forks.length).toBe(2)
  // 12 × $4 + 2 × $20 + 82k × $8, per million ≈ $0.66
  const rewrote =
    'auto keep-warm 1/6: the fork re-wrote the cache instead of reading it (read 0 · wrote 82k · ≈ $0.66); auto keep-warm stops until the next turn.'
  expect(w.logs[1]).toBe(rewrote)
  expect(w.toasts).toContain(rewrote)
  expect(await summary($)).toContain('cache warm · 60:00 left')
  await clock.advance(2 * HOUR)
  expect(w.forks.length).toBe(2)
  expect(await budget($, 'autowarm')).toContain('stopped: the last fork re-wrote the cache')
  // The next turn clears the halt.
  w.reply.value = { isAnswered: true, text: 'ok', usage: FORK_USAGE }
  await fullTurn($, w)
  await clock.advance(57 * MIN)
  expect(w.forks.length).toBe(3)
})

test('the pane shows the auto keep-warm state on both surfaces', async ($, on) => {
  const { w, clock } = world(on)
  await start($)
  await fullTurn($, w)
  await budget($, '')
  const off = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await off.find({ type: 'Text', text: 'Auto keep-warm' })).toBeDefined()
  expect(await off.find({ type: 'Text', text: /pings on · auto keep-warm off/ })).toBeDefined()
  await off.unmount()
  await budget($, 'autowarm on')
  await clock.advance(57 * MIN)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'on · at 3 min left · 1 of 6 this idle stretch' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /pings on · auto keep-warm on/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a slow automatic fork lets no ping through, and one still running when a turn starts is not counted in the new stretch', async ($, on) => {
  let sleep: (ms: number) => Promise<void> = async () => {}
  const { w, clock } = world(on, {
    fork: (async ($: unknown, e: unknown) => {
      w.forks.push(e)
      await sleep(45_000)
      return { value: w.reply.value }
    }) as never,
  })
  sleep = ms => clock.sleep(ms)
  await start($)
  await budget($, 'autowarm on')
  await fullTurn($, w)
  // The fork starts at 57:00 and answers at 57:45: the 30-second ticks in between stay quiet.
  await clock.advance(57 * MIN)
  await clock.advance(MIN)
  expect(w.forks.length).toBe(1)
  expect(w.toasts).toEqual([])
  expect(w.logs).toEqual([`auto keep-warm 1/6: ${AUTO_LINE}`])
  // The next fork starts at 1:54:45; a turn starts while it runs.
  await clock.advance(57 * MIN)
  expect(w.forks.length).toBe(2)
  await $.turn.start({ text: 'go on', turnId: 't2' })
  await clock.advance(MIN)
  expect(w.logs[1]).toBe(`keep-warm: ${AUTO_LINE}`)
  expect(await budget($, 'autowarm')).toBe('Auto keep-warm: on · at 3 min left · 0 of 6 this idle stretch · waits while a turn runs')
})

test('/budget autowarm replies: usage, a lifetime it never fires under, and a project file that keeps it off', async ($, on) => {
  const { w } = world(on, { user: { cacheTtlMinutes: 3 } })
  await start($)
  await fullTurn($, w)
  expect(await budget($, 'autowarm maybe')).toBe('Use /budget autowarm on or /budget autowarm off.')
  expect(await budget($, 'autowarm on')).toContain(
    'Saved for every session on this machine. It never fires while autoKeepWarmMinutes (3) is not under cacheTtlMinutes (3).',
  )
  expect(await budget($, 'autowarm')).toBe('Auto keep-warm: on, but 3 min is not under the 3 min cache lifetime, so it never fires')
})

test('a project file that sets autoKeepWarm false wins over /budget autowarm on', async ($, on) => {
  world(on, { project: { autoKeepWarm: false } })
  await start($)
  expect(await budget($, 'autowarm on')).toBe('Auto keep-warm saved as on, but .claude/token-budget.json turns it off in this project.')
  expect(await budget($, 'autowarm')).toBe('Auto keep-warm: off')
})
