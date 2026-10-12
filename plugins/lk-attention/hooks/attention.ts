// Pure helpers for the attention mod: config merging, text, band and argv builders.
// Nothing here touches $, so tests call these directly.

import type { AttentionEvent, Config, Kind } from '../types'

export const INBOX_MAX = 50
export const RATE_MS = 10_000
export const SYSTEM_SOUND = '/usr/share/sounds/freedesktop/stereo/complete.oga'
export const BUNDLED_SOUND = 'assets/ding.wav'
export const PLAYERS = ['paplay', 'pw-play'] as const

export const DEFAULTS: Config = {
  enabled: true,
  sound: true,
  native: true,
  band: true,
  longTurnMs: 20_000,
  subagentMs: 60_000,
  quietAfterPromptMs: 0,
  soundFile: '',
  includeSubagents: false,
  permissionGraceMs: 4000,
  permissionSignal: 'dialog',
}

export const HELP = [
  'attention: tells you when Claude needs you or finished something long.',
  '  /attention              open the inbox pane',
  '  /attention text         print the inbox',
  '  /attention on|off       everything on or off',
  '  /attention sound on|off the sound',
  '  /attention native on|off  the desktop notification',
  '  /attention band on|off  the line above the prompt',
  '  /attention long <ms>    how long a turn must run to notify (20000, 20s, 2m)',
  '  /attention subagents on|off  permission waits from subagents too',
  '  /attention signal dialog|grace  what raises a permission wait (default dialog)',
  '  /attention grace <ms>   how long an ask must stay unanswered before it notifies (4000, 4s)',
  '  /attention test         send a test event through every channel',
].join('\n')

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Keeps only well-formed Config fields from an untrusted object. */
export function sanitize(raw: unknown): Partial<Config> {
  if (!isRecord(raw)) return {}
  const out: Partial<Config> = {}
  for (const k of ['enabled', 'sound', 'native', 'band', 'includeSubagents'] as const) {
    if (typeof raw[k] === 'boolean') out[k] = raw[k] as boolean
  }
  for (const k of ['longTurnMs', 'subagentMs', 'quietAfterPromptMs', 'permissionGraceMs'] as const) {
    const n = raw[k]
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) out[k] = Math.round(n)
  }
  if (raw.permissionSignal === 'dialog' || raw.permissionSignal === 'grace') out.permissionSignal = raw.permissionSignal
  if (typeof raw.soundFile === 'string') out.soundFile = raw.soundFile.trim()
  return out
}

/** Defaults, then each layer in order; later layers win field by field. */
export function mergeConfig(...layers: unknown[]): Config {
  let cfg: Config = { ...DEFAULTS }
  for (const layer of layers) cfg = { ...cfg, ...sanitize(layer) }
  return cfg
}

/** "20000", "20s", "1.5m" or "500ms" to milliseconds; null when it is not one. */
export function parseMs(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m)?\s*$/i.exec(text)
  if (!m) return null
  const n = Number(m[1])
  const unit = (m[2] ?? 'ms').toLowerCase()
  const ms = unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n
  return Number.isFinite(ms) ? Math.round(ms) : null
}

/** 42s, 2m 5s, 1h 3m. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`
}

/** One line, whitespace collapsed, clipped with an ellipsis. */
export function oneLine(text: unknown, max = 120): string {
  const s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s
}

/** The first non-empty line of a markdown answer, markup stripped. */
export function firstLine(answer: unknown, max = 120): string {
  if (typeof answer !== 'string') return ''
  const line = answer
    .split('\n')
    .map(l => l.replace(/[#*`>_|]/g, '').trim())
    .find(Boolean)
  return oneLine(line ?? '', max)
}

/** What a permission wait is about, from the tool's input. */
export function describeInput(tool: string, input: unknown): string {
  if (!isRecord(input)) return tool
  for (const k of ['command', 'file_path', 'notebook_path', 'url', 'pattern', 'description']) {
    if (typeof input[k] === 'string' && input[k]) return oneLine(input[k], 100)
  }
  return tool
}

/** The first question an AskUserQuestion dialog shows. */
export function firstQuestion(questions: unknown): string {
  if (!Array.isArray(questions) || questions.length === 0) return ''
  const q = questions[0]
  if (isRecord(q)) return oneLine(q.question ?? q.header ?? '', 120)
  return oneLine(q, 120)
}

/** The notify-send command used when $.ui.notify is not there (Claude Code before 2.1.295). */
export function notifyArgv(title: string, body: string): string[] {
  return ['notify-send', '-a', 'Claude Code', '-i', 'dialog-information', oneLine(title, 80) || 'Claude Code', oneLine(body, 200)]
}

/** The player commands to try for a sound file, in order. */
export function soundArgvs(file: string): string[][] {
  return PLAYERS.map(p => [p, file])
}

const SHORT: Record<Kind, string> = {
  'permission-waiting': 'permission',
  'question-waiting': 'question',
  failed: 'failed',
  'long-turn-done': 'done',
  'subagent-done': 'subagent',
  test: 'test',
}

const ORDER: Kind[] = ['permission-waiting', 'question-waiting', 'failed', 'long-turn-done', 'subagent-done', 'test']

export function shortKind(kind: Kind): string {
  return SHORT[kind] ?? kind
}

/** The band for the unseen events, or null when nothing is unseen: the whole text, the state chip
 *  ("3 waiting", "1 new"), the kinds for the right side, the kit tone of the chip (danger after a
 *  failure, else accent, the Claude orange) and whether it is urgent: an ask waiting or a failure
 *  draws the kinds in the default text color, anything else quiet. */
export function bandOf(
  inbox: readonly AttentionEvent[],
): { text: string; state: string; kinds: string; tone: 'accent' | 'danger'; urgent: boolean } | null {
  const unseen = inbox.filter(ev => !ev.seen)
  if (unseen.length === 0) return null
  const parts: string[] = []
  for (const kind of ORDER) {
    const evs = unseen.filter(ev => ev.kind === kind)
    if (evs.length === 0) continue
    const name = SHORT[kind]
    if (kind === 'permission-waiting') {
      const tools = [...new Set(evs.map(ev => ev.tool || '?'))]
      parts.push(`${name} (${tools.join(', ')})`)
    } else {
      parts.push(evs.length > 1 ? `${name} x${evs.length}` : name)
    }
  }
  const waiting = unseen.some(ev => ev.kind === 'permission-waiting' || ev.kind === 'question-waiting')
  const state = `${unseen.length} ${waiting ? 'waiting' : 'new'}`
  const kinds = parts.join(', ')
  const failed = unseen.some(ev => ev.kind === 'failed')
  return { text: `attention ● ${state}: ${kinds}`, state, kinds, tone: failed ? 'danger' : 'accent', urgent: waiting || failed }
}

/** HH:MM:SS in local time. */
export function clockTime(at: number): string {
  try {
    return new Date(at).toTimeString().slice(0, 8)
  } catch {
    return '--:--:--'
  }
}

/** One inbox row as plain text. */
export function rowText(ev: AttentionEvent): string {
  const mark = ev.seen ? '○' : '●'
  const body = ev.body ? ` · ${ev.body}` : ''
  return `${mark} ${clockTime(ev.at)}  ${shortKind(ev.kind).padEnd(10)} ${ev.title}${body}`
}

/** /attention text: settings, then the inbox newest first. */
export function inboxText(inbox: readonly AttentionEvent[], cfg: Config): string {
  const unseen = inbox.filter(ev => !ev.seen).length
  const head =
    `attention ${cfg.enabled ? 'on' : 'off'} · native ${cfg.native ? 'on' : 'off'} · sound ${cfg.sound ? 'on' : 'off'}` +
    ` · band ${cfg.band ? 'on' : 'off'} · long turn ${fmtDuration(cfg.longTurnMs)} · subagent ${fmtDuration(cfg.subagentMs)}` +
    ` · signal ${cfg.permissionSignal}` +
    (cfg.permissionSignal === 'grace' ? ` · grace ${fmtDuration(cfg.permissionGraceMs)}` : '') +
    ` · subagent asks ${cfg.includeSubagents ? 'on' : 'off'}` +
    (cfg.quietAfterPromptMs > 0 ? ` · quiet ${fmtDuration(cfg.quietAfterPromptMs)} after a prompt` : '')
  if (inbox.length === 0) return `${head}\nInbox empty.`
  return [`${head}`, `Inbox: ${inbox.length} events, ${unseen} unseen (newest first)`, ...inbox.map(rowText)].join('\n')
}
