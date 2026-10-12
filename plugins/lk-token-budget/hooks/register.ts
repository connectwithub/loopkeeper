// token-budget: enforce a token budget for the session and for each subagent.
//
// turn.step       counts every request's usage (main loop and subagents) into $.state
// turn.start      marks a main-loop turn running and starts a new idle stretch (auto keep-warm)
// turn.complete   closes a main-loop turn (history for the projection), flushes the
//                 per-project lifetime total, reads context fill, nags in "warn" mode
// agent.spawn     refuses new subagents once the budget is spent ("deny-agents")
// tool.call       refuses tool calls once the budget is spent ("stop"), and a
//                 subagent's calls once it passes the per-agent limit
// command.run     /budget and its subcommands
// ui.render       the one-line band above the prompt and the /budget pane
//
// The prompt cache (cache.ts): turn.step of the main loop stamps the last request, a
// 30-second $.clock.every timer started from session.start (and again on /clear, /resume,
// /branch) pings before the assumed TTL ends and once when it has, prompt.submit notes a cold
// send with its cost, and Keep warm (band button, pane button, /budget keepwarm) sends one
// tiny $.model.fork. With /budget autowarm on (off by default) the timer also sends that fork on
// its own when autoKeepWarmMinutes are left, at most autoKeepWarmMax times per idle stretch
// (turn.start to turn.start), one try per warm window, and never while a turn runs, after a
// compaction, once cold, after a fork that re-wrote the cache, or once the budget is spent.
//
// Usage is counted from turn.step only; turn.complete's e.usage repeats the same
// responses, so adding it would double count.
//
// Helpers that take $ are top-level functions so static analysis can read them.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement } from 'claude-code'

import type { CacheState, Config, Tally } from '../types'
import {
  DEFAULTS,
  HELP,
  MAIN,
  ACTIONS,
  agentDenyText,
  applyStep,
  applyTurnComplete,
  averagePerTurn,
  bandParts,
  barOf,
  emptyTally,
  fmt,
  levelOf,
  mergeConfig,
  modelsOf,
  num,
  parseFraction,
  parseTokens,
  percentOf,
  sanitize,
  sessionDenyText,
  summaryText,
  topAgents,
  toneOfLevel,
  turnsLeft,
} from './budget'
import {
  afterKeepWarm,
  afterRequest,
  autoArmed,
  autoWarmDue,
  autoWarmStatus,
  bandCache,
  bandChip,
  cacheTile,
  coldSendText,
  coldText,
  coldUsd,
  duePing,
  emptyCache,
  isCold,
  keepWarmText,
  pingText,
  refreshUsd,
  rewroteCache,
  timeLeftMs,
  tokensText,
  ttlOf,
  usdText,
} from './cache'
import { TONES, makeKit } from './kit'
import type { Elements, Kit, Tone } from './kit'

const PANE = 'token-budget'
const TOOL_PREFIX = 'mcp__lk-token-budget__'
const SETTINGS_KEY = 'settings'
const PROJECT_FILE = '.claude/token-budget.json'
/** The quiet theme color (the kit's): secondary text in the pane. */
const QUIET = 'inactive'
const TICK_MS = 30_000
const KEEP_WARM_PROMPT = 'Reply with the single word ok.'

const tallyAtom = atom({ plugin: 'lk-token-budget', key: 'tally' } as const, emptyTally())
const configAtom = atom({ plugin: 'lk-token-budget', key: 'config' } as const, DEFAULTS)
const warnedAtom = atom({ plugin: 'lk-token-budget', key: 'warned' } as const, false)
const lifetimeAtom = atom({ plugin: 'lk-token-budget', key: 'lifetime' } as const, 0)
const ctxAtom = atom({ plugin: 'lk-token-budget', key: 'ctx' } as const, null as number | null)
const cwdAtom = atom({ plugin: 'lk-token-budget', key: 'cwd' } as const, '')
const cacheAtom = atom({ plugin: 'lk-token-budget', key: 'cache' } as const, emptyCache())

type Api = EngineInterface

// The cache timer. Timers stop when the module reloads, so this is module state on purpose:
// session.start (and classic.SessionStart) start a fresh one and cancel any older one.
let cacheTimer: { cancel(): void } | null = null
// The band's cache text at the last tick, so the timer redraws only when it changes.
let lastBand = ''
// A keep-warm fork in flight: a second press waits for it instead of sending another.
let warming = false
// Bumped at each turn.start, so an automatic fork still in flight when a turn starts isn't
// counted (or halted) in the new idle stretch.
let stretch = 0

function lifetimeKey(cwd: string): string {
  return 'lifetime:' + (cwd || '(unknown)')
}

function projectPath(cwd: string): string {
  return cwd ? cwd.replace(/\/+$/, '') + '/' + PROJECT_FILE : PROJECT_FILE
}

/** Reads <cwd>/.claude/token-budget.json, or null when it is missing or not JSON. */
async function readProject($: Api, cwd: string): Promise<unknown> {
  try {
    const path = projectPath(cwd)
    if (!(await $.fs.exists(path))) return null
    return JSON.parse(String(await $.fs.read(path)))
  } catch {
    return null
  }
}

/** Reads ~/.claude/token-budget.json (cache settings and prices for every project), or null. */
async function readUser($: Api): Promise<unknown> {
  try {
    const home = String((await $.env.get('HOME')) ?? '').replace(/\/+$/, '')
    if (!home) return null
    const path = home + '/' + PROJECT_FILE
    if (!(await $.fs.exists(path))) return null
    return JSON.parse(String(await $.fs.read(path)))
  } catch {
    return null
  }
}

/** Merges defaults, the user file, saved settings and the project file into $.state. */
async function loadConfig($: Api): Promise<Config> {
  let saved: unknown = null
  try {
    saved = await $.store.get(SETTINGS_KEY)
  } catch {
    saved = null
  }
  const cwd = await read($, cwdAtom)
  const cfg = mergeConfig(saved, await readProject($, cwd), await readUser($))
  await update($, configAtom, () => cfg)
  // A raised budget re-arms the one-time warning.
  const tally = await read($, tallyAtom)
  if (levelOf(tally.total, cfg) === 'ok') await update($, warnedAtom, () => false)
  return cfg
}

/** Saves a settings change in $.store, then reloads the merged config. */
async function saveSetting($: Api, patch: Partial<Config>): Promise<Config> {
  let saved: unknown = null
  try {
    saved = await $.store.get(SETTINGS_KEY)
  } catch {
    saved = null
  }
  await $.store.set(SETTINGS_KEY, { ...sanitize(saved), ...patch })
  return loadConfig($)
}

async function loadLifetime($: Api): Promise<void> {
  try {
    const cwd = await read($, cwdAtom)
    const stored = num(await $.store.get(lifetimeKey(cwd)))
    await update($, lifetimeAtom, () => stored)
  } catch {
    // Display only: keep what the band had.
  }
}

/** Adds counted tokens not yet saved to the per-project lifetime total in $.store. */
async function flushLifetime($: Api): Promise<void> {
  try {
    const tally = await read($, tallyAtom)
    const amount = tally.unflushed
    if (amount <= 0) return
    const key = lifetimeKey(await read($, cwdAtom))
    // Read again right before the write: other sessions in this project add to it too.
    const next = num(await $.store.get(key)) + amount
    await $.store.set(key, next)
    await update($, lifetimeAtom, () => next)
    await update($, tallyAtom, (t: Tally) => ({ ...t, unflushed: Math.max(0, t.unflushed - amount) }))
  } catch {
    // Try again at the next turn.
  }
}

async function resetTally($: Api): Promise<void> {
  await flushLifetime($)
  await update($, tallyAtom, (t: Tally) => emptyTally(t.sessionId))
  await update($, warnedAtom, () => false)
}

/** Reads context fill for the band; leaves the last reading when usage() has none. */
async function readContext($: Api): Promise<void> {
  try {
    const u = await $.session.usage()
    const c = u && u.context
    if (!c) return
    const pct =
      typeof c.percent === 'number'
        ? c.percent
        : typeof c.tokens === 'number' && c.window > 0
          ? (c.tokens / c.window) * 100
          : null
    if (pct !== null && Number.isFinite(pct)) await update($, ctxAtom, () => Math.round(pct))
    const tokens = c.tokens
    if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) {
      await update($, cacheAtom, (s: CacheState) => ({ ...s, contextTokens: tokens }))
    }
  } catch {
    // No reading: the band omits ctx.
  }
}

/** Counts one request, then shows the one-time warning when the tally crosses warnAt. */
async function recordStep($: Api, usage: unknown, agentId: string | undefined, model: string): Promise<void> {
  const cfg = await read($, configAtom)
  const before = await read($, tallyAtom)
  const after = applyStep(before, usage as never, agentId, cfg.countCacheReads, model)
  if (after === before) return
  await update($, tallyAtom, () => after)
  const level = levelOf(after.total, cfg)
  if (level !== 'ok' && !(await read($, warnedAtom))) {
    await update($, warnedAtom, () => true)
    $.ui.toast(
      level === 'over'
        ? `Session budget spent: ${fmt(after.total)} of ${fmt(cfg.session)}.`
        : `${percentOf(after.total, cfg)}% of the session budget used (${fmt(after.total)} of ${fmt(cfg.session)}).`,
    )
  }
}

/** $.clock.now(), or the wall clock when no clock answers. */
async function nowOf($: Api): Promise<number> {
  try {
    const t = await $.clock.now()
    return typeof t === 'number' && Number.isFinite(t) ? t : Date.now()
  } catch {
    return Date.now()
  }
}

/** Shows a toast, never throwing. */
function toast($: Api, text: string): void {
  try {
    const r: unknown = $.ui.toast(text)
    if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(undefined, () => {})
  } catch {
    // nothing to show it with
  }
}

/** Logs a dim transcript line Claude doesn't read, never throwing. */
function note($: Api, text: string): void {
  try {
    const r: unknown = $.ui.log(text)
    if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(undefined, () => {})
  } catch {
    // nothing to log with
  }
}

function redraw($: Api): void {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // the next event redraws
  }
}

/** A main-loop request was answered: a new warm window; its usage approximates the context until turn.complete reads it. */
async function markRequest($: Api, usage: Record<string, unknown>, model: string): Promise<void> {
  const now = await nowOf($)
  const ctx = num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.output_tokens)
  await update($, cacheAtom, (s: CacheState) => ({
    ...afterRequest(s, now, model || null),
    contextTokens: ctx > 0 ? ctx : s.contextTokens,
  }))
}

/** Enforcement is on and the session budget is spent: auto keep-warm pauses. */
async function budgetSpent($: Api, cfg: Config): Promise<boolean> {
  if (!cfg.autoKeepWarm || !cfg.enforce) return false
  return levelOf((await read($, tallyAtom)).total, cfg) === 'over'
}

/** The auto keep-warm line for the pane, /budget autowarm and /budget text. */
async function autoStatus($: Api): Promise<string> {
  const cfg = await read($, configAtom)
  return autoWarmStatus(await read($, cacheAtom), ttlOf(cfg), cfg, await budgetSpent($, cfg))
}

/**
 * One timer tick: the automatic keep-warm when it is due, else a ping at a threshold (skipped
 * while auto keep-warm is armed), one toast when the cache turns cold, a redraw when the band's
 * text changed.
 */
async function cacheTick($: Api): Promise<void> {
  const cfg = await read($, configAtom)
  const now = await nowOf($)
  const ttl = ttlOf(cfg)
  const auto = (await budgetSpent($, cfg)) ? { ...cfg, autoKeepWarm: false } : cfg
  let s = await read($, cacheAtom)
  if (isCold(s, now, ttl)) {
    if (!s.cold) {
      s = { ...s, cold: true }
      await update($, cacheAtom, (c: CacheState) => ({ ...c, cold: true }))
      if (cfg.cachePings) toast($, coldText(s, coldUsd(s, cfg)))
    }
  } else if (!warming && autoWarmDue(s, now, ttl, auto)) {
    // Stamp the window first: a fork that fails is not tried again before the cache goes cold.
    const tried = s.lastRequestAt
    await update($, cacheAtom, (c: CacheState) => ({ ...c, autoTriedAt: tried }))
    await keepWarm($, true)
    s = await read($, cacheAtom)
  } else if (cfg.cachePings && !warming && !autoArmed(s, ttl, auto)) {
    const due = duePing(s, now, ttl, cfg.cacheWarnMinutes)
    if (due !== null) {
      s = { ...s, lastPing: due }
      await update($, cacheAtom, (c: CacheState) => ({ ...c, lastPing: due }))
      toast($, pingText(s, now, due, coldUsd(s, cfg), ttl))
    }
  }
  // The pane draws the same countdown, so redraw whether or not the band is shown.
  const text = bandCache(s, now, cfg).text
  if (text !== lastBand) {
    lastBand = text
    redraw($)
  }
}

/** (Re)starts the 30-second cache timer, cancelling an older one. */
function startCacheTimer($: Api): void {
  try {
    cacheTimer?.cancel()
  } catch {
    // an old timer from before a reload is already gone
  }
  cacheTimer = null
  try {
    cacheTimer = $.clock.every(TICK_MS, () => {
      void cacheTick($).catch(() => {})
    })
  } catch {
    cacheTimer = null
  }
}

/**
 * Seeds the cache state of a resumed or forked session from the SessionStart payload. The fields
 * are in the generated types but not the docs, so each is read defensively; when none is there
 * the state stays unknown until the first request.
 */
async function seedFromResume($: Api, e: Record<string, unknown>): Promise<void> {
  if (e.source !== 'resume' && e.source !== 'fork') return
  const cfg = await read($, configAtom)
  const now = await nowOf($)
  const ttl = ttlOf(cfg)
  const secs = e.seconds_since_last_response
  const expired = e.prompt_cache_likely_expired
  let at = 0
  if (typeof secs === 'number' && Number.isFinite(secs) && secs >= 0) at = now - secs * 1000
  // The engine knows its own TTL: when it says expired, trust it over our assumption.
  if (expired === true) at = at > 0 ? Math.min(at, now - ttl) : now - ttl
  if (!(at > 0)) return
  const tokens = e.context_tokens
  const model = e.model
  await update($, cacheAtom, (s: CacheState) => ({
    ...s,
    lastRequestAt: at,
    model: typeof model === 'string' && model ? model : s.model,
    contextTokens: typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0 ? tokens : s.contextTokens,
    compacted: false,
    lastPing: null,
    cold: false,
  }))
}

/** One fork of the conversation. `$.model.fork` takes only `prompt`; the short prompt keeps the reply tiny. */
async function forkOnce($: Api): Promise<unknown> {
  return await $.model.fork({ prompt: KEEP_WARM_PROMPT })
}

/** A keep-warm that got no reply: a toast, and a log line too for the automatic one. The timer is left alone. */
function keepWarmFailed($: Api, auto: boolean, what: string): string {
  const msg = auto ? `auto keep-warm ${what}; no retry before the cache goes cold` : 'keep-warm ' + what
  toast($, msg)
  if (auto) note($, msg)
  return msg
}

/**
 * Sends one tiny fork of the conversation to refresh the cache: on a press, on /budget keepwarm,
 * or (auto) from the timer once /budget autowarm is on. Logs a dim line with its cost.
 */
async function keepWarm($: Api, auto = false): Promise<string> {
  if (warming) return 'Keep-warm already running.'
  warming = true
  const startedIn = stretch
  try {
    let reply: unknown
    try {
      reply = await forkOnce($)
    } catch (err) {
      return keepWarmFailed($, auto, 'failed: ' + (err instanceof Error ? err.message : String(err)))
    }
    const r = reply as { isAnswered?: unknown; reason?: unknown; usage?: Record<string, unknown> } | null
    if (!r || r.isAnswered !== true) {
      const why = r && typeof r.reason === 'string' && r.reason ? ` (${r.reason})` : ''
      return keepWarmFailed($, auto, 'got no reply' + why)
    }
    const now = await nowOf($)
    const u = r.usage && typeof r.usage === 'object' ? r.usage : {}
    // A fork that wrote more than it read paid for the prefix afresh: the cache had lapsed early
    // or the model changed. The cache is warm again either way, but auto keep-warm stops.
    const rewrote = auto && rewroteCache(u)
    // A turn started while it ran: it belongs to the stretch that ended, so it doesn't count in the new one.
    const counts = auto && startedIn === stretch
    await update($, cacheAtom, (s: CacheState) => afterKeepWarm(s, now, counts, counts && rewrote))
    const s = await read($, cacheAtom)
    const cfg = await read($, configAtom)
    const msg = keepWarmText(s, cfg, u, counts, counts && rewrote)
    note($, msg)
    if (rewrote) toast($, msg)
    lastBand = ''
    redraw($)
    return msg
  } finally {
    warming = false
  }
}

/** The band's or summary's cache text right now. */
async function cacheText($: Api): Promise<{ text: string; tone: Tone }> {
  const cfg = await read($, configAtom)
  const s = await read($, cacheAtom)
  return bandCache(s, await nowOf($), cfg)
}

async function onSessionStart($: Api, cwd: string): Promise<void> {
  if (cwd) await update($, cwdAtom, () => cwd)
  let id = ''
  try {
    id = String((await $.session.id()) ?? '')
  } catch {
    id = ''
  }
  const tally = await read($, tallyAtom)
  // session.start also fires after a hot reload; $.state survived it, so keep the counts.
  if (!id || tally.sessionId !== id) {
    await flushLifetime($)
    await update($, tallyAtom, () => emptyTally(id))
    await update($, warnedAtom, () => false)
    await update($, ctxAtom, () => null)
  }
  await loadConfig($)
  await loadLifetime($)
}

/** /budget and its subcommands. */
async function runCommand($: Api, args: string): Promise<{ text?: string }> {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const sub = (words[0] ?? '').toLowerCase()
  const arg = words.slice(1).join(' ')
  if (sub === '') {
    await $.ui.open({ id: PANE, title: 'Token budget', focus: true, closeOnEscape: true })
    return {}
  }
  if (sub === 'text') {
    return {
      text: summaryText(
        await read($, tallyAtom),
        await read($, configAtom),
        await read($, ctxAtom),
        await read($, lifetimeAtom),
        (await cacheText($)).text,
      ) + `\nAuto keep-warm: ${await autoStatus($)}`,
    }
  }
  if (sub === 'keepwarm') {
    return { text: await keepWarm($) }
  }
  if (sub === 'autowarm') {
    const v = arg.toLowerCase()
    if (v === '') return { text: `Auto keep-warm: ${await autoStatus($)}` }
    if (v !== 'on' && v !== 'off') return { text: 'Use /budget autowarm on or /budget autowarm off.' }
    const cfg = await saveSetting($, { autoKeepWarm: v === 'on' })
    if (v === 'off') return { text: 'Auto keep-warm off: the cache is refreshed only when you press Keep warm or run /budget keepwarm.' }
    if (!cfg.autoKeepWarm) return { text: `Auto keep-warm saved as on, but ${PROJECT_FILE} turns it off in this project.` }
    const s = await read($, cacheAtom)
    const usd = refreshUsd(s, cfg)
    const each = usd === null ? '' : `, each ≈ ${usdText(usd)} at the current context (${tokensText(s.contextTokens)} tokens)`
    const never =
      cfg.autoKeepWarmMinutes < cfg.cacheTtlMinutes
        ? ''
        : ` It never fires while autoKeepWarmMinutes (${cfg.autoKeepWarmMinutes}) is not under cacheTtlMinutes (${cfg.cacheTtlMinutes}).`
    return {
      text:
        `Auto keep-warm on: one tiny request when ${cfg.autoKeepWarmMinutes} min are left, at most ${cfg.autoKeepWarmMax} per idle stretch${each}. ` +
        `Saved for every session on this machine.${never}`,
    }
  }
  if (sub === 'pings') {
    const v = arg.toLowerCase()
    if (v !== 'on' && v !== 'off') return { text: 'Use /budget pings on or /budget pings off.' }
    const cfg = await saveSetting($, { cachePings: v === 'on' })
    return { text: cfg.cachePings ? 'Cache pings on.' : 'Cache pings off: the band still shows the cache.' }
  }
  if (sub === 'set' || sub === 'agent') {
    const n = parseTokens(arg)
    if (n === null) return { text: `Not a token count: "${arg}". Try 500k, 2m, 1.5m or 1500000.` }
    const cfg = await saveSetting($, sub === 'set' ? { session: n } : { perAgent: n })
    const got = sub === 'set' ? cfg.session : cfg.perAgent
    const label = sub === 'set' ? 'Session budget' : 'Per-agent budget'
    const shown = got > 0 ? fmt(got) : 'off'
    return { text: got === n ? `${label} set to ${shown}.` : `${label} saved as ${fmt(n)}, but ${PROJECT_FILE} overrides it: ${shown}.` }
  }
  if (sub === 'action') {
    const a = arg.toLowerCase()
    if (!(ACTIONS as readonly string[]).includes(a)) return { text: 'Action must be warn, deny-agents or stop.' }
    const cfg = await saveSetting($, { action: a as Config['action'] })
    return { text: cfg.action === a ? `Action set to ${a}.` : `Action saved as ${a}, but ${PROJECT_FILE} overrides it: ${cfg.action}.` }
  }
  if (sub === 'warn') {
    const f = parseFraction(arg)
    if (f === null) return { text: 'Warn level must be a fraction between 0 and 1, such as 0.8.' }
    const cfg = await saveSetting($, { warnAt: f })
    return { text: `Warning at ${Math.round(cfg.warnAt * 100)}% of the session budget.` }
  }
  if (sub === 'reset') {
    await resetTally($)
    return { text: 'Token budget counts reset for this session.' }
  }
  if (sub === 'on' || sub === 'off') {
    const cfg = await saveSetting($, { enforce: sub === 'on' })
    return { text: cfg.enforce ? 'Enforcement on.' : 'Enforcement off: tokens are still counted, nothing is denied.' }
  }
  if (sub === 'band') {
    const v = arg.toLowerCase()
    if (v !== 'on' && v !== 'off') return { text: 'Use /budget band on or /budget band off.' }
    const cfg = await saveSetting($, { band: v === 'on' })
    return { text: cfg.band ? 'Band shown above the prompt.' : 'Band hidden.' }
  }
  return { text: HELP }
}

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    try {
      await onSessionStart($, typeof e.cwd === 'string' ? e.cwd : '')
    } catch {
      // Counting starts from the defaults.
    }
    try {
      await $.command.register({
        name: 'budget',
        description: 'Token budget and prompt cache: open the pane, or set, agent, action, warn, reset, on, off, band, keepwarm, autowarm, pings, text',
        argumentHint:
          '[set <n> | agent <n> | action <warn|deny-agents|stop> | warn <0-1> | reset | on | off | band on|off | keepwarm | autowarm on|off | pings on|off | text]',
        immediate: true,
      })
    } catch {
      // The name is taken: the rest of the mod still counts and enforces.
    }
    startCacheTimer($)
    return next(e)
  })

  // /clear, /resume and /branch reset $.state without a session.start: load config again.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try {
      const cwd = typeof e.cwd === 'string' ? e.cwd : ''
      await onSessionStart($, cwd)
    } catch {
      // Defaults stay in place.
    }
    try {
      await seedFromResume($, e as unknown as Record<string, unknown>)
    } catch {
      // The cache state stays unknown until the first request.
    }
    lastBand = ''
    startCacheTimer($)
    return next(e)
  })

  // A compaction of the main conversation: the next request writes a new cache, nothing to re-warm.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    try {
      const skipped = !!result && typeof (result as { skip?: unknown }).skip === 'string'
      if (!e.agentId && e.trigger !== 'precompute' && !skipped) {
        await update($, cacheAtom, (s: CacheState) => ({ ...s, compacted: true, lastPing: null, cold: false }))
      }
    } catch {
      // Observing only.
    }
    return result
  })

  // A prompt sent while the cache is cold (by our own clock) re-writes the context: say what it costs. Never dropped.
  on('prompt.submit', async ($, e, next) => {
    try {
      const text = typeof e.text === 'string' ? e.text : ''
      if (!e.turnId && !text.trimStart().startsWith('/')) {
        const cfg = await read($, configAtom)
        const s = await read($, cacheAtom)
        if (isCold(s, await nowOf($), ttlOf(cfg))) {
          const msg = coldSendText(s, coldUsd(s, cfg))
          note($, msg)
          toast($, msg)
        }
      }
    } catch {
      // A note only: the prompt goes ahead either way.
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await flushLifetime($)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    try {
      if (result && result.usage) {
        await recordStep($, result.usage, e.agentId, typeof e.model === 'string' ? e.model : '')
        if (!e.agentId) {
          const u = result.usage as unknown as Record<string, unknown>
          const model = typeof u.model === 'string' && u.model ? u.model : typeof e.model === 'string' ? e.model : ''
          await markRequest($, u, model)
        }
      }
    } catch {
      // A miscount never breaks the request.
    }
    return result
  })

  // A main-loop turn starts (subagents' turns and keep-warm forks raise none): no automatic
  // keep-warm while it runs, and a new idle stretch, so the cap and a halt start over.
  on('turn.start', async ($, e, next) => {
    stretch++
    try {
      await update($, cacheAtom, (s: CacheState) => ({ ...s, turnRunning: true, autoWarms: 0, autoHalted: false }))
    } catch {
      // Observing only.
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      if (!e.agentId) await update($, cacheAtom, (s: CacheState) => ({ ...s, turnRunning: false }))
      await update($, tallyAtom, (t: Tally) => applyTurnComplete(t, e.agentId))
      if (!e.agentId) await readContext($)
      await flushLifetime($)
      const cfg = await read($, configAtom)
      const tally = await read($, tallyAtom)
      if (!e.agentId && cfg.enforce && cfg.action === 'warn' && levelOf(tally.total, cfg) === 'over') {
        $.ui.toast(`Session budget spent: ${fmt(tally.total)} of ${fmt(cfg.session)}. Raise it with /budget set <n>.`)
      }
    } catch {
      // Observing only.
    }
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    let deny: string | null = null
    try {
      const cfg = await read($, configAtom)
      const tally = await read($, tallyAtom)
      if (cfg.enforce && cfg.action === 'deny-agents' && levelOf(tally.total, cfg) === 'over') {
        deny = sessionDenyText(tally, cfg, 'deny-agents')
      }
    } catch {
      deny = null
    }
    if (deny) return { deny }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    let deny: string | null = null
    try {
      const tool = typeof e.tool === 'string' ? e.tool : ''
      // The mod's own tools and calls the user raised with a press stay open. `consent` rides on
      // every tool.call input (ToolCallReserved) but the built-in tools' types don't declare it.
      const exempt = tool.startsWith(TOOL_PREFIX) || ('consent' in e && typeof e.consent === 'string' && e.consent !== '')
      const cfg = await read($, configAtom)
      if (!exempt && cfg.enforce) {
        const tally = await read($, tallyAtom)
        if (cfg.action === 'stop' && levelOf(tally.total, cfg) === 'over') {
          deny = sessionDenyText(tally, cfg, 'stop')
        } else if (cfg.perAgent > 0 && e.agentId) {
          const used = tally.byAgent[e.agentId] ?? 0
          if (used >= cfg.perAgent) deny = agentDenyText(used, cfg)
        }
      }
    } catch {
      deny = null
    }
    if (deny) return { deny }
    return next(e)
  })

  on('command.run', { command: 'budget' }, async ($, e) => {
    try {
      return await runCommand($, typeof e.args === 'string' ? e.args : '')
    } catch (err) {
      return { text: 'token-budget: ' + (err instanceof Error ? err.message : String(err)) }
    }
  })

  // The band: `budget  ● ▰▱▱▱ 2k / 2.0M 0%  ● cache warm 54:12 left   main 2k · agents 500 · …  [Keep warm]`,
  // one kit line stacked above the bands after it. The right side is quiet, in default text once the
  // cache is cold or the budget is spent.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const cfg = await read($, configAtom)
    if (!cfg.band || (e.props && e.props.hasSurvey)) return next(e)
    const tally = await read($, tallyAtom)
    const ctx = await read($, ctxAtom)
    const cache = await read($, cacheAtom)
    const now = await nowOf($)
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const k = makeKit(ui as unknown as Elements, e.surface)
    const level = levelOf(tally.total, cfg)
    const { used, info } = bandParts(tally, cfg, ctx)
    lastBand = bandCache(cache, now, cfg).text
    const c = bandChip(cache, now, cfg)
    const chips = [
      { text: used, tone: toneOfLevel(level) },
      { text: c.chip, tone: c.tone },
    ]
    const right = c.note ? [...info, c.note] : info
    const urgent = c.tone === 'danger' || level === 'over'
    // The kit returns its trees as unknown (it compiles without the engine's types): this is
    // where they meet the engine's element types.
    const drawn = (
      urgent
        ? Box({
            flexDirection: 'row',
            justifyContent: 'space-between',
            columnGap: 2,
            children: [k.line('budget', chips) as RenderElement, k.text(right.join(' · '), { wrap: 'truncate' }) as RenderElement],
          })
        : k.line('budget', chips, right)
    ) as RenderElement
    // Keep warm only once there is a cache to warm (after a request, before a compaction).
    const warmable = cache.lastRequestAt > 0 && !cache.compacted
    const line = Box({
      key: 'budget-band',
      flexDirection: 'row',
      justifyContent: 'space-between',
      columnGap: 2,
      children: [
        Box({ flexDirection: 'column', flexShrink: 1, flexGrow: 1, children: [drawn] }),
        warmable
          ? (k.buttons([{ key: 'keepwarm', label: 'Keep warm', hotkey: 'w', plain: true, onPress: () => keepWarm($) }]) as RenderElement)
          : null,
      ],
    })
    const theirs = await next(e)
    if (!theirs) return line
    return Box({ flexDirection: 'column', children: [line, theirs] })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const cfg = await read($, configAtom)
    const tally = await read($, tallyAtom)
    const lifetime = await read($, lifetimeAtom)
    const ctx = await read($, ctxAtom)
    const cache = await read($, cacheAtom)
    const now = await nowOf($)
    let sessionUsd: number | null = null
    try {
      const u = await $.session.usage()
      const usd = u && u.cost ? u.cost.usd : undefined
      if (typeof usd === 'number' && Number.isFinite(usd)) sessionUsd = usd
    } catch {
      sessionUsd = null
    }
    const ui = $.ui.resolve(e)
    const { Text } = ui
    const k: Kit = makeKit(ui as unknown as Elements, e.surface)
    const level = levelOf(tally.total, cfg)
    const color = TONES[toneOfLevel(level)].fg

    const tile = cacheTile(cache, now, cfg)
    const cold = coldUsd(cache, cfg)
    const left = timeLeftMs(cache, now, ttlOf(cfg))
    const ctxValue =
      cache.contextTokens > 0
        ? tokensText(cache.contextTokens) + (ctx !== null ? ` · ${ctx}%` : '')
        : ctx !== null
          ? `${ctx}%`
          : '—'

    // The pane is a page of blocks one row apart: the tiles, one tight block per section (its header
    // and its rows) and the buttons.
    const tiles = k.tiles([
      { label: 'Context', value: ctxValue },
      { label: 'Cache', value: tile.value, tone: tile.tone },
      { label: 'Cold resend', value: cold === null ? '—' : '≈ ' + usdText(cold), tone: tile.tone === 'danger' ? 'danger' : undefined },
      { label: 'Session cost', value: sessionUsd === null ? '—' : usdText(sessionUsd), tone: 'accent' },
    ])

    const budget: unknown[] = [k.section('Budget', `enforcement ${cfg.enforce ? 'on' : 'off'}`)]
    budget.push(
      k.kv(
        'Limit',
        `${cfg.session > 0 ? fmt(cfg.session) : 'none'} · action ${cfg.action} · warn at ${Math.round(cfg.warnAt * 100)}% · per agent ${cfg.perAgent > 0 ? fmt(cfg.perAgent) : 'off'}`,
      ),
    )
    const remaining = cfg.session > 0 ? fmt(Math.max(0, cfg.session - tally.total)) : 'no limit'
    budget.push(
      Text({
        wrap: 'truncate',
        children: [
          Text({ color, children: [`${level === 'over' ? '✗' : '●'} ${barOf(tally.total, cfg, 16)} `] }),
          `Used ${fmt(tally.total)} (${percentOf(tally.total, cfg)}%) · remaining ${remaining}`,
        ],
      }),
    )
    budget.push(
      k.text(
        `${tally.requests} requests · ${tally.turns} turns · cache reads ${fmt(tally.cacheRead)} (${cfg.countCacheReads ? 'counted' : 'not counted'})`,
        { color: QUIET, wrap: 'truncate' },
      ),
    )

    const prompt: unknown[] = [k.section('Prompt cache', `pings ${cfg.cachePings ? 'on' : 'off'} · auto keep-warm ${cfg.autoKeepWarm ? 'on' : 'off'}`)]
    prompt.push(
      k.kv(
        'Lifetime',
        `${cfg.cacheTtlMinutes} min (assumed) · pings at ${cfg.cacheWarnMinutes.length ? cfg.cacheWarnMinutes.join(', ') + ' min' : 'none'}`,
      ),
    )
    prompt.push(
      k.kv(
        'Last request',
        cache.lastRequestAt > 0
          ? `${cache.model ?? 'unknown model'}${left !== null ? ` · ${tile.value}` : ''}`
          : 'none yet',
        tile.tone,
      ),
    )
    prompt.push(k.kv('Auto keep-warm', autoWarmStatus(cache, ttlOf(cfg), cfg, await budgetSpent($, cfg))))

    const models = modelsOf(tally)
    const byModel: unknown[] = [k.section('By model', String(models.length))]
    if (models.length === 0) byModel.push(k.text('nothing counted yet', { color: QUIET }))
    for (const [m, t] of models) byModel.push(k.row({ key: 'm:' + m, left: m, right: fmt(t) }))

    const agents = topAgents(tally)
    const byAgent: unknown[] = [k.section('Agents', `main loop ${fmt(tally.byAgent[MAIN] ?? 0)}`)]
    if (agents.length === 0) byAgent.push(k.text('no subagents yet', { color: QUIET }))
    for (const [a, t] of agents) {
      const capped = cfg.perAgent > 0 && t >= cfg.perAgent
      byAgent.push(
        k.row({
          key: 'a:' + a,
          left: [k.text(capped ? '✗' : '○', { color: capped ? TONES.danger.fg : QUIET }), a],
          right: fmt(t),
        }),
      )
    }

    const avg = averagePerTurn(tally)
    const turns = turnsLeft(tally, cfg)
    const projection: unknown[] = [k.section('Projection')]
    projection.push(
      k.text(
        avg === null
          ? 'No completed turns yet: no projection.'
          : `Average ${fmt(avg)} per turn${turns !== null ? ` · about ${turns} turns left at this pace` : ''}`,
        { wrap: 'truncate' },
      ),
    )
    projection.push(k.kv('Lifetime in this project', fmt(lifetime + tally.unflushed)))
    const buttons = k.buttons([
      { key: 'keepwarm', label: 'Keep warm', hotkey: 'w', plain: true, onPress: () => keepWarm($) },
      { key: 'reset', label: 'Reset', hotkey: 'r', plain: true, onPress: () => resetTally($) },
      { key: 'close', label: 'Close', hotkey: 'c', plain: true, onPress: () => $.ui.close({ id: PANE }) },
    ])
    return k.page([
      tiles,
      k.stack(budget),
      k.stack(prompt),
      k.stack(byModel),
      k.stack(byAgent),
      k.stack(projection),
      buttons,
    ]) as RenderElement
  })
}
