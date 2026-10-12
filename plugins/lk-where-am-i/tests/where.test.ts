import { expect, test } from 'claude-code/testing'

import type { Location } from '../types'
import {
  bandLine,
  bandSegments,
  bandText,
  basename,
  cacheState,
  countLines,
  fmtAge,
  fmtLeft,
  folderOnly,
  isLinkedWorktree,
  levelOf,
  liveWindows,
  nextWarned,
  parseBranch,
  parseCount,
  parseDefaultBranch,
  parseLastCommit,
  parseRevParse,
  parseSha,
  parseWorktrees,
  repoName,
  resolvePath,
  sanitizeTtl,
  sanitizeWindows,
} from '../hooks/where'

const ok = (stdout: string) => ({ exitCode: 0, stdout })
const NOW = Date.parse('2026-10-09T12:00:00Z')
const MIN = 60_000

function repoLoc(over: Partial<Location> = {}): Location {
  return {
    ...folderOnly('/work/acme-repo', NOW),
    isRepo: true,
    repo: 'acme-repo',
    toplevel: '/work/acme-repo',
    branch: 'master',
    sha: 'abc1234',
    dirty: 3,
    upstream: 'set',
    upstreamName: 'origin/master',
    ahead: 2,
    lastCommitAt: NOW / 1000 - 14 * 60,
    lastSubject: 'Fix it',
    defaultBranch: 'master',
    ...over,
  }
}

test('paths: basename, resolvePath', () => {
  expect(basename('/a/b/c/')).toBe('c')
  expect(basename('/')).toBe('/')
  expect(resolvePath('/work/repo/sub', '../../.git')).toBe('/work/.git')
  expect(resolvePath('/work/repo', '.git')).toBe('/work/repo/.git')
  expect(resolvePath('/work/repo', '/abs/x/./y')).toBe('/abs/x/y')
})

test('rev-parse: main checkout', () => {
  const r = parseRevParse('/work/acme-repo/.git\n.git\n/work/acme-repo\n', '/work/acme-repo')
  expect(r).toEqual({ gitDir: '/work/acme-repo/.git', commonDir: '/work/acme-repo/.git', toplevel: '/work/acme-repo' })
  expect(isLinkedWorktree(r!)).toBe(false)
  expect(repoName(r!)).toBe('acme-repo')
})

test('rev-parse: subdirectory resolves a relative common dir', () => {
  const r = parseRevParse('/work/acme-repo/.git\n../.git\n/work/acme-repo\n', '/work/acme-repo/src')
  expect(r!.commonDir).toBe('/work/acme-repo/.git')
  expect(isLinkedWorktree(r!)).toBe(false)
})

test('rev-parse: linked worktree names the main repo and differs in git dir', () => {
  const r = parseRevParse(
    '/work/acme-repo/.git/worktrees/feat-x\n/work/acme-repo/.git\n/work/wt/feat-x\n',
    '/work/wt/feat-x',
  )
  expect(isLinkedWorktree(r!)).toBe(true)
  expect(repoName(r!)).toBe('acme-repo')
})

test('rev-parse: bare-style common dir and junk output', () => {
  expect(repoName({ gitDir: '/x/app.git/worktrees/a', commonDir: '/x/app.git', toplevel: '/x/a' })).toBe('app')
  expect(parseRevParse('', '/w')).toBeNull()
  expect(parseRevParse('only\none\n', '/w')).toBeNull()
})

test('branch, detached HEAD and sha', () => {
  expect(parseBranch(ok('feature/login\n'))).toBe('feature/login')
  expect(parseBranch({ exitCode: 1, stdout: '' })).toBeNull()
  expect(parseBranch(null)).toBeNull()
  expect(parseSha(ok('a1b2c3d\n'))).toBe('a1b2c3d')
  expect(parseSha(ok('fatal: no'))).toBeNull()
  expect(parseSha({ exitCode: 128, stdout: '' })).toBeNull()
})

test('dirty count, unpushed count, no upstream', () => {
  expect(countLines(' M a.ts\n?? b.ts\nA  c.ts\n')).toBe(3)
  expect(countLines('')).toBe(0)
  expect(parseCount('2\n')).toBe(2)
  expect(parseCount('fatal: no upstream configured for branch')).toBeNull()
})

test('last commit time and subject', () => {
  expect(parseLastCommit('1760000000\u0000Fix the thing\n')).toEqual({ at: 1760000000, subject: 'Fix the thing' })
  expect(parseLastCommit('1760000000\n')).toEqual({ at: 1760000000, subject: '' })
  expect(parseLastCommit('')).toBeNull()
})

test('default branch from origin/HEAD', () => {
  expect(parseDefaultBranch(ok('origin/main\n'))).toBe('main')
  expect(parseDefaultBranch(ok('refs/remotes/origin/develop'))).toBe('develop')
  expect(parseDefaultBranch({ exitCode: 128, stdout: '' })).toBeNull()
})

test('worktree list --porcelain', () => {
  const out = [
    'worktree /work/acme-repo',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/master',
    '',
    'worktree /work/wt/feat-x',
    'HEAD 2222222222222222222222222222222222222222',
    'detached',
    'locked reason here',
    '',
    'worktree /work/wt/old',
    'HEAD 3333333333333333333333333333333333333333',
    'branch refs/heads/old',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n')
  const w = parseWorktrees(out)
  expect(w.length).toBe(3)
  expect(w[0]).toMatchObject({ path: '/work/acme-repo', branch: 'master', detached: false })
  expect(w[1]).toMatchObject({ path: '/work/wt/feat-x', branch: null, detached: true, locked: true })
  expect(w[2]).toMatchObject({ branch: 'old', prunable: true })
})

test('age and countdown formats', () => {
  expect(fmtAge(14 * 60 + 30)).toBe('14m')
  expect(fmtAge(5 * 3600)).toBe('5h')
  expect(fmtAge(3 * 86400)).toBe('3d')
  expect(fmtLeft(41 * MIN)).toBe('41m')
  expect(fmtLeft(80 * MIN)).toBe('1h20')
  expect(fmtLeft(10_000)).toBe('<1m')
})

test('rate-limit levels as kit tones: warn at 80, danger at 95', () => {
  expect(levelOf(79.9)).toBe('ok')
  expect(levelOf(80)).toBe('warn')
  expect(levelOf(94.9)).toBe('warn')
  expect(levelOf(95)).toBe('danger')
})

test('windows: sanitize, drop stale, order 5h then 7d', () => {
  const w = sanitizeWindows([
    { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(NOW + 3 * 86400_000).toISOString() },
    { kind: 'five_hour', percentUsed: 34 },
    { kind: 'old', percentUsed: 50, resetsAt: new Date(NOW - MIN).toISOString() },
    { kind: 'bad', percentUsed: 'x' },
    null,
  ])
  expect(w.length).toBe(3)
  expect(liveWindows(w, NOW).map(x => x.kind)).toEqual(['five_hour', 'seven_day'])
  expect(sanitizeWindows('nope')).toEqual([])
})

test('one toast per window at 90%, re-armed when the window drops back', () => {
  let r = nextWarned({}, [{ kind: 'five_hour', percentUsed: 89 }])
  expect(r.toast.length).toBe(0)
  r = nextWarned(r.warned, [{ kind: 'five_hour', percentUsed: 90 }, { kind: 'seven_day', percentUsed: 10 }])
  expect(r.toast.map(w => w.kind)).toEqual(['five_hour'])
  r = nextWarned(r.warned, [{ kind: 'five_hour', percentUsed: 97 }])
  expect(r.toast.length).toBe(0)
  r = nextWarned(r.warned, [{ kind: 'five_hour', percentUsed: 3 }])
  expect(r.warned).toEqual({})
  r = nextWarned(r.warned, [{ kind: 'five_hour', percentUsed: 92 }])
  expect(r.toast.length).toBe(1)
})

test('cache clock: unknown, warm, low, cold', () => {
  expect(cacheState(null, NOW, 60)).toEqual({ kind: 'unknown' })
  expect(cacheState(NOW - 19 * MIN, NOW, 60)).toEqual({ kind: 'warm', leftMs: 41 * MIN })
  expect(cacheState(NOW - 56 * MIN, NOW, 60)).toEqual({ kind: 'low', leftMs: 4 * MIN })
  expect(cacheState(NOW - 61 * MIN, NOW, 60)).toEqual({ kind: 'cold' })
  expect(cacheState(NOW - 6 * MIN, NOW, 5)).toEqual({ kind: 'cold' })
  expect(sanitizeTtl('60')).toBe(60)
  expect(sanitizeTtl(0)).toBeNull()
  expect(sanitizeTtl('abc')).toBeNull()
})

test('band composition with every part', () => {
  const segs = bandSegments({
    loc: repoLoc({ isLinkedWorktree: true, worktreeName: 'feat-x' }),
    windows: [
      { kind: 'five_hour', percentUsed: 34 },
      { kind: 'seven_day', percentUsed: 12 },
    ],
    nowMs: NOW,
    lastStepMs: NOW - 19 * MIN,
    ttlMin: 60,
  })
  expect(bandText(segs)).toBe(
    'acme-repo@master ⑂wt:feat-x · 3 dirty · 2↑ · 14m since commit · 5h 34% · 7d 12% · cache 41m',
  )
  expect(segs.every(s => s.tone === undefined)).toBe(true)
})

test('band hides unknown parts and tones warnings', () => {
  const segs = bandSegments({
    loc: repoLoc({ branch: null, sha: 'a1b2c3d', dirty: null, upstream: 'unknown', ahead: null, lastCommitAt: null }),
    windows: [
      { kind: 'five_hour', percentUsed: 96 },
      { kind: 'seven_day', percentUsed: 81 },
    ],
    nowMs: NOW,
    lastStepMs: NOW - 57 * MIN,
    ttlMin: 60,
  })
  expect(bandText(segs)).toBe('acme-repo@(a1b2c3d) · 5h 96% · 7d 81% · cache 3m')
  expect(segs.find(s => s.text === '5h 96%')!.tone).toBe('danger')
  expect(segs.find(s => s.text === '7d 81%')!.tone).toBe('warn')
  expect(segs.find(s => s.text === 'cache 3m')!.tone).toBe('warn')
})

test('band: no upstream, clean, cache cold, non-git folder, nothing known', () => {
  const t = bandText(
    bandSegments({
      loc: repoLoc({ dirty: 0, upstream: 'none', upstreamName: null, ahead: null }),
      windows: [],
      nowMs: NOW,
      lastStepMs: NOW - 2 * 3600_000,
      ttlMin: 60,
    }),
  )
  expect(t).toBe('acme-repo@master · clean · no upstream · 14m since commit · cache cold')
  expect(
    bandText(bandSegments({ loc: folderOnly('/home/tester/notes', NOW), windows: [], nowMs: NOW, lastStepMs: null, ttlMin: 60 })),
  ).toBe('notes (no git)')
  expect(bandSegments({ loc: null, windows: [], nowMs: NOW, lastStepMs: null, ttlMin: 60 })).toEqual([])
})

test('bandLine: the location as the label, windows and cache as chips, the rest on the right', () => {
  const input = {
    loc: repoLoc({ isLinkedWorktree: true, worktreeName: 'feat-x' }),
    windows: [
      { kind: 'five_hour', percentUsed: 34 },
      { kind: 'seven_day', percentUsed: 96 },
    ],
    nowMs: NOW,
    lastStepMs: NOW - 57 * MIN,
    ttlMin: 60,
  }
  expect(bandLine(input)).toEqual({
    label: 'acme-repo@master ⑂wt:feat-x',
    chips: [
      { text: '5h 34%', tone: 'muted' },
      { text: '7d 96%', tone: 'danger' },
      { text: 'cache 3m', tone: 'warn' },
    ],
    right: ['3 dirty', '2↑', '14m since commit'],
    urgent: true,
  })
  // a calm band: every chip muted, nothing urgent
  const calm = bandLine({ ...input, windows: [{ kind: 'five_hour', percentUsed: 34 }], lastStepMs: NOW - 19 * MIN })!
  expect(calm.chips).toEqual([
    { text: '5h 34%', tone: 'muted' },
    { text: 'cache 41m', tone: 'muted' },
  ])
  expect(calm.urgent).toBe(false)
})

test('bandLine: windows past the fourth chip move right; folder and nothing-known cases', () => {
  const many = bandLine({
    loc: null,
    windows: [
      { kind: 'five_hour', percentUsed: 10 },
      { kind: 'seven_day', percentUsed: 20 },
      { kind: 'spend_limit', percentUsed: 30 },
      { kind: 'other', percentUsed: 40 },
    ],
    nowMs: NOW,
    lastStepMs: NOW - 2 * 3600_000,
    ttlMin: 60,
  })!
  expect(many.label).toBe('where')
  expect(many.chips.map(c => c.text)).toEqual(['5h 10%', '7d 20%', 'spend 30%', 'cache cold'])
  expect(many.right).toEqual(['other 40%'])
  const folder = bandLine({ loc: folderOnly('/home/tester/notes', NOW), windows: [], nowMs: NOW, lastStepMs: null, ttlMin: 60 })
  expect(folder).toEqual({ label: 'notes (no git)', chips: [], right: [], urgent: false })
  expect(bandLine({ loc: null, windows: [], nowMs: NOW, lastStepMs: null, ttlMin: 60 })).toBeNull()
})
