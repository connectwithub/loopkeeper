// Decisions concern: capture decisions into the project's own decision log from inside the session,
// browse the recent ones, and (when switched on) watch turns for decisions worth keeping.
//
// - session.start: finds the log (config override, known files, ADR dir, default), registers /decide,
//   /decisions and the record_decision tool
// - /decide and record_decision append one entry, never rewriting what is there
// - /decisions opens a pane of the last 20; /decisions text prints them
// - the band above the prompt counts this session's decisions, and holds the watch's major decisions
//   with Record and Skip (lib/watch.ts)
// - /decide prefs and /decide watch … steer the watch, which is OFF until a config file or
//   /decide watch on turns it on
// - the end of the /lk chain: /lk status adds the decisions line, anything no earlier concern owns
//   is answered here with one "unknown sub-command" line
// - the hub (/lk) draws a Decisions row (hotkey 6), the last of the hub chain; the pane leads with the
//   nav bar of every loopkeeper pane
//
// The pure parts (log formats, watch parsing, dedupe, the band card) are in lib/; the engine side
// stays in this file because `$` never crosses an import.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { mergeConfigText } from './lib/config.ts'
import {
  ADR_DIR,
  ADR_DIR_LOG,
  CANDIDATES,
  DECIDE_USAGE,
  DECISIONS_USAGE,
  DEFAULT_LOG,
  absOf,
  appendEntry,
  bandText,
  isAdrFile,
  lastEntries,
  parseDecideArgs,
  parseEntries,
  parseOverride,
  stampOf,
  textListing,
  toolInputOf,
  uniqueId,
} from './lib/decisionFormats.ts'
import type { DecisionInput, Entry, Kind, Proposed, Target, WatchConfig } from './lib/decisionFormats.ts'
import { TONES, makeKit } from './lib/kit.ts'
import type { Elements, Tone } from './lib/kit.ts'
import { TOOL, TOOL_FULL, projectConfigPath, subOf, userConfigPath } from './lib/names.ts'
import { HUB_ID, HUB_ROWS, PANES } from './lib/panes.ts'
import {
  KEY_BAND,
  KEY_CALLS,
  KEY_MODEL,
  KEY_WATCH,
  LOG_CONTEXT,
  MAX_KINDS,
  MAX_PENDING,
  MAX_PREFS,
  MAX_SKIPPED,
  WATCH_DEFAULTS,
  WATCH_MAX_TOKENS,
  WATCH_SYSTEM,
  WATCH_TIMEOUT_MS,
  WATCH_USAGE,
  buildWatchPrompt,
  byOfJsonl,
  cut,
  decisionsLayers,
  hasCue,
  isModelId,
  kindOf,
  kindsKey,
  majorCard,
  makePool,
  mergePrefs,
  mergeWatchConfig,
  minorToast,
  normText,
  parseWatchReply,
  prefsKey,
  recentCalls,
  skippedKey,
  strings,
} from './lib/watch.ts'
import type { Proposal } from './lib/watch.ts'

const PANE_ID = 'loopkeeper-decisions'
const LIST_LIMIT = 20
const CONCERN_WORDS = ['stage', 'gates', 'files', 'routing', 'review', 'decisions']

const decisionCount = atom({ plugin: 'loopkeeper', key: 'decisionCount' } as const, 0)
const decisionBand = atom({ plugin: 'loopkeeper', key: 'decisionBand' } as const, true)
const decisionTarget = atom({ plugin: 'loopkeeper', key: 'decisionTarget' } as const, null as Target | null)
const decisionEntries = atom({ plugin: 'loopkeeper', key: 'decisionEntries' } as const, [] as Entry[])
const decisionStats = atom({ plugin: 'loopkeeper', key: 'decisionStats' } as const, { total: 0, today: 0 })
const decisionCwd = atom({ plugin: 'loopkeeper', key: 'decisionCwd' } as const, '')
const decisionWatch = atom({ plugin: 'loopkeeper', key: 'decisionWatch' } as const, WATCH_DEFAULTS as WatchConfig)
const decisionPending = atom({ plugin: 'loopkeeper', key: 'decisionPending' } as const, [] as Proposed[])
const decisionTurnRecorded = atom({ plugin: 'loopkeeper', key: 'decisionTurnRecorded' } as const, [] as string[])
const decisionTurnPrompt = atom({ plugin: 'loopkeeper', key: 'decisionTurnPrompt' } as const, '')
const decisionPrefs = atom({ plugin: 'loopkeeper', key: 'decisionPrefs' } as const, [] as string[])
const decisionKinds = atom({ plugin: 'loopkeeper', key: 'decisionKinds' } as const, [] as [string, Kind][])
const decisionLogged = atom({ plugin: 'loopkeeper', key: 'decisionLogged' } as const, [] as string[])

const BADGE: Record<Kind, { label: string; tone: Tone }> = {
  major: { label: 'major', tone: 'accent' },
  minor: { label: 'minor', tone: 'muted' },
  you: { label: 'you', tone: 'info' },
}

type Recorded = { ok: true; file: string; id: string } | { ok: false; error: string }

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Logs a dim line in the transcript, never throwing. */
function note($: EngineInterface, text: string): void {
  try {
    const r: unknown = $.ui.log(text)
    if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(undefined, () => {})
  } catch {
    // nothing to do
  }
}

/** Shows a toast, never throwing. */
function toast($: EngineInterface, text: string): void {
  try {
    const r: unknown = $.ui.toast(text)
    if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(undefined, () => {})
  } catch {
    // nothing to do
  }
}

async function existsSafe($: EngineInterface, path: string): Promise<boolean> {
  try {
    return (await $.fs.exists(path)) === true
  } catch {
    return false
  }
}

async function textOf($: EngineInterface, path: string): Promise<string | null> {
  try {
    return (await $.fs.exists(path)) ? await $.fs.read(path) : null
  } catch {
    return null
  }
}

async function cwdOf($: EngineInterface): Promise<string> {
  const known = await read($, decisionCwd)
  if (known) return known
  try {
    return String((await $.session.cwd()) ?? '')
  } catch {
    return ''
  }
}

/** The text of both config files. Local on purpose: $ is never passed across an import. */
async function configTexts($: EngineInterface): Promise<{ user: string | null; project: string | null }> {
  let home = ''
  try {
    home = String((await $.env.get('HOME')) ?? '')
  } catch {
    home = ''
  }
  const cwd = await cwdOf($)
  return {
    user: home ? await textOf($, userConfigPath(home)) : null,
    project: cwd ? await textOf($, projectConfigPath(cwd)) : null,
  }
}

async function nowMs($: EngineInterface): Promise<number> {
  try {
    const ms = Number(await $.clock.now())
    if (Number.isFinite(ms) && ms > 0) return ms
  } catch {
    // fall back to the wall clock
  }
  return Date.now()
}

async function sessionIdOf($: EngineInterface): Promise<string> {
  try {
    const id = await $.session.id()
    return typeof id === 'string' && id ? id : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function storeGet($: EngineInterface, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch {
    return undefined
  }
}

/** Saves a value; false when the store refused it. */
async function storeSet($: EngineInterface, key: string, value: unknown): Promise<boolean> {
  try {
    await $.store.set(key, value as never)
    return true
  } catch {
    return false
  }
}

/** Logs a watch problem once per session (per kind), so a failing API does not fill the transcript. */
async function logWatchProblem($: EngineInterface, kind: string, text: string): Promise<void> {
  const seen = await read($, decisionLogged)
  if (seen.includes(kind)) return
  await update($, decisionLogged, list => [...list, kind])
  note($, text)
}

// ---------------------------------------------------------------- the log

/** Copies the saved band setting from $.store into $.state. */
async function loadBand($: EngineInterface): Promise<void> {
  try {
    const saved = await $.store.get(KEY_BAND)
    await update($, decisionBand, () => saved !== false)
  } catch {
    // keep the default: on
  }
}

/** Finds the target log and keeps it in $.state. */
async function detect($: EngineInterface): Promise<Target> {
  let cwd = ''
  try {
    cwd = String((await $.session.cwd()) ?? '')
  } catch {
    cwd = ''
  }
  await update($, decisionCwd, () => cwd)
  let found: Target
  try {
    found = await findTarget($, cwd)
  } catch (err) {
    found = { file: DEFAULT_LOG, abs: absOf(cwd, DEFAULT_LOG), format: 'jsonl', exists: false, source: 'default', note: messageOf(err) }
  }
  await update($, decisionTarget, () => found)
  return found
}

/** The detection order: config override, known logs, an ADR directory, the default. */
async function findTarget($: EngineInterface, cwd: string): Promise<Target> {
  let problem: string | undefined
  const configPath = projectConfigPath(cwd)
  if (await existsSafe($, configPath)) {
    let raw = ''
    try {
      raw = await $.fs.read(configPath)
    } catch (err) {
      problem = `.claude/loopkeeper.json unreadable: ${messageOf(err)}`
    }
    // A config that names no log (other sections, or only watch settings) is not an override
    const parsed = problem ? null : parseOverride(raw)
    if (parsed && 'error' in parsed) {
      problem = parsed.error
    } else if (parsed) {
      const abs = absOf(cwd, parsed.file)
      return { file: parsed.file, abs, format: parsed.format, exists: await existsSafe($, abs), source: 'override' }
    }
  }
  const withNote = (t: Target): Target => (problem ? { ...t, note: problem } : t)
  for (const candidate of CANDIDATES) {
    const abs = absOf(cwd, candidate.file)
    if (await existsSafe($, abs)) return withNote({ ...candidate, abs, exists: true, source: 'found' })
  }
  const dir = absOf(cwd, ADR_DIR)
  if (await existsSafe($, dir)) {
    let names: string[] = []
    try {
      const listed = await $.fs.list(dir)
      names = Array.isArray(listed) ? listed.map(entry => String(entry?.name ?? '')) : []
    } catch {
      names = []
    }
    if (names.some(isAdrFile)) {
      return withNote({ file: ADR_DIR_LOG, abs: absOf(cwd, ADR_DIR_LOG), format: 'jsonl', exists: false, source: 'adr-dir' })
    }
  }
  return withNote({ file: DEFAULT_LOG, abs: absOf(cwd, DEFAULT_LOG), format: 'jsonl', exists: false, source: 'default' })
}

/** The last entries (with who recorded them, when a jsonl log says so) and the counts, into $.state. */
async function keepEntries($: EngineInterface, content: string | null, format: Target['format']): Promise<Entry[]> {
  const by = format === 'jsonl' ? byOfJsonl(content) : new Map<string, 'user' | 'claude'>()
  const list = lastEntries(content, format, LIST_LIMIT).map(entry => {
    const who = by.get(normText(entry.decision))
    return who ? { ...entry, by: who } : entry
  })
  const all = parseEntries(content, format)
  const today = stampOf(await nowMs($)).date
  await update($, decisionEntries, () => list)
  await update($, decisionStats, () => ({ total: all.length, today: all.filter(x => x.date === today).length }))
  return list
}

async function currentTarget($: EngineInterface): Promise<Target> {
  const t = (await read($, decisionTarget)) as Target | null
  return t ?? (await detect($))
}

/** Reads the target and keeps its last entries in $.state. */
async function loadEntries($: EngineInterface): Promise<{ target: Target | null; list: Entry[] }> {
  const t = await currentTarget($)
  let content: string | null = null
  let exists = false
  try {
    exists = await existsSafe($, t.abs)
    if (exists) content = await $.fs.read(t.abs)
  } catch (err) {
    note($, `could not read ${t.file}: ${messageOf(err)}`)
  }
  const now = t.exists === exists ? t : { ...t, exists }
  if (now !== t) await update($, decisionTarget, () => now)
  const list = await keepEntries($, content, t.format)
  return { target: now, list }
}

/** Every entry in the target log, in file order (the watch reads them to leave out what is recorded). */
async function allEntries($: EngineInterface): Promise<Entry[]> {
  const t = await currentTarget($)
  try {
    if (!(await existsSafe($, t.abs))) return []
    return parseEntries(await $.fs.read(t.abs), t.format)
  } catch {
    return []
  }
}

/** Appends one decision to the target: read, then write the old text plus the entry. */
async function record($: EngineInterface, input: DecisionInput, by: 'user' | 'claude'): Promise<Recorded> {
  try {
    const t = await currentTarget($)
    const exists = await existsSafe($, t.abs)
    const existing = exists ? await $.fs.read(t.abs) : null
    if (exists && typeof existing !== 'string') return { ok: false, error: `could not read ${t.file}` }
    const stamp = stampOf(await nowMs($))
    const id = uniqueId(stamp.id, existing)
    const rec = { id, date: stamp.date, ...input, session: await sessionIdOf($), by }
    const content = appendEntry(existing, t.format, rec)
    if (existing !== null && !content.startsWith(existing)) return { ok: false, error: 'refused: the entry would change existing content' }
    await $.fs.write(t.abs, content)
    await update($, decisionCount, n => n + 1)
    const written: Target = { ...t, exists: true }
    await update($, decisionTarget, () => written)
    await keepEntries($, content, t.format)
    return { ok: true, file: t.file, id }
  } catch (err) {
    return { ok: false, error: messageOf(err) }
  }
}

// ---------------------------------------------------------------- the decision watch

/**
 * The watch settings: defaults (off), the user file, the project file, then what /decide watch saved
 * in the store. A bad value in any layer is ignored. Config problems in the decisions section are
 * logged once per session.
 */
async function loadWatchConfig($: EngineInterface): Promise<WatchConfig> {
  const texts = await configTexts($)
  const saved = { watch: await storeGet($, KEY_WATCH), watchModel: await storeGet($, KEY_MODEL) }
  const cfg = mergeWatchConfig([...decisionsLayers(texts.user, texts.project), saved])
  await update($, decisionWatch, () => cfg)
  try {
    const problems = mergeConfigText(texts.user, texts.project).problems.filter(p => /^(?:user|project) decisions[ .:]/.test(p))
    if (problems.length) await logWatchProblem($, 'config', 'loopkeeper: ' + problems.slice(0, 3).join('; '))
  } catch {
    // the settings above stand
  }
  return cfg
}

async function loadPrefs($: EngineInterface): Promise<string[]> {
  const cwd = await cwdOf($)
  const list = strings(await storeGet($, prefsKey(cwd))).slice(-MAX_PREFS)
  await update($, decisionPrefs, () => list)
  return list
}

async function loadKinds($: EngineInterface): Promise<void> {
  const cwd = await cwdOf($)
  const saved = await storeGet($, kindsKey(cwd))
  const list: [string, Kind][] = Array.isArray(saved)
    ? saved.filter(
        (p): p is [string, Kind] =>
          Array.isArray(p) && typeof p[0] === 'string' && (p[1] === 'major' || p[1] === 'minor' || p[1] === 'you'),
      )
    : []
  await update($, decisionKinds, () => list.slice(-MAX_KINDS))
}

/** Loads the config, the preferences and the badges into $.state (session start, /clear, Refresh). */
async function loadWatch($: EngineInterface): Promise<void> {
  await loadWatchConfig($)
  await loadPrefs($)
  await loadKinds($)
}

async function markKind($: EngineInterface, text: string, kind: Kind): Promise<void> {
  const n = normText(text)
  if (!n) return
  const cwd = await cwdOf($)
  const list = [...(await read($, decisionKinds)).filter(p => p[0] !== n), [n, kind] as [string, Kind]].slice(-MAX_KINDS)
  await update($, decisionKinds, () => list)
  await storeSet($, kindsKey(cwd), list)
}

/** Notes a decision just recorded: its badge, and this turn's list unless the user typed it. */
async function noteRecorded($: EngineInterface, text: string, kind: Kind): Promise<void> {
  if (kind !== 'you') await update($, decisionTurnRecorded, list => [...list, text])
  await markKind($, text, kind)
}

/** Turns the watch on or off and remembers it; off also drops the waiting majors. False when not saved. */
async function setWatch($: EngineInterface, isOn: boolean): Promise<boolean> {
  const saved = await storeSet($, KEY_WATCH, isOn)
  await update($, decisionWatch, c => ({ ...c, watch: isOn }))
  if (!isOn) await update($, decisionPending, () => [])
  return saved
}

/** turn.start: a new turn has recorded nothing yet. */
async function startTurn($: EngineInterface, prompt: unknown): Promise<void> {
  await update($, decisionTurnRecorded, () => [])
  await update($, decisionTurnPrompt, () => (typeof prompt === 'string' ? prompt : ''))
}

/** The last user message with text, and the last assistant text after it. */
async function turnTexts($: EngineInterface, fallbackAnswer: unknown): Promise<{ prompt: string; answer: string }> {
  let msgs: unknown[] = []
  try {
    const got: unknown = await $.session.messages()
    if (Array.isArray(got)) msgs = got
  } catch {
    msgs = []
  }
  const textOfMsg = (m: unknown) => {
    const t = (m as { text?: unknown } | null)?.text
    return typeof t === 'string' ? t.trim() : ''
  }
  const roleOf = (m: unknown) => (m as { role?: unknown } | null)?.role
  let at = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (roleOf(msgs[i]) === 'user' && textOfMsg(msgs[i])) {
      at = i
      break
    }
  }
  let prompt = at >= 0 ? textOfMsg(msgs[at]) : ''
  let answer = ''
  for (let i = msgs.length - 1; i > at; i--) {
    if (roleOf(msgs[i]) === 'assistant' && textOfMsg(msgs[i])) {
      answer = textOfMsg(msgs[i])
      break
    }
  }
  if (!prompt) prompt = (await read($, decisionTurnPrompt)).trim()
  if (!answer && typeof fallbackAnswer === 'string') answer = fallbackAnswer.trim()
  return { prompt, answer }
}

/**
 * The watch on one main turn: gates (on, length, cue word, hourly cap), one model call, the reply
 * parsed and deduped. Null when no call was made or the reply was unusable (logged once).
 * `log` is every entry in the log, `now` the time in ms. With the watch off nothing is called.
 */
async function proposeFromTurn($: EngineInterface, answerText: unknown, log: readonly Entry[], now: number): Promise<Proposal | null> {
  const cfg = await loadWatchConfig($)
  if (!cfg.watch) return null
  const { prompt, answer } = await turnTexts($, answerText)
  if (prompt.length + answer.length < cfg.watchMinChars) return null
  if (!hasCue(prompt + '\n' + answer)) return null

  const calls = recentCalls(await storeGet($, KEY_CALLS), now)
  if (calls.length >= cfg.watchMaxPerHour) {
    await logWatchProblem(
      $,
      'cap',
      `loopkeeper: the watch is paused, ${calls.length} calls in the last hour (watchMaxPerHour ${cfg.watchMaxPerHour})`,
    )
    return null
  }
  await storeSet($, KEY_CALLS, [...calls, now])

  const turn = await read($, decisionTurnRecorded)
  const prefs = await loadPrefs($)
  let reply: unknown
  try {
    reply = await $.model.complete({
      model: cfg.watchModel,
      system: WATCH_SYSTEM,
      prompt: buildWatchPrompt({ log: log.slice(-LOG_CONTEXT).map(x => x.decision), turn, prefs, prompt, answer }),
      maxTokens: WATCH_MAX_TOKENS,
      timeoutMs: WATCH_TIMEOUT_MS,
    })
  } catch (err) {
    await logWatchProblem($, 'refused', `loopkeeper: the watch call was refused (${messageOf(err)}); ignored`)
    return null
  }
  const r = reply as { isAnswered?: unknown; text?: unknown; reason?: unknown } | null
  if (!r || r.isAnswered !== true) {
    const why = typeof r?.reason === 'string' ? r.reason : 'no answer'
    await logWatchProblem($, 'no-reply', `loopkeeper: the watch got no reply (${why}); ignored`)
    return null
  }
  const parsed = parseWatchReply(r.text)
  if (!parsed) {
    await logWatchProblem($, 'not-json', 'loopkeeper: the watch reply was not JSON; ignored')
    return null
  }

  const cwd = await cwdOf($)
  const skipped = strings(await storeGet($, skippedKey(cwd)))
  const waiting = await read($, decisionPending)
  const pool = makePool([...log.map(x => x.decision), ...skipped, ...turn, ...waiting.map(p => p.text)])
  const out: Proposal = { minors: [], majors: [], preferences: parsed.preferences }
  for (const d of parsed.decisions) {
    if (pool.has(d.text)) continue
    pool.add(d.text)
    const item = { text: d.text, why: d.why, tags: d.tags }
    if (d.weight === 'minor') out.minors.push(item)
    else out.majors.push(item)
  }
  return out
}

/** After the minors were recorded: one toast, the majors queued for the band, the preferences merged. */
async function finishTurn($: EngineInterface, recorded: readonly string[], p: Proposal): Promise<void> {
  if (recorded.length) toast($, minorToast(recorded))
  if (p.majors.length) await update($, decisionPending, list => [...list, ...p.majors].slice(-MAX_PENDING))
  if (p.preferences.length) {
    const cwd = await cwdOf($)
    const merged = mergePrefs(await loadPrefs($), p.preferences)
    await update($, decisionPrefs, () => merged)
    await storeSet($, prefsKey(cwd), merged)
  }
}

/** Runs the watch on a main turn: minors recorded at once, majors queued, preferences merged. */
async function watchTurn($: EngineInterface, answer: unknown): Promise<void> {
  const proposal = await proposeFromTurn($, answer, await allEntries($), await nowMs($))
  if (!proposal) return
  const recorded: string[] = []
  for (const m of proposal.minors) {
    const done = await record($, { decision: m.text, why: m.why, tags: m.tags }, 'claude')
    if (done.ok) {
      recorded.push(m.text)
      await noteRecorded($, m.text, 'minor')
    } else {
      await logWatchProblem($, 'write', 'loopkeeper: a minor decision was not recorded: ' + done.error)
    }
  }
  await finishTurn($, recorded, proposal)
}

/** Takes the oldest waiting major off the queue (Record or Skip pressed). */
async function takeMajor($: EngineInterface): Promise<Proposed | null> {
  const m = (await read($, decisionPending))[0]
  if (!m) return null
  await update($, decisionPending, l => l.filter(p => p.text !== m.text))
  return m
}

/** Puts a major back at the front, after a failed Record. */
async function returnMajor($: EngineInterface, m: Proposed): Promise<void> {
  await update($, decisionPending, l => [m, ...l.filter(p => p.text !== m.text)].slice(0, MAX_PENDING))
}

/** Remembers a skipped major for this project, so the watch never offers it again. */
async function skipMajor($: EngineInterface, m: Proposed): Promise<void> {
  const cwd = await cwdOf($)
  const n = normText(m.text)
  const skipped = strings(await storeGet($, skippedKey(cwd))).filter(s => normText(s) !== n)
  await storeSet($, skippedKey(cwd), [...skipped, m.text].slice(-MAX_SKIPPED))
}

/** Record or Skip on the band's major decision card. */
async function answerMajor($: EngineInterface, choice: 'record' | 'skip'): Promise<void> {
  const m = await takeMajor($)
  if (!m) return
  if (choice === 'skip') {
    await skipMajor($, m)
    return
  }
  const done = await record($, { decision: m.text, why: m.why, tags: m.tags }, 'claude')
  if (done.ok) {
    await noteRecorded($, m.text, 'major')
    toast($, 'recorded: ' + cut(m.text, 60))
  } else {
    // Back to the front, so Record can be pressed again (or Skip)
    await returnMajor($, m)
    toast($, 'loopkeeper: not recorded: ' + done.error)
  }
}

async function watchStatus($: EngineInterface, now: number): Promise<string> {
  const cfg = await loadWatchConfig($)
  const calls = recentCalls(await storeGet($, KEY_CALLS), now)
  const waiting = (await read($, decisionPending)).length
  const prefs = (await loadPrefs($)).length
  return (
    `Decision watch ${cfg.watch ? 'on' : 'off'} · model ${cfg.watchModel} · ` +
    `${calls.length}/${cfg.watchMaxPerHour} calls in the last hour · turns of ${cfg.watchMinChars}+ characters with a cue word · ` +
    `${waiting} major pending · ${prefs} learned preference${prefs === 1 ? '' : 's'}`
  )
}

/** /decide prefs …, /decide watch …; null when the text is a decision to record. */
async function watchCommand($: EngineInterface, args: unknown, now: number): Promise<{ text: string } | null> {
  const text = (typeof args === 'string' ? args : '').trim().replace(/\s+/g, ' ')
  const lower = text.toLowerCase()
  if (lower === 'prefs' || lower === 'preferences') {
    const prefs = await loadPrefs($)
    if (!prefs.length) return { text: 'No learned preferences yet. The decision watch adds them as it reads your turns.' }
    return { text: [`Learned preferences (${prefs.length}, newest last):`, ...prefs.map(p => '- ' + p)].join('\n') }
  }
  if (lower === 'prefs clear' || lower === 'preferences clear') {
    const cwd = await cwdOf($)
    const n = (await loadPrefs($)).length
    await update($, decisionPrefs, () => [])
    const saved = await storeSet($, prefsKey(cwd), [])
    return { text: saved ? `Cleared ${n} learned preference${n === 1 ? '' : 's'}.` : 'Cleared for this session; not saved.' }
  }
  if (lower === 'watch' || lower === 'watch status') return { text: await watchStatus($, now) }
  if (lower === 'watch on' || lower === 'watch off') {
    const isOn = lower === 'watch on'
    const saved = await setWatch($, isOn)
    const cfg = await loadWatchConfig($)
    const what = isOn ? `Decision watch on (model ${cfg.watchModel}).` : 'Decision watch off. No model calls until /decide watch on.'
    return { text: saved ? what : what + ' Not saved: the store refused it.' }
  }
  const model = /^watch model(?: (\S+))?$/i.exec(text)
  if (model) {
    const id = model[1] ?? ''
    if (!isModelId(id)) {
      const watchConfig = await loadWatchConfig($)
      return { text: `Watch model is ${watchConfig.watchModel}. ${WATCH_USAGE}` }
    }
    const saved = await storeSet($, KEY_MODEL, id)
    await update($, decisionWatch, c => ({ ...c, watchModel: id }))
    return { text: saved ? `Watch model: ${id}.` : `Watch model: ${id} for this session; not saved.` }
  }
  // A mistyped subcommand ("prefs clr", "watch off now") gets the usage instead of being recorded
  if (/^(?:prefs|preferences) \S+$/i.test(text) || /^watch (?:on|off|status) \S+$/i.test(text)) return { text: WATCH_USAGE }
  return null
}

// ---------------------------------------------------------------- the band switch and /lk

/** Sets the decisions band on or off for the session and in the store (the same key /lk band uses). */
async function setBand($: EngineInterface, isOn: boolean): Promise<boolean> {
  await update($, decisionBand, () => isOn)
  return storeSet($, KEY_BAND, isOn)
}

async function statusLine($: EngineInterface): Promise<string> {
  const waiting = (await read($, decisionPending)).length
  const pending = waiting > 0 ? ` · ${waiting} major pending` : ''
  const count = await read($, decisionCount)
  const watching = (await read($, decisionWatch)).watch
  return `decisions ● ${count} this session · watch ${watching ? 'on' : 'off'}${pending}`
}

// The end of the /lk chain. status adds this concern's line; reload, band and on/off are shared words
// that earlier concerns handled first; anything else nobody owned is unknown, once.
async function lk($: EngineInterface, e: { args: string }): Promise<{ text: string }> {
  const { sub, rest, text } = subOf(e.args)
  if (sub === 'status') return { text: await statusLine($) }
  if (sub === 'reload') {
    await loadBand($)
    const found = await detect($)
    await loadWatch($)
    const status = await statusLine($)
    return { text: `decisions ● reloaded: ${found.file} (${found.format}) · ${status}` }
  }
  if (sub === 'band') {
    const words = rest.map(w => w.toLowerCase())
    const named = words.filter(w => CONCERN_WORDS.includes(w))
    // Another concern was named: nothing for this one to do
    if (named.length > 0 && !named.includes('decisions')) return { text: '' }
    const word = words.find(w => w === 'on' || w === 'off')
    if (!word) {
      const shown = await read($, decisionBand)
      return { text: `decisions ● band ${shown ? 'on' : 'off'}` }
    }
    const saved = await setBand($, word === 'on')
    return { text: `decisions ● band ${word}${saved ? '' : ' (this session only)'}` }
  }
  // GSD mode is another concern's switch; the watch stays as it is.
  if (sub === 'on' || sub === 'off') return { text: '' }
  return { text: `loopkeeper: unknown sub-command "${text}". Try /lk status, /lk stage (the Stage pane) or /lk help (the keys).` }
}

// ---------------------------------------------------------------- the hub and the nav bar

// HUB_ID, HUB_ROWS and PANES (every loopkeeper pane in wiring order) come from lib/panes.ts.

// the "ctrl+x tab to focus the panel" toast showed this session (stage.ts's atom, shared by all six concern files)
const stageFocusHinted = atom({ plugin: 'loopkeeper', key: 'stageFocusHinted' } as const, false)

// Switch panes: close `fromId` first ('' closes nothing), since a focus request is refused while the person holds a
// pane, then open `toId` with the focus. The composer keeps the focus while it holds a draft: then a toast says how to
// reach the pane, once a session and only in the terminal (the press's `surface`; with no press, a session whose every
// surface is the terminal). False when the pane could not be opened.
async function switchTo($: EngineInterface, fromId: string, toId: string, title: string, surface?: unknown): Promise<boolean> {
  if (fromId) {
    try {
      await $.ui.close({ id: fromId })
    } catch {
      // already closed
    }
  }
  try {
    await $.ui.open({ id: toId, title, focus: true, closeOnEscape: true, ...(toId === HUB_ID ? { rows: HUB_ROWS } : {}) })
  } catch {
    return false
  }
  try {
    const pane = (await $.ui.panes()).find(p => p.id === toId)
    if (pane && !pane.isFocused && !(await read($, stageFocusHinted))) {
      const terminal = typeof surface === 'string' ? surface === 'terminal' : (await $.session.surfaces()).every(s => s === 'terminal')
      if (terminal) {
        await update($, stageFocusHinted, () => true)
        toast($, 'ctrl+x tab to focus the panel')
      }
    }
  } catch {
    // no list: no hint
  }
  return true
}

// The nav bar's items: every loopkeeper pane, a press switching from `fromId` to it
function navItems($: EngineInterface, fromId: string) {
  return PANES.map(p => ({
    key: p.key,
    label: p.label,
    hotkey: p.hotkey,
    onPress: async (e?: { surface?: unknown }) => {
      if (!(await switchTo($, fromId, p.id, p.title, e?.surface))) toast($, 'Could not open the ' + p.label + ' pane.')
    },
  }))
}

/** The hub row's words: the status line without its label (`2 this session · watch off`), and `band off` when hidden. */
async function hubWords($: EngineInterface): Promise<string> {
  const words = (await statusLine($)).replace(/^decisions ● /, '')
  return (await read($, decisionBand)) ? words : words + ' · band off'
}

// ---------------------------------------------------------------- wiring

export function wireDecisions(on: On): void {
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    try {
      await loadBand($)
      await detect($)
      await loadWatch($)
    } catch {
      // Defaults stand.
    }
    try {
      await $.tool.register({
        name: TOOL.recordDecision,
        description:
          "Record a decision in this project's decision log (the file loopkeeper found: a decisions.jsonl, " +
          'a decisions.md under .claude/brain or a DECISION_JOURNAL.md). Call it once, right after the user and you ' +
          'settle a design or implementation choice worth remembering later: a library or architecture pick, ' +
          'a convention, a trade-off, a rejected alternative. Do not call it for routine edits or for choices ' +
          'still under discussion. Write the decision as one plain sentence, the reason in "why", and a few ' +
          'short lowercase tags. The entry is appended; nothing already in the log is changed.',
        inputSchema: {
          type: 'object',
          properties: {
            decision: { type: 'string', description: 'The decision, as one sentence' },
            why: { type: 'string', description: 'Why it was chosen, briefly' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Short tags, without #' },
          },
          required: ['decision'],
        },
        isDeferred: false,
      })
    } catch (err) {
      note($, 'loopkeeper: record_decision not registered: ' + messageOf(err))
    }
    try {
      await $.command.register({
        name: 'decide',
        description: "Record a decision in this project's decision log",
        argumentHint: '<decision> -- <why> #tag | prefs [clear] | watch on|off|status | watch model <id>',
      })
    } catch (err) {
      note($, 'loopkeeper: /decide not registered: ' + messageOf(err))
    }
    try {
      await $.command.register({
        name: 'decisions',
        description: 'Browse recent decisions (pane), or: text | reload | band on|off',
        argumentHint: '[text | reload | band on|off]',
        immediate: true,
      })
    } catch (err) {
      note($, 'loopkeeper: /decisions not registered: ' + messageOf(err))
    }
    return next(e)
  })

  // /clear, /resume and /branch reset $.state without a new session.start
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try {
      await loadBand($)
      await detect($)
      await loadWatch($)
    } catch {
      // Defaults stand.
    }
    return next(e)
  }).catch(async (_$, e, next) => next(e))

  on('command.run', { command: 'decide' }, async ($, e) => {
    const sub = await watchCommand($, e?.args, await nowMs($))
    if (sub) return sub
    const input = parseDecideArgs(e?.args)
    if (!input.decision) return { text: DECIDE_USAGE + '\n' + WATCH_USAGE }
    const done = await record($, input, 'user')
    if (!done.ok) return { text: 'Not recorded: ' + done.error }
    await noteRecorded($, input.decision, 'you')
    toast($, 'Recorded in ' + done.file)
    return { text: `Recorded ${done.id} in ${done.file}` }
  }).catch(async () => ({ text: 'Not recorded: loopkeeper failed while handling /decide.' }))

  on('command.run', { command: 'decisions' }, async ($, e) => {
    const args = (typeof e?.args === 'string' ? e.args : '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    const verb = args[0] ?? ''
    if (verb === '' || verb === 'open' || verb === 'pane') {
      await loadEntries($)
      try {
        await $.ui.open({ id: PANE_ID, title: 'Decisions', focus: true, closeOnEscape: true })
      } catch (err) {
        return { text: 'Could not open the pane: ' + messageOf(err) }
      }
      return {}
    }
    if (verb === 'text') {
      const loaded = await loadEntries($)
      return { text: textListing(loaded.target, loaded.list) }
    }
    if (verb === 'reload') {
      const found = await detect($)
      const loaded = await loadEntries($)
      const extra = found.note ? ` (${found.note})` : ''
      return { text: `Target: ${found.file} (${found.format}, ${found.source})${extra}. ${loaded.list.length} recent entries.` }
    }
    if (verb === 'band') {
      const word = args[1] ?? ''
      if (word !== 'on' && word !== 'off') {
        const isOn = await read($, decisionBand)
        return { text: `Band is ${isOn ? 'on' : 'off'}. Use /decisions band on|off.` }
      }
      const saved = await setBand($, word === 'on')
      return { text: saved ? `Band ${word}.` : `Band ${word} for this session; not saved.` }
    }
    return { text: DECISIONS_USAGE }
  }).catch(async () => ({ text: 'loopkeeper: /decisions failed.' }))

  on('command.run', { command: 'lk' }, async ($, e) => lk($, e)).catch(async () => ({ text: 'decisions ● failed' }))
  on('command.run', { command: 'loopkeeper' }, async ($, e) => lk($, e)).catch(async () => ({ text: 'decisions ● failed' }))

  on('tool.call', { tool: TOOL_FULL.recordDecision }, async ($, e) => {
    const input = toolInputOf(e)
    if (!input.decision) return { result: 'Not recorded: record_decision needs a non-empty "decision".' }
    const done = await record($, input, 'claude')
    if (!done.ok) return { result: 'Not recorded: ' + done.error }
    await noteRecorded($, input.decision, 'major')
    toast($, 'Recorded in ' + done.file)
    return { result: `Recorded ${done.id} in ${done.file}` }
  }).catch(async () => ({ result: 'Not recorded: loopkeeper failed while writing the decision.' }))

  // The decision watch (lib/watch.ts): a turn starts with nothing recorded, and a main turn that ended
  // with an answer is read once by a small model call, when the watch is on.
  on('turn.start', async ($, e, next) => {
    await startTurn($, e?.text)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    const ended = e as { agentId?: unknown; isAborted?: unknown; reason?: unknown; answer?: unknown } | undefined
    // A subagent's turn carries agentId; an interrupted or failed turn settled nothing
    if (ended && !ended.agentId && ended.isAborted !== true && ended.reason !== 'error' && ended.reason !== 'refusal') {
      try {
        await watchTurn($, ended.answer)
      } catch (err) {
        await logWatchProblem($, 'failed', 'loopkeeper: the watch failed: ' + messageOf(err))
      }
    }
    return out
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e?.props?.hasSurvey) return next(e)
    const isOn = await read($, decisionBand)
    const n = await read($, decisionCount)
    const waiting = (await read($, decisionPending)).length
    const showLine = isOn && n > 0
    if (!showLine && waiting === 0) return next(e)
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const k = makeKit(ui as unknown as Elements, e?.surface ?? 'terminal')
    const parts: unknown[] = []
    // A major decision from the watch waits here for Record or Skip, whatever the band setting
    if (waiting > 0) {
      parts.push(
        majorCard(
          k,
          await read($, decisionPending),
          () => answerMajor($, 'record'),
          () => answerMajor($, 'skip'),
        ),
      )
    }
    if (showLine) {
      const watching = (await read($, decisionWatch)).watch === true
      parts.push(k.line('decisions', [{ text: bandText(n), tone: 'info' }], watching ? 'watch on' : undefined))
    }
    // Keep what the concerns after this one draw in the band, under ours.
    const theirs = await next(e)
    if (!theirs && parts.length === 1) return parts[0] as never
    return Box({ flexDirection: 'column', children: (theirs ? [...parts, theirs] : parts) as never[] })
  })

  // The hub's Decisions row, the last of the hub chain: `6: Decisions` and the status words, quiet, above what the
  // engine draws beneath (next, often null). It shows with the band off; a failure draws what the chain drew.
  on('ui.render', { component: 'Pane', requestId: HUB_ID }, async ($, e, next) => {
    let asked = false
    let theirs: unknown = null
    try {
      const ui = $.ui.resolve(e) as unknown as Elements
      const k = makeKit(ui, e?.surface ?? 'terminal')
      const row = k.row({
        key: 'hub-decisions',
        left: [
          ui.Button({
            key: 'panel-decisions',
            label: 'Decisions',
            hotkey: '6',
            plain: true,
            onPress: async (press?: { surface?: unknown }) => {
              if (!(await switchTo($, HUB_ID, PANE_ID, 'Decisions', press?.surface))) toast($, 'Could not open the Decisions pane.')
            },
          }),
          k.text(await hubWords($), { color: TONES.muted.fg, wrap: 'truncate' }),
        ],
      })
      asked = true
      theirs = await next(e)
      return (theirs === null || theirs === undefined ? row : k.stack([row, theirs])) as never
    } catch {
      return (asked ? theirs : await next(e)) as never
    }
  })

  // The pane: the nav bar, the hero and tiles, the target and controls, the major decisions pending, the recent
  // decisions and the learned preferences.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    if (e?.requestId !== PANE_ID) return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const k = makeKit(ui as unknown as Elements, e?.surface ?? 'terminal')
    const t = (await read($, decisionTarget)) as Target | null
    const list = await read($, decisionEntries)
    const st = await read($, decisionStats)
    const cfg = await read($, decisionWatch)
    // the watch button: on → Pause; paused by the user (the stored value is false) → Resume; off by default or by a
    // config file → Turn on
    const watchLabel = cfg.watch ? 'Pause watch' : (await storeGet($, KEY_WATCH)) === false ? 'Resume watch' : 'Turn watch on'
    const waiting = await read($, decisionPending)
    const prefs = await read($, decisionPrefs)
    const kinds = new Map(await read($, decisionKinds))
    const head = t
      ? `${t.file} · ${t.format}${t.exists ? '' : ' · created on first record'}`
      : 'no target yet: run /decisions reload'

    const hero = k.hero({
      kicker: 'decisions',
      title: `${st.today} decision${st.today === 1 ? '' : 's'} today`,
      sub: list[0] ? 'Last: ' + list[0].decision : 'Nothing recorded yet',
      tone: 'accent',
    })
    const tiles = k.tiles([
      { label: 'Total', value: String(st.total) },
      { label: 'Today', value: String(st.today), tone: st.today > 0 ? 'info' : undefined },
      { label: 'Major pending', value: String(waiting.length), tone: waiting.length > 0 ? 'warn' : undefined },
      { label: 'Watch', value: cfg.watch ? 'on' : 'off', tone: cfg.watch ? 'ok' : 'muted' },
    ])

    const controls = k.buttons([
      {
        key: 'refresh',
        label: 'Refresh',
        hotkey: 'r',
        plain: true,
        autoFocus: true,
        onPress: async () => {
          await detect($)
          await loadEntries($)
          await loadWatch($)
        },
      },
      {
        key: 'close',
        label: 'Close',
        hotkey: 'c',
        plain: true,
        onPress: async () => {
          try {
            await $.ui.close({ id: PANE_ID })
          } catch {
            // already closed
          }
        },
      },
      {
        key: 'watch-toggle',
        label: watchLabel,
        hotkey: 'w',
        plain: true,
        onPress: async () => {
          await setWatch($, !cfg.watch)
        },
      },
    ])

    const rows = list.map((entry, i) => {
      const kind = kindOf(entry, kinds)
      const lines = [
        Box({
          flexDirection: 'row',
          columnGap: 1,
          children: [
            ...(kind ? [k.badge(BADGE[kind].label, BADGE[kind].tone)] : []),
            Text({ bold: true, children: [entry.date || '----------'] }),
            Text({ wrap: 'wrap', children: [entry.decision] }),
          ] as never[],
        }),
      ]
      if (entry.why) lines.push(Text({ color: TONES.muted.fg, wrap: 'wrap', children: ['  ' + entry.why] }))
      if (entry.tags.length) {
        lines.push(Text({ color: TONES.info.fg, children: ['  ' + entry.tags.map(tag => '#' + tag).join(' ')] }))
      }
      return Box({ key: 'entry-' + i, flexDirection: 'column', children: lines })
    })

    const blocks: unknown[] = [
      k.nav(navItems($, PANE_ID), 'decisions'),
      hero,
      tiles,
      Box({
        flexDirection: 'column',
        children: [
          Text({ color: TONES.muted.fg, wrap: 'truncate-middle', children: [head] }),
          ...(t?.note ? [Text({ color: TONES.warn.fg, children: ['Note: ' + t.note] })] : []),
          controls,
        ],
      }),
    ]
    if (waiting.length) {
      blocks.push(
        k.stack([
          k.section('Major pending', 'r: Record · s: Skip on the band'),
          ...waiting.map((p, i) =>
            k.row({ key: 'pending-' + i, left: [k.badge('major', 'accent'), Text({ wrap: 'wrap', children: [p.text] })] }),
          ),
        ]),
      )
    }
    blocks.push(
      k.stack([
        k.section('Recent decisions', String(list.length)),
        // kit 3.1: one row between entries (list), each entry tight inside
        rows.length
          ? k.list(rows)
          : Text({ color: TONES.muted.fg, children: ['No decisions yet. Record one with /decide <decision> -- <why> #tag'] }),
      ]),
    )
    blocks.push(
      k.stack([
        k.section('Learned preferences', String(prefs.length)),
        ...(prefs.length
          ? [...prefs].reverse().map(p => Text({ wrap: 'wrap', children: ['· ' + p] }))
          : [Text({ color: TONES.muted.fg, children: ['None yet. The decision watch learns them from your turns.'] })]),
      ]),
    )
    return k.page(blocks) as never
  })
}
