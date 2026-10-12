import { describe, expect, test } from 'claude-code/testing'

import {
  appendEntry,
  isAdrFile,
  lastEntries,
  normalizeFormat,
  parseDecideArgs,
  parseEntries,
  parseOverride,
  resolveInside,
  stampOf,
  textListing,
  toolInputOf,
  uniqueId,
} from '../hooks/lib/decisionFormats.ts'
import type { DecisionRecord } from '../hooks/lib/decisionFormats.ts'

const REC: DecisionRecord = {
  id: 'D-20261008-1405',
  date: '2026-10-08',
  decision: 'Use pnpm workspaces over Nx',
  why: 'fewer moving parts',
  tags: ['tooling', 'monorepo'],
  session: 'sess-1',
  by: 'user',
}

describe('/decide parsing', () => {
  test('decision, why and tags', async () => {
    expect(parseDecideArgs('Use pnpm workspaces over Nx -- fewer moving parts #tooling #monorepo')).toEqual({
      decision: 'Use pnpm workspaces over Nx',
      why: 'fewer moving parts',
      tags: ['tooling', 'monorepo'],
    })
  })

  test('why and tags are optional', async () => {
    expect(parseDecideArgs('  Keep the API private  ')).toEqual({ decision: 'Keep the API private', why: '', tags: [] })
    expect(parseDecideArgs('Ship weekly #process')).toEqual({ decision: 'Ship weekly', why: '', tags: ['process'] })
    expect(parseDecideArgs('Ship weekly -- smaller diffs')).toEqual({ decision: 'Ship weekly', why: 'smaller diffs', tags: [] })
  })

  test('tags anywhere, duplicates dropped, a # inside a word is text', async () => {
    expect(parseDecideArgs('#db Use Postgres for C# services -- joins #db #storage')).toEqual({
      decision: 'Use Postgres for C# services',
      why: 'joins',
      tags: ['db', 'storage'],
    })
  })

  test('a double dash inside a word does not split', async () => {
    expect(parseDecideArgs('Pass --strict to tsc -- catches more')).toEqual({
      decision: 'Pass --strict to tsc',
      why: 'catches more',
      tags: [],
    })
  })

  test('empty input gives an empty decision', async () => {
    expect(parseDecideArgs('').decision).toBe('')
    expect(parseDecideArgs(undefined).decision).toBe('')
    expect(parseDecideArgs('-- only a why #x').decision).toBe('')
  })

  test('tool input is guarded and normalized', async () => {
    expect(toolInputOf({ decision: ' A\nB ', why: 3, tags: ['#x', 'x', '', 4, 'y z'] })).toEqual({
      decision: 'A B',
      why: '',
      tags: ['x', 'yz'],
    })
    expect(toolInputOf(null)).toEqual({ decision: '', why: '', tags: [] })
    expect(toolInputOf({ decision: 'D', tags: 'a, b' }).tags).toEqual(['a', 'b'])
  })
})

describe('stamps and ids', () => {
  test('local date and minute id', async () => {
    const ms = new Date(2026, 9, 8, 14, 5, 30).getTime()
    expect(stampOf(ms)).toEqual({ date: '2026-10-08', id: 'D-20261008-1405' })
  })

  test('an id already in the log gets a suffix', async () => {
    const log = '{"id":"D-20261008-1405"}\n{"id":"D-20261008-1405-2"}\n'
    expect(uniqueId('D-20261008-1405', log)).toBe('D-20261008-1405-3')
    expect(uniqueId('D-20261008-1406', log)).toBe('D-20261008-1406')
    expect(uniqueId('D-1', null)).toBe('D-1')
  })
})

describe('appending', () => {
  test('jsonl: one object per line, existing lines kept', async () => {
    const existing = '{"id":"ADR-0001","date":"2026-08-01","title":"Old","decision":"Old one"}\n'
    const out = appendEntry(existing, 'jsonl', REC)
    expect(out.startsWith(existing)).toBe(true)
    const added = out.slice(existing.length)
    expect(added.endsWith('\n')).toBe(true)
    expect(added.split('\n').length).toBe(2)
    expect(JSON.parse(added)).toEqual({
      id: 'D-20261008-1405',
      date: '2026-10-08',
      decision: 'Use pnpm workspaces over Nx',
      why: 'fewer moving parts',
      tags: ['tooling', 'monorepo'],
      session: 'sess-1',
      by: 'user',
    })
  })

  test('jsonl: a file without a final newline gets one first', async () => {
    const existing = '{"id":"A"}'
    const out = appendEntry(existing, 'jsonl', REC)
    expect(out.startsWith(existing + '\n{')).toBe(true)
    expect(out.trim().split('\n').length).toBe(2)
  })

  test('jsonl: a new file is just the entry', async () => {
    const out = appendEntry(null, 'jsonl', REC)
    expect(out.split('\n').length).toBe(2)
    expect(JSON.parse(out).by).toBe('user')
  })

  test('markdown: matches the dated em-dash bullets', async () => {
    const existing = '# Decisions\n\n- 2026-10-01 \u2014 Zod schemas are the single source of types.\n'
    const out = appendEntry(existing, 'markdown', REC)
    expect(out.startsWith(existing)).toBe(true)
    expect(out.slice(existing.length)).toBe(
      '- 2026-10-08 \u2014 Use pnpm workspaces over Nx. Why: fewer moving parts. #tooling #monorepo\n',
    )
  })

  test('markdown: frontmatter and a missing final newline are preserved', async () => {
    const existing = '---\ntype: log\n---\n# Decision log\n\n- 2026-09-27 \u2014 Kit lives here.'
    const out = appendEntry(existing, 'markdown', { ...REC, why: '', tags: [] })
    expect(out).toBe(existing + '\n- 2026-10-08 \u2014 Use pnpm workspaces over Nx.\n')
  })

  test('markdown: an unrecognised bullet style gets the bold-date fallback', async () => {
    const existing = '# Notes\n\n- something else\n'
    const out = appendEntry(existing, 'markdown', REC)
    expect(out.slice(existing.length)).toBe(
      '- **2026-10-08** \u2014 Use pnpm workspaces over Nx. _Why:_ fewer moving parts. #tooling #monorepo\n',
    )
  })

  test('markdown: a new file gets a heading', async () => {
    expect(appendEntry(null, 'markdown', REC).startsWith('# Decisions\n\n- 2026-10-08 \u2014 ')).toBe(true)
  })

  test('journal-md: a dated section after a blank line', async () => {
    const existing = '# Decision Journal\n\n## 2026-07-12 \u2014 Phase 2b done\n- **What:** Verified.\n'
    const out = appendEntry(existing, 'journal-md', REC)
    expect(out.startsWith(existing)).toBe(true)
    expect(out.slice(existing.length)).toBe(
      '\n## 2026-10-08 \u2014 Use pnpm workspaces over Nx\n' +
        '- **What:** Use pnpm workspaces over Nx.\n' +
        '- **Why:** fewer moving parts.\n' +
        '- **Tags:** #tooling #monorepo\n',
    )
  })

  test('journal-md: no extra blank line when the file already ends with one', async () => {
    const existing = '## 2026-07-12 \u2014 A\n- **What:** a.\n\n'
    const out = appendEntry(existing, 'journal-md', { ...REC, why: '', tags: [] })
    expect(out.slice(existing.length)).toBe('## 2026-10-08 \u2014 Use pnpm workspaces over Nx\n- **What:** Use pnpm workspaces over Nx.\n')
  })

  test('journal-md: a long decision gets a short heading', async () => {
    const decision = 'Adopt a single release train for every package so that versions are cut together and published from one workflow'
    const out = appendEntry('', 'journal-md', { ...REC, decision })
    const heading = out.split('\n').find(line => line.startsWith('## ')) ?? ''
    expect(heading.length < 100).toBe(true)
    expect(heading.endsWith('\u2026')).toBe(true)
  })
})

describe('parsing the last entries', () => {
  test('jsonl: own entries and ADR-style entries, newest first', async () => {
    const content =
      '{"id":"ADR-0001","date":"2026-08-01","title":"Env runs tools","decision":"long text","context":"ctx","tags":["arch"]}\n' +
      'not json\n' +
      '{"id":"D-20261008-1405","date":"2026-10-08","decision":"Use pnpm","why":"simple","tags":["tooling"],"session":"s","by":"user"}\n' +
      '{"id":"ADR-0002","date":"2026-08-12","title":"Cache first"}\n'
    const list = lastEntries(content, 'jsonl', 20)
    expect(list.map(e => e.decision)).toEqual(['Use pnpm', 'Cache first', 'Env runs tools'])
    expect(list[0]).toEqual({ id: 'D-20261008-1405', date: '2026-10-08', decision: 'Use pnpm', why: 'simple', tags: ['tooling'] })
    expect(list[2]?.why).toBe('ctx')
    expect(lastEntries(content, 'jsonl', 1).length).toBe(1)
  })

  test('markdown: bullets with project prefixes, why markers and tags', async () => {
    const content =
      '---\ntype: log\n---\n# Decision log\n\n' +
      '- 2026-09-27 \u2014 Kit lives in the shared folder.\n' +
      '- 2026-10-07 \u2014 [demo] Templates type two extra fields.\n' +
      '- 2026-10-08 \u2014 Use pnpm. Why: simple. #tooling #ci\n' +
      '- **2026-10-08** \u2014 Fallback style. _Why:_ no convention. #misc\n' +
      '- not a decision\n'
    const list = lastEntries(content, 'markdown', 20)
    expect(list.map(e => e.decision)).toEqual([
      'Fallback style.',
      'Use pnpm.',
      'Templates type two extra fields.',
      'Kit lives in the shared folder.',
    ])
    expect(list[0]).toEqual({ date: '2026-10-08', decision: 'Fallback style.', why: 'no convention.', tags: ['misc'] })
    expect(list[1]).toEqual({ date: '2026-10-08', decision: 'Use pnpm.', why: 'simple.', tags: ['tooling', 'ci'] })
    expect(list[2]?.tags).toEqual(['demo'])
  })

  test('journal-md: sections with What, Why and Tags lines', async () => {
    const content =
      '# Decision Journal\n\nIntro.\n\n' +
      '## 2026-07-12 \u2014 Phase 3 scaffolding\n- **What:** Two modules.\n- **Why in-repo sim:** nothing third-party.\n\n' +
      '## 2026-08-06 \u2014 Day 11 (midday)\n\n**Pre-flight.** ok\n\n' +
      '## 2026-10-08 \u2014 Use pnpm\n- **What:** Use pnpm.\n- **Why:** simple.\n- **Tags:** #tooling\n'
    const list = lastEntries(content, 'journal-md', 2)
    expect(list).toEqual([
      { date: '2026-10-08', decision: 'Use pnpm', why: 'simple.', tags: ['tooling'] },
      { date: '2026-08-06', decision: 'Day 11 (midday)', why: '', tags: [] },
    ])
    expect(parseEntries(content, 'journal-md')[0]?.why).toBe('nothing third-party.')
  })

  test('round trip: what each appender writes parses back', async () => {
    for (const format of ['jsonl', 'markdown', 'journal-md'] as const) {
      const list = parseEntries(appendEntry(null, format, REC), format)
      expect(list.length).toBe(1)
      expect(list[0]?.date).toBe('2026-10-08')
      expect(list[0]?.decision.startsWith('Use pnpm workspaces over Nx')).toBe(true)
      expect(list[0]?.why.startsWith('fewer moving parts')).toBe(true)
      expect(list[0]?.tags).toEqual(['tooling', 'monorepo'])
    }
  })

  test('nothing to parse', async () => {
    expect(parseEntries('', 'jsonl')).toEqual([])
    expect(parseEntries(undefined, 'markdown')).toEqual([])
  })
})

describe('paths and overrides', () => {
  test('paths stay inside the project', async () => {
    expect(resolveInside('docs/./decisions//log.jsonl')).toBe('docs/decisions/log.jsonl')
    expect(resolveInside('a/../b.md')).toBe('b.md')
    expect(resolveInside('../outside.md')).toBe(null)
    expect(resolveInside('a/../../x')).toBe(null)
    expect(resolveInside('/etc/passwd')).toBe(null)
    expect(resolveInside('C:\\x.md')).toBe(null)
    expect(resolveInside('~/x.md')).toBe(null)
    expect(resolveInside('')).toBe(null)
    expect(resolveInside(42)).toBe(null)
  })

  test('the override needs a file inside the project and a known format', async () => {
    const of = (o: unknown) => JSON.stringify({ decisions: o })
    expect(parseOverride(of({ file: 'notes/d.md', format: 'journal-md' }))).toEqual({ file: 'notes/d.md', format: 'journal-md' })
    expect('error' in (parseOverride(of({ file: '../d.md', format: 'jsonl' })) ?? {})).toBe(true)
    expect('error' in (parseOverride(of({ file: 'd.md', format: 'yaml' })) ?? {})).toBe(true)
    expect('error' in (parseOverride('nope') ?? {})).toBe(true)
  })

  test('the override reads the decisions section of the project config, and names it in its errors', async () => {
    const bad = parseOverride(JSON.stringify({ decisions: { file: '../d.md', format: 'jsonl' } }))
    expect(bad).toEqual({ error: '.claude/loopkeeper.json, "decisions" section: "file" must be a relative path inside the project' })
    const fmt = parseOverride(JSON.stringify({ decisions: { file: 'd.md', format: 'yaml' } }))
    expect(fmt).toEqual({ error: '.claude/loopkeeper.json, "decisions" section: "format" must be one of jsonl, markdown, journal-md' })
    expect(parseOverride('nope')).toEqual({ error: '.claude/loopkeeper.json is not valid JSON' })
    expect(parseOverride('[]')).toEqual({ error: '.claude/loopkeeper.json is not an object' })
    // a file in the old place of the keys (top level) is not an override
    expect(parseOverride(JSON.stringify({ file: 'd.md', format: 'jsonl' }))).toBeNull()
  })

  test('a config that names no log is not an override', async () => {
    expect(parseOverride('{}')).toBeNull()
    expect(parseOverride(JSON.stringify({ pipeline: { approval: 'ask' } }))).toBeNull()
    expect(parseOverride(JSON.stringify({ decisions: { watch: true, watchModel: 'sonnet' } }))).toBeNull()
    expect(parseOverride(JSON.stringify({ decisions: { file: '', watch: true } }))).toBeNull()
  })

  test('markdown is the public name of the decisions.md format and brain-md is still accepted', async () => {
    expect(normalizeFormat('markdown')).toBe('markdown')
    expect(normalizeFormat('brain-md')).toBe('markdown')
    expect(normalizeFormat('jsonl')).toBe('jsonl')
    expect(normalizeFormat('journal-md')).toBe('journal-md')
    expect(normalizeFormat('yaml')).toBeNull()
    expect(parseOverride(JSON.stringify({ decisions: { file: 'brain/decisions.md', format: 'brain-md' } }))).toEqual({
      file: 'brain/decisions.md',
      format: 'markdown',
    })
  })

  test('ADR file names', async () => {
    expect(isAdrFile('ADR-001-ionic.md')).toBe(true)
    expect(isAdrFile('0007-use-x.md')).toBe(true)
    expect(isAdrFile('INDEX.md')).toBe(false)
    expect(isAdrFile('README.md')).toBe(false)
  })

  test('text listing', async () => {
    const target = { file: 'brain/decisions.md', abs: '/w/brain/decisions.md', format: 'markdown' as const, exists: true, source: 'found' }
    const text = textListing(target, [{ date: '2026-10-08', decision: 'Use pnpm.', why: 'simple.', tags: ['ci'] }])
    expect(text).toBe('Decisions \u00b7 brain/decisions.md (markdown)\nLast 1, newest first:\n2026-10-08  Use pnpm.\n            why: simple.\n            #ci')
    expect(textListing(target, [])).toContain('No decisions yet')
  })
})
