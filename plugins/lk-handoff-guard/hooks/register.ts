// handoff-guard: never lose a session to the context limit.
//
// session.start        loads config, reads context fill, registers /handoff; seeds a session
//                      that missed the clear signal (resume-before-load race, from session-saver)
// classic.SessionStart after /clear: reloads config ($.state was reset) and submits the one-line
//                      resume prompt queued in $.store by the handoff that cleared
// turn.step            before each main-loop request: measures fill (plus tool output not yet
//                      measured) so a long tool-heavy turn is caught mid-turn; past handoffAt it
//                      asks (ask) or hands off (auto) and ends the turn
// turn.complete        after each main-loop turn: measures, warns once at warnAt, asks or hands off
// tool.call            records edited files; in auto mode past denyAt refuses new calls
// session.compact      writes the handoff first when none was written since the last clear, then
//                      lets compaction proceed (never blocks it)
// command.run          /handoff and its subcommands
// ui.render            the one-line band (stacks other mods' band under it) and the pane
//
// State that must survive /clear (the queued resume prompt, the last brief, settings) lives in
// $.store; $.state is reset by /clear, which is exactly the per-session state we want reset.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { BriefInfo, Config, Reading } from '../types'
import {
  DEFAULTS,
  EDIT_TOOLS,
  FILE_HEADERS,
  HELP,
  MODES,
  appendLine,
  bandParts,
  briefMarkdown,
  buildSections,
  clip,
  completePrompt,
  datedLine,
  dateOf,
  extractFromMessages,
  factsBlock,
  forkPrompt,
  isMeta,
  levelOf,
  markUnverifiedFigures,
  mergeConfig,
  parseBrief,
  parseFraction,
  pct,
  projectTemplate,
  readingOf,
  renderTranscript,
  replaceSection,
  sanitize,
  setFrontmatter,
  slugOf,
  upsertLogLine,
  whenOf,
  wordsFor,
} from './logic'
import { LEVEL_TONE } from './logic'
import type { Facts, Msg, Parsed, Sections } from './logic'
import { TONES, makeKit, tokensShort } from './kit'
import type { Elements, Tone } from './kit'

type Api = EngineInterface

const PANE = 'handoff-guard'
const SETTINGS_KEY = 'settings'
const CONFIG_FILE = '.claude/handoff-guard.json'
const BRAIN_DIR = '.claude/brain'
const PENDING_TTL_MS = 15 * 60_000
const RACE_TTL_MS = 2 * 60_000
const CHARS_PER_TOKEN = 4
const CLEAR_DELAY_MS = 250
const ASK_NOW = 'Handoff now'
const ASK_OFF = 'Off this session'

const configAtom = atom({ plugin: 'lk-handoff-guard', key: 'config' } as const, DEFAULTS)
const readingAtom = atom({ plugin: 'lk-handoff-guard', key: 'reading' } as const, null as Reading | null)
const historyAtom = atom({ plugin: 'lk-handoff-guard', key: 'history' } as const, [] as Reading[])
const warnedAtom = atom({ plugin: 'lk-handoff-guard', key: 'warned' } as const, false)
const nextAskAtom = atom({ plugin: 'lk-handoff-guard', key: 'nextAskAt' } as const, 0)
const askedOutAtom = atom({ plugin: 'lk-handoff-guard', key: 'askedOut' } as const, false)
const sessionOffAtom = atom({ plugin: 'lk-handoff-guard', key: 'sessionOff' } as const, false)
const autoTriedAtom = atom({ plugin: 'lk-handoff-guard', key: 'autoTried' } as const, false)
const writtenAtom = atom({ plugin: 'lk-handoff-guard', key: 'written' } as const, false)
const clearingAtom = atom({ plugin: 'lk-handoff-guard', key: 'clearing' } as const, false)
const busyAtom = atom({ plugin: 'lk-handoff-guard', key: 'busy' } as const, false)
const editedSessionAtom = atom({ plugin: 'lk-handoff-guard', key: 'editedSession' } as const, [] as string[])
const editedTurnAtom = atom({ plugin: 'lk-handoff-guard', key: 'editedTurn' } as const, [] as string[])
const lastBriefAtom = atom({ plugin: 'lk-handoff-guard', key: 'lastBrief' } as const, null as BriefInfo | null)
const resumedAtom = atom({ plugin: 'lk-handoff-guard', key: 'resumed' } as const, '')
const cwdAtom = atom({ plugin: 'lk-handoff-guard', key: 'cwd' } as const, '')

// Module variables: a guard against two handoffs at once, and tool output that has landed
// since the last measured response (borrowed from auto-handoff's "unmeasured").
let inFlight = false
let unmeasured = 0

type Pending = { at: number; when: string; path: string; from: string }

// ---------------------------------------------------------------- small helpers

const capPreview = (text: string) => (text.length > 6000 ? text.slice(0, 6000) + '\n…' : text)

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

function toast($: Api, text: string): void {
  try {
    $.ui.toast(text)
  } catch {
    // Display only.
  }
}

async function now($: Api): Promise<number> {
  try {
    const t = await $.clock.now()
    return typeof t === 'number' && Number.isFinite(t) ? t : Date.now()
  } catch {
    return Date.now()
  }
}

async function cwdOf($: Api): Promise<string> {
  const held = await read($, cwdAtom)
  if (held) return held
  try {
    const c = await $.session.cwd()
    if (typeof c === 'string' && c) {
      await update($, cwdAtom, () => c)
      return c
    }
  } catch {
    // Fall through.
  }
  return ''
}

async function sessionId($: Api): Promise<string> {
  try {
    return String((await $.session.id()) ?? '')
  } catch {
    return ''
  }
}

const join = (dir: string, rel: string) => (dir ? dir.replace(/\/+$/, '') + '/' + rel : rel)

async function readText($: Api, path: string): Promise<string | null> {
  try {
    if (!(await $.fs.exists(path))) return null
    const t = await $.fs.read(path)
    return typeof t === 'string' ? t : null
  } catch {
    return null
  }
}

async function readJson($: Api, path: string): Promise<unknown> {
  const t = await readText($, path)
  if (t === null) return null
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

async function storeGet($: Api, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- config

async function loadConfig($: Api): Promise<Config> {
  let home = ''
  try {
    home = (await $.env.get('HOME')) ?? ''
  } catch {
    home = ''
  }
  const cwd = await cwdOf($)
  const user = home ? await readJson($, join(home, CONFIG_FILE)) : null
  const project = cwd ? await readJson($, join(cwd, CONFIG_FILE)) : null
  const saved = await storeGet($, SETTINGS_KEY)
  const cfg = mergeConfig(user, project, saved)
  await update($, configAtom, () => cfg)
  return cfg
}

async function saveSetting($: Api, patch: Partial<Config>): Promise<Config> {
  const saved = sanitize(await storeGet($, SETTINGS_KEY))
  await $.store.set(SETTINGS_KEY, { ...saved, ...patch })
  return loadConfig($)
}

/** The last brief for this project, from $.store, so /handoff status and the pane survive /clear. */
async function loadLast($: Api): Promise<void> {
  const cwd = await cwdOf($)
  const v = (await storeGet($, 'last:' + cwd)) as BriefInfo | undefined
  if (v && typeof v === 'object' && typeof v.path === 'string' && typeof v.when === 'string') {
    await update($, lastBriefAtom, () => v)
  }
}

// ---------------------------------------------------------------- measurement

async function measure($: Api, where: string, extraTokens = 0): Promise<Reading | null> {
  try {
    const u = await $.session.usage()
    const r = readingOf(u && (u as { context?: unknown }).context, await now($), where, extraTokens)
    if (!r) return null
    await update($, readingAtom, () => r)
    await update($, historyAtom, (h: Reading[]) => [...h, r].slice(-30))
    return r
  } catch {
    return null
  }
}

/** Warns once at warnAt; past handoffAt asks, hands off or does nothing by mode. 'stop' ends the turn. */
async function evaluate($: Api, r: Reading, where: 'start' | 'step' | 'complete'): Promise<'stop' | 'none'> {
  const cfg = await read($, configAtom)
  const level = levelOf(r.frac, cfg)
  if (level !== 'ok' && !(await read($, warnedAtom))) {
    await update($, warnedAtom, () => true)
    toast($, `context ${pct(r.frac)}%: run /handoff when you reach a stopping point`)
  }
  if (where === 'start' || level !== 'due') return 'none'
  if (cfg.mode === 'off' || (await read($, sessionOffAtom))) return 'none'
  if (inFlight || (await read($, clearingAtom))) return 'none'

  if (cfg.mode === 'auto') {
    if (await read($, autoTriedAtom)) return 'none'
    await update($, autoTriedAtom, () => true)
    const info = await doHandoff($, true)
    return info ? 'stop' : 'none'
  }

  // ask
  if (await read($, askedOutAtom)) return 'none'
  const nextAsk = await read($, nextAskAtom)
  const threshold = nextAsk > 0 ? nextAsk : cfg.handoffAt
  if (r.frac < threshold) return 'none'
  const first = threshold < cfg.reaskAt
  const later = first ? `Later (ask at ${pct(cfg.reaskAt)}%)` : 'Later'
  let answer = later
  try {
    answer = await $.ui.ask(`Context at ${pct(r.frac)}%. Write the handoff and clear now?`, {
      options: [ASK_NOW, later, ASK_OFF],
      header: 'Handoff',
    })
  } catch {
    // Dismissed, or nobody to ask (-p): treat as Later.
    answer = later
  }
  if (answer === ASK_NOW) {
    const info = await doHandoff($, true)
    return info ? 'stop' : 'none'
  }
  if (answer === ASK_OFF) {
    await update($, sessionOffAtom, () => true)
    toast($, 'handoff-guard: off for this session. /handoff still writes one.')
    return 'none'
  }
  if (first) await update($, nextAskAtom, () => cfg.reaskAt)
  else await update($, askedOutAtom, () => true)
  return 'none'
}

// ---------------------------------------------------------------- the handoff

async function git($: Api, cwd: string, argv: string[]): Promise<string> {
  try {
    const r = await $.process.run(['git', ...argv], { cwd: cwd || undefined, timeoutMs: 5000 })
    return r && r.exitCode === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : ''
  } catch {
    return ''
  }
}

async function loopkeeperStage($: Api): Promise<string> {
  try {
    // The loopkeeper core's stage, not in this contract: typed loosely and read only when present.
    const got = (await $.state.get({ plugin: 'loopkeeper', key: 'stageCurrent' } as never)) as { value?: unknown } | undefined
    return got && typeof got.value === 'string' ? got.value : ''
  } catch {
    return ''
  }
}

async function messagesOf($: Api): Promise<Msg[]> {
  try {
    const m = await $.session.messages()
    return Array.isArray(m) ? (m as unknown as Msg[]) : []
  } catch {
    return []
  }
}

async function collectFacts($: Api, messages: Msg[]): Promise<Facts> {
  const cwd = await cwdOf($)
  const branch = await git($, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const log = await git($, cwd, ['log', '-5', '--pretty=format:%h %s'])
  const x = extractFromMessages(messages)
  const seen = await read($, editedSessionAtom)
  const editedSession = [...new Set([...x.edited, ...seen])]
  const r = await read($, readingAtom)
  return {
    cwd,
    when: whenOf(await now($)),
    branch,
    commits: log ? log.split('\n').map(l => clip(l, 120)).filter(Boolean).slice(0, 5) : [],
    editedTurn: await read($, editedTurnAtom),
    editedSession,
    lastPrompt: x.lastPrompt,
    lastAnswer: x.lastAnswer,
    openQuestions: x.openQuestions,
    stage: await loopkeeperStage($),
    ctxPercent: r ? pct(r.frac) : null,
    ctxTokens: r ? r.tokens : null,
    ctxWindow: r ? r.window : null,
  }
}

/** Fork first (shares the session's prompt cache), then complete; null when neither gives all headings. */
async function draft($: Api, cfg: Config, facts: string, messages: Msg[]): Promise<{ parsed: Parsed | null; source: string; flagged: string[] }> {
  const words = wordsFor(cfg.maxBriefTokens)
  const tryText = (text: unknown, source: string) => {
    if (typeof text !== 'string' || !parseBrief(text)) return null
    const checked = markUnverifiedFigures(text, facts)
    const parsed = parseBrief(checked.text)
    return parsed ? { parsed, source, flagged: checked.flagged } : null
  }
  try {
    const r = await $.model.fork({ prompt: forkPrompt(facts, words) })
    const got = r && r.isAnswered ? tryText(r.text, 'fork') : null
    if (got) return got
  } catch {
    // Fall back to complete.
  }
  try {
    const r = await $.model.complete({
      model: cfg.model,
      system: 'You write short, precise handoff notes for coding sessions.',
      prompt: completePrompt(facts, renderTranscript(messages), words),
      maxTokens: cfg.maxBriefTokens,
      timeoutMs: 60_000,
    })
    const got = r && r.isAnswered ? tryText(r.text, 'complete') : null
    if (got) return got
  } catch {
    // Facts only.
  }
  return { parsed: null, source: 'facts', flagged: [] }
}

/** Writes project.md sections, a log line, decisions and questions in the handoff folder's shapes. */
async function writeBrain($: Api, cwd: string, s: Sections, at: number, sid: string): Promise<string> {
  const dir = join(cwd, BRAIN_DIR)
  const date = dateOf(at)
  const projectPath = join(dir, 'project.md')
  let project = (await readText($, projectPath)) ?? projectTemplate(slugOf(cwd), date)
  project = replaceSection(project, 'Status today', s.status)
  project = replaceSection(project, 'Next', s.next)
  if (s.deadEnds) project = replaceSection(project, 'Dead ends', s.deadEnds)
  project = setFrontmatter(project, 'updated', date)
  await $.fs.write(projectPath, project)

  const logPath = join(dir, 'log.md')
  const logLine = datedLine(date, s.log)
  const prevKey = 'logline:' + cwd
  const prev = (await storeGet($, prevKey)) as { sid?: string; line?: string } | undefined
  const previous = prev && prev.sid === sid && typeof prev.line === 'string' ? prev.line : undefined
  const logDoc = (await readText($, logPath)) ?? FILE_HEADERS['log.md']
  await $.fs.write(logPath, upsertLogLine(logDoc, logLine, previous))
  try {
    await $.store.set(prevKey, { sid, line: logLine })
  } catch {
    // The next handoff appends instead of replacing.
  }

  for (const [file, items] of [
    ['decisions.md', s.decisions],
    ['questions.md', s.questions],
  ] as const) {
    if (!items.length) continue
    const path = join(dir, file)
    let doc = (await readText($, path)) ?? FILE_HEADERS[file]
    for (const item of items) doc = appendLine(doc, datedLine(date, item)).doc
    await $.fs.write(path, doc)
  }
  return projectPath
}

/** The whole handoff. With clear, queues the resume prompt in $.store and then /clear. */
async function doHandoff($: Api, clear: boolean): Promise<BriefInfo | null> {
  if (inFlight) return null
  inFlight = true
  await update($, busyAtom, () => true)
  try {
    const cfg = await read($, configAtom)
    const cwd = await cwdOf($)
    const sid = await sessionId($)
    const messages = await messagesOf($)
    const facts = await collectFacts($, messages)
    const factsText = factsBlock(facts)
    const { parsed, source, flagged } = await draft($, cfg, factsText, messages)
    const sections = buildSections(parsed, facts)
    const at = await now($)
    const path = await writeBrain($, cwd, sections, at, sid)
    const info: BriefInfo = {
      at,
      when: whenOf(at),
      path,
      sessionId: sid,
      source,
      flagged,
      preview: capPreview(briefMarkdown(sections, factsText)),
    }
    await update($, lastBriefAtom, () => info)
    await update($, writtenAtom, () => true)
    try {
      await $.store.set('last:' + cwd, info)
    } catch {
      // Status after /clear falls back to nothing.
    }
    const shown = path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path
    toast($, `Handoff written: ${shown}${source === 'facts' ? ' (facts only)' : ''}${flagged.length ? ` · ${flagged.length} unverified figure(s)` : ''}`)
    if (clear) {
      const pending: Pending = { at, when: info.when, path, from: sid }
      await $.store.set('pending:' + cwd, pending)
      await update($, clearingAtom, () => true)
      // From a timer, outside any event: a command.run hook may not run a command, and a
      // turn.step hook holds the turn. Not awaited: /clear runs once the session is idle.
      $.clock.after(CLEAR_DELAY_MS, () => runClear($, cwd, shown))
    }
    return info
  } catch (err) {
    toast($, 'handoff-guard: the handoff failed: ' + errText(err))
    return null
  } finally {
    inFlight = false
    try {
      await update($, busyAtom, () => false)
    } catch {
      // Display only.
    }
  }
}

function runClear($: Api, cwd: string, shown: string): void {
  $.command.run({ command: 'clear' }).catch(async (err: unknown) => {
    toast($, `handoff-guard: /clear was refused (${errText(err)}); the handoff is at ${shown}`)
    try {
      await $.store.delete('pending:' + cwd)
      await update($, clearingAtom, () => false)
    } catch {
      // Nothing else to undo.
    }
  })
}

/** After /clear: submit the one-line resume prompt the handoff queued, once. */
async function consumePending($: Api, maxAgeMs: number): Promise<boolean> {
  const cwd = await cwdOf($)
  const key = 'pending:' + cwd
  const p = (await storeGet($, key)) as Pending | undefined
  if (!p || typeof p !== 'object' || typeof p.when !== 'string' || typeof p.at !== 'number') return false
  try {
    await $.store.delete(key)
  } catch {
    return false // Never risk submitting twice.
  }
  if ((await now($)) - p.at > maxAgeMs) return false
  await update($, resumedAtom, () => p.when)
  const text = `Resume from the handoff in .claude/brain/project.md (written ${p.when}); read it first.`
  // Not awaited: it resolves when the new turn starts.
  $.prompt.submit({ text }).catch(() => {
    toast($, `handoff-guard: could not start the resume turn; read .claude/brain/project.md (written ${p.when})`)
  })
  return true
}

/** Resets per-session state and reloads what a fresh session needs (after start or /clear). */
async function onStart($: Api, cwd: string): Promise<void> {
  if (cwd) await update($, cwdAtom, () => cwd)
  unmeasured = 0
  await loadConfig($)
  await loadLast($)
  const r = await measure($, 'start')
  if (r) await evaluate($, r, 'start')
}

// ---------------------------------------------------------------- pane helpers (pure)

/** The quiet color of the kit (secondary text), a theme key. */
const QUIET = TONES.muted.fg

/** The pane's hero line: the handoff state, in the words the band uses. */
function heroTitle(r: Reading | null, cfg: Config, o: { busy: boolean; sessionOff: boolean }): string {
  if (o.busy) return 'Writing the handoff…'
  if (!r) return 'Context: no reading yet'
  const ctx = `Context ${pct(r.frac)}%`
  const level = levelOf(r.frac, cfg)
  if (level === 'due') {
    if (cfg.mode === 'off' || o.sessionOff) return `${ctx} · handoff due · guard off`
    return cfg.mode === 'auto' ? `${ctx} · handoff due · auto handoff` : `${ctx} · handoff due: /handoff clear`
  }
  if (level === 'warn') return `${ctx} · /handoff at a stopping point`
  return `${ctx} · next handoff at ${pct(cfg.handoffAt)}%`
}

// ---------------------------------------------------------------- /handoff

async function statusText($: Api): Promise<string> {
  const cfg = await read($, configAtom)
  const r = await read($, readingAtom)
  const last = await read($, lastBriefAtom)
  const off = await read($, sessionOffAtom)
  const ctx = r
    ? `Context ${pct(r.frac)}%` + (r.tokens !== null && r.window !== null ? ` (${r.tokens} of ${r.window} tokens)` : '')
    : 'Context: no reading yet'
  const lines = [
    `${ctx} · warn ${pct(cfg.warnAt)}% · handoff ${pct(cfg.handoffAt)}% · mode ${cfg.mode}${off ? ' (off this session)' : ''}`,
    last ? `Last handoff: ${last.when} (${last.source}) at ${last.path}` : 'Last handoff: none for this project yet',
  ]
  return lines.join('\n')
}

async function runCommand($: Api, args: string): Promise<{ text?: string }> {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const sub = (words[0] ?? '').toLowerCase()
  const arg = words.slice(1).join(' ').toLowerCase()
  if (sub === '' || sub === 'now' || sub === 'write') {
    const info = await doHandoff($, false)
    return { text: info ? `Handoff written to ${info.path} (${info.source}).` : 'handoff-guard: no handoff written (one is already running, or it failed).' }
  }
  if (sub === 'clear') {
    const info = await doHandoff($, true)
    return {
      text: info
        ? `Handoff written to ${info.path} (${info.source}). Clearing; the next session resumes from it.`
        : 'handoff-guard: no handoff written, so nothing was cleared.',
    }
  }
  if (sub === 'status') return { text: await statusText($) }
  if (sub === 'show' || sub === 'pane') {
    await $.ui.open({ id: PANE, title: 'Handoff guard', focus: true, closeOnEscape: true })
    return {}
  }
  if (sub === 'mode') {
    if (!(MODES as readonly string[]).includes(arg)) return { text: 'Mode must be ask, auto or off.' }
    const cfg = await saveSetting($, { mode: arg as Config['mode'] })
    if (arg !== 'off') await update($, sessionOffAtom, () => false)
    return { text: cfg.mode === arg ? `Mode set to ${arg}.` : `Mode saved as ${arg}, but a config file overrides it: ${cfg.mode}.` }
  }
  if (sub === 'at' || sub === 'warn') {
    const f = parseFraction(arg)
    if (f === null) return { text: 'Give a fraction between 0 and 1, such as 0.85.' }
    const cfg = await saveSetting($, sub === 'at' ? { handoffAt: f } : { warnAt: f })
    if (sub === 'at') {
      await update($, nextAskAtom, () => 0)
      await update($, askedOutAtom, () => false)
      await update($, autoTriedAtom, () => false)
    } else {
      await update($, warnedAtom, () => false)
    }
    return { text: `Warning at ${pct(cfg.warnAt)}%, handoff at ${pct(cfg.handoffAt)}%.` }
  }
  if (sub === 'band') {
    if (arg !== 'on' && arg !== 'off') return { text: 'Use /handoff band on or /handoff band off.' }
    const cfg = await saveSetting($, { band: arg === 'on' })
    return { text: cfg.band ? 'Band shown above the prompt.' : 'Band hidden.' }
  }
  return { text: HELP }
}

// ---------------------------------------------------------------- hooks

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    try {
      await onStart($, typeof e.cwd === 'string' ? e.cwd : '')
    } catch {
      // Defaults stay in place.
    }
    // The clear signal can fire before this module loads (a reload at the wrong moment): a
    // fresh queued resume and an empty transcript count too (session-saver's race guard).
    try {
      if ((await messagesOf($)).length === 0) await consumePending($, RACE_TTL_MS)
    } catch {
      // The pending entry stays for classic.SessionStart.
    }
    try {
      await $.command.register({
        name: 'handoff',
        description: 'Write the brain handoff now; or clear, status, show, mode, at, warn, band',
        argumentHint: '[clear | status | show | mode ask|auto|off | at <0-1> | warn <0-1> | band on|off]',
        immediate: true,
      })
    } catch {
      // The name is taken: measuring and the band still work.
    }
    return next(e)
  })

  // /clear (and /resume, /branch) reset $.state without a session.start.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    const source = typeof e.source === 'string' ? e.source : ''
    if (source === 'clear' || source === 'resume' || source === 'compact') {
      try {
        await onStart($, typeof e.cwd === 'string' ? e.cwd : '')
      } catch {
        // Defaults stay in place.
      }
    }
    if (source === 'clear') {
      try {
        await consumePending($, PENDING_TTL_MS)
      } catch {
        // Nothing queued.
      }
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      const kind = e.origin && typeof e.origin === 'object' ? (e.origin as { kind?: string; asUser?: boolean }) : undefined
      const typed = !kind || ['composer', 'bridge', 'sdk'].includes(String(kind.kind)) || kind.asUser === true
      if (typed && typeof e.text === 'string' && !isMeta(e.text) && (await read($, resumedAtom))) {
        await update($, resumedAtom, () => '')
      }
    } catch {
      // Display only.
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    try {
      if (!e.agentId) await update($, editedTurnAtom, () => [])
    } catch {
      // Observing only.
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      let stop = false
      try {
        const r = await measure($, 'step', Math.ceil(unmeasured))
        // Index 0 follows a turn.complete reading; act on the requests after tool calls.
        if (r && typeof e.index === 'number' && e.index > 0) stop = (await evaluate($, r, 'step')) === 'stop'
      } catch {
        stop = false
      }
      if (stop) {
        unmeasured = 0
        yield { kind: 'text', index: 0, text: '[handoff-guard] Context is nearly full: the handoff is written to .claude/brain/ and this session is clearing.' } as never
        yield { kind: 'stop', stopReason: 'end_turn', usage: null } as never
        return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
      }
    }
    const result = yield* next(e)
    if (!e.agentId) unmeasured = 0
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      try {
        unmeasured = 0
        const r = await measure($, 'complete')
        if (r) await evaluate($, r, 'complete')
      } catch {
        // Observing only.
      }
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    let deny: string | null = null
    try {
      const tool = typeof e.tool === 'string' ? e.tool : ''
      const exempt = tool === 'AskUserQuestion' || tool.startsWith('mcp__handoff-guard__') || (typeof e.consent === 'string' && e.consent !== '')
      if (!exempt) {
        const cfg = await read($, configAtom)
        // Only auto mode refuses, so only auto mode pays for a fresh reading here.
        const r = cfg.mode === 'auto' && !e.agentId ? ((await measure($, 'tool', Math.ceil(unmeasured))) ?? (await read($, readingAtom))) : null
        if (r && !(await read($, sessionOffAtom)) && r.frac >= cfg.denyAt) {
          deny = `[handoff-guard] Not run: the context is at ${pct(r.frac)}%, past ${pct(cfg.denyAt)}%. The handoff to .claude/brain/ is being written and this session will clear; the next session redoes this call. Make no more tool calls: end with one line saying where you stopped.`
        }
      }
    } catch {
      deny = null
    }
    if (deny) return { deny }
    const result = await next(e)
    try {
      const tool = typeof e.tool === 'string' ? e.tool : ''
      const ok = result && typeof result === 'object' && !('deny' in result && result.deny) && !(result as { isError?: boolean }).isError
      const path = (e as { file_path?: unknown; notebook_path?: unknown }).file_path ?? (e as { notebook_path?: unknown }).notebook_path
      if (ok && EDIT_TOOLS.has(tool) && typeof path === 'string') {
        await update($, editedSessionAtom, (xs: string[]) => [...xs.filter(x => x !== path), path].slice(-50))
        await update($, editedTurnAtom, (xs: string[]) => [...xs.filter(x => x !== path), path].slice(-50))
      }
      if (!e.agentId && result && typeof result === 'object') {
        const t = (result as { text?: unknown }).text ?? (result as { result?: unknown }).result
        if (typeof t === 'string') unmeasured += t.length / CHARS_PER_TOKEN
      }
    } catch {
      // Observing only.
    }
    return result
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId || e.trigger === 'precompute') return next(e)
    try {
      const cfg = await read($, configAtom)
      if (cfg.mode !== 'off' && !(await read($, sessionOffAtom)) && !(await read($, writtenAtom)) && !inFlight) {
        await doHandoff($, false)
      }
    } catch {
      // Never block compaction.
    }
    const result = await next(e)
    try {
      if (result && typeof result === 'object' && !('skip' in result)) {
        // Compaction is a fresh start for the context: the next one writes again.
        await update($, writtenAtom, () => false)
        await measure($, 'compact')
      }
    } catch {
      // Observing only.
    }
    return result
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    try {
      return await runCommand($, typeof e.args === 'string' ? e.args : '')
    } catch (err) {
      return { text: 'handoff-guard: ' + errText(err) }
    }
  })

  // The band, one kit line: a bold label, the context chip in the level's tone (ok, accent, danger;
  // muted before the first reading), then what to do and the last handoff on the right side: quiet,
  // or in the default text color once the handoff is due (kit.line draws its right side quiet).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const props = (e.props ?? {}) as { hasSurvey?: boolean }
    const cfg = await read($, configAtom)
    if (props.hasSurvey === true || !cfg.band) return next(e)
    const r = await read($, readingAtom)
    const last = await read($, lastBriefAtom)
    const parts = bandParts(r, cfg, {
      lastWhen: last ? last.when : undefined,
      busy: await read($, busyAtom),
      sessionOff: await read($, sessionOffAtom),
      resumed: (await read($, resumedAtom)) || undefined,
    })
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const kit = makeKit(ui as unknown as Elements, e.surface)
    const chips = [{ text: parts.chip, tone: parts.tone }]
    const right = parts.right.join(' · ')
    const drawn = (
      parts.urgent && right
        ? Box({
            flexDirection: 'row',
            justifyContent: 'space-between',
            columnGap: 2,
            children: [kit.line('handoff', chips) as ReturnType<typeof Box>, kit.text(right, { wrap: 'truncate' }) as ReturnType<typeof Box>],
          })
        : kit.line('handoff', chips, parts.right)
    ) as ReturnType<typeof Box>
    const line = Box({ key: 'handoff-guard-band', flexDirection: 'column', children: [drawn] })
    const theirs = await next(e)
    if (!theirs) return line
    return Box({ flexDirection: 'column', children: [line, theirs] })
  })

  // The pane, drawn with the kit: a hero for the handoff state, tiles, the readings, the last brief, buttons.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const cfg = await read($, configAtom)
    const r = await read($, readingAtom)
    const history = await read($, historyAtom)
    const last = await read($, lastBriefAtom)
    const busy = await read($, busyAtom)
    const off = await read($, sessionOffAtom)
    const ui = $.ui.resolve(e)
    const kit = makeKit(ui as unknown as Elements, e.surface)
    const level = r ? levelOf(r.frac, cfg) : 'ok'
    const tone: Tone = r ? LEVEL_TONE[level] : 'muted'

    const hero = kit.hero({
      kicker: 'handoff guard',
      title: heroTitle(r, cfg, { busy, sessionOff: off }),
      sub: [
        r && r.tokens !== null && r.window !== null ? `${tokensShort(r.tokens)} of ${tokensShort(r.window)} tokens` : '',
        `mode ${cfg.mode}${off ? ' (off this session)' : ''}`,
        last ? `last handoff ${last.when}` : 'no handoff yet',
      ]
        .filter(Boolean)
        .join(' · '),
      tone: busy ? 'info' : tone,
    })

    const tiles = kit.tiles([
      { label: 'Context', value: r ? `${pct(r.frac)}%` : '--', tone },
      { label: 'Warn at', value: `${pct(cfg.warnAt)}%`, tone: LEVEL_TONE.warn },
      { label: 'Handoff at', value: `${pct(cfg.handoffAt)}%`, tone: 'danger' },
      { label: 'Mode', value: off ? `${cfg.mode} (off)` : cfg.mode, tone: cfg.mode === 'off' || off ? 'muted' : cfg.mode === 'auto' ? 'accent' : 'info' },
    ])

    const shown = history.slice(-10)
    const readings: unknown[] = shown.length
      ? shown.map((h, i) => {
          const lv = levelOf(h.frac, cfg)
          return kit.row({
            key: `reading-${i}`,
            left: [kit.pill(lv.padEnd(4), LEVEL_TONE[lv]), whenOf(h.at).slice(11), kit.text(h.where.padEnd(8), { color: QUIET })],
            right: [kit.bar(Math.min(1, h.frac), { width: 20, tone: LEVEL_TONE[lv] })],
          })
        })
      : [kit.text('none yet', { color: QUIET })]

    const brief: unknown[] = last
      ? [
          kit.row({
            left: [
              kit.pill(last.source, last.source === 'facts' ? 'accent' : 'ok'),
              kit.text(last.path, { color: QUIET, wrap: 'truncate-start' }),
            ],
          }),
          last.flagged.length ? kit.row({ left: [kit.pill('unverified', 'accent'), last.flagged.join(', ')] }) : null,
          ui.Markdown({ text: last.preview.split('\n').slice(0, 60).join('\n') }),
        ]
      : [kit.text('No handoff written for this project yet. /handoff writes one.', { color: QUIET })]

    return kit.page([
      hero,
      tiles,
      // A full-width Svg bar where the surface draws Svg, the 40-column text bar on the terminal.
      r ? kit.progress(Math.min(1, r.frac), kit.surface === 'terminal' ? { width: 40, tone } : { tone }) : null,
      kit.stack([kit.header(`Readings · ${history.length}`, history.length > shown.length ? `last ${shown.length}` : undefined), ...readings]),
      kit.stack([kit.header('Last handoff', last ? last.when : 'none yet'), ...brief]),
      kit.buttons([
        { key: 'write', label: 'Write handoff', hotkey: 'w', plain: true, onPress: () => doHandoff($, false) },
        { key: 'close', label: 'Close', hotkey: 'c', plain: true, onPress: () => $.ui.close({ id: PANE }) },
      ]),
    ]) as never
  })
}
