// The classifier, the routing table merge and the rules block: pure, no $ (ported from gsd-orchestrator).
import { expect, test } from 'claude-code/testing'

import { classify, decide, explain, findTag, hasKeyword } from '../hooks/lib/classify.ts'
import { RULES } from '../hooks/lib/loopRules.ts'
import { buildConfig, defaultRouting, resolveModel } from '../hooks/lib/routingConfig.ts'

const config = defaultRouting()

test('recon descriptions route to recon', () => {
  expect(classify('Survey the repo and list config files', config).role).toBe('recon')
  expect(classify('Explore\nWhere is the auth middleware', config).role).toBe('recon')
})

test('execute descriptions route to execute', () => {
  const c = classify('Implement the login form and fix the build', config)
  expect(c.role).toBe('execute')
  expect(c.matched).toEqual(['implement', 'build', 'fix'])
})

test('verify descriptions route to verify', () => {
  expect(classify('Review the diff and lint the code', config).role).toBe('verify')
})

test('hard descriptions route to hard', () => {
  expect(classify('Design the caching strategy', config).role).toBe('hard')
})

test('no keyword means the default role', () => {
  const c = classify('general-purpose\nHelper\nDo the thing.', config)
  expect(c.role).toBe('default')
  expect(c.matched).toEqual([])
})

test('ties resolve hard > verify > execute > recon', () => {
  expect(classify('plan and verify', config).role).toBe('hard')
  expect(classify('verify then fix', config).role).toBe('verify')
  expect(classify('fix what you find', config).role).toBe('execute')
  expect(classify('find and review', config).role).toBe('verify')
})

test('more distinct hits beat priority', () => {
  expect(classify('search, grep and list files, then plan', config).role).toBe('recon')
})

test('keywords match at a word start, case-insensitively', () => {
  expect(hasKeyword('Run the TESTS', 'test')).toBe(true)
  expect(hasKeyword('the latest build', 'test')).toBe(false)
  expect(hasKeyword('Map  the auth flow', 'map the')).toBe(true)
})

test('tags are found in either form', () => {
  expect(findTag('Quick look [model:opus]')).toEqual({ kind: 'model', value: 'opus', raw: '[model:opus]' })
  expect(findTag('x [ROLE:Hard] y')).toEqual({ kind: 'role', value: 'hard', raw: '[ROLE:Hard]' })
  expect(findTag('[role:nonsense]')).toBeUndefined()
})

test('decide: teammates are routed like subagents', () => {
  const d = decide({ description: 'Review the API', subagentType: 'reviewer', isTeammate: true }, config, true)
  expect(d.source).toBe('routed')
  expect(d.setModel).toBe('sonnet')
  expect(d.isTeammate).toBe(true)
})

test('decide: forks are left to inherit', () => {
  const d = decide({ description: 'Design it', fork: true }, config, true)
  expect(d.setModel).toBeUndefined()
})

test('decide: a malformed spawn still yields a decision', () => {
  const d = decide({ description: 42, prompt: null } as any, config, true)
  expect(d.role).toBe('default')
  expect(d.setModel).toBe('sonnet')
})

test('config merge: defaults, then user, then project, then session', () => {
  const merged = buildConfig(
    { models: { opus: 'claude-opus-custom' }, roles: { recon: 'sonnet', verify: 'opus' } },
    { roles: { recon: 'opus', hard: { addKeywords: ['migration plan'] } } },
    { verify: 'haiku' },
  )
  expect(merged.roles.recon).toMatchObject({ model: 'opus', source: '.claude/loopkeeper.json' })
  expect(merged.roles.verify).toMatchObject({ model: 'haiku', source: 'session (/lk route)' })
  expect(merged.roles.execute.source).toBe('default')
  expect(merged.roles.hard.keywords).toContain('migration plan')
  expect(resolveModel('opus', merged)).toBe('claude-opus-custom')
})

test('config merge: broken layers are ignored', () => {
  const merged = buildConfig('nope', { roles: { recon: 7, bogus: 'opus' } }, null)
  expect(merged).toEqual(defaultRouting())
})

test('explain names the role, the model and the scores', () => {
  const text = explain('Design the caching strategy', config)
  expect(text).toContain('→ hard → opus (opus)')
  expect(text).toContain('hard 2 (design, strategy)')
})

test('the rules block stays under 25 lines', () => {
  expect(RULES.split('\n').length < 25).toBe(true)
  expect(RULES).toContain('GSD orchestrator mode is on.')
})
