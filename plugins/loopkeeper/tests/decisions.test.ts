import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { TONES } from '../hooks/lib/kit.ts'
import { render } from './render.ts'
import { BAND as BAND_PROPS, CWD, PROJECT_CONFIG, USER_CONFIG, lineOf, linePlain, lk, start, texts, world as sharedWorld } from './world.ts'

const NOW = new Date(2026, 9, 8, 14, 5, 0).getTime()
const TOOL = 'mcp__loopkeeper__record_decision'
const PANE_ID = 'loopkeeper-decisions'
const BAND_KEY = 'loopkeeper:decisions:band'

/** A fake project: files by absolute path, directories by absolute path (the shared fixture, with this suite's clock). */
function world(on: On, files: Record<string, string>, dirs: Record<string, string[]> = {}, failWrite = '') {
  const w = sharedWorld(on, { files, dirs, failWrite, now: NOW })
  return { files, writes: w.writes, toasts: w.toasts, store: w.store, panes: w.panes }
}

const START = { surface: 'terminal', isInteractive: true, cwd: CWD } as const

async function targetLine($: any): Promise<string> {
  const out = await $.command.run({ command: 'decisions', args: 'text' })
  return String(out.text).split('\n')[0]
}

describe('target detection', () => {
  const ALL: Record<string, string> = {
    [PROJECT_CONFIG]: '{"decisions":{"file":"notes/log.md","format":"journal-md"}}',
    '/work/project/docs/decisions/decisions.jsonl': '',
    '/work/project/.claude/brain/decisions.md': '# Decisions\n',
    '/work/project/brain/decisions.md': '# Decision log\n',
    '/work/project/DECISION_JOURNAL.md': '# Decision Journal\n',
  }
  const order: [string, string][] = [
    [PROJECT_CONFIG, 'notes/log.md (journal-md)'],
    ['/work/project/docs/decisions/decisions.jsonl', 'docs/decisions/decisions.jsonl (jsonl)'],
    ['/work/project/.claude/brain/decisions.md', '.claude/brain/decisions.md (markdown)'],
    ['/work/project/brain/decisions.md', 'brain/decisions.md (markdown)'],
    ['/work/project/DECISION_JOURNAL.md', 'DECISION_JOURNAL.md (journal-md)'],
  ]

  order.forEach(([present, expected], i) => {
    test(`picks ${expected} ahead of everything after it`, { timeoutMs: 20_000 }, async ($, on) => {
      const files: Record<string, string> = {}
      for (const [path] of order.slice(i)) files[path] = ALL[path] ?? ''
      world(on, files)
      await $.session.start(START)
      expect(await targetLine($)).toContain(expected)
      expect(present in files).toBe(true)
    })
  })

  test('an ADR directory without a jsonl gets docs/decisions/decisions.jsonl, created on first record', async ($, on) => {
    world(on, {}, { '/work/project/docs/decisions': ['ADR-001-ionic.md', 'ADR-002-state.md'] })
    await $.session.start(START)
    expect(await targetLine($)).toBe('Decisions · docs/decisions/decisions.jsonl (jsonl) · created on first record')
  })

  test('a docs/decisions directory with no ADR files falls through to the default', async ($, on) => {
    world(on, {}, { '/work/project/docs/decisions': ['README.md'] })
    await $.session.start(START)
    expect(await targetLine($)).toContain('.claude/decisions.jsonl (jsonl)')
  })

  test('nothing found: .claude/decisions.jsonl', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    expect(await targetLine($)).toBe('Decisions · .claude/decisions.jsonl (jsonl) · created on first record')
  })

  test('an override pointing outside the project is ignored with a note', async ($, on) => {
    world(on, {
      [PROJECT_CONFIG]: '{"decisions":{"file":"../elsewhere.md","format":"brain-md"}}',
      '/work/project/brain/decisions.md': '# Decision log\n',
    })
    await $.session.start(START)
    const out = await $.command.run({ command: 'decisions', args: 'text' })
    expect(out.text).toContain('brain/decisions.md (markdown)')
    expect(out.text).toContain('Note: .claude/loopkeeper.json, "decisions" section: "file" must be a relative path inside the project')
  })

  test('/decisions reload detects again', async ($, on) => {
    const w = world(on, {})
    await $.session.start(START)
    w.files['/work/project/DECISION_JOURNAL.md'] = '# Decision Journal\n'
    const out = await $.command.run({ command: 'decisions', args: 'reload' })
    expect(out.text).toBe('Target: DECISION_JOURNAL.md (journal-md, found). 0 recent entries.')
  })
})

describe('/decide', () => {
  test('appends a jsonl entry, toasts and replies with the file', async ($, on) => {
    const existing = '{"id":"ADR-0001","date":"2026-08-01","title":"Old"}\n'
    const w = world(on, { '/work/project/docs/decisions/decisions.jsonl': existing })
    await $.session.start(START)
    const out = await $.command.run({ command: 'decide', args: 'Use pnpm over Nx -- fewer moving parts #tooling #ci' })
    expect(out.text).toBe('Recorded D-20261008-1405 in docs/decisions/decisions.jsonl')
    expect(w.toasts).toEqual(['Recorded in docs/decisions/decisions.jsonl'])
    expect(w.writes.length).toBe(1)
    expect(w.writes[0]?.path).toBe('/work/project/docs/decisions/decisions.jsonl')
    const text = w.writes[0]?.text ?? ''
    expect(text.startsWith(existing)).toBe(true)
    expect(JSON.parse(text.slice(existing.length))).toEqual({
      id: 'D-20261008-1405',
      date: '2026-10-08',
      decision: 'Use pnpm over Nx',
      why: 'fewer moving parts',
      tags: ['tooling', 'ci'],
      session: 'sess-1',
      by: 'user',
    })
  })

  test('appends to a decisions.md under .claude/brain', async ($, on) => {
    const existing = '# Decisions\n\n- 2026-10-01 — Older decision.\n'
    const w = world(on, { '/work/project/.claude/brain/decisions.md': existing })
    await $.session.start(START)
    await $.command.run({ command: 'decide', args: 'Keep it private -- IP review first #release' })
    expect(w.files['/work/project/.claude/brain/decisions.md']).toBe(
      existing + '- 2026-10-08 — Keep it private. Why: IP review first. #release\n',
    )
  })

  test('two decisions in one minute get distinct ids', async ($, on) => {
    const w = world(on, {})
    await $.session.start(START)
    await $.command.run({ command: 'decide', args: 'First' })
    const out = await $.command.run({ command: 'decide', args: 'Second' })
    expect(out.text).toBe('Recorded D-20261008-1405-2 in .claude/decisions.jsonl')
    const lines = (w.files['/work/project/.claude/decisions.jsonl'] ?? '').trim().split('\n')
    expect(lines.map(line => JSON.parse(line).decision)).toEqual(['First', 'Second'])
  })

  test('no decision: usage, nothing written', async ($, on) => {
    const w = world(on, {})
    await $.session.start(START)
    const out = await $.command.run({ command: 'decide', args: '  #tag ' })
    expect(out.text).toContain('Usage: /decide')
    expect(w.writes).toEqual([])
  })

  test('a failed write is reported, not thrown', async ($, on) => {
    world(on, {}, {}, 'read-only file system')
    await $.session.start(START)
    const out = await $.command.run({ command: 'decide', args: 'Something' })
    expect(out.text).toContain('Not recorded:')
    expect(out.text).toContain('read-only file system')
  })
})

describe('record_decision tool', () => {
  test('appends with by: claude and replies with the file path', async ($, on) => {
    const existing = '# Decision Journal\n\n## 2026-07-12 — Older\n- **What:** older.\n'
    const w = world(on, { '/work/project/DECISION_JOURNAL.md': existing })
    await $.session.start(START)
    const out = await $.tool.call({ tool: TOOL, decision: 'Cap orders at three a day', why: 'risk', tags: ['risk'] })
    expect(out).toEqual({ result: 'Recorded D-20261008-1405 in DECISION_JOURNAL.md' })
    expect(w.files['/work/project/DECISION_JOURNAL.md']).toBe(
      existing +
        '\n## 2026-10-08 — Cap orders at three a day\n- **What:** Cap orders at three a day.\n- **Why:** risk.\n- **Tags:** #risk\n',
    )
    expect(w.toasts).toEqual(['Recorded in DECISION_JOURNAL.md'])
  })

  test('jsonl entries from the tool say by: claude', async ($, on) => {
    const w = world(on, {})
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, decision: 'Use Zod' })
    expect(JSON.parse(w.files['/work/project/.claude/decisions.jsonl'] ?? '{}')).toMatchObject({ decision: 'Use Zod', by: 'claude', why: '', tags: [] })
  })

  test('a call without a decision is answered, nothing written', async ($, on) => {
    const w = world(on, {})
    await $.session.start(START)
    const out = await $.tool.call({ tool: TOOL, why: 'no decision' })
    expect(String(out.result)).toContain('needs a non-empty "decision"')
    expect(w.writes).toEqual([])
  })

  test('other tools pass through', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    // the fixture's engine answers any tool that is not ours with 'ran'
    expect(await $.tool.call({ tool: 'Bash', command: 'ls' })).toEqual({ result: 'ran' })
  })
})

describe('/decisions', () => {
  const BRAIN =
    '# Decisions\n\n' +
    Array.from({ length: 25 }, (_, i) => `- 2026-09-${String(i + 1).padStart(2, '0')} — Decision ${i + 1}.`).join('\n') +
    '\n'

  test('text lists the last 20, newest first', async ($, on) => {
    world(on, { '/work/project/brain/decisions.md': BRAIN })
    await $.session.start(START)
    const out = await $.command.run({ command: 'decisions', args: 'text' })
    const lines = String(out.text).split('\n')
    expect(lines[0]).toBe('Decisions · brain/decisions.md (markdown)')
    expect(lines[1]).toBe('Last 20, newest first:')
    expect(lines[2]).toBe('2026-09-25  Decision 25.')
    expect(lines[lines.length - 1]).toBe('2026-09-06  Decision 6.')
  })

  test('the pane shows the target, the entries and its buttons', async ($, on) => {
    const w = world(on, { '/work/project/brain/decisions.md': '# D\n\n- 2026-10-08 — Use pnpm. Why: simple. #ci\n' })
    await $.session.start(START)
    expect(await $.command.run({ command: 'decisions', args: '' })).toEqual({})
    expect(w.panes).toEqual([PANE_ID])
    const ui = await $.ui.mount({
      plugin: 'loopkeeper',
      component: 'Pane',
      requestId: PANE_ID,
      surface: 'terminal',
      viewport: { columns: 120, rows: 40 },
      props: { title: 'Decisions', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: 'brain/decisions.md · markdown' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Use pnpm.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  simple.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  #ci' })).toBeDefined()
    expect(await ui.find({ key: 'refresh' })).toBeDefined()

    w.files['/work/project/brain/decisions.md'] += '- 2026-10-09 — Added elsewhere.\n'
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: 'Added elsewhere.' })).toBeDefined()

    // kit 3.1: the pane is a page (one row between blocks), the entries a list (one row between them), and the
    // controls a kit button row with Refresh focused
    type N = { type?: string; props?: Record<string, any>; children?: unknown[] }
    const kids = (n: N): N[] => ((n.children ?? n.props?.children ?? []) as N[]).filter(c => c && typeof c === 'object')
    const all = (n: N): N[] => [n, ...kids(n).flatMap(all)]
    const tree = (await ui.drawn()) as N
    expect(tree.props).toMatchObject({ flexDirection: 'column', rowGap: 1 })
    const entries = all(tree).find(n => kids(n).some(c => c.props?.key === 'entry-0')) as N
    expect(entries.props).toMatchObject({ flexDirection: 'column', rowGap: 1 })
    expect(kids(entries).map(c => c.props?.key)).toEqual(['entry-0', 'entry-1'])
    const controls = all(tree).find(n => kids(n).some(c => c.props?.key === 'refresh')) as N
    expect(controls.props).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, rowGap: 1 })
    expect(kids(controls).map(c => c.props?.key)).toEqual(['refresh', 'close', 'watch-toggle'])
    expect(kids(controls)[0]!.props).toMatchObject({ plain: true, autoFocus: true })

    await ui.press({ key: 'close' })
    expect(w.panes).toEqual([PANE_ID, 'closed:' + PANE_ID])
    await ui.unmount()
  })

  const WATCH_PANE = (surface: 'terminal' | 'desktop') => ({
    plugin: 'loopkeeper',
    component: 'Pane',
    requestId: PANE_ID,
    surface,
    viewport: { columns: 120, rows: 40 },
    props: { title: 'Decisions', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  /** The watch button's label on both surfaces (they agree), after an optional press of it. */
  async function watchLabel($: any, press = false): Promise<string> {
    const labels: string[] = []
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount(WATCH_PANE(surface))
      if (press && surface === 'terminal') await ui.press({ key: 'watch-toggle' })
      labels.push(String((await ui.find({ key: 'watch-toggle' }))?.props.label))
      await ui.unmount()
    }
    expect(labels[1]).toBe(labels[0])
    return labels[0]
  }

  test('the watch button says Turn watch on when the watch is off by default, Pause watch when on, Resume watch when paused', { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, {})
    await $.session.start(START)
    expect(await watchLabel($)).toBe('Turn watch on')
    expect(await watchLabel($, true)).toBe('Pause watch')
    expect(w.store.get('loopkeeper:decisions:watch')).toBe(true)
    expect(await watchLabel($, true)).toBe('Resume watch')
    expect(w.store.get('loopkeeper:decisions:watch')).toBe(false)
    expect(await watchLabel($, true)).toBe('Pause watch')
  })

  test('the watch button says Turn watch on when a config file turns the watch off', { timeoutMs: 20_000 }, async ($, on) => {
    world(on, { [USER_CONFIG]: '{"decisions":{"watch": true}}', [PROJECT_CONFIG]: '{"decisions":{"watch": false}}' })
    await $.session.start(START)
    expect(await watchLabel($)).toBe('Turn watch on')
  })

  test('the watch button says Pause watch when a config file turns the watch on', async ($, on) => {
    world(on, { [USER_CONFIG]: '{"decisions":{"watch": true}}' })
    await $.session.start(START)
    expect(await watchLabel($)).toBe('Pause watch')
  })

  test('band on|off is saved in the store', async ($, on) => {
    const w = world(on, {})
    await $.session.start(START)
    expect((await $.command.run({ command: 'decisions', args: 'band off' })).text).toBe('Band off.')
    expect(w.store.get(BAND_KEY)).toBe(false)
    expect((await $.command.run({ command: 'decisions', args: 'band' })).text).toContain('Band is off')
    expect((await $.command.run({ command: 'decisions', args: 'band on' })).text).toBe('Band on.')
    expect(w.store.get(BAND_KEY)).toBe(true)
  })

  test('unknown arguments print usage', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    expect((await $.command.run({ command: 'decisions', args: 'frobnicate' })).text).toContain('Usage: /decisions')
  })
})

describe('the band above the prompt', () => {
  const BAND = {
    plugin: 'loopkeeper',
    component: 'AbovePrompt',
    requestId: 'above-prompt',
    surface: 'terminal',
    viewport: { columns: 120, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  } as const

  test('hidden until a decision is recorded, then one line with the count', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
    await $.command.run({ command: 'decide', args: 'One' })
    await $.tool.call({ tool: TOOL, decision: 'Two' })
    await $.command.run({ command: 'decide', args: 'Three' })
    const line = lineOf(await ui.drawn(), 'decisions')
    expect(linePlain(line)).toBe('decisions  ● 3 this session')
    expect(line?.label).toEqual({ text: 'decisions', color: undefined, bold: true })
    expect(line?.chips).toEqual([{ text: '● 3 this session', color: TONES.info.fg, bold: true }])
    expect(line?.right).toBeUndefined()
    // the watch on adds a quiet right side
    await $.command.run({ command: 'decide', args: 'watch on' })
    const watching = lineOf(await ui.drawn(), 'decisions')
    expect(linePlain(watching)).toBe('decisions  ● 3 this session   watch on')
    expect(watching?.right?.color).toBe(TONES.muted.fg)
    await ui.unmount()
  })

  test('the count line draws the same on the terminal and the desktop, with no dimColor or backgroundColor', async ($, on) => {
    world(on, {})
    await $.session.start(START)
    await $.command.run({ command: 'decide', args: 'One' })
    const plain: string[] = []
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      const tree = await ui.drawn()
      const line = lineOf(tree, 'decisions')
      expect(line?.label).toEqual({ text: 'decisions', color: undefined, bold: true })
      expect(line?.chips).toEqual([{ text: '● 1 this session', color: TONES.info.fg, bold: true }])
      expect(JSON.stringify(tree)).not.toMatch(/dimColor|backgroundColor/)
      plain.push(linePlain(line))
      await ui.unmount()
    }
    expect(plain[0]).toBe('decisions  ● 1 this session')
    expect(plain[1]).toBe(plain[0])
  })

  test('band off hides it, and the setting is read back at start', async ($, on) => {
    const w = world(on, {})
    w.store.set(BAND_KEY, false)
    await $.session.start(START)
    await $.command.run({ command: 'decide', args: 'One' })
    const ui = await $.ui.mount(BAND)
    expect(lineOf(await ui.drawn(), 'decisions')).toBeUndefined()
    await $.command.run({ command: 'decisions', args: 'band on' })
    expect(linePlain(lineOf(await ui.drawn(), 'decisions'))).toBe('decisions  ● 1 this session')
    await ui.unmount()
  })

  test('the setting comes back after /clear', async ($, on) => {
    const w = world(on, {})
    w.store.set(BAND_KEY, false)
    await $.classic.SessionStart({ source: 'clear' })
    expect((await $.command.run({ command: 'decisions', args: 'band' })).text).toContain('Band is off')
  })
})

describe('the log target in the config files', () => {
  test('file and format come from the decisions section of the project file, with the public name markdown', async ($, on) => {
    const w = world(on, { [PROJECT_CONFIG]: '{"decisions":{"file":"notes/log.md","format":"markdown"}}' })
    await $.session.start(START)
    expect(await targetLine($)).toBe('Decisions · notes/log.md (markdown) · created on first record')
    await $.command.run({ command: 'decide', args: 'Keep it small -- less to review #scope' })
    expect(w.files['/work/project/notes/log.md']).toBe('# Decisions\n\n- 2026-10-08 — Keep it small. Why: less to review. #scope\n')
  })

  test('brain-md is accepted as an alias of markdown', async ($, on) => {
    world(on, { [PROJECT_CONFIG]: '{"decisions":{"file":"notes/log.md","format":"brain-md"}}' })
    await $.session.start(START)
    expect(await targetLine($)).toContain('notes/log.md (markdown)')
  })

  test('the user file cannot move the log', async ($, on) => {
    world(on, { [USER_CONFIG]: '{"decisions":{"file":"elsewhere.md","format":"journal-md"}}' })
    await $.session.start(START)
    expect(await targetLine($)).toContain('.claude/decisions.jsonl (jsonl)')
  })

  test('a config with other sections or only watch settings is not an override and raises no note', async ($, on) => {
    world(on, { [PROJECT_CONFIG]: '{"pipeline":{"approval":"ask"},"decisions":{"watch":true}}', '/work/project/DECISION_JOURNAL.md': '# Decision Journal\n' })
    await $.session.start(START)
    const out = await $.command.run({ command: 'decisions', args: 'text' })
    expect(out.text).toContain('DECISION_JOURNAL.md (journal-md)')
    expect(out.text).not.toContain('Note:')
  })

  test('a bad format is a note and detection carries on', async ($, on) => {
    world(on, { [PROJECT_CONFIG]: '{"decisions":{"file":"notes/log.md","format":"yaml"}}' })
    await $.session.start(START)
    expect(await targetLine($)).toContain('.claude/decisions.jsonl (jsonl)')
    expect((await $.command.run({ command: 'decisions', args: 'text' })).text).toContain(
      'Note: .claude/loopkeeper.json, "decisions" section: "format" must be one of jsonl, markdown, journal-md',
    )
  })

  test('a broken project config is a note and detection carries on', async ($, on) => {
    world(on, { [PROJECT_CONFIG]: '{ nope' })
    await $.session.start(START)
    expect((await $.command.run({ command: 'decisions', args: 'text' })).text).toContain('Note: .claude/loopkeeper.json is not valid JSON')
  })
})

describe('registration', () => {
  test('/decide, /decisions and the record_decision tool are registered, and the tool text names no personal tool', async ($, on) => {
    const w = sharedWorld(on, {})
    await start($)
    expect(w.registered).toEqual(expect.arrayContaining(['decide', 'decisions']))
    expect(w.tools.map(t => t.name)).toContain('record_decision')
    const text = w.tools.map(t => t.description ?? '').join('\n')
    expect(text).toContain('a decisions.md under .claude/brain')
    expect(text).not.toMatch(/brain.sync|decision.pad/)
  })

  test('a refused /decisions leaves the tool and /decide working', async ($, on) => {
    const w = sharedWorld(on, { refuse: ['decisions'] })
    await start($)
    expect(w.registered).toContain('decide')
    expect(w.registered).not.toContain('decisions')
    expect(w.tools.map(t => t.name)).toContain('record_decision')
  })
})

describe('/lk, the end of the chain', () => {
  test('status ends with the decisions line, once', async ($, on) => {
    sharedWorld(on, {})
    await start($)
    await $.command.run({ command: 'decide', args: 'One' })
    const text = await lk($, 'status')
    expect(text.match(/decisions ●/g)?.length).toBe(1)
    expect(text.split('\n').pop()).toBe('decisions ● 1 this session · watch off')
    expect(await lk($, 'status', 'loopkeeper')).toBe(text)
  })

  test('an unknown word is answered once, and shared words never are unknown', async ($, on) => {
    sharedWorld(on, {})
    await start($)
    const unknown = await lk($, 'frobnicate')
    expect(unknown.match(/unknown sub-command/g)?.length).toBe(1)
    expect(unknown.split('\n').length).toBe(1)
    // it names the words to try: status, stage (the Stage pane) and help (the keys)
    for (const word of ['/lk status', '/lk stage', '/lk help']) expect(unknown).toContain(word)
    expect(await lk($, 'reload')).toContain('decisions ● reloaded')
    expect(await lk($, 'reload')).not.toContain('unknown')
    expect(await lk($, 'band')).not.toContain('unknown')
  })

  test('/lk band decisions on|off sets the same store key as /decisions band', async ($, on) => {
    const w = sharedWorld(on, {})
    await start($)
    expect(await lk($, 'band decisions off')).toContain('band off')
    expect(w.store.get(BAND_KEY)).toBe(false)
    expect((await $.command.run({ command: 'decisions', args: 'band' })).text).toContain('Band is off')
    expect(await lk($, 'band on')).toContain('band on')
    expect(w.store.get(BAND_KEY)).toBe(true)
    // another concern named: not ours (the stage answers for its own band)
    expect(await lk($, 'band stage off')).not.toContain('decisions')
    expect(w.store.get(BAND_KEY)).toBe(true)
  })

  test('/lk reload reads the config and the log target again', async ($, on) => {
    const w = sharedWorld(on, { files: {} })
    await start($)
    w.writes.length = 0
    expect(await lk($, 'reload')).toContain('.claude/decisions.jsonl (jsonl)')
  })
})

describe('the decisions band in the stack of bands', () => {
  test('one line under no other band, and above the lines of the concerns after it', async ($, on) => {
    sharedWorld(on, {})
    await start($)
    await $.command.run({ command: 'decide', args: 'One' })
    const ui = await $.ui.mount(BAND_PROPS)
    const top = await ui.find({ type: 'Box' })
    const lines = texts(top)
    expect(linePlain(lineOf(await ui.drawn(), 'decisions'))).toBe('decisions  ● 1 this session')
    expect(lines).toContain('drawn by Claude Code')
    expect(lines.indexOf('● 1 this session')).toBeLessThan(lines.indexOf('drawn by Claude Code'))
    await ui.unmount()
  })

  test('a survey in view leaves the band to the others', async ($, on) => {
    sharedWorld(on, {})
    await start($)
    await $.command.run({ command: 'decide', args: 'One' })
    const ui = await $.ui.mount({ ...BAND_PROPS, props: { ...BAND_PROPS.props, hasSurvey: true } })
    expect(await ui.find({ type: 'Text', text: /this session/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('the hub row and the nav bar', () => {
  const SURFACES = ['terminal', 'desktop'] as const
  const SLOW = { timeoutMs: 20_000 }
  const at = (requestId: string, title: string, surface: string) =>
    ({
      plugin: 'loopkeeper',
      component: 'Pane',
      requestId,
      surface,
      viewport: { columns: 120, rows: 40 },
      props: { title, isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    }) as never
  const hub = (surface: string) => at('loopkeeper-hub', 'loopkeeper', surface)

  type Node = { type?: string; props?: Record<string, any>; children?: unknown[] }
  const nodesIn = (n: any): Node[] => (n && typeof n === 'object' ? [n, ...((n.children ?? n.props?.children ?? []) as unknown[]).flatMap(nodesIn)] : [])
  const textIn = (n: any): string =>
    typeof n === 'string' ? n : n && typeof n === 'object' ? ((n.children ?? n.props?.children ?? []) as unknown[]).map(textIn).join('') : ''

  /** A world with ui.open recorded (its options) and ui.panes answering for the last pane opened. */
  function linked(on: On, opts: Parameters<typeof sharedWorld>[1] = {}) {
    const opened: any[] = []
    const focused = { value: true }
    ;(on as any)('ui.open', {}, ($: unknown, e: any, next: (e: unknown) => unknown) => {
      opened.push(e)
      return next(e)
    })
    const w = sharedWorld(on, opts)
    ;(on as any)('ui.panes', () => ({ value: opened.length ? [{ id: opened[opened.length - 1].id, title: '', isShown: true, isFocused: focused.value, isPlaced: true }] : [] }))
    return { w, opened, focused }
  }

  for (const surface of SURFACES) {
    test(`hub on ${surface}: the Decisions row is 6: Decisions and the status words, quiet; a press switches to the pane`, SLOW, async ($, on) => {
      const { w, opened, focused } = linked(on)
      await start($)
      await $.command.run({ command: 'decide', args: 'One' })
      const ui = await $.ui.mount(hub(surface))
      const row = await ui.find({ key: 'hub-decisions' })
      expect(textIn(row)).toContain('1 this session · watch off')
      expect((await ui.find({ key: 'panel-decisions' }))?.props).toMatchObject({ label: 'Decisions', hotkey: '6', plain: true })
      const words = nodesIn(row).find(n => n.type === 'Text' && textIn(n).startsWith('1 this session'))
      expect(words?.props?.color).toBe(TONES.muted.fg)
      // the last row of the chain: the other mods' header and the actions follow it
      if (surface === 'terminal') {
        const text = render(await ui.drawn(), 100)
        expect(text).toContain('6: Decisions')
        expect(text.indexOf('5: Reviews')).toBeLessThan(text.indexOf('6: Decisions'))
      }
      focused.value = false
      await ui.press({ key: 'panel-decisions' })
      expect(w.panes.slice(-2)).toEqual(['closed:loopkeeper-hub', PANE_ID])
      expect(opened[opened.length - 1]).toMatchObject({ id: PANE_ID, title: 'Decisions', focus: true, closeOnEscape: true })
      // the ctrl+x tab hint in the terminal (the press's surface), never on the desktop
      expect(w.toasts.filter(t => t === 'ctrl+x tab to focus the panel').length).toBe(surface === 'terminal' ? 1 : 0)
      await ui.unmount()
    })

    test(`Decisions pane on ${surface}: the nav bar leads, Decisions bold, the others digit Buttons that switch panes`, SLOW, async ($, on) => {
      const { w, opened } = linked(on)
      await start($)
      const ui = await $.ui.mount(at(PANE_ID, 'Decisions', surface))
      const items = ((await ui.find({ key: 'nav' }))?.children ?? []) as Node[]
      expect(items.map(n => n.type)).toEqual(['Button', 'Button', 'Button', 'Button', 'Button', 'Button', 'Text'])
      expect(textIn(items[6])).toBe('Decisions')
      expect(items[6].props).toMatchObject({ bold: true, color: TONES.accent.fg })
      const buttons = items.filter(n => n.type === 'Button')
      expect(buttons.map(n => n.props?.hotkey)).toEqual(['0', '1', '2', '3', '4', '5'])
      expect(buttons.map(n => n.props?.label)).toEqual(['Hub', 'Stage', 'Gates', 'Files', 'Routes', 'Reviews'])
      expect(buttons.every(n => n.props?.plain === true)).toBe(true)
      if (surface === 'terminal') expect(render(await ui.drawn(), 100).split('\n')[0]).toBe('0: Hub  1: Stage  2: Gates  3: Files  4: Routes  5: Reviews  Decisions')
      // the pane's own letter hotkeys stay: r Refresh, c Close, w the watch
      expect((await ui.find({ key: 'refresh' }))?.props?.hotkey).toBe('r')
      expect((await ui.find({ key: 'watch-toggle' }))?.props?.hotkey).toBe('w')
      await ui.press({ key: 'routes' })
      expect(w.panes.slice(-2)).toEqual(['closed:' + PANE_ID, 'loopkeeper-routes'])
      await ui.press({ key: 'hub' })
      expect(w.panes.slice(-2)).toEqual(['closed:' + PANE_ID, 'loopkeeper-hub'])
      expect(opened[opened.length - 1]).toMatchObject({ id: 'loopkeeper-hub', focus: true, closeOnEscape: true, rows: 22 })
      await ui.unmount()
    })
  }

  test('the hub keeps the Decisions row with the band off', SLOW, async ($, on) => {
    linked(on)
    await start($)
    await lk($, 'band decisions off')
    const ui = await $.ui.mount(hub('terminal'))
    expect(textIn(await ui.find({ key: 'hub-decisions' }))).toContain('0 this session · watch off · band off')
    await ui.unmount()
  })

  test('with CLAUDE_MODS_DISABLE=loopkeeper the hub keeps the Decisions row', SLOW, async ($, on) => {
    linked(on, { env: { CLAUDE_MODS_DISABLE: 'loopkeeper' } })
    await start($)
    const ui = await $.ui.mount(hub('desktop'))
    expect(textIn(await ui.find({ key: 'hub-decisions' }))).toContain('0 this session · watch off')
    expect(await ui.find({ key: 'panel-decisions' })).toBeDefined()
    await ui.unmount()
  })
})
