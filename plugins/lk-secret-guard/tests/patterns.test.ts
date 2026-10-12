import { expect, test } from 'claude-code/testing'

import { EMPTY_CONFIG, isPlaceholder, mask, mergeConfig, pathMatches, scan } from '../hooks/patterns'
import { FAKE } from './world'

const ctx = { cwd: '/work', home: '/home/tester' }
const scanAll = (text: string) => scan(text, { config: EMPTY_CONFIG, wordsApply: true })

test('mask never reveals a whole value, at any length', () => {
  for (const v of [...Object.values(FAKE), 'abcdefghijkl', 'abcdefg', 'abc', 'ab', 'a', '']) {
    const m = mask(v)
    if (v.length > 0) expect(m.includes(v)).toBe(false)
    expect(m).toContain('…')
  }
  expect(mask(FAKE.aws)).toBe('AKIA…456')
})

test('each credential is reported once, with its kind and action', () => {
  expect(scanAll(FAKE.anthropic).map(f => f.id)).toEqual(['anthropic-key'])
  expect(scanAll(FAKE.openaiProj).map(f => f.id)).toEqual(['openai-key'])
  expect(scanAll(`apiKey: "${FAKE.openai}"`).map(f => f.id)).toEqual(['openai-key'])
  expect(scanAll(FAKE.twilio)[0].action).toBe('warn')
  expect(scanAll(FAKE.jwt)[0].action).toBe('warn')
  expect(scanAll(FAKE.aws)[0].action).toBe('block')
})

test('block findings sort before warn findings', () => {
  const found = scanAll(`${FAKE.jwt} ${FAKE.aws}`)
  expect(found.map(f => f.action)).toEqual(['block', 'warn'])
})

test('placeholders', () => {
  expect(isPlaceholder('changeme123')).toBe(true)
  expect(isPlaceholder('zzzzzzzz')).toBe(true)
  expect(isPlaceholder('${SECRET}')).toBe(true)
  expect(isPlaceholder('q8Zt4LmP0wRb')).toBe(false)
})

test('path matching', () => {
  expect(pathMatches('.env', '.env', ctx)).toBe(true)
  expect(pathMatches('.env.*', 'config/.env.production', ctx)).toBe(true)
  expect(pathMatches('README', '/work/docs/README.md', ctx)).toBe(true)
  expect(pathMatches('public/', 'src/publication.ts', ctx)).toBe(false)
  expect(pathMatches('tests/fixtures/**', 'tests/fixtures/keys/a.pem', ctx)).toBe(true)
  expect(pathMatches('~/.claude/**', '~/.claude/x.json', ctx)).toBe(true)
  expect(pathMatches('**/*.secret', 'src/app.ts', ctx)).toBe(false)
})

test('merge: later layers replace path lists, word lists are unioned', () => {
  const merged = mergeConfig([
    { deny: ['A'], publicPaths: ['public/'], allowPaths: ['.env'] },
    { deny: ['B'], publicPaths: ['docs/'] },
  ])
  expect(merged.deny).toEqual(['A', 'B'])
  expect(merged.publicPaths).toEqual(['docs/'])
  expect(merged.allowPaths).toEqual(['.env'])
})
