// attention: tell the user when Claude needs them or finished something long,
// and keep an inbox of those moments.
//
// turn.complete   long main-loop turn done, failed turn (error or interrupt), subagent done
// Permission waits follow config.permissionSignal. "dialog" (default): only
// classic.PermissionRequest raises one. "grace": also
// tool.check      permission ask: the verdict after next(e) is 'ask'. Held for a grace
//                 period (auto mode approves most asks within it); raised only if still
//                 unanswered. Subagent asks are ignored unless includeSubagents.
// classic.PermissionRequest  the dialog is really shown: raises the held ask at once
// ui.render ToolProgress      the tool is running (so it was approved): drops the held ask.
//                 classic.PreToolUse can't serve: it fires before tool.check.
// tool.call       remembers which loop a call runs in; clears its wait once it settles
// agent.spawn     the subagent's label and start time
// ui.render       AskUserQuestion: question wait (first render per tool call id);
//                 AbovePrompt: the one-line band; Pane: the /attention inbox
// prompt.submit   the user is back: marks the inbox seen and starts the quiet period
// command.run     /attention and its subcommands
//
// Delivery (toast, native, sound) runs from $.clock.after(0) so no hook waits on
// notify-send or a player. Helpers that take $ are top-level functions so static
// analysis can read them.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { AttentionEvent, Config, Kind } from '../types'
import {
  BUNDLED_SOUND,
  DEFAULTS,
  HELP,
  INBOX_MAX,
  RATE_MS,
  SYSTEM_SOUND,
  bandOf,
  clockTime,
  describeInput,
  firstLine,
  firstQuestion,
  fmtDuration,
  inboxText,
  mergeConfig,
  notifyArgv,
  oneLine,
  parseMs,
  sanitize,
  shortKind,
  soundArgvs,
} from './attention'
import { TONES, makeKit } from './kit'
import type { Elements, Tone } from './kit'

type Api = EngineInterface

const PANE = 'attention'
const SETTINGS_KEY = 'settings'
const CONFIG_FILE = '.claude/attention.json'
const HUMAN_ORIGINS = ['composer', 'bridge', 'sdk']

const inboxAtom = atom({ plugin: 'lk-attention', key: 'inbox' } as const, [] as AttentionEvent[])
const configAtom = atom({ plugin: 'lk-attention', key: 'config' } as const, DEFAULTS)
const claimedAtom = atom({ plugin: 'lk-attention', key: 'claimed' } as const, [] as string[])
const lastNativeAtom = atom({ plugin: 'lk-attention', key: 'lastNative' } as const, {} as Record<string, number>)
const lastPromptAtom = atom({ plugin: 'lk-attention', key: 'lastPromptAt' } as const, null as number | null)
const cwdAtom = atom({ plugin: 'lk-attention', key: 'cwd' } as const, '')

/** tool_use_id -> the loop and tool of a call in flight (tool.check carries no agentId). */
const calls = new Map<string, { tool: string; agentId?: string; description?: string }>()
/** agentId -> label and start time, from agent.spawn. */
const agents = new Map<string, { label: string; startedAt: number }>()
/** AskUserQuestion render ids already handed to a timer, so re-renders schedule nothing. */
const queued = new Set<string>()
/** Main-loop asks held for the grace period, by tool_use_id. */
const pending = new Map<string, { tool: string; input: unknown; agentId?: string; timer: { cancel(): void } | null }>()
/** Set once classic.PermissionRequest has fired: from then on it alone raises main-loop waits. */
let sawPermissionRequest = false
let seq = 0

type Raise = {
  kind: Kind
  title: string
  body: string
  agentId?: string
  toolUseId?: string
  tool?: string
  /** Toast and inbox only: no native notification or sound (the user is at the keyboard). */
  quiet?: boolean
  /** Raise it already seen (history only, no band). */
  seen?: boolean
}

// ---------------------------------------------------------------- pane helpers (pure)

const ASK_KINDS: readonly Kind[] = ['permission-waiting', 'question-waiting']
const DONE_KINDS: readonly Kind[] = ['long-turn-done', 'subagent-done']

/** The quiet color of the kit (secondary text, seen events), a theme key. */
const QUIET = TONES.muted.fg

/** The kit tone of a kind: asks accent (the Claude orange), failures danger, finished work ok, the rest info. */
function toneOfKind(kind: Kind): Tone {
  if (ASK_KINDS.includes(kind)) return 'accent'
  if (kind === 'failed') return 'danger'
  if (DONE_KINDS.includes(kind)) return 'ok'
  return 'info'
}

/** Inbox counts by kind for the pane's tiles. */
function countsOf(inbox: readonly AttentionEvent[]): { asks: number; done: number; failed: number } {
  const n = (kinds: readonly Kind[]) => inbox.filter(ev => kinds.includes(ev.kind)).length
  return { asks: n(ASK_KINDS), done: n(DONE_KINDS), failed: n(['failed']) }
}

async function now($: Api): Promise<number> {
  try {
    const t = await $.clock.now()
    return typeof t === 'number' && Number.isFinite(t) ? t : Date.now()
  } catch {
    return Date.now()
  }
}

/** Claims a key once: true for the first caller, false ever after (one update, so no double raise). */
async function claim($: Api, key: string): Promise<boolean> {
  let first = false
  await update($, claimedAtom, (list: string[]) => {
    if (list.includes(key)) return list
    first = true
    return [...list, key].slice(-500)
  })
  return first
}

async function readJson($: Api, path: string): Promise<unknown> {
  try {
    if (!(await $.fs.exists(path))) return null
    return JSON.parse(String(await $.fs.read(path)))
  } catch {
    return null
  }
}

async function readSaved($: Api): Promise<unknown> {
  try {
    return await $.store.get(SETTINGS_KEY)
  } catch {
    return null
  }
}

/** Merges defaults, ~/.claude/attention.json, <cwd>/.claude/attention.json and /attention settings. */
async function loadConfig($: Api): Promise<Config> {
  let home = ''
  try {
    home = String((await $.env.get('HOME')) ?? '')
  } catch {
    home = ''
  }
  const cwd = await read($, cwdAtom)
  const user = home ? await readJson($, home.replace(/\/+$/, '') + '/' + CONFIG_FILE) : null
  const project = cwd ? await readJson($, cwd.replace(/\/+$/, '') + '/' + CONFIG_FILE) : null
  const cfg = mergeConfig(user, project, await readSaved($))
  await update($, configAtom, () => cfg)
  return cfg
}

async function saveSetting($: Api, patch: Partial<Config>): Promise<Config> {
  await $.store.set(SETTINGS_KEY, { ...sanitize(await readSaved($)), ...patch })
  return loadConfig($)
}

async function onSessionStart($: Api, cwd: string): Promise<void> {
  if (!cwd) {
    try {
      cwd = String((await $.session.cwd()) ?? '')
    } catch {
      cwd = ''
    }
  }
  if (cwd) await update($, cwdAtom, () => cwd)
  await loadConfig($)
}

/** Sends the desktop notification: $.ui.notify when this build has it, else notify-send. */
async function sendNative($: Api, title: string, body: string): Promise<string> {
  // $.ui.notify arrived in Claude Code 2.1.295. The validator refuses reading a $ method
  // as a value, so feature detection is the call itself: on an older build it throws
  // (not a function) and notify-send takes over.
  try {
    // @ts-ignore not in the 2.1.294 typings
    await $.ui.notify({ title, body })
    return 'native via $.ui.notify'
  } catch {
    // Fall through to notify-send.
  }
  try {
    const r = await $.process.run(notifyArgv(title, body), { timeoutMs: 5000 })
    return r.exitCode === 0 ? 'native via notify-send' : `native failed: notify-send exited ${r.exitCode}`
  } catch {
    return 'native failed: notify-send not found'
  }
}

/** Runs paplay, then pw-play, on a file; the player that worked, or null. */
async function playFile($: Api, file: string): Promise<string | null> {
  for (const argv of soundArgvs(file)) {
    try {
      const r = await $.process.run(argv, { timeoutMs: 10_000 })
      if (r.exitCode === 0) return argv[0]
    } catch {
      // Not installed: try the next player.
    }
  }
  return null
}

/** Plays the configured file, else the freedesktop sound, else the bundled ding. */
async function playSound($: Api, cfg: Config): Promise<string> {
  let file = cfg.soundFile
  if (!file) {
    try {
      if (await $.fs.exists(SYSTEM_SOUND)) file = SYSTEM_SOUND
    } catch {
      file = ''
    }
  }
  if (file) {
    const player = await playFile($, file)
    if (player) return `sound via ${player} ${file}`
  }
  try {
    await $.audio.play({ asset: BUNDLED_SOUND })
    return `sound via $.audio.play ${BUNDLED_SOUND}`
  } catch {
    // No $.audio, or the engine has no player here: run one ourselves.
  }
  let root = ''
  try {
    root = String($.plugin.root ?? '')
  } catch {
    root = ''
  }
  if (root) {
    const bundled = root.replace(/\/+$/, '') + '/' + BUNDLED_SOUND
    const player = await playFile($, bundled)
    if (player) return `sound via ${player} ${bundled}`
  }
  return 'sound failed: no player worked (install pulseaudio-utils or pipewire)'
}

/** Toast always; native and sound unless quiet, rate-limited or switched off. */
async function deliver($: Api, ev: AttentionEvent, opts: { force: boolean; quiet: boolean }): Promise<string[]> {
  const cfg = await read($, configAtom)
  const report: string[] = []
  try {
    await $.ui.toast(ev.title)
    report.push('toast')
  } catch {
    report.push('toast failed')
  }
  if (!opts.force) {
    if (opts.quiet) return report
    const last = await read($, lastPromptAtom)
    if (cfg.quietAfterPromptMs > 0 && last !== null && ev.at - last < cfg.quietAfterPromptMs) {
      report.push('quiet after your prompt')
      return report
    }
  }
  if (!cfg.native && !cfg.sound) return report
  if (!opts.force) {
    let allowed = false
    await update($, lastNativeAtom, (m: Record<string, number>) => {
      const prev = m[ev.kind]
      if (typeof prev === 'number' && ev.at - prev < RATE_MS) return m
      allowed = true
      return { ...m, [ev.kind]: ev.at }
    })
    if (!allowed) {
      report.push('rate-limited')
      return report
    }
  }
  if (cfg.native) report.push(await sendNative($, ev.title, ev.body))
  if (cfg.sound) report.push(await playSound($, cfg))
  return report
}

/** Adds an event to the inbox and schedules its delivery. Null when the mod is off. */
async function raise($: Api, r: Raise): Promise<AttentionEvent | null> {
  const cfg = await read($, configAtom)
  if (!cfg.enabled) return null
  const at = await now($)
  seq += 1
  const ev: AttentionEvent = {
    id: `${r.kind}:${at}:${seq}`,
    at,
    kind: r.kind,
    title: oneLine(r.title, 100),
    body: oneLine(r.body, 160),
    seen: r.seen === true,
  }
  if (r.agentId) ev.agentId = r.agentId
  if (r.toolUseId) ev.toolUseId = r.toolUseId
  if (r.tool) ev.tool = r.tool
  await update($, inboxAtom, (list: AttentionEvent[]) => [ev, ...list].slice(0, INBOX_MAX))
  const quiet = r.quiet === true
  try {
    $.clock.after(0, () => {
      deliver($, ev, { force: false, quiet }).catch(() => undefined)
    })
  } catch {
    // No clock: the inbox and band still have it.
  }
  return ev
}

/** Marks waits resolved and seen: one tool call's, or every open one when id is null. */
async function resolveWaits($: Api, toolUseId: string | null): Promise<void> {
  await update($, inboxAtom, (list: AttentionEvent[]) => {
    let changed = false
    const out = list.map(ev => {
      const isWait = ev.kind === 'permission-waiting' || ev.kind === 'question-waiting'
      if (!isWait || ev.resolved) return ev
      if (toolUseId !== null && ev.toolUseId !== toolUseId) return ev
      changed = true
      return { ...ev, resolved: true, seen: true }
    })
    return changed ? out : list
  })
}

async function markAllSeen($: Api): Promise<void> {
  await update($, inboxAtom, (list: AttentionEvent[]) =>
    list.some(ev => !ev.seen) ? list.map(ev => (ev.seen ? ev : { ...ev, seen: true })) : list,
  )
}

function agentLabel(agentId: string): string {
  const a = agents.get(agentId)
  return a && a.label ? a.label : agentId.slice(0, 8)
}

async function onTurnComplete($: Api, e: Record<string, unknown>): Promise<void> {
  const cfg = await read($, configAtom)
  if (!cfg.enabled) return
  const agentId = typeof e.agentId === 'string' && e.agentId ? e.agentId : ''
  const duration = typeof e.durationMs === 'number' && Number.isFinite(e.durationMs) ? e.durationMs : 0
  const reason = typeof e.reason === 'string' ? e.reason : ''
  const aborted = e.isAborted === true || reason === 'aborted'
  const answer = firstLine(e.answer)
  const turnId = typeof e.turnId === 'string' ? e.turnId : ''

  if (!agentId) {
    // The turn is over: nothing is waiting on the user any more.
    cancelPending(null)
    await resolveWaits($, null)
    if (reason === 'error') {
      await raise($, { kind: 'failed', title: 'Claude stopped on an error', body: answer || 'An API error ended the turn.' })
    } else if (aborted) {
      // The user interrupted it, so they are here: history only.
      await raise($, { kind: 'failed', title: `Turn interrupted after ${fmtDuration(duration)}`, body: answer, quiet: true, seen: true })
    } else if (duration >= cfg.longTurnMs) {
      await raise($, { kind: 'long-turn-done', title: `Claude finished (${fmtDuration(duration)})`, body: answer || 'The turn is done.' })
    }
    return
  }

  if (aborted || reason === 'error' || reason === 'refusal') return
  const started = agents.get(agentId)?.startedAt
  const ran = Math.max(duration, typeof started === 'number' ? (await now($)) - started : 0)
  if (ran < cfg.subagentMs) return
  if (!(await claim($, `a:${agentId}:${turnId}`))) return
  await raise($, {
    kind: 'subagent-done',
    title: `Subagent done: ${agentLabel(agentId)} (${fmtDuration(ran)})`,
    body: answer || 'The subagent returned.',
    agentId,
  })
}

function cancelPending(toolUseId: string | null): void {
  for (const [id, p] of [...pending]) {
    if (toolUseId !== null && id !== toolUseId) continue
    try {
      p.timer?.cancel()
    } catch {
      // Already fired.
    }
    pending.delete(id)
  }
}

/** Holds an 'ask' for the grace period; raises it only if nothing answered it by then. */
async function holdAsk($: Api, tool: string, toolUseId: string, input: unknown, agentId: string | undefined): Promise<void> {
  const cfg = await read($, configAtom)
  // In dialog mode an 'ask' only means "the mode decides": auto mode's classifier
  // answers most itself, so nothing is raised or scheduled.
  if (cfg.permissionSignal !== 'grace') return
  if (agentId && !cfg.includeSubagents) return
  if (pending.has(toolUseId)) return
  const entry: { tool: string; input: unknown; agentId?: string; timer: { cancel(): void } | null } = { tool, input, agentId, timer: null }
  pending.set(toolUseId, entry)
  try {
    entry.timer = $.clock.after(cfg.permissionGraceMs, () => {
      if (pending.get(toolUseId) !== entry) return
      pending.delete(toolUseId)
      // Once the dialog event has been seen it is authoritative for the main loop.
      if (sawPermissionRequest && !agentId) return
      onPermissionAsk($, tool, toolUseId, input, agentId).catch(() => undefined)
    })
  } catch {
    pending.delete(toolUseId)
  }
}

/** classic.PermissionRequest: a dialog is on screen now. Matches the held ask by tool and input. */
async function onDialogShown($: Api, tool: string, input: unknown, agentId: string): Promise<void> {
  const cfg = await read($, configAtom)
  if (!cfg.enabled || (agentId && !cfg.includeSubagents)) return
  const same = (a: unknown, b: unknown) => {
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch {
      return false
    }
  }
  const held = [...pending].filter(([, p]) => p.tool === tool && (p.agentId ?? '') === agentId)
  const match = held.find(([, p]) => same(p.input, input)) ?? held[held.length - 1]
  if (match) {
    cancelPending(match[0])
    await onPermissionAsk($, tool, match[0], input, agentId)
    return
  }
  // No held ask (dialog mode): take the newest call in flight for this tool and loop,
  // so its tool.call settling clears the wait.
  const inFlight = [...calls].filter(([, c]) => c.tool === tool && (c.agentId ?? '') === agentId)
  if (inFlight.length > 0) {
    await onPermissionAsk($, tool, inFlight[inFlight.length - 1][0], input, agentId)
    return
  }
  // Nothing to match: raise with a key of our own (cleared when the turn ends).
  const at = await now($)
  await onPermissionAsk($, tool, `pr:${tool}:${at}`, input, agentId)
}

async function onPermissionAsk($: Api, tool: string, toolUseId: string, input: unknown, agentHint?: string): Promise<void> {
  if (!(await claim($, `p:${toolUseId}`))) return
  const agentId = calls.get(toolUseId)?.agentId || agentHint || undefined
  const who = agentId ? `Subagent ${agentLabel(agentId)}` : 'Claude'
  await raise($, {
    kind: 'permission-waiting',
    title: `${who} needs your OK: ${tool}`,
    body: describeInput(tool, input),
    toolUseId,
    tool,
    agentId,
  })
}

async function onQuestion($: Api, requestId: string, questions: unknown): Promise<void> {
  if (!(await claim($, `q:${requestId}`))) return
  const call = calls.get(requestId)
  const agentId = call?.agentId
  await raise($, {
    kind: 'question-waiting',
    title: agentId ? `Subagent ${agentLabel(agentId)} is asking you something` : 'Claude is asking you something',
    body: firstQuestion(questions) || 'A question is waiting for your answer.',
    toolUseId: requestId,
    agentId,
  })
}

async function runCommand($: Api, args: string): Promise<{ text?: string }> {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const sub = (words[0] ?? '').toLowerCase()
  const arg = (words[1] ?? '').toLowerCase()
  const onOff = (v: string) => (v === 'on' ? true : v === 'off' ? false : null)

  if (sub === '') {
    await $.ui.open({ id: PANE, title: 'Attention', focus: true, closeOnEscape: true })
    return {}
  }
  if (sub === 'text') return { text: inboxText(await read($, inboxAtom), await read($, configAtom)) }
  if (sub === 'on' || sub === 'off') {
    const cfg = await saveSetting($, { enabled: sub === 'on' })
    return { text: cfg.enabled ? 'attention on.' : 'attention off: nothing is raised until /attention on.' }
  }
  if (sub === 'sound' || sub === 'native' || sub === 'band') {
    const v = onOff(arg)
    if (v === null) return { text: `Use /attention ${sub} on or /attention ${sub} off.` }
    const cfg = await saveSetting($, { [sub]: v } as Partial<Config>)
    return { text: `${sub[0].toUpperCase()}${sub.slice(1)} ${cfg[sub] ? 'on' : 'off'}.` }
  }
  if (sub === 'subagents') {
    const v = onOff(arg)
    if (v === null) return { text: 'Use /attention subagents on or /attention subagents off.' }
    const cfg = await saveSetting($, { includeSubagents: v })
    return { text: cfg.includeSubagents ? 'Permission waits from subagents notify too.' : 'Permission waits from subagents are ignored.' }
  }
  if (sub === 'signal') {
    if (arg !== 'dialog' && arg !== 'grace') return { text: 'Use /attention signal dialog or /attention signal grace.' }
    const cfg = await saveSetting($, { permissionSignal: arg })
    return {
      text:
        cfg.permissionSignal === 'dialog'
          ? 'Permission waits notify only when a dialog is shown.'
          : `Permission waits notify when an ask stays unanswered for ${fmtDuration(cfg.permissionGraceMs)}.`,
    }
  }
  if (sub === 'grace') {
    const ms = parseMs(words.slice(1).join(' '))
    if (ms === null) return { text: 'Use /attention grace <ms>, such as 4000 or 4s.' }
    const cfg = await saveSetting($, { permissionGraceMs: ms })
    return { text: `A permission ask notifies after ${fmtDuration(cfg.permissionGraceMs)} unanswered.` }
  }
  if (sub === 'long') {
    const ms = parseMs(words.slice(1).join(' '))
    if (ms === null) return { text: 'Use /attention long <ms>, such as 20000, 20s or 2m.' }
    const cfg = await saveSetting($, { longTurnMs: ms })
    return { text: `Turns of ${fmtDuration(cfg.longTurnMs)} or more notify when they finish.` }
  }
  if (sub === 'test') {
    const cfg = await read($, configAtom)
    const at = await now($)
    seq += 1
    const ev: AttentionEvent = {
      id: `test:${at}:${seq}`,
      at,
      kind: 'test',
      title: 'attention test',
      body: 'If you can see and hear this, notifications work.',
      seen: false,
    }
    await update($, inboxAtom, (list: AttentionEvent[]) => [ev, ...list].slice(0, INBOX_MAX))
    const report = await deliver($, ev, { force: true, quiet: false })
    const off = [!cfg.native ? 'native is off' : '', !cfg.sound ? 'sound is off' : ''].filter(Boolean)
    return { text: `Test sent: ${report.join('; ')}${off.length ? ` (${off.join(', ')})` : ''}.` }
  }
  return { text: HELP }
}

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    try {
      await onSessionStart($, typeof e.cwd === 'string' ? e.cwd : '')
    } catch {
      // Defaults stay in place.
    }
    try {
      await $.command.register({
        name: 'attention',
        description: 'Attention inbox: open the pane, or text, on, off, sound, native, band, subagents, signal, grace, long, test',
        argumentHint: '[text | on | off | sound on|off | native on|off | band on|off | subagents on|off | signal dialog|grace | grace <ms> | long <ms> | test]',
        immediate: true,
      })
    } catch {
      // The name is taken: events still raise and the band still draws.
    }
    return next(e)
  })

  // /clear, /resume and /branch reset $.state without a session.start: load config again.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try {
      await onSessionStart($, typeof e.cwd === 'string' ? e.cwd : '')
    } catch {
      // Defaults stay in place.
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      const origin = e.origin as { kind?: unknown } | undefined
      const kind = origin && typeof origin.kind === 'string' ? origin.kind : ''
      // Task notifications and peers' messages arrive here too; only the user's own prompt counts.
      if (!kind || HUMAN_ORIGINS.includes(kind)) {
        const t = await now($)
        await update($, lastPromptAtom, () => t)
        await markAllSeen($)
      }
    } catch {
      // Observing only.
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    try {
      const id = result && typeof result.agentId === 'string' ? result.agentId : ''
      if (id) {
        const fromCall = typeof e.tool_use_id === 'string' ? calls.get(e.tool_use_id)?.description : undefined
        const label = oneLine(e.description || fromCall || e.name || e.subagentType || '', 40)
        agents.set(id, { label, startedAt: await now($) })
      }
    } catch {
      // The label falls back to the agent id.
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    const id = typeof e.tool_use_id === 'string' ? e.tool_use_id : ''
    if (id) {
      const rec = e as unknown as Record<string, unknown>
      calls.set(id, {
        tool: typeof e.tool === 'string' ? e.tool : '',
        agentId: typeof e.agentId === 'string' ? e.agentId : undefined,
        description: typeof rec.description === 'string' ? rec.description : undefined,
      })
    }
    try {
      return await next(e)
    } finally {
      if (id) {
        calls.delete(id)
        cancelPending(id)
        try {
          await resolveWaits($, id)
        } catch {
          // The wait clears at the end of the turn instead.
        }
      }
    }
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    try {
      const id = typeof e.tool_use_id === 'string' ? e.tool_use_id : ''
      const tool = typeof e.tool === 'string' ? e.tool : ''
      // A query (no tool_use_id) shows no dialog; AskUserQuestion raises its own question event.
      if (id && verdict && verdict.decision === 'ask' && tool !== 'AskUserQuestion') {
        if ((await read($, configAtom)).enabled) await holdAsk($, tool, id, e.input, calls.get(id)?.agentId)
      }
    } catch {
      // Observing only.
    }
    return verdict
  })

  // Fires only when a permission dialog is really shown (not for asks auto mode decides).
  on('classic.PermissionRequest', async ($, e, next) => {
    try {
      sawPermissionRequest = true
      const tool = typeof e.tool_name === 'string' ? e.tool_name : ''
      const agentId = typeof e.agent_id === 'string' ? e.agent_id : ''
      if (tool && tool !== 'AskUserQuestion') await onDialogShown($, tool, e.tool_input, agentId)
    } catch {
      // Observing only.
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      await onTurnComplete($, e as unknown as Record<string, unknown>)
    } catch {
      // Observing only.
    }
    return result
  })

  on('command.run', { command: 'attention' }, async ($, e) => {
    try {
      return await runCommand($, typeof e.args === 'string' ? e.args : '')
    } catch (err) {
      return { text: 'attention: ' + (err instanceof Error ? err.message : String(err)) }
    }
  })

  // Drawing is pure (no state writes while ui.render dispatches), so the raise runs
  // from a zero-delay timer; claim() inside it keeps it to the first render per id.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    try {
      const id = typeof e.requestId === 'string' ? e.requestId : ''
      if (id && !queued.has(id) && (await read($, configAtom)).enabled) {
        if (queued.size > 500) queued.clear()
        queued.add(id)
        const props = (e.props ?? {}) as { questions?: unknown }
        const questions = props.questions
        $.clock.after(0, () => {
          onQuestion($, id, questions).catch(() => undefined)
        })
      }
    } catch {
      // Observing only: the dialog draws as usual.
    }
    return next(e)
  })

  // The run-in-background pill is drawn under a foreground tool that is already running,
  // so its call was approved: drop the held ask before the grace fires. Only module
  // memory and the timer change here (no state write), so drawing stays pure.
  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    try {
      const props = (e.props ?? {}) as { tool_use_id?: unknown }
      const id = typeof props.tool_use_id === 'string' ? props.tool_use_id : typeof e.requestId === 'string' ? e.requestId : ''
      if (id && pending.has(id)) cancelPending(id)
    } catch {
      // Observing only.
    }
    return next(e)
  })

  // The band, one kit line: a bold label, the state chip in the tone bandOf encodes (accent, or
  // danger after a failure) and the waiting kinds on the right side: in the default text color when
  // an ask waits or a turn failed, else quiet (kit.line draws its right side quiet).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const props = (e.props ?? {}) as { hasSurvey?: boolean }
    const cfg = await read($, configAtom)
    if (props.hasSurvey === true || !cfg.band || !cfg.enabled) return next(e)
    const band = bandOf(await read($, inboxAtom))
    if (!band) return next(e)
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const kit = makeKit(ui as unknown as Elements, e.surface)
    const chips = [{ text: band.state, tone: band.tone }]
    const drawn = (
      band.urgent && band.kinds
        ? Box({
            flexDirection: 'row',
            justifyContent: 'space-between',
            columnGap: 2,
            children: [kit.line('attention', chips) as ReturnType<typeof Box>, kit.text(band.kinds, { wrap: 'truncate' }) as ReturnType<typeof Box>],
          })
        : kit.line('attention', chips, band.kinds)
    ) as ReturnType<typeof Box>
    const line = Box({ key: 'attention-band', flexDirection: 'column', children: [drawn] })
    const theirs = await next(e)
    if (!theirs) return line
    return Box({ flexDirection: 'column', children: [line, theirs] })
  })

  // The inbox pane, drawn with the kit: a hero for the newest unseen event, tiles, the inbox rows, buttons.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const inbox = await read($, inboxAtom)
    const cfg = await read($, configAtom)
    const at = await now($)
    const kit = makeKit($.ui.resolve(e) as unknown as Elements, e.surface)
    const ago = (ev: AttentionEvent) => `${fmtDuration(at - ev.at)} ago`
    const onOff = (v: boolean) => (v ? 'on' : 'off')
    const unseen = inbox.filter(ev => !ev.seen)
    // The inbox is newest first, so the first unseen event is the newest.
    const newest = unseen[0]
    const counts = countsOf(inbox)
    const unseenFailed = unseen.some(ev => ev.kind === 'failed')
    const unseenAsk = unseen.some(ev => ASK_KINDS.includes(ev.kind))

    const hero = newest
      ? kit.hero({
          kicker: 'attention',
          title: newest.title,
          sub: [shortKind(newest.kind), ago(newest), newest.body].filter(Boolean).join(' · '),
          tone: toneOfKind(newest.kind),
        })
      : kit.hero({
          kicker: 'attention',
          title: 'Nothing waiting',
          sub: inbox.length ? `${inbox.length} events in the inbox, all seen` : 'The inbox is empty.',
          tone: 'ok',
        })

    const tiles: { label: string; value: string; tone?: Tone }[] = [
      { label: 'Unseen', value: String(unseen.length), tone: unseen.length ? (unseenFailed ? 'danger' : 'accent') : 'muted' },
      { label: 'Asks', value: String(counts.asks), tone: unseenAsk ? 'accent' : 'muted' },
      { label: 'Done', value: String(counts.done), tone: counts.done ? 'ok' : 'muted' },
    ]
    if (counts.failed) tiles.push({ label: 'Failed', value: String(counts.failed), tone: 'danger' })

    const settings = kit.row({
      left: [
        kit.pill(cfg.enabled ? 'on' : 'off', cfg.enabled ? 'ok' : 'danger'),
        kit.text(
          `native ${onOff(cfg.native)} · sound ${onOff(cfg.sound)} · band ${onOff(cfg.band)} · long turn ${fmtDuration(cfg.longTurnMs)}`,
          { color: QUIET, wrap: 'truncate' },
        ),
      ],
    })

    const rows: unknown[] = inbox.length
      ? inbox.map(ev => {
          const tone = toneOfKind(ev.kind)
          return kit.row({
            key: ev.id,
            left: [
              kit.text(ev.seen ? '○' : '●', { color: ev.seen ? QUIET : TONES[tone].fg }),
              kit.pill(shortKind(ev.kind), tone),
              kit.text(ev.title, ev.seen ? { color: QUIET, wrap: 'truncate' } : { bold: true, wrap: 'truncate' }),
              ev.body ? kit.text(ev.body, { color: QUIET, wrap: 'truncate' }) : null,
            ],
            right: [clockTime(ev.at), ago(ev)],
          })
        })
      : [kit.text('Nothing yet. /attention test checks notify-send and the sound.', { color: QUIET })]

    return kit.page([
      hero,
      kit.tiles(tiles),
      settings,
      kit.stack([kit.header(`Inbox · ${inbox.length}`, unseen.length ? `${unseen.length} unseen · newest first` : 'newest first'), ...rows]),
      kit.buttons([
        { key: 'seen', label: 'Mark all seen', hotkey: 'm', plain: true, onPress: () => markAllSeen($) },
        { key: 'close', label: 'Close', hotkey: 'c', plain: true, onPress: () => $.ui.close({ id: PANE }) },
      ]),
    ]) as never
  })
}
