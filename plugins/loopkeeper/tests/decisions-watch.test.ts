import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  WATCH_SYSTEM,
  hasCue,
  makePool,
  mergePrefs,
  mergeWatchConfig,
  minorToast,
  parseWatchReply,
} from '../hooks/lib/watch.ts'
import { CWD, PROJECT_CONFIG, USER_CONFIG, world as sharedWorld } from './world.ts'

const NOW = new Date(2026, 9, 8, 14, 5, 0).getTime()
const LOG = `${CWD}/.claude/decisions.jsonl`
const TOOL = 'mcp__loopkeeper__record_decision'
/** A user config that switches the watch on: the watch is off by default (ADR 0006). */
const WATCH_ON = JSON.stringify({ decisions: { watch: true } })

const PROMPT =
  'Which store should the cache sit on? We talked about Redis and SQLite, and I would rather not run another server on the laptop.'
const ANSWER =
  'Then we go with SQLite for the cache: one file, no server, and the tests can use an in-memory database. ' +
  'I named the table kv_cache and set the default TTL to 60 seconds.'

const MAJOR = { text: 'Use SQLite for the cache', why: 'one file, no server', weight: 'major', tags: ['storage'] }

/** A reply the stubbed model gives: an object (sent as JSON), raw text, or null for no answer. */
type Reply = Record<string, unknown> | string | null
type Message = { role: 'user' | 'assistant'; text: string; toolUses: unknown[] }

function chat(prompt: string, answer: string): Message[] {
  return [
    { role: 'user', text: 'An earlier question', toolUses: [] },
    { role: 'assistant', text: 'An earlier answer', toolUses: [] },
    { role: 'user', text: prompt, toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ name: 'Read' }] },
    { role: 'assistant', text: answer, toolUses: [] },
  ]
}

/**
 * A fake project, store, model and transcript (the shared fixture, with this suite's clock and transcript).
 * The watch is switched on through the user config unless the test brings its own user config.
 */
function world(on: On, opts: { files?: Record<string, string>; replies?: Reply[]; store?: Record<string, unknown> } = {}) {
  const files: Record<string, string> = { [USER_CONFIG]: WATCH_ON, ...(opts.files ?? {}) }
  const w = sharedWorld(on, { files, replies: opts.replies, now: NOW, messages: chat(PROMPT, ANSWER) })
  for (const [k, v] of Object.entries(opts.store ?? {})) w.store.set(k, v)
  return { files, writes: w.writes, toasts: w.toasts, logs: w.logs, calls: w.calls, store: w.store, clock: w.clock, chat: w.chat }
}

const START = { surface: 'terminal', isInteractive: true, cwd: CWD } as const

let turnNo = 0
/** One main turn (or a subagent's, with agentId): turn.start, then turn.complete. */
async function turn($: any, opts: { agentId?: string; between?: () => Promise<unknown> } = {}) {
  turnNo += 1
  const turnId = 'turn-' + turnNo
  if (!opts.agentId) await $.turn.start({ turnId, text: PROMPT })
  if (opts.between) await opts.between()
  const done: Record<string, unknown> = { turnId, answer: ANSWER, durationMs: 1200, isAborted: false, usage: null, reason: 'answer' }
  if (opts.agentId) done.agentId = opts.agentId
  await $.turn.complete(done)
}

const BAND = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'loopkeeper',
    component: 'AbovePrompt',
    requestId: 'above-prompt',
    surface,
    viewport: { columns: 120, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 }, view: {} },
  }) as const

const PANE = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'loopkeeper',
    component: 'Pane',
    requestId: 'loopkeeper-decisions',
    surface,
    viewport: { columns: 150, rows: 50 },
    props: { title: 'Decisions', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  }) as const

function logLines(files: Record<string, string>): Record<string, unknown>[] {
  return (files[LOG] ?? '')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

describe('major decisions', () => {
  test('wait on the band as a card with Record and Skip, on both surfaces', { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, { replies: [{ decisions: [MAJOR], preferences: [] }] })
    await $.session.start(START)
    await turn($)
    expect(w.calls.length).toBe(1)
    const call = w.calls[0]
    expect(call?.model).toBe('haiku')
    expect(call?.maxTokens).toBe(600)
    expect(call?.timeoutMs).toBe(8000)
    expect(call?.system).toBe(WATCH_SYSTEM)
    expect(call?.prompt).toContain(PROMPT)
    expect(call?.prompt).toContain(ANSWER)
    expect(w.writes).toEqual([])
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount(BAND(surface))
      expect(await ui.find({ type: 'Text', text: 'loopkeeper · major decision' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Use SQLite for the cache' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'why: one file, no server' })).toBeDefined()
      expect(await ui.find({ key: 'decisions-record' })).toMatchObject({ props: { label: 'Record', hotkey: 'r' } })
      expect(await ui.find({ key: 'decisions-skip' })).toMatchObject({ props: { label: 'Skip', hotkey: 's' } })
      await ui.unmount()
    }
  })

  test('Record appends the entry with by: claude and toasts', { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, { replies: [{ decisions: [MAJOR], preferences: [] }] })
    await $.session.start(START)
    await turn($)
    const ui = await $.ui.mount(BAND('terminal'))
    await ui.press({ key: 'decisions-record' })
    expect(logLines(w.files)).toEqual([
      {
        id: 'D-20261008-1405',
        date: '2026-10-08',
        decision: 'Use SQLite for the cache',
        why: 'one file, no server',
        tags: ['storage'],
        session: 'sess-1',
        by: 'claude',
      },
    ])
    expect(w.toasts).toEqual(['recorded: Use SQLite for the cache'])
    expect(await ui.find({ type: 'Text', text: 'Use SQLite for the cache' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '● 1 this session' })).toBeDefined()
    await ui.unmount()
  })

  test('Skip remembers it for the project, and the watch never offers it again', { timeoutMs: 20_000 }, async ($, on) => {
    const again = { ...MAJOR, text: 'use SQLite for the cache.' }
    const w = world(on, { replies: [{ decisions: [MAJOR] }, { decisions: [again] }] })
    await $.session.start(START)
    await turn($)
    const ui = await $.ui.mount(BAND('terminal'))
    await ui.press({ key: 'decisions-skip' })
    expect(w.store.get('loopkeeper:decisions:skipped:/work/project')).toEqual(['Use SQLite for the cache'])
    expect(w.writes).toEqual([])
    await turn($)
    expect(w.calls.length).toBe(2)
    expect(await ui.find({ key: 'decisions-record' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
    await ui.unmount()
  })

  test('unanswered majors queue up to five, oldest shown first', { timeoutMs: 20_000 }, async ($, on) => {
    const many = ['Use SQLite', 'Adopt Zod', 'Switch to pnpm', 'Keep ESM only', 'Drop Node 18', 'Choose Vitest'].map(text => ({
      text,
      why: '',
      weight: 'major',
      tags: [],
    }))
    world(on, { replies: [{ decisions: many.slice(0, 3) }, { decisions: many.slice(3) }] })
    await $.session.start(START)
    await turn($)
    await turn($)
    const ui = await $.ui.mount(BAND('terminal'))
    // six offered, five kept: the oldest was replaced
    expect(await ui.find({ type: 'Text', text: 'Adopt Zod' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 of 5' })).toBeDefined()
    await ui.press({ key: 'decisions-skip' })
    expect(await ui.find({ type: 'Text', text: 'Switch to pnpm' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 of 4' })).toBeDefined()
    await ui.unmount()
  })
})

describe('minor decisions', () => {
  test('are recorded at once with by: claude and summed up in one toast', async ($, on) => {
    const w = world(on, {
      replies: [
        {
          decisions: [
            { text: 'Name the cache table kv_cache', why: '', weight: 'minor', tags: ['naming'] },
            { text: 'Default the cache TTL to 60 seconds', why: 'short sessions', weight: 'minor', tags: [] },
          ],
          preferences: [],
        },
      ],
    })
    await $.session.start(START)
    await turn($)
    const lines = logLines(w.files)
    expect(lines.map(x => [x.decision, x.by])).toEqual([
      ['Name the cache table kv_cache', 'claude'],
      ['Default the cache TTL to 60 seconds', 'claude'],
    ])
    expect(w.toasts).toEqual([
      'loopkeeper: recorded 2 minor decisions: Name the cache table kv_cache; Default the cache TTL to 60 seconds',
    ])
    const ui = await $.ui.mount(BAND('terminal'))
    expect(await ui.find({ key: 'decisions-record' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '● 2 this session' })).toBeDefined()
    await ui.unmount()
  })
})

describe('dedupe', () => {
  test('a decision whose words are 80 % in an existing entry is left out', async ($, on) => {
    const existing =
      '{"id":"D-20261001-0900","date":"2026-10-01","decision":"Use SQLite for the cache","why":"","tags":[],"session":"s0","by":"user"}\n'
    const w = world(on, {
      files: { [LOG]: existing },
      replies: [
        {
          decisions: [
            { text: 'Use SQLite for the cache layer', why: '', weight: 'major', tags: [] },
            { text: 'use sqlite for the cache!', why: '', weight: 'minor', tags: [] },
            { text: 'Name the cache table kv_cache', why: '', weight: 'minor', tags: [] },
          ],
        },
      ],
    })
    await $.session.start(START)
    await turn($)
    expect(w.calls[0]?.prompt).toContain('Already in the decision log (newest last):\n- Use SQLite for the cache')
    expect(logLines(w.files).map(x => x.decision)).toEqual(['Use SQLite for the cache', 'Name the cache table kv_cache'])
    expect(w.toasts).toEqual(['loopkeeper: recorded 1 minor decision: Name the cache table kv_cache'])
    const ui = await $.ui.mount(BAND('terminal'))
    expect(await ui.find({ key: 'decisions-record' })).toBeUndefined()
    await ui.unmount()
  })

  test('a decision recorded through record_decision in the same turn is not offered again', async ($, on) => {
    const w = world(on, { replies: [{ decisions: [{ text: 'Adopt Zod for request validation', weight: 'major' }] }, {}] })
    await $.session.start(START)
    await turn($, { between: () => $.tool.call({ tool: TOOL, decision: 'Adopt Zod for request validation', why: 'typed input' }) })
    expect(w.calls[0]?.prompt).toContain('Recorded during this turn:\n- Adopt Zod for request validation')
    const ui = await $.ui.mount(BAND('terminal'))
    expect(await ui.find({ key: 'decisions-record' })).toBeUndefined()
    await ui.unmount()
    // the next turn starts with an empty list
    await turn($)
    expect(w.calls[1]?.prompt).toContain('Recorded during this turn:\n(none)')
    expect(logLines(w.files).length).toBe(1)
  })
})

describe('when the watch calls the model', () => {
  test('watch off: no model call; on again: calls; the setting is saved', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    expect((await $.command.run({ command: 'decide', args: 'watch off' })).text).toBe(
      'Decision watch off. No model calls until /decide watch on.',
    )
    expect(w.store.get('loopkeeper:decisions:watch')).toBe(false)
    await turn($)
    expect(w.calls.length).toBe(0)
    expect((await $.command.run({ command: 'decide', args: 'watch on' })).text).toBe('Decision watch on (model haiku).')
    await turn($)
    expect(w.calls.length).toBe(1)
    expect((await $.command.run({ command: 'decide', args: 'watch status' })).text).toContain(
      'Decision watch on · model haiku · 1/20 calls in the last hour',
    )
    expect(w.writes).toEqual([])
  })

  test('watch: false in the user config turns it off', async ($, on) => {
    const w = world(on, { files: { [USER_CONFIG]: '{"decisions":{"watch": false}}' } })
    await $.session.start(START)
    await turn($)
    expect(w.calls.length).toBe(0)
  })

  test('watchModel from the project file, then /decide watch model; watch keys alone are not a log override', async ($, on) => {
    const w = world(on, { files: { [PROJECT_CONFIG]: '{"decisions":{"watchModel": "sonnet"}}' } })
    await $.session.start(START)
    const listing = await $.command.run({ command: 'decisions', args: 'text' })
    expect(String(listing.text)).not.toContain('Note:')
    await turn($)
    expect((await $.command.run({ command: 'decide', args: 'watch model haiku' })).text).toBe('Watch model: haiku.')
    await turn($)
    expect(w.calls.map(c => c.model)).toEqual(['sonnet', 'haiku'])
    expect(w.store.get('loopkeeper:decisions:watch-model')).toBe('haiku')
  })

  test('no cue word, or a short turn: no call', async ($, on) => {
    const w = world(on)
    const prompt = 'Summarise the README for me: what each folder holds, how the scripts are run, and what the tests cover.'
    const answer =
      'The README covers three folders. hooks holds the module, tests holds the test files, and types holds the ' +
      'declarations. The scripts run from the root with bash, and the tests cover parsing, the pane and the band.'
    expect(hasCue(prompt + '\n' + answer)).toBe(false)
    expect((prompt + answer).length >= 200).toBe(true)
    w.chat.messages = chat(prompt, answer)
    await $.session.start(START)
    await turn($)
    expect(w.calls.length).toBe(0)
    w.chat.messages = chat('Use pnpm?', 'Yes, we use pnpm here.')
    await turn($)
    expect(w.calls.length).toBe(0)
    w.chat.messages = chat(PROMPT, ANSWER)
    await turn($)
    expect(w.calls.length).toBe(1)
  })

  test('at most watchMaxPerHour calls in an hour, logged once', async ($, on) => {
    const w = world(on, { files: { [USER_CONFIG]: '{"decisions":{"watch": true,"watchMaxPerHour": 2}}' } })
    await $.session.start(START)
    await turn($)
    await turn($)
    await turn($)
    await turn($)
    expect(w.calls.length).toBe(2)
    expect(w.logs.filter(line => line.includes('the watch is paused')).length).toBe(1)
    await w.clock.advance(60 * 60 * 1000)
    await turn($)
    expect(w.calls.length).toBe(3)
  })

  test('calls made in session one count against the cap in session two, until the hour passes', async ($, on) => {
    const empty = { decisions: [], preferences: [] }
    const w = world(on, {
      files: { [USER_CONFIG]: '{"decisions":{"watch": true,"watchMaxPerHour": 2}}' },
      replies: [empty, empty, empty],
    })
    await $.session.start(START)
    await turn($)
    await turn($)
    expect(w.calls.length).toBe(2)
    expect(w.store.get('loopkeeper:decisions:watch-calls')).toHaveLength(2)
    // session two starts on the same store: the two calls of session one still count
    await $.session.start(START)
    expect(w.store.get('loopkeeper:decisions:watch-calls')).toHaveLength(2)
    await turn($)
    expect(w.calls.length).toBe(2)
    expect(w.logs.filter(line => line.includes('the watch is paused')).length).toBe(1)
    // an hour on, the calls have aged out and the watch calls the model again
    await w.clock.advance(60 * 60 * 1000)
    await turn($)
    expect(w.calls.length).toBe(3)
  })

  test("a subagent's turn (agentId set) makes no call", async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await turn($, { agentId: 'agent-7' })
    expect(w.calls.length).toBe(0)
  })

  test('a reply that is not JSON is ignored with one log line', async ($, on) => {
    const w = world(on, { replies: ['Sure, nothing was decided here.', 'Still prose, no braces at all.'] })
    await $.session.start(START)
    await turn($)
    await turn($)
    expect(w.calls.length).toBe(2)
    expect(w.logs).toEqual(['loopkeeper: the watch reply was not JSON; ignored'])
    expect(w.writes).toEqual([])
    expect(w.toasts).toEqual([])
  })

  test('an unanswered call is ignored with one log line', async ($, on) => {
    const w = world(on, { replies: [null, null] })
    await $.session.start(START)
    await turn($)
    await turn($)
    expect(w.logs).toEqual(['loopkeeper: the watch got no reply (api-error); ignored'])
    expect(w.writes).toEqual([])
  })
})

describe('preferences', () => {
  test('are merged per project, listed, shown in the pane and cleared', async ($, on) => {
    const w = world(on, {
      store: { 'loopkeeper:decisions:prefs:/work/project': ['Prefer small focused commits', 'Explain trade-offs before editing'] },
      replies: [{ decisions: [], preferences: ['prefer small, focused commits!', 'Write the test before the fix'] }],
    })
    await $.session.start(START)
    await turn($)
    expect(w.calls[0]?.prompt).toContain('Learned preferences:\n- Prefer small focused commits\n- Explain trade-offs before editing')
    expect(w.store.get('loopkeeper:decisions:prefs:/work/project')).toEqual([
      'Explain trade-offs before editing',
      'prefer small, focused commits!',
      'Write the test before the fix',
    ])
    expect((await $.command.run({ command: 'decide', args: 'prefs' })).text).toBe(
      'Learned preferences (3, newest last):\n- Explain trade-offs before editing\n- prefer small, focused commits!\n- Write the test before the fix',
    )
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount(PANE(surface))
      expect(await ui.find({ type: 'Text', text: /learned preferences/i })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '· Write the test before the fix' })).toBeDefined()
      await ui.unmount()
    }
    expect((await $.command.run({ command: 'decide', args: 'prefs clear' })).text).toBe('Cleared 3 learned preferences.')
    expect(w.store.get('loopkeeper:decisions:prefs:/work/project')).toEqual([])
  })
})

describe('the pane', () => {
  test('draws the hero, tiles, badges and buttons on both surfaces', async ($, on) => {
    const log =
      '{"id":"D-20261001-0900","date":"2026-10-01","decision":"Keep the API versioned","why":"clients pin","tags":["api"],"session":"s0","by":"claude"}\n' +
      '{"id":"D-20261008-1000","date":"2026-10-08","decision":"Use pnpm workspaces","why":"","tags":[],"session":"s0","by":"user"}\n'
    const w = world(on, {
      files: { [LOG]: log },
      replies: [
        {
          decisions: [
            { text: 'Name the cache table kv_cache', weight: 'minor' },
            { text: 'Use SQLite for the cache', weight: 'major' },
          ],
        },
      ],
    })
    await $.session.start(START)
    await turn($)
    await $.command.run({ command: 'decisions', args: '' })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount(PANE(surface))
      const badge = (s: string) => new RegExp('\\b' + s + '\\b')
      expect(await ui.find({ type: 'Text', text: /^decisions$/i })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '2 decisions today' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Last: Name the cache table kv_cache' })).toBeDefined()
      for (const label of ['Total', 'Today', 'Major pending', 'Watch']) {
        expect(await ui.find({ type: 'Text', text: label })).toBeDefined()
      }
      expect(await ui.find({ type: 'Text', text: '3' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'on' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '.claude/decisions.jsonl · jsonl' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'r: Record · s: Skip on the band' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /recent decisions/i })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: badge('minor') })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: badge('you') })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: badge('major') })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '  clients pin' })).toBeDefined()
      expect(await ui.find({ key: 'refresh' })).toBeDefined()
      expect(await ui.find({ key: 'close' })).toBeDefined()
      expect(await ui.find({ key: 'watch-toggle' })).toBeDefined()
      await ui.unmount()
    }
    const ui = await $.ui.mount(PANE('terminal'))
    await ui.press({ key: 'watch-toggle' })
    expect(w.store.get('loopkeeper:decisions:watch')).toBe(false)
    expect(await ui.find({ type: 'Text', text: 'off' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'r: Record · s: Skip on the band' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('pure helpers', () => {
  test('parseWatchReply takes the first JSON object, even inside prose or a fence', async () => {
    const reply = parseWatchReply(
      'Here you go:\n```json\n{"decisions":[{"text":"Use {braces} in names","why":"","weight":"minor","tags":["Naming","naming"]},' +
        '{"decision":"Adopt Zod","tags":"x"},{"text":""}],"preferences":["Prefer small commits",""]}\n```',
    )
    expect(reply).toEqual({
      decisions: [
        { text: 'Use {braces} in names', why: '', tags: ['naming'], weight: 'minor' },
        { text: 'Adopt Zod', why: '', tags: [], weight: 'major' },
      ],
      preferences: ['Prefer small commits'],
    })
    expect(parseWatchReply('no json here')).toBeNull()
    expect(parseWatchReply('{"decisions": [}')).toBeNull()
    expect(parseWatchReply('{not json} then {"decisions":[]}')).toEqual({ decisions: [], preferences: [] })
  })

  test('the pool dedupes at 80 % of the new text\'s words', async () => {
    const pool = makePool(['Use SQLite for the cache'])
    expect(pool.has('Use SQLite for the cache layer')).toBe(true)
    expect(pool.has('use sqlite, for the cache!')).toBe(true)
    expect(pool.has('Use Postgres for the main database')).toBe(false)
    pool.add('Use Postgres for the main database')
    expect(pool.has('use postgres for the main database')).toBe(true)
  })

  test('mergePrefs keeps the newest of equal ones and at most 40', async () => {
    expect(mergePrefs(['A rule', 'Another rule'], ['a RULE!'])).toEqual(['Another rule', 'a RULE!'])
    const many = Array.from({ length: 45 }, (_, i) => 'rule ' + i)
    const merged = mergePrefs([], many)
    expect(merged.length).toBe(40)
    expect(merged[0]).toBe('rule 5')
  })

  test('mergeWatchConfig ignores bad values', async () => {
    expect(mergeWatchConfig([{ watch: 'no', watchModel: 'bad model id', watchMaxPerHour: -1, watchMinChars: 1.5 }])).toEqual({
      watch: false,
      watchModel: 'haiku',
      watchMaxPerHour: 20,
      watchMinChars: 200,
    })
    expect(mergeWatchConfig([{ watchMaxPerHour: 5 }, { watch: false, watchModel: 'sonnet' }])).toEqual({
      watch: false,
      watchModel: 'sonnet',
      watchMaxPerHour: 5,
      watchMinChars: 200,
    })
  })

  test('cue words and the minor toast', async () => {
    expect(hasCue('we went with pnpm')).toBe(true)
    expect(hasCue('the user list is empty')).toBe(false)
    expect(minorToast(['x'.repeat(70)])).toBe('loopkeeper: recorded 1 minor decision: ' + 'x'.repeat(60) + '…')
  })
})

describe('the watch is off by default (ADR 0006)', () => {
  const NONE = { [USER_CONFIG]: '' }

  test('a fresh session with no config makes no model call on a qualifying turn', async ($, on) => {
    const w = world(on, { files: NONE, replies: [{ decisions: [MAJOR], preferences: ['Prefer small commits'] }] })
    await $.session.start(START)
    expect((await $.command.run({ command: 'decide', args: 'watch status' })).text).toContain('Decision watch off')
    await turn($)
    await turn($)
    expect(w.calls.length).toBe(0)
    expect(w.writes).toEqual([])
    expect(w.toasts).toEqual([])
    expect(w.store.has('loopkeeper:decisions:watch-calls')).toBe(false)
    const ui = await $.ui.mount(BAND('terminal'))
    expect(await ui.find({ key: 'decisions-record' })).toBeUndefined()
    await ui.unmount()
  })

  test('the defaults are off, haiku, 20 an hour and 200 characters', async () => {
    expect(mergeWatchConfig([])).toEqual({ watch: false, watchModel: 'haiku', watchMaxPerHour: 20, watchMinChars: 200 })
  })

  test('"watch": true in the user config turns it on', async ($, on) => {
    const w = world(on, { files: { [USER_CONFIG]: WATCH_ON } })
    await $.session.start(START)
    await turn($)
    expect(w.calls.length).toBe(1)
  })

  test('"watch": true in the project config turns it on', async ($, on) => {
    const w = world(on, { files: { [USER_CONFIG]: '', [PROJECT_CONFIG]: WATCH_ON } })
    await $.session.start(START)
    await turn($)
    expect(w.calls.length).toBe(1)
  })

  test('/decide watch on turns it on from a fresh session, and /decide watch off turns it off again', async ($, on) => {
    const w = world(on, { files: NONE })
    await $.session.start(START)
    await turn($)
    expect(w.calls.length).toBe(0)
    expect((await $.command.run({ command: 'decide', args: 'watch on' })).text).toBe('Decision watch on (model haiku).')
    expect(w.store.get('loopkeeper:decisions:watch')).toBe(true)
    await turn($)
    expect(w.calls.length).toBe(1)
    await $.command.run({ command: 'decide', args: 'watch off' })
    await turn($)
    expect(w.calls.length).toBe(1)
  })

  test('the saved /decide watch setting wins over the config files, and survives a new session', async ($, on) => {
    const w = world(on, { files: { [USER_CONFIG]: WATCH_ON }, store: { 'loopkeeper:decisions:watch': false } })
    await $.session.start(START)
    await turn($)
    expect(w.calls.length).toBe(0)
  })

  test('a config problem in the decisions section is logged once, and the rest still applies', async ($, on) => {
    const w = world(on, { files: { [USER_CONFIG]: JSON.stringify({ decisions: { watch: true, colour: 'red' } }) } })
    await $.session.start(START)
    await turn($)
    await turn($)
    expect(w.calls.length).toBe(2)
    expect(w.logs.filter(l => l.includes('decisions.colour')).length).toBe(1)
    expect(w.logs.some(l => l.startsWith('loopkeeper: '))).toBe(true)
  })

  test('the turn that ends with the watch off never reads the transcript for a model call, even with majors queued before', async ($, on) => {
    const w = world(on, { replies: [{ decisions: [MAJOR] }] })
    await $.session.start(START)
    await turn($)
    const ui = await $.ui.mount(BAND('terminal'))
    expect(await ui.find({ key: 'decisions-record' })).toBeDefined()
    await $.command.run({ command: 'decide', args: 'watch off' })
    expect(await ui.find({ key: 'decisions-record' })).toBeUndefined()
    await turn($)
    expect(w.calls.length).toBe(1)
    await ui.unmount()
  })
})
