// gates-merge.test.ts: the merge gate (green CI, then one "Merge now?" question), amend on shared branches, and the
// opt-in add-all check. Ported from change-control's merge tests (20); names changed only (loopkeeper:, /lk gates,
// loopkeeper.json). The stage machine is always present (ADR 0004) and its default stages leave shipping open, as the
// old world's default pipeline did, so the ship gate stays out of these tests.
import { expect, test } from 'claude-code/testing'

import { bash, CWD, edit, lk, projectGates, startTurn, world, type Run } from './world.ts'

const MERGE_Q = (what: string) => `Merge now? (loopkeeper: ${what})`

/** gh answers: PR #12 open, its checks as given; git on branch `branch`. */
const gh = (checks: Array<{ name: string; bucket: string }> | null, branch = 'feature', extra: (argv: string[]) => Run | undefined = () => undefined) =>
  (argv: string[]): Run | undefined => {
    const cmd = argv.join(' ')
    const hit = extra(argv)
    if (hit) return hit
    if (cmd === 'git branch --show-current') return { exitCode: 0, stdout: branch + '\n' }
    if (cmd.startsWith('gh pr view')) return checks === null ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: JSON.stringify({ number: 12, state: 'OPEN' }) }
    if (cmd.startsWith('gh pr checks 12')) return { exitCode: checks?.every(c => c.bucket === 'pass') ? 0 : 8, stdout: JSON.stringify(checks ?? []) }
    return undefined
  }

const GREEN = [
  { name: 'lint', bucket: 'pass' },
  { name: 'unit', bucket: 'pass' },
]

type Verdict = { decision: string; reason?: string }
const check = async ($: any, call: unknown): Promise<Verdict> => (await $.tool.check(call)) as Verdict

test('gh pr merge with a failing check is denied with the list, without asking', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, { answers: ['Merge'], run: gh([{ name: 'lint', bucket: 'pass' }, { name: 'unit', bucket: 'fail' }, { name: 'e2e', bucket: 'cancel' }]) })
  await startTurn($)
  const r = await check($, bash('gh pr merge 12 --squash'))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('PR #12')
  expect(r.reason).toContain('failing: unit, e2e')
  expect(w.asked).toEqual([])
  expect(w.processes.some(p => p.join(' ') === 'gh pr checks 12 --json name,bucket')).toBe(true)
})

test('gh pr merge with a pending check is denied with the list', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, { answers: ['Merge'], run: gh([{ name: 'lint', bucket: 'pass' }, { name: 'build', bucket: 'pending' }]) })
  await startTurn($)
  const r = await check($, bash('gh pr merge 12'))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('pending: build')
  expect(w.asked).toEqual([])
})

test('gh pr merge with green CI asks "Merge now?"; Merge lets it run', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, { answers: ['Merge'], run: gh(GREEN) })
  await startTurn($)
  const r = await check($, bash('gh pr merge 12 --squash'))
  expect(r.decision).toBe('allow')
  expect(w.asked).toEqual([MERGE_Q('gh pr merge 12')])
})

test('gh pr merge with green CI: Cancel denies', async ($, on) => {
  world(on, { answers: ['Cancel'], run: gh(GREEN) })
  await startTurn($)
  const r = await check($, bash('gh pr merge 12'))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('the user chose Cancel')
})

test('gh pr merge with nobody to ask is denied', async ($, on) => {
  const w = world(on, { surfaces: [], run: gh(GREEN) })
  await startTurn($)
  const r = await check($, bash('gh pr merge 12'))
  expect(r.decision).toBe('deny')
  expect(w.asked).toEqual([])
})

test('not a PR: no CI to wait for, straight to the question', async ($, on) => {
  const w = world(on, { answers: ['Merge'], run: gh(null) })
  await startTurn($)
  expect((await check($, bash('gh pr merge'))).decision).toBe('allow')
  expect(w.asked).toEqual([MERGE_Q('gh pr merge')])
  expect(w.processes.some(p => p[1] === 'pr' && p[2] === 'checks')).toBe(false)
})

test('requireGreenCi off skips gh pr checks', async ($, on) => {
  const w = world(on, { answers: ['Merge'], files: projectGates({ requireGreenCi: false }), run: gh([{ name: 'unit', bucket: 'fail' }]) })
  await startTurn($)
  expect((await check($, bash('gh pr merge 12'))).decision).toBe('allow')
  expect(w.processes.some(p => p[0] === 'gh')).toBe(false)
})

test('git push to main asks; push to a feature branch does not', async ($, on) => {
  const w = world(on, { answers: ['Cancel'], run: gh(null) })
  await startTurn($)
  expect((await check($, bash('git push -u origin feature'))).decision).toBe('allow')
  expect(w.asked).toEqual([])
  const r = await check($, bash('git push origin main'))
  expect(r.decision).toBe('deny')
  expect(w.asked).toEqual([MERGE_Q('push to the default branch')])
})

test('a bare git push while on master asks', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, { answers: ['Merge'], run: gh(null, 'master') })
  await startTurn($)
  expect((await check($, bash('git push'))).decision).toBe('allow')
  expect(w.asked.length).toBe(1)
})

test('git merge main asks', async ($, on) => {
  const w = world(on, { answers: ['Merge'], run: gh(null) })
  await startTurn($)
  expect((await check($, bash('git merge --no-ff main'))).decision).toBe('allow')
  expect(w.asked).toEqual([MERGE_Q('merge with the default branch')])
})

test('mergeGate off: merges go to the rules beneath', async ($, on) => {
  const w = world(on, { files: projectGates({ mergeGate: false }), run: gh(GREEN) })
  await startTurn($)
  expect((await check($, bash('gh pr merge 12'))).decision).toBe('allow')
  expect(w.asked).toEqual([])
})

test('a heredoc that mentions merging does not trigger the gate (but its target file counts)', async ($, on) => {
  const w = world(on, { answers: ['Cancel'], run: gh(GREEN) })
  await startTurn($)
  const r = await check($, bash('cat <<EOF > notes.md\ngh pr merge 12\ngit push origin main\nEOF'))
  expect(r.decision).toBe('allow')
  expect(w.asked).toEqual([])
  expect(await lk($, 'gates text')).toContain('  notes.md')
})

test('a commit message that says "merge" does not trigger the gate', async ($, on) => {
  const w = world(on, { answers: ['Cancel'], run: gh(GREEN) })
  await startTurn($)
  expect((await check($, bash('git commit -m "merge main into feature; gh pr merge later"'))).decision).toBe('allow')
  expect(w.asked).toEqual([])
})

// ---- Amend -------------------------------------------------------------------------

test('git commit --amend on the default branch is denied', async ($, on) => {
  world(on, { run: gh(null, 'main') })
  await startTurn($)
  const r = await check($, bash('git commit --amend --no-edit'))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('Make a new commit instead')
})

test('git commit --amend on a pushed feature branch is denied', async ($, on) => {
  world(on, { run: gh(null, 'feature', argv => (argv[1] === 'merge-base' ? { exitCode: 0, stdout: '' } : undefined)) })
  await startTurn($)
  expect((await check($, bash('git commit --amend -m x'))).decision).toBe('deny')
})

test('git commit --amend on an unpushed feature branch is allowed', async ($, on) => {
  world(on, { run: gh(null, 'feature') })
  await startTurn($)
  expect((await check($, bash('git commit --amend -m x'))).decision).toBe('allow')
})

test('blockAmend off allows amend anywhere', async ($, on) => {
  world(on, { files: projectGates({ blockAmend: false }), run: gh(null, 'main') })
  await startTurn($)
  expect((await check($, bash('git commit --amend'))).decision).toBe('allow')
})

// ---- Add all -------------------------------------------------------------------------

const status = (out: string) => (argv: string[]): Run | undefined => (argv[1] === 'status' ? { exitCode: 0, stdout: out } : undefined)

test('blockAddAll off (default): git add -A is not checked', async ($, on) => {
  world(on, { run: gh(null, 'feature', status(' M other.ts\n')) })
  await startTurn($)
  expect((await check($, bash('git add -A'))).decision).toBe('allow')
})

test('blockAddAll: git add . is denied, listing files this session did not touch', async ($, on) => {
  world(on, { files: projectGates({ blockAddAll: true }), run: gh(null, 'feature', status(' M src/mine.ts\n?? stray.log\n M other/theirs.ts\n')) })
  await startTurn($)
  await check($, edit(`${CWD}/src/mine.ts`))
  const r = await check($, bash('git add .'))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('stray.log, other/theirs.ts')
  expect(r.reason?.includes('src/mine.ts')).toBe(false)
  expect(r.reason).toContain('Stage the files you changed by name')
})

test('blockAddAll: git add -A is allowed when every changed file was touched this session', async ($, on) => {
  world(on, { files: projectGates({ blockAddAll: true }), run: gh(null, 'feature', status(' M src/mine.ts\n')) })
  await startTurn($)
  await check($, edit(`${CWD}/src/mine.ts`))
  await $.turn.start({ text: 'commit it', turnId: 't2' })
  expect((await check($, bash('git add -A && git commit -m "x"'))).decision).toBe('allow')
})

test('blockAddAll after a cd into a subfolder: porcelain paths are read from the repository top level', async ($, on) => {
  // git answers the top level only when asked from the folder the command runs in
  const run = (argv: string[], cwd?: string): Run | undefined =>
    argv.join(' ') === 'git rev-parse --show-toplevel'
      ? cwd === `${CWD}/src` ? { exitCode: 0, stdout: `${CWD}\n` } : { exitCode: 128, stdout: '' }
      : gh(null, 'feature', status(' M src/mine.ts\n'))(argv)
  const w = world(on, { files: projectGates({ blockAddAll: true }), run })
  await startTurn($)
  w.cd(`${CWD}/src`)
  await check($, edit(`${CWD}/src/mine.ts`))
  await $.turn.start({ text: 'commit it', turnId: 't2' })
  expect((await check($, bash('git add -A'))).decision).toBe('allow')
  expect(w.processes.some(p => p.join(' ') === 'git rev-parse --show-toplevel')).toBe(true)
})
