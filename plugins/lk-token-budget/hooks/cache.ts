// Pure helpers for the prompt-cache timer: time left, cold, which ping is due, and the
// band, toast and log texts. Nothing here touches the mods API.
//
// The cache lifetime is an assumption (cacheTtlMinutes, 60 by default): Claude Code doesn't
// report when the API drops the main session's cache entry. Cold is decided from the mod's own
// clock: now − lastRequestAt ≥ TTL, unless a compaction came since (then the next request starts
// a new cache anyway and there is nothing to re-warm).
//
// Auto keep-warm (off by default) is decided here too: autoArmed says it can act in this warm
// window, autoWarmDue says the timer should send it now.

import type { CacheState, Config } from '../types'
import { coldWriteUsd, requestUsd } from './prices'
import type { UsageLike } from './prices'

export type { CacheState }

export type CacheTone = 'ok' | 'warn' | 'danger' | 'muted'

/** Below this much time left the cache chip turns to the warn tone. */
export const WARN_MS = 5 * 60_000

/** The cache settings and prices bandCache and coldUsd read. */
export type CacheConfig = Pick<Config, 'cacheTtlMinutes' | 'prices'>

/** The auto keep-warm settings autoArmed, autoWarmDue and autoWarmStatus read. */
export type AutoConfig = Pick<Config, 'autoKeepWarm' | 'autoKeepWarmMinutes' | 'autoKeepWarmMax'>

export function emptyCache(): CacheState {
  return {
    lastRequestAt: 0,
    model: null,
    contextTokens: 0,
    compacted: false,
    lastPing: null,
    cold: false,
    autoWarms: 0,
    autoTriedAt: 0,
    autoHalted: false,
    turnRunning: false,
  }
}

/** A finite, non-negative count, or 0 (state saved before a field existed reads as 0). */
function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

export function ttlOf(cfg: Pick<Config, 'cacheTtlMinutes'>): number {
  const m = cfg.cacheTtlMinutes
  return (typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : 60) * 60_000
}

/** A request answered now: a new warm window, with no ping fired in it yet. */
export function afterRequest(state: CacheState, now: number, model?: string | null): CacheState {
  return {
    ...state,
    lastRequestAt: now,
    model: model || state.model,
    compacted: false,
    lastPing: null,
    cold: false,
  }
}

/**
 * A keep-warm answered now: a new warm window, like a request. An automatic one counts toward the
 * cap; one that re-wrote the cache instead of reading it halts auto keep-warm until the next turn.
 */
export function afterKeepWarm(state: CacheState, now: number, auto: boolean, rewrote = false): CacheState {
  return {
    ...afterRequest(state, now, state.model),
    autoWarms: count(state.autoWarms) + (auto ? 1 : 0),
    autoHalted: state.autoHalted === true || (auto && rewrote),
  }
}

/** The fork wrote more to the cache than it read from it: the prefix was billed afresh, not refreshed. */
export function rewroteCache(usage: UsageLike | null | undefined): boolean {
  if (!usage || typeof usage !== 'object') return false
  return count(usage.cache_creation_input_tokens) > count(usage.cache_read_input_tokens)
}

/** Milliseconds until the cache goes cold, 0 once it has; null before the first request. */
export function timeLeftMs(state: CacheState, now: number, ttlMs: number): number | null {
  if (!(state.lastRequestAt > 0)) return null
  return Math.max(0, state.lastRequestAt + ttlMs - now)
}

/** Cold by the mod's own clock: a request was made, no compaction since, and the TTL has passed. */
export function isCold(state: CacheState, now: number, ttlMs: number): boolean {
  return state.lastRequestAt > 0 && !state.compacted && now - state.lastRequestAt >= ttlMs
}

/**
 * The warn threshold (minutes) to ping for now, or null. The due threshold is the smallest one
 * the time left has reached; it fires when no threshold at or below it fired in this warm window,
 * so each fires once, and a late tick fires only the most urgent one. A new request clears lastPing.
 */
export function duePing(state: CacheState, now: number, ttlMs: number, thresholdsMin: number[]): number | null {
  if (state.compacted || isCold(state, now, ttlMs)) return null
  const left = timeLeftMs(state, now, ttlMs)
  if (left === null) return null
  const reached = (Array.isArray(thresholdsMin) ? thresholdsMin : [])
    .filter(t => typeof t === 'number' && Number.isFinite(t) && t > 0 && t * 60_000 < ttlMs && left <= t * 60_000)
    .sort((a, b) => a - b)
  const due = reached[0]
  if (due === undefined) return null
  if (state.lastPing !== null && due >= state.lastPing) return null
  return due
}

/**
 * Auto keep-warm can act in this warm window: on, firing under the TTL, a request seen and no
 * compaction since, no turn running, not halted, under the cap, and not tried in this window yet.
 * While it is armed the timer skips the pings, because it will refresh the cache itself.
 */
export function autoArmed(state: CacheState, ttlMs: number, cfg: AutoConfig): boolean {
  if (!cfg.autoKeepWarm || state.turnRunning === true || state.autoHalted === true) return false
  if (!(state.lastRequestAt > 0) || state.compacted) return false
  if (!(cfg.autoKeepWarmMinutes * 60_000 < ttlMs)) return false
  if (count(state.autoWarms) >= cfg.autoKeepWarmMax) return false
  return state.autoTriedAt !== state.lastRequestAt
}

/** The timer should send the automatic keep-warm now: armed, still warm, and autoKeepWarmMinutes or less left. */
export function autoWarmDue(state: CacheState, now: number, ttlMs: number, cfg: AutoConfig): boolean {
  if (!autoArmed(state, ttlMs, cfg) || isCold(state, now, ttlMs)) return false
  const left = timeLeftMs(state, now, ttlMs)
  return left !== null && left <= cfg.autoKeepWarmMinutes * 60_000
}

/** One line on the auto keep-warm for the pane, /budget autowarm and /budget text. */
export function autoWarmStatus(state: CacheState, ttlMs: number, cfg: AutoConfig, overBudget = false): string {
  if (!cfg.autoKeepWarm) return 'off'
  const min = cfg.autoKeepWarmMinutes
  if (!(min * 60_000 < ttlMs)) return `on, but ${min} min is not under the ${ttlMs / 60_000} min cache lifetime, so it never fires`
  const n = Math.min(count(state.autoWarms), cfg.autoKeepWarmMax)
  const parts = [`on · at ${min} min left · ${n} of ${cfg.autoKeepWarmMax} this idle stretch`]
  if (overBudget) parts.push('paused: session budget spent')
  else if (state.autoHalted === true) parts.push('stopped: the last fork re-wrote the cache')
  else if (n >= cfg.autoKeepWarmMax) parts.push('cap reached until the next turn')
  else if (state.turnRunning === true) parts.push('waits while a turn runs')
  return parts.join(' · ')
}

/** About what one keep-warm costs: the context at the cache-read price; null without a price or a context size. */
export function refreshUsd(state: CacheState, cfg: Pick<Config, 'prices'>): number | null {
  if (!state.model || !(state.contextTokens > 0)) return null
  return requestUsd({ cache_read_input_tokens: state.contextTokens }, state.model, cfg.prices)
}

/** What a cold resend of the context costs, or null when the model or the context size is unknown. */
export function coldUsd(state: CacheState, cfg: Pick<Config, 'prices'>): number | null {
  if (!state.model || !(state.contextTokens > 0)) return null
  return coldWriteUsd(state.contextTokens, state.model, cfg.prices)
}

/** '$1.23', '<$0.01', '$124'. */
export function usdText(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00'
  if (usd < 0.005) return '<$0.01'
  if (usd >= 100) return '$' + String(Math.round(usd))
  return '$' + usd.toFixed(2)
}

/** '54:12', '60:00', '0:05': minutes keep counting past 59. */
export function mmss(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const s = total % 60
  return `${Math.floor(total / 60)}:${s < 10 ? '0' + s : s}`
}

/** '240k', '1.2M', '950'. */
export function tokensText(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return (Math.round(n / 100_000) / 10).toString() + 'M'
  if (n >= 1_000) return String(Math.round(n / 1_000)) + 'k'
  return String(Math.round(n))
}

/** The band's cache part and its tone. */
export function bandCache(state: CacheState, now: number, cfg: CacheConfig): { text: string; tone: CacheTone } {
  const ttl = ttlOf(cfg)
  if (!(state.lastRequestAt > 0)) return { text: 'cache · no request yet', tone: 'muted' }
  if (state.compacted) return { text: 'cache · compacted, next request starts fresh', tone: 'muted' }
  const usd = coldUsd(state, cfg)
  if (isCold(state, now, ttl)) {
    return { text: usd === null ? 'cache cold' : `cache cold · resend ≈ ${usdText(usd)}`, tone: 'danger' }
  }
  const left = timeLeftMs(state, now, ttl) ?? 0
  const cost = usd === null ? '' : ` · cold resend ≈ ${usdText(usd)}`
  return { text: `cache warm · ${mmss(left)} left${cost}`, tone: left < WARN_MS ? 'warn' : 'ok' }
}

/**
 * The band's cache chip and the note for its quiet right side: `● cache warm 54:12 left` (ok, warn
 * in the last five minutes) with `cold resend ≈ $1.92`, `● cache cold` (danger) with `resend ≈ $1.92`,
 * or a muted chip before the first request and after a compaction. `note` is '' when there is none.
 */
export function bandChip(state: CacheState, now: number, cfg: CacheConfig): { chip: string; tone: CacheTone; note: string } {
  const ttl = ttlOf(cfg)
  if (!(state.lastRequestAt > 0)) return { chip: 'cache: no request yet', tone: 'muted', note: '' }
  if (state.compacted) return { chip: 'cache compacted', tone: 'muted', note: 'next request starts fresh' }
  const usd = coldUsd(state, cfg)
  if (isCold(state, now, ttl)) return { chip: 'cache cold', tone: 'danger', note: usd === null ? '' : `resend ≈ ${usdText(usd)}` }
  const left = timeLeftMs(state, now, ttl) ?? 0
  return {
    chip: `cache warm ${mmss(left)} left`,
    tone: left < WARN_MS ? 'warn' : 'ok',
    note: usd === null ? '' : `cold resend ≈ ${usdText(usd)}`,
  }
}

/** The pane tile's short cache state. */
export function cacheTile(state: CacheState, now: number, cfg: CacheConfig): { value: string; tone: CacheTone } {
  const ttl = ttlOf(cfg)
  if (!(state.lastRequestAt > 0)) return { value: 'no request yet', tone: 'muted' }
  if (state.compacted) return { value: 'compacted', tone: 'muted' }
  if (isCold(state, now, ttl)) return { value: 'cold', tone: 'danger' }
  const left = timeLeftMs(state, now, ttl) ?? 0
  return { value: `warm ${mmss(left)}`, tone: left < WARN_MS ? 'warn' : 'ok' }
}

function rateText(state: CacheState, usd: number | null): string {
  if (usd === null || !(state.contextTokens > 0)) return ''
  const perM = Math.round(((usd * 1e6) / state.contextTokens) * 100) / 100
  return ` (${tokensText(state.contextTokens)} tokens at $${perM}/MTok)`
}

/** The toast at a warn threshold; with ttlMs, a late tick says the real minutes left. */
export function pingText(state: CacheState, now: number, thresholdMin: number, usd: number | null, ttlMs?: number): string {
  let min = thresholdMin
  const left = typeof ttlMs === 'number' ? timeLeftMs(state, now, ttlMs) : null
  if (left !== null && left > 0) min = Math.min(thresholdMin, Math.ceil(left / 60_000))
  const cost = usd === null ? '' : `; a resend after that costs ≈ ${usdText(usd)}${rateText(state, usd)}`
  return `Prompt cache goes cold in ${min} min${cost}. Keep warm: /budget keepwarm, or w on the band.`
}

/** The toast once the timer sees the cache go cold. */
export function coldText(state: CacheState, usd: number | null): string {
  const cost = usd === null ? '' : ` The next send re-writes the context, ≈ ${usdText(usd)}${rateText(state, usd)}.`
  return `Prompt cache went cold.${cost}`
}

/** The log line and toast when a prompt is sent while the cache is cold. */
export function coldSendText(state: CacheState, usd: number | null): string {
  const what = state.contextTokens > 0 ? `${tokensText(state.contextTokens)} tokens of context` : 'the context'
  const cost = usd === null ? '' : ` at the cache-write price, ≈ ${usdText(usd)}`
  return `Cache cold: this prompt re-writes ${what}${cost}.`
}

/**
 * The dim log line after a keep-warm answered, with what it read, wrote and cost. `state` is the
 * state after afterKeepWarm, so an automatic one's count already includes it.
 */
export function keepWarmText(
  state: CacheState,
  cfg: Pick<Config, 'cacheTtlMinutes' | 'prices' | 'autoKeepWarmMax'>,
  usage: UsageLike,
  auto: boolean,
  rewrote = false,
): string {
  const usd = requestUsd(usage, state.model, cfg.prices)
  const figures =
    `read ${tokensText(count(usage.cache_read_input_tokens))} · wrote ${tokensText(count(usage.cache_creation_input_tokens))}` +
    (usd === null ? '' : ` · ≈ ${usdText(usd)}`)
  if (!auto) return `keep-warm: cache refreshed for ${cfg.cacheTtlMinutes} min · ${figures}`
  const n = count(state.autoWarms)
  const head = `auto keep-warm ${n}/${cfg.autoKeepWarmMax}`
  if (rewrote) return `${head}: the fork re-wrote the cache instead of reading it (${figures}); auto keep-warm stops until the next turn.`
  const last = n >= cfg.autoKeepWarmMax ? ' · cap reached, no more until the next turn' : ''
  return `${head}: cache refreshed for ${cfg.cacheTtlMinutes} min · ${figures}${last}`
}
