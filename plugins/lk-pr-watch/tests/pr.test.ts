import { expect, test } from 'claude-code/testing'

import type { Snapshot, Watched } from '../types'
import {
  DEFAULTS,
  bandParts,
  bandText,
  bareUrls,
  cadenceMs,
  diff,
  durationOf,
  isDiscoveryCommand,
  isDue,
  isNoPr,
  isPushCommand,
  latestPerName,
  levelOf,
  linkable,
  matchTarget,
  mergeConfig,
  newWatched,
  parseCommand,
  parseGraphql,
  parsePrUrl,
  parsePrView,
  refOf,
} from '../hooks/pr'
import { MIXED, PR_VIEW, T0, T1, checkRun, fail, graphql, pass, pending, statusContext } from './fixtures'

const snapOf = (j: unknown): Snapshot => {
  const r = parseGraphql(JSON.stringify(j))
  if ('error' in r) throw new Error(r.error)
  return r.snap
}
const watchedWith = (snap: Snapshot | null, error = ''): Watched => ({ ...newWatched(refOf('acme', 'widgets', 42), 'branch'), snap, error })

test('parsePrView reads gh pr view JSON and rejects junk', () => {
  expect(parsePrView(JSON.stringify(PR_VIEW))).toEqual(PR_VIEW)
  expect(parsePrView('')).toBe(null)
  expect(parsePrView('not json')).toBe(null)
  expect(parsePrView(JSON.stringify({ number: 1, url: 'https://example.com/x' }))).toBe(null)
  expect(parsePrView(JSON.stringify({ number: 7, url: 'https://github.com/o/r/pull/7' }))).toMatchObject({
    number: 7,
    state: 'OPEN',
    mergeable: 'UNKNOWN',
    reviewDecision: '',
    isDraft: false,
  })
  expect(isNoPr('no pull requests found for branch "main"')).toBe(true)
  expect(isNoPr('HTTP 401: Bad credentials')).toBe(false)
})

test('parseGraphql buckets checks and keeps the latest run per name', () => {
  const s = snapOf(MIXED)
  expect(s).toMatchObject({ number: 42, state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED' })
  expect(s.checks.map(c => [c.name, c.bucket])).toEqual([
    ['build', 'pass'],
    ['lint', 'pass'],
    ['types', 'pass'],
    ['test', 'fail'],
    ['e2e', 'pending'],
  ])
  expect(s.checks[0]).toMatchObject({ link: 'https://github.com/acme/widgets/actions/runs/1/job/build', startedAt: T0, completedAt: T1 })

  // a re-run replaces the earlier run of the same check
  const old = checkRun({ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-10-09T09:00:00Z' })
  const rerun = checkRun({ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-09T09:30:00Z' })
  expect(snapOf(graphql({ contexts: [rerun, old] })).checks.map(c => c.bucket)).toEqual(['pass'])
  expect(latestPerName([old, rerun]).length).toBe(1)
  // a queued re-run (no start time yet) counts as the latest
  const queued = checkRun({ name: 'test', status: 'QUEUED', conclusion: null, startedAt: null })
  expect(snapOf(graphql({ contexts: [old, queued] })).checks[0].bucket).toBe('pending')

  // commit statuses and the other conclusions
  const more = snapOf(
    graphql({
      contexts: [
        statusContext('coverage', 'SUCCESS'),
        statusContext('deploy', 'PENDING'),
        statusContext('legacy', 'ERROR'),
        checkRun({ name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED', startedAt: T0 }),
        checkRun({ name: 'slow', status: 'COMPLETED', conclusion: 'CANCELLED', startedAt: T0 }),
        checkRun({ name: 'odd', status: 'COMPLETED', conclusion: 'TIMED_OUT', startedAt: T0 }),
      ],
    }),
  )
  expect(more.checks.map(c => c.bucket)).toEqual(['pass', 'pending', 'fail', 'skipping', 'cancel', 'fail'])

  // control characters from GitHub never reach the terminal
  expect(snapOf(graphql({ contexts: [pass('ci\x1b[31m\n')] })).checks[0].name).toBe('ci[31m')
})

test('parseGraphql reports errors instead of throwing', () => {
  expect(parseGraphql('')).toEqual({ error: 'gh returned no JSON' })
  expect(parseGraphql(JSON.stringify({ errors: [{ message: 'Could not resolve to a PullRequest' }] }))).toEqual({
    error: 'Could not resolve to a PullRequest',
  })
  expect(parseGraphql(JSON.stringify({ data: { repository: { pullRequest: null } } }))).toEqual({ error: 'PR not found' })
  // no rollup at all: no checks
  const bare = { data: { repository: { pullRequest: { number: 3, title: 't', state: 'OPEN', commits: { nodes: [] } } } } }
  expect(snapOf(bare)).toMatchObject({ number: 3, checks: [], mergeable: 'UNKNOWN', reviewDecision: '' })
})

test('diff: pending to failed, failed to green, review change, merged', () => {
  const p0 = snapOf(graphql({ contexts: [pass('build'), pending('test')] }))
  // first poll reports nothing
  expect(diff(null, p0)).toEqual([])
  // nothing changed
  expect(diff(p0, p0)).toEqual([])

  const p1 = snapOf(graphql({ contexts: [pass('build'), fail('test')] }))
  const t1 = diff(p0, p1)
  expect(t1.length).toBe(1)
  expect(t1[0]).toMatchObject({ kind: 'failed', check: { name: 'test' } })
  // still failing next poll: not new
  expect(diff(p1, p1)).toEqual([])

  const p2 = snapOf(graphql({ contexts: [pass('build'), pass('test')] }))
  expect(diff(p1, p2)).toEqual([{ kind: 'green' }])

  const p3 = snapOf(graphql({ contexts: [pass('build'), pass('test')], reviewDecision: 'CHANGES_REQUESTED' }))
  expect(diff(p2, p3)).toEqual([{ kind: 'review', from: 'REVIEW_REQUIRED', to: 'CHANGES_REQUESTED' }])

  const p4 = snapOf(graphql({ contexts: [pass('build'), pass('test')], reviewDecision: 'CHANGES_REQUESTED', state: 'MERGED' }))
  expect(diff(p3, p4)).toEqual([{ kind: 'merged' }])

  // a brand-new check that fails is newly failed
  const p5 = snapOf(graphql({ contexts: [pass('build'), pass('test'), fail('e2e')] }))
  expect(diff(p2, p5).map(t => t.kind)).toEqual(['failed'])
})

test('band text, level and parts per state', () => {
  expect(bandText(watchedWith(snapOf(MIXED)))).toBe('PR #42 ● checks 3/5 ✓ 1 ✗ 1 … · review: changes requested · mergeable')
  expect(levelOf(snapOf(MIXED))).toBe('danger')

  const green = snapOf(graphql({ contexts: [pass('a'), pass('b')], reviewDecision: 'APPROVED' }))
  expect(bandText(watchedWith(green))).toBe('PR #42 ● checks 2/2 ✓ · review: approved · mergeable')
  expect(levelOf(green)).toBe('ok')

  const running = snapOf(graphql({ contexts: [pass('a'), pending('b')], reviewDecision: 'APPROVED' }))
  expect(bandText(watchedWith(running))).toBe('PR #42 ● checks 1/2 ✓ 1 … · review: approved · mergeable')
  expect(levelOf(running)).toBe('warn')

  const conflicts = snapOf(graphql({ contexts: [pass('a')], mergeable: 'CONFLICTING', reviewDecision: null }))
  expect(bandText(watchedWith(conflicts))).toBe('PR #42 ● checks 1/1 ✓ · review: no review · conflicts')
  expect(levelOf(conflicts)).toBe('danger')

  const merged = snapOf(graphql({ contexts: [], state: 'MERGED', reviewDecision: 'APPROVED' }))
  expect(bandText(watchedWith(merged))).toBe('PR #42 ● no checks · review: approved · merged')
  expect(levelOf(merged)).toBe('ok')

  expect(bandText(watchedWith(null))).toBe('PR #42 ● loading…')
  expect(bandText(watchedWith(null, 'HTTP 401'))).toBe('PR #42 ● gh failed: HTTP 401')

  // one line only: the branch PR first, then a count of the rest
  const user = { ...newWatched(refOf('acme', 'other', 7), 'user'), snap: green }
  expect(bandParts([user, watchedWith(green)])).toEqual({
    label: 'PR #42',
    chips: [
      { text: 'checks 2/2 ✓', tone: 'ok' },
      { text: 'approved', tone: 'ok' },
      { text: 'mergeable', tone: 'ok' },
    ],
    right: ['+1 more'],
    urgent: false,
  })
  expect(bandParts([])).toBe(null)
  // a failed check, a conflict, a closed PR and a gh failure are urgent; a pending check or no checks is not
  expect(bandParts([watchedWith(snapOf(MIXED))])?.chips).toEqual([
    { text: 'checks 3/5 ✓ 1 ✗ 1 …', tone: 'danger' },
    { text: 'changes requested', tone: 'danger' },
    { text: 'mergeable', tone: 'ok' },
  ])
  expect(bandParts([watchedWith(snapOf(MIXED))])?.urgent).toBe(true)
  expect(bandParts([watchedWith(running)])?.chips[0]).toEqual({ text: 'checks 1/2 ✓ 1 …', tone: 'warn' })
  expect(bandParts([watchedWith(running)])?.urgent).toBe(false)
  expect(bandParts([watchedWith(conflicts)])?.chips.slice(1)).toEqual([
    { text: 'no review', tone: 'muted' },
    { text: 'conflicts', tone: 'danger' },
  ])
  expect(bandParts([watchedWith(merged)])?.chips).toEqual([
    { text: 'no checks', tone: 'muted' },
    { text: 'approved', tone: 'ok' },
    { text: 'merged', tone: 'ok' },
  ])
  expect(bandParts([watchedWith(null)])).toEqual({ label: 'PR #42', chips: [{ text: 'loading…', tone: 'muted' }], right: [], urgent: false })
  expect(bandParts([watchedWith(null, 'HTTP 401')])).toEqual({ label: 'PR #42', chips: [{ text: 'gh failed', tone: 'danger' }], right: ['HTTP 401'], urgent: true })
})

test('PR URLs: bare prompts only, with dedupe', () => {
  expect(parsePrUrl('see https://github.com/o/r/pull/9/files')).toMatchObject({ owner: 'o', repo: 'r', number: 9, id: 'o/r#9' })
  expect(bareUrls('https://github.com/o/r/pull/1')).toEqual([refOf('o', 'r', 1)])
  expect(bareUrls('  https://github.com/o/r/pull/1\nhttps://github.com/o/r/pull/1 https://github.com/o/r/pull/2 ').map(r => r.id)).toEqual(['o/r#1', 'o/r#2'])
  expect(bareUrls('review https://github.com/o/r/pull/1')).toEqual([])
  expect(bareUrls('github.com/o/r/pull/1')).toEqual([])
  expect(bareUrls('https://github.com/o/r/pulls/1')).toEqual([])
})

test('poll cadence: hot while pending after a push, normal otherwise', () => {
  const cfg = DEFAULTS
  const running = [watchedWith(snapOf(graphql({ contexts: [pending('ci')] })))]
  const done = [watchedWith(snapOf(graphql({ contexts: [pass('ci')] })))]
  expect(cadenceMs(cfg, running, 1000, 60_000)).toBe(30_000)
  expect(cadenceMs(cfg, running, 61_000, 60_000)).toBe(120_000)
  expect(cadenceMs(cfg, done, 1000, 60_000)).toBe(120_000)
  expect(isDue(cfg, running, 30_000, 60_000, 0)).toBe(true)
  expect(isDue(cfg, running, 29_999, 60_000, 0)).toBe(false)
  expect(isDue(cfg, done, 30_000, 60_000, 0)).toBe(false)
  expect(isDue(cfg, [], 1e9, 0, 0)).toBe(false)
})

test('discovery commands', () => {
  expect(isDiscoveryCommand('git push -u origin feature')).toBe(true)
  expect(isDiscoveryCommand('gh pr create --fill')).toBe(true)
  expect(isDiscoveryCommand('gh pr merge 42 --squash')).toBe(true)
  expect(isDiscoveryCommand('git status && git pushd')).toBe(false)
  expect(isDiscoveryCommand('gh pr list')).toBe(false)
  expect(isPushCommand('gh pr merge 42')).toBe(false)
  expect(isPushCommand('cd x && git push')).toBe(true)
})

test('config merge and command parsing', () => {
  expect(mergeConfig(null, null)).toEqual(DEFAULTS)
  expect(mergeConfig({ pollSec: 300, notifyOn: ['failed', 'bogus'] }, { hotPollSec: 1, appendNoteOnFailure: false })).toEqual({
    pollSec: 300,
    hotPollSec: 10,
    notifyOn: ['failed'],
    appendNoteOnFailure: false,
  })
  expect(mergeConfig({ pollSec: 'soon' }, 'junk')).toEqual(DEFAULTS)

  expect(parseCommand('')).toEqual({ kind: 'open' })
  expect(parseCommand('text')).toEqual({ kind: 'text' })
  expect(parseCommand('add https://github.com/o/r/pull/5')).toEqual({ kind: 'add', ref: refOf('o', 'r', 5) })
  expect(parseCommand('add #12')).toEqual({ kind: 'add-number', number: 12 })
  expect(parseCommand('add nope').kind).toBe('help')
  expect(parseCommand('rm 12')).toEqual({ kind: 'rm', target: '12' })
  expect(parseCommand('band OFF')).toEqual({ kind: 'band', on: false })
  expect(parseCommand('band maybe').kind).toBe('help')
  expect(parseCommand('frobnicate').kind).toBe('help')

  const prs = [watchedWith(null), newWatched(refOf('x', 'y', 42), 'user'), newWatched(refOf('x', 'y', 7), 'user')]
  expect(matchTarget(prs, '42').length).toBe(2)
  expect(matchTarget(prs, 'x/y#42').map(p => p.id)).toEqual(['x/y#42'])
  expect(matchTarget(prs, 'https://github.com/x/y/pull/7').map(p => p.id)).toEqual(['x/y#7'])
  expect(matchTarget(prs, 'nine')).toEqual([])
})

test('links and durations', () => {
  expect(linkable('https://github.com/acme/widgets/actions/runs/1/job/2')).toBe(true)
  expect(linkable('http://ci.example.test/1')).toBe(false)
  expect(linkable('')).toBe(false)
  const s = snapOf(MIXED)
  expect(durationOf(s.checks[0], 0)).toBe('1m 23s')
  expect(durationOf(s.checks[4], Date.parse('2026-10-09T10:00:45Z'))).toBe('45s')
  expect(durationOf({ ...s.checks[0], startedAt: '' }, 0)).toBe('')
})
