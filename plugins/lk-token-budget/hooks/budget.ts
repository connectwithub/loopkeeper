// Pure helpers for token-budget: parsing, config merging, counting, formatting.
// Nothing here touches the mods API, so tests can call every function directly.

import type { Action, Config, Tally } from '../types'
import { sanitizePrices } from './prices'

export const ACTIONS: readonly Action[] = ['warn', 'deny-agents', 'stop']

export const DEFAULTS: Config = {
  session: 2_000_000,
  perAgent: 400_000,
  warnAt: 0.8,
  action: 'warn',
  countCacheReads: false,
  enforce: true,
  band: true,
  cacheTtlMinutes: 60,
  cacheWarnMinutes: [15, 5, 1],
  cachePings: true,
  autoKeepWarm: false,
  autoKeepWarmMinutes: 3,
  autoKeepWarmMax: 6,
  prices: {},
}

export const HISTORY = 50
export const TOP_AGENTS = 10
export const BAR_CELLS = 8
export const MAIN = 'main'

export function emptyTally(sessionId = ''): Tally {
  return {
    sessionId,
    total: 0,
    cacheRead: 0,
    byModel: {},
    byAgent: {},
    requests: 0,
    turns: 0,
    perTurn: [],
    turnMark: 0,
    unflushed: 0,
  }
}

/** A finite, non-negative number, or 0. */
export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/**
 * Parses a token count: `500k`, `2m`, `1.5m`, `1500000`, `1,500,000`, `2M`.
 * Returns null for anything else, including negatives.
 */
export function parseTokens(text: unknown): number | null {
  if (typeof text === 'number') return Number.isFinite(text) && text >= 0 ? Math.round(text) : null
  if (typeof text !== 'string') return null
  const s = text.trim().toLowerCase().replace(/[,_\s]/g, '')
  const m = /^(\d+(?:\.\d+)?|\.\d+)([km]?)$/.exec(s)
  if (!m) return null
  const scale = m[2] === 'k' ? 1_000 : m[2] === 'm' ? 1_000_000 : 1
  const n = Math.round(Number(m[1]) * scale)
  return Number.isFinite(n) ? n : null
}

/** Parses a warn fraction in (0, 1]; also takes `80%`. */
export function parseFraction(text: unknown): number | null {
  if (typeof text !== 'string' && typeof text !== 'number') return null
  const s = String(text).trim()
  const pct = s.endsWith('%')
  const n = Number(pct ? s.slice(0, -1) : s)
  if (!Number.isFinite(n)) return null
  const f = pct ? n / 100 : n
  return f > 0 && f <= 1 ? f : null
}

/** Keeps only the well-formed fields of a partial config from the store or a file. */
export function sanitize(raw: unknown): Partial<Config> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const out: Partial<Config> = {}
  const session = parseTokens(r.session)
  if (session !== null) out.session = session
  const perAgent = parseTokens(r.perAgent)
  if (perAgent !== null) out.perAgent = perAgent
  const warnAt = parseFraction(r.warnAt)
  if (warnAt !== null) out.warnAt = warnAt
  if (typeof r.action === 'string' && (ACTIONS as readonly string[]).includes(r.action)) out.action = r.action as Action
  if (typeof r.countCacheReads === 'boolean') out.countCacheReads = r.countCacheReads
  if (typeof r.enforce === 'boolean') out.enforce = r.enforce
  if (typeof r.band === 'boolean') out.band = r.band
  const ttl = typeof r.cacheTtlMinutes === 'string' ? Number(r.cacheTtlMinutes) : r.cacheTtlMinutes
  if (typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 && ttl <= 24 * 60) out.cacheTtlMinutes = ttl
  if (Array.isArray(r.cacheWarnMinutes)) {
    const mins = r.cacheWarnMinutes.filter((m): m is number => typeof m === 'number' && Number.isFinite(m) && m > 0)
    if (mins.length === r.cacheWarnMinutes.length) out.cacheWarnMinutes = [...new Set(mins)].sort((a, b) => b - a)
  }
  if (typeof r.cachePings === 'boolean') out.cachePings = r.cachePings
  if (typeof r.autoKeepWarm === 'boolean') out.autoKeepWarm = r.autoKeepWarm
  const autoMin = typeof r.autoKeepWarmMinutes === 'string' ? Number(r.autoKeepWarmMinutes) : r.autoKeepWarmMinutes
  if (typeof autoMin === 'number' && Number.isFinite(autoMin) && autoMin >= 1 && autoMin <= 24 * 60) out.autoKeepWarmMinutes = autoMin
  const autoMax = typeof r.autoKeepWarmMax === 'string' ? Number(r.autoKeepWarmMax) : r.autoKeepWarmMax
  if (typeof autoMax === 'number' && Number.isInteger(autoMax) && autoMax >= 1 && autoMax <= 1000) out.autoKeepWarmMax = autoMax
  const prices = sanitizePrices(r.prices)
  if (prices) out.prices = prices
  return out
}

/** A project file may turn auto keep-warm off, never on or up: a cloned repo can't start spending in the background. */
function projectOnly(p: Partial<Config>): Partial<Config> {
  const out = { ...p }
  delete out.autoKeepWarmMinutes
  delete out.autoKeepWarmMax
  if (out.autoKeepWarm !== false) delete out.autoKeepWarm
  return out
}

/** defaults, then ~/.claude/token-budget.json, then saved settings, then the project file: later wins. Prices merge by family. */
export function mergeConfig(saved: unknown, project: unknown, user?: unknown): Config {
  const u = sanitize(user)
  const s = sanitize(saved)
  const p = projectOnly(sanitize(project))
  return { ...DEFAULTS, ...u, ...s, ...p, prices: { ...DEFAULTS.prices, ...u.prices, ...s.prices, ...p.prices } }
}

/** The fields of a turn.step result's usage that this mod reads. */
export type StepUsage = {
  input_tokens?: unknown
  output_tokens?: unknown
  cache_read_input_tokens?: unknown
  cache_creation_input_tokens?: unknown
  model?: unknown
}

/** Counted tokens for one request: input + output + cache writes (+ cache reads when counted). */
export function countedOf(usage: StepUsage | null | undefined, countCacheReads: boolean): number {
  if (!usage || typeof usage !== 'object') return 0
  return (
    num(usage.input_tokens) +
    num(usage.output_tokens) +
    num(usage.cache_creation_input_tokens) +
    (countCacheReads ? num(usage.cache_read_input_tokens) : 0)
  )
}

/** Adds one request's usage to the tally. Returns the same tally when usage is missing. */
export function applyStep(
  tally: Tally,
  usage: StepUsage | null | undefined,
  agentId: string | undefined,
  countCacheReads: boolean,
  fallbackModel: string,
): Tally {
  if (!usage || typeof usage !== 'object') return tally
  const counted = countedOf(usage, countCacheReads)
  const model = typeof usage.model === 'string' && usage.model ? usage.model : fallbackModel || 'unknown'
  const who = agentId || MAIN
  return {
    ...tally,
    total: tally.total + counted,
    cacheRead: tally.cacheRead + num(usage.cache_read_input_tokens),
    byModel: { ...tally.byModel, [model]: (tally.byModel[model] ?? 0) + counted },
    byAgent: { ...tally.byAgent, [who]: (tally.byAgent[who] ?? 0) + counted },
    requests: tally.requests + 1,
    unflushed: tally.unflushed + counted,
  }
}

/** Closes a main-loop turn: counts it and records what it spent. Subagent turns change nothing. */
export function applyTurnComplete(tally: Tally, agentId: string | undefined): Tally {
  if (agentId) return tally
  const spent = Math.max(0, tally.total - tally.turnMark)
  return {
    ...tally,
    turns: tally.turns + 1,
    perTurn: [...tally.perTurn, spent].slice(-HISTORY),
    turnMark: tally.total,
  }
}

export type Level = 'ok' | 'warn' | 'over'

export function levelOf(total: number, cfg: Config): Level {
  if (cfg.session <= 0) return 'ok'
  if (total >= cfg.session) return 'over'
  if (total >= cfg.warnAt * cfg.session) return 'warn'
  return 'ok'
}

/** The kit tone of a budget level: ok, warn, or danger once the budget is spent. */
export function toneOfLevel(level: Level): 'ok' | 'warn' | 'danger' {
  return level === 'over' ? 'danger' : level === 'warn' ? 'warn' : 'ok'
}

/** Short token figure: 1.2M, 0.9M, 45k, 812. */
export function fmt(n: number): string {
  const v = num(n)
  if (v >= 100_000) return (v / 1_000_000).toFixed(1) + 'M'
  if (v >= 1_000) return Math.round(v / 1_000) + 'k'
  return String(Math.round(v))
}

export function percentOf(total: number, cfg: Config): number {
  return cfg.session > 0 ? Math.round((total / cfg.session) * 100) : 0
}

export function barOf(total: number, cfg: Config, cells = BAR_CELLS): string {
  const frac = cfg.session > 0 ? Math.min(1, total / cfg.session) : 0
  const full = Math.min(cells, Math.floor(frac * cells))
  return '▰'.repeat(full) + '▱'.repeat(cells - full)
}

export function mainOf(tally: Tally): number {
  return tally.byAgent[MAIN] ?? 0
}

export function agentsOf(tally: Tally): number {
  return Math.max(0, tally.total - mainOf(tally))
}

/**
 * The band's pieces: `used` (bar, used, percent: the band's budget chip), `info` (main, agents, ctx,
 * enforcement: its quiet right side), and `head` and `rest` for the plain-text line.
 */
export function bandParts(
  tally: Tally,
  cfg: Config,
  ctx: number | null,
): { head: string; rest: string; used: string; info: string[] } {
  const used =
    cfg.session > 0
      ? `${barOf(tally.total, cfg)} ${fmt(tally.total)} / ${fmt(cfg.session)} ${percentOf(tally.total, cfg)}%`
      : `${fmt(tally.total)} (no limit)`
  const info = [`main ${fmt(mainOf(tally))}`, `agents ${fmt(agentsOf(tally))}`]
  if (typeof ctx === 'number' && Number.isFinite(ctx)) info.push(`ctx ${Math.round(ctx)}%`)
  if (!cfg.enforce) info.push('enforcement off')
  return { head: 'budget ' + used, rest: ' · ' + info.join(' · '), used, info }
}

/** The band's one line, without colors; `cache` is the cache part (cache.ts bandCache) when known. */
export function bandText(tally: Tally, cfg: Config, ctx: number | null, cache?: string): string {
  const { head, rest } = bandParts(tally, cfg, ctx)
  return head + rest + (cache ? ' · ' + cache : '')
}

export function sessionDenyText(tally: Tally, cfg: Config, action: Action): string {
  const spent = `token-budget: session budget spent (${fmt(tally.total)} of ${fmt(cfg.session)}).`
  return action === 'stop'
    ? `${spent} Stop and report to the user; they can run /budget set <n> or /budget action warn to continue.`
    : `${spent} No new subagents; finish with what you have, or the user can raise it with /budget set <n>.`
}

export function agentDenyText(used: number, cfg: Config): string {
  return `token-budget: this subagent used ${fmt(used)} tokens (limit ${fmt(cfg.perAgent)}); wrap up and return your result now.`
}

export function averagePerTurn(tally: Tally): number | null {
  if (tally.perTurn.length === 0) return null
  return tally.perTurn.reduce((a, b) => a + b, 0) / tally.perTurn.length
}

export function turnsLeft(tally: Tally, cfg: Config): number | null {
  const avg = averagePerTurn(tally)
  if (avg === null || avg <= 0 || cfg.session <= 0) return null
  return Math.max(0, Math.floor((cfg.session - tally.total) / avg))
}

export function topAgents(tally: Tally, n = TOP_AGENTS): Array<[string, number]> {
  return Object.entries(tally.byAgent)
    .filter(([id]) => id !== MAIN)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
}

export function modelsOf(tally: Tally): Array<[string, number]> {
  return Object.entries(tally.byModel).sort((a, b) => b[1] - a[1])
}

/** The plain-text summary /budget text prints. */
export function summaryText(tally: Tally, cfg: Config, ctx: number | null, lifetime: number, cache?: string): string {
  const lines: string[] = []
  lines.push(bandText(tally, cfg, ctx, cache))
  const remaining = cfg.session > 0 ? fmt(Math.max(0, cfg.session - tally.total)) : 'no limit'
  lines.push(
    `Budget ${cfg.session > 0 ? fmt(cfg.session) : 'none'} · action ${cfg.action} · warn at ${Math.round(cfg.warnAt * 100)}% · per agent ${cfg.perAgent > 0 ? fmt(cfg.perAgent) : 'off'} · enforcement ${cfg.enforce ? 'on' : 'off'}`,
  )
  lines.push(
    `Used ${fmt(tally.total)} · remaining ${remaining} · ${tally.requests} requests · ${tally.turns} turns · cache reads ${fmt(tally.cacheRead)} (${cfg.countCacheReads ? 'counted' : 'not counted'})`,
  )
  const models = modelsOf(tally)
  if (models.length) lines.push('By model: ' + models.map(([m, t]) => `${m} ${fmt(t)}`).join(', '))
  const agents = topAgents(tally)
  if (agents.length) lines.push('Top agents: ' + agents.map(([a, t]) => `${a} ${fmt(t)}`).join(', '))
  const avg = averagePerTurn(tally)
  const left = turnsLeft(tally, cfg)
  if (avg !== null) lines.push(`Average ${fmt(avg)} per turn${left !== null ? ` · about ${left} turns left` : ''}`)
  lines.push(`Lifetime in this project: ${fmt(lifetime)}`)
  return lines.join('\n')
}

export const HELP =
  'Usage: /budget [set <n> | agent <n> | action warn|deny-agents|stop | warn <0-1> | reset | on | off | band on|off | keepwarm | autowarm on|off | pings on|off | text]. ' +
  'Numbers take 500k, 2m, 1.5m or 1500000.'
