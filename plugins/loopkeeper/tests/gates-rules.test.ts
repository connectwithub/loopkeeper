// gates-rules.test.ts: the gates' pure rules (lib/gateRules.ts, lib/shell.ts), ported from change-control's rules.test.ts.
import { expect, test } from 'claude-code/testing'

import {
  bandModel,
  bashTargets,
  checkLayer,
  contextText,
  DEFAULTS,
  gitActions,
  isAddAll,
  isPlanMaterial,
  matchGlob,
  matchProtected,
  mergeHitsDefault,
  mergeLayers,
  normalizePath,
  parsePorcelain,
  planPathsText,
  pushHitsDefault,
  summarizeChecks,
  failClosedReason,
  filesOptions,
  limitOf,
  limitSource,
  noteBashWrites,
  raiseTo,
  sectionLayer,
} from '../hooks/lib/gateRules.ts'
import { bare, prNumber } from '../hooks/lib/shell.ts'

// ---- Glob matcher ------------------------------------------------------------------

const GLOBS: Array<[string, string, boolean]> = [
  ['docs/decisions/**', 'docs/decisions/ADR-0001.md', true],
  ['docs/decisions/**', 'docs/decisions/a/b/c.md', true],
  ['docs/decisions/**', 'docs/decisionsX/a.md', false],
  ['docs/decisions/**', 'other/docs/decisions/a.md', false],
  ['.env*', '.env', true],
  ['.env*', '.env.local', true],
  ['.env*', 'api/.env.production', true],
  ['.env*', 'env.txt', false],
  ['.env*', 'src/.envrc.d/x', false],
  ['**/migrations/**', 'migrations/001.sql', true],
  ['**/migrations/**', 'db/migrations/001.sql', true],
  ['**/migrations/**', 'db/migrations/nested/002.sql', true],
  ['**/migrations/**', 'db/migration/001.sql', false],
  ['src/*.ts', 'src/a.ts', true],
  ['src/*.ts', 'src/x/a.ts', false],
  ['src/**/*.ts', 'src/a.ts', true],
  ['src/**/*.ts', 'src/x/y/a.ts', true],
  ['file?.md', 'file1.md', true],
  ['file?.md', 'file12.md', false],
  ['a.b', 'aXb', false],
  ['/abs/**', '/abs/x', true],
]
for (const [glob, path, want] of GLOBS) {
  test(`glob ${glob} ${want ? 'matches' : 'does not match'} ${path}`, () => {
    expect(matchGlob(glob, path)).toBe(want)
  })
}

test('deny wins over ask when two protected globs match', () => {
  const r = matchProtected(
    [
      { glob: 'config/**', action: 'ask' },
      { glob: '.env*', action: 'deny' },
    ],
    'config/.env',
  )
  expect(r?.action).toBe('deny')
})

test('normalizePath makes paths relative to cwd and resolves dots', () => {
  expect(normalizePath('/work/src/a.ts', '/work')).toBe('src/a.ts')
  expect(normalizePath('src/../lib/./b.ts', '/work/')).toBe('lib/b.ts')
  expect(normalizePath('/elsewhere/x', '/work')).toBe('/elsewhere/x')
  expect(normalizePath('/workshop/x', '/work')).toBe('/workshop/x')
})

// ---- Bash targets ------------------------------------------------------------------

const TARGETS: Array<[string, string[]]> = [
  ["sed -i 's/a/b/' src/a.ts src/b.ts", ['src/a.ts', 'src/b.ts']],
  ['sed -i.bak -e s/a/b/ c.ts', ['c.ts']],
  ['echo hi > out.txt', ['out.txt']],
  ['echo hi >> log/app.log', ['log/app.log']],
  ['cat a | tee x.txt y.txt', ['x.txt', 'y.txt']],
  ['cp -r a.txt dest/', ['dest']],
  ['mv old.ts new.ts', ['new.ts']],
  ['touch one two', ['one', 'two']],
  ['rm -f gone.ts /work/also.ts', ['gone.ts', 'also.ts']],
  ['npm test 2>&1 | tail', []],
  ['echo "a > b" ; grep x y', []],
  ['cat <<EOF > notes.md\nline > fake.txt\nEOF', ['notes.md']],
  ['echo x > /tmp/scratch && echo y > /dev/null', []],
  ['sudo touch /etc/hosts', ['/etc/hosts']],
  ['FOO=1 rm ./build/out.js', ['build/out.js']],
]
for (const [cmd, want] of TARGETS) {
  test(`bash targets of ${JSON.stringify(cmd)}`, () => {
    expect(bashTargets(cmd, '/work')).toEqual(want)
  })
}

// ---- bare() and at() (borrowed; see the notice in lib/shell.ts) -----------------------------

const kinds = (cmd: string) => gitActions(bare(cmd)).map(a => a.kind)

test('a heredoc with a merge word inside does NOT trigger', () => {
  expect(kinds('cat <<EOF > notes.md\ngh pr merge 12\ngit push origin main\nEOF')).toEqual([])
  expect(kinds("git commit -F - <<'MSG'\ngh pr merge and git push origin main\nMSG")).toEqual([])
})

test('quoted text and comments do not trigger', () => {
  expect(kinds('git commit -m "merge: gh pr merge 3 then git push origin main"')).toEqual([])
  expect(kinds("grep -r 'git push origin main' docs")).toEqual([])
  expect(kinds('ls # git push origin main')).toEqual([])
  expect(kinds('echo gh pr merge 4')).toEqual([])
})

test('wrappers and runners still trigger', () => {
  expect(kinds('sudo -E env CI=1 gh pr merge 12 --squash')).toEqual(['gh-merge'])
  expect(prNumber(bare('npx --yes gh pr merge --squash 42'))).toBe('42')
  expect(kinds('cd repo && timeout 60 git push origin main')).toEqual(['git-push'])
  expect(kinds('bash -c "gh pr merge 7"')).toEqual(['gh-merge'])
  expect(kinds('gh -R o/r pr merge 9')).toEqual(['gh-merge'])
  expect(kinds('git -C sub commit --amend --no-edit')).toEqual(['amend'])
  expect(kinds('bash <<EOF\ngh pr merge 5\nEOF')).toEqual(['gh-merge'])
  // Known limit of the borrowed bare(): a heredoc piped into a shell is blanked
  expect(kinds('cat <<EOF | bash\ngh pr merge 5\nEOF')).toEqual([])
})

test('git merge --abort and plain commits are not actions', () => {
  expect(kinds('git merge --abort')).toEqual([])
  expect(kinds('git commit -m x')).toEqual([])
  expect(kinds('git add src/a.ts')).toEqual([])
})

test('add-all forms', () => {
  expect(isAddAll(['-A'])).toBe(true)
  expect(isAddAll(['.'])).toBe(true)
  expect(isAddAll(['--all'])).toBe(true)
  expect(isAddAll(['-vA'])).toBe(true)
  expect(isAddAll(['src/a.ts'])).toBe(false)
  expect(kinds('git add -A && git commit -m x')).toEqual(['add-all'])
})

test('push and merge targets', () => {
  const d = ['main', 'master']
  expect(pushHitsDefault(['origin', 'main'], 'feature', d)).toBe(true)
  expect(pushHitsDefault(['origin', 'HEAD:refs/heads/master'], 'feature', d)).toBe(true)
  expect(pushHitsDefault(['-u', 'origin', 'feature'], 'feature', d)).toBe(false)
  expect(pushHitsDefault([], 'main', d)).toBe(true)
  expect(pushHitsDefault(['origin'], 'feature', d)).toBe(false)
  expect(pushHitsDefault(['origin', 'HEAD'], 'master', d)).toBe(true)
  expect(pushHitsDefault(['--all'], 'feature', d)).toBe(true)
  expect(mergeHitsDefault(['main'], 'feature', d)).toBe(true)
  expect(mergeHitsDefault(['origin/main'], 'feature', d)).toBe(true)
  expect(mergeHitsDefault(['feature-2'], 'main', d)).toBe(true)
  expect(mergeHitsDefault(['feature-2'], 'feature', d)).toBe(false)
})

test('summarizeChecks buckets', () => {
  const s = summarizeChecks(
    JSON.stringify([
      { name: 'lint', bucket: 'pass' },
      { name: 'unit', bucket: 'fail' },
      { name: 'e2e', bucket: 'pending' },
      { name: 'docs', bucket: 'skipping' },
      { name: 'old', bucket: 'cancel' },
    ]),
  )
  expect(s).toEqual({ pass: ['lint', 'docs'], failing: ['unit', 'old'], pending: ['e2e'] })
  expect(summarizeChecks('not json').pending.length).toBe(1)
})

test('parsePorcelain reads paths and renames', () => {
  expect(parsePorcelain(' M src/a.ts\n?? new.txt\nR  old.ts -> moved.ts\n M "with space.md"\n')).toEqual([
    'src/a.ts',
    'new.txt',
    'moved.ts',
    'with space.md',
  ])
})

// ---- Config merge -------------------------------------------------------------------

test('defaults are the documented ones', () => {
  const { config, sources } = mergeLayers([])
  expect(config).toEqual(DEFAULTS)
  expect(sources.maxFilesPerTurn).toBe('default')
})

test('later layers win, protected merges by glob, "off" removes one', () => {
  const { config, sources } = mergeLayers([
    { label: '~/.claude/loopkeeper.json', layer: { maxFilesPerTurn: 10, requirePlan: true } },
    {
      label: '.claude/loopkeeper.json',
      layer: {
        maxFilesPerTurn: 4,
        protected: [
          { glob: '.env*', action: 'ask' },
          { glob: '**/migrations/**', action: 'off' },
          { glob: 'infra/**', action: 'deny' },
        ],
      },
    },
    { label: 'session', layer: { maxFilesPerTurn: 2 } },
  ])
  expect(config.maxFilesPerTurn).toBe(2)
  expect(sources.maxFilesPerTurn).toBe('session')
  expect(config.requirePlan).toBe(true)
  expect(sources.requirePlan).toBe('~/.claude/loopkeeper.json')
  expect(config.protected).toEqual([
    { glob: 'docs/decisions/**', action: 'ask' },
    { glob: '.env*', action: 'ask' },
    { glob: 'infra/**', action: 'deny' },
  ])
  expect(sources['protected:infra/**']).toBe('.claude/loopkeeper.json')
  expect(sources['protected:**/migrations/**']).toBeUndefined()
})

test('bad fields are skipped and named', () => {
  const { layer, errors } = checkLayer({ maxFilesPerTurn: 0, mergeGate: 'yes', protected: [{ glob: '', action: 'ask' }, { glob: 'x', action: 'maybe' }] })
  expect(layer).toEqual({ protected: [] })
  expect(errors.length).toBe(4)
})

// ---- Band and context text --------------------------------------------------------

const base = { enabled: true, count: 3, max: 6, unlimited: false, requirePlan: true, planOk: true, mergeGate: true, fired: false }

test('band chips: files, plan, merge gate and ship, at most four', () => {
  expect(bandModel(base)).toEqual({
    chips: [
      { text: '3/6 files', tone: 'ok' },
      { text: 'plan ok', tone: 'ok' },
      { text: 'merge gate', tone: 'info' },
    ],
  })
  expect(bandModel({ ...base, planOk: false, mergeGate: false }).chips).toEqual([
    { text: '3/6 files', tone: 'ok' },
    { text: 'plan needed', tone: 'warn' },
  ])
  expect(bandModel({ ...base, requirePlan: false }).chips.map(c => c.text)).toEqual(['3/6 files', 'merge gate'])
  expect(bandModel({ ...base, unlimited: true, count: 9 }).chips[0]).toEqual({ text: '9/∞ files', tone: 'ok' })
  expect(bandModel({ ...base, shipGate: true, shipHeld: true }).chips.slice(3)).toEqual([{ text: 'ship held', tone: 'warn' }])
  expect(bandModel({ ...base, shipGate: true, shipHeld: false }).chips.slice(3)).toEqual([{ text: 'ship open', tone: 'ok' }])
  expect(bandModel({ ...base, shipGate: true, shipHeld: true }).chips.length).toBe(4)
})

test('band files chip is warn near the limit and danger when a rule fired; tones, never color names', () => {
  expect(bandModel({ ...base, count: 5 }).chips[0]?.tone).toBe('warn')
  expect(bandModel({ ...base, count: 6 }).chips[0]?.tone).toBe('warn')
  expect(bandModel({ ...base, count: 4 }).chips[0]?.tone).toBe('ok')
  expect(bandModel({ ...base, count: 1, fired: true }).chips[0]?.tone).toBe('danger')
  expect(JSON.stringify(bandModel({ ...base, count: 6, fired: true }))).not.toMatch(/yellow|red|green|gray|grey/)
})

test('band right side names where the limit comes from, never the base', () => {
  expect(bandModel({ ...base, source: 'base', limit: 6 }).right).toBeUndefined()
  expect(bandModel({ ...base, source: 'budget', limit: 23 }).right).toBe('budget 23')
  expect(bandModel({ ...base, source: 'raise', limit: 33 }).right).toBe('raised 33')
  expect(bandModel({ ...base, source: 'max', limit: 3 }).right).toBe('max 3')
})

test('band off for the session and the kill switch', () => {
  expect(bandModel({ ...base, enabled: false })).toEqual({
    chips: [{ text: 'off for this session', tone: 'danger' }],
    right: '/lk gates on to resume',
  })
  expect(bandModel({ ...base, disabled: true })).toEqual({ chips: [{ text: 'off (CLAUDE_MODS_DISABLE)', tone: 'muted' }] })
})

test('context text is at most 8 lines and names the limits', () => {
  const all = { ...DEFAULTS, requirePlan: true, blockAddAll: true }
  const text = contextText(all)
  expect(text.split('\n').length <= 8).toBe(true)
  expect(text).toContain('At most 10 distinct files')
  expect(text).toContain('.env* (deny)')
  expect(text).toContain('plan is approved')
  expect(text).toContain('until CI is green')
  expect(text).toContain('git add -A')
})

// ---- Plan material (0.3) --------------------------------------------------------------

test('isPlanMaterial: the scratchpad under /tmp/claude-* and the default planPaths globs', () => {
  const cwd = '/work'
  const yes = [
    '/tmp/claude-1000/x/y/scratchpad/plan.html',
    '/tmp/claude-1000/-media-proj/5b65/scratchpad/notes.md',
    '/private/tmp/claude-501/p/s/scratchpad/plan.html',
    '/work/.claude/plans/today.md',
    '.claude/plans/deep/plan.html',
    'docs/plans/2026-10.md',
    'src/feature.plan.md',
    'feature.plan.html',
    '/work/a/b/c.plan.html',
  ]
  for (const p of yes) expect(isPlanMaterial(p, cwd)).toBe(true)
  const no = [
    '/tmp/claude-1000',
    '/tmp/claude-1000/',
    '/tmp/other/plan.html',
    '/tmp/claudex/plan.html',
    '/home/tester/elsewhere/x.plan.md',
    'src/a.ts',
    'docs/planning.md',
    '.claude/plans/../../src/a.ts',
    'plan.html',
    '',
  ]
  for (const p of no) expect(isPlanMaterial(p, cwd)).toBe(false)
  // custom globs replace the defaults; the scratchpad stays
  expect(isPlanMaterial('design/x.md', cwd, ['design/**'])).toBe(true)
  expect(isPlanMaterial('docs/plans/x.md', cwd, ['design/**'])).toBe(false)
  expect(isPlanMaterial('/tmp/claude-1000/a/b.html', cwd, [])).toBe(true)
})

test('planPaths config: a good list replaces the defaults, a bad one is skipped and named', () => {
  expect(DEFAULTS.planPaths).toEqual(['.claude/plans/**', 'docs/plans/**', '**/*.plan.md', '**/*.plan.html'])
  const good = checkLayer({ planPaths: [' design/** ', 'notes/*.md'] })
  expect(good.layer).toEqual({ planPaths: ['design/**', 'notes/*.md'] })
  expect(good.errors).toEqual([])
  for (const bad of ['design/**', [''], [1], null, {}]) {
    const r = checkLayer({ planPaths: bad })
    expect(r.layer).toEqual({})
    expect(r.errors).toEqual(['planPaths must be a list of non-empty glob strings'])
  }
  const merged = mergeLayers([
    { label: '~/.claude/loopkeeper.json', layer: { planPaths: ['a/**'] } },
    { label: '.claude/loopkeeper.json', layer: checkLayer({ planPaths: 'oops' }).layer },
  ])
  expect(merged.config.planPaths).toEqual(['a/**'])
  expect(merged.sources.planPaths).toBe('~/.claude/loopkeeper.json')
  expect(mergeLayers([]).sources.planPaths).toBe('default')
  const text = planPathsText(['a/**'], '~/.claude/loopkeeper.json')
  expect(text).toContain('[~/.claude/loopkeeper.json]')
  expect(text).toContain('/tmp/claude-*/**')
  expect(text).toContain('  a/**')
})

test('context text: plan material line under requirePlan, and an Artifact page is not shipping', () => {
  const text = contextText({ ...DEFAULTS, requirePlan: true, blockAddAll: true })
  expect(text.split('\n').length).toBe(8)
  expect(text).toContain(
    '- Plan material is exempt: files under the scratchpad (/tmp/claude-*), .claude/plans/, docs/plans/ and *.plan.md|html may be written during planning, and a plan page may be published with the Artifact tool for the user to read and answer questions in; that is not shipping.',
  )
  expect(text).toContain('or runs /lk gates ship ok (publishing an Artifact page is not shipping).')
  expect(contextText(DEFAULTS)).not.toContain('Plan material')
})

// ---- New in loopkeeper: the file budget (ADR 0011), the config section, the Files seam, fail-closed ----------

test('limitOf: the max override wins; otherwise the largest of base, plan budget and session raise', () => {
  expect(limitOf({ base: 10, budget: 0, raise: 0 })).toBe(10)
  expect(limitOf({ base: 10, budget: 23, raise: 0 })).toBe(23)
  expect(limitOf({ base: 10, budget: 23, raise: 33 })).toBe(33)
  expect(limitOf({ base: 10, budget: 43, raise: 33 })).toBe(43)
  expect(limitOf({ max: 4, base: 10, budget: 43, raise: 33 })).toBe(4)
  expect(limitOf({ max: null, base: 10, budget: 0, raise: 20 })).toBe(20)
  expect(limitSource({ base: 10, budget: 23, raise: 0 })).toBe('budget')
  expect(limitSource({ base: 10, budget: 0, raise: 20 })).toBe('raise')
  expect(limitSource({ max: 4, base: 10, budget: 0, raise: 0 })).toBe('max')
  expect(limitSource({ base: 10, budget: 0, raise: 0 })).toBe('base')
})

test('raiseTo and the four options: the label carries the figure', () => {
  expect(raiseTo(10, 10)).toBe(20)
  expect(raiseTo(23, 10)).toBe(33)
  expect(filesOptions(20)).toEqual(['Allow 1 more', 'Allow rest of turn', 'Raise to 20 for this session', 'Stop'])
})

test('sectionLayer reads the changeControl section of loopkeeper.json; other sections are not its business', () => {
  expect(sectionLayer(JSON.stringify({ pipeline: { auto: false } }))).toEqual({ layer: {}, errors: [] })
  expect(sectionLayer('')).toEqual({ layer: {}, errors: [] })
  expect(sectionLayer(JSON.stringify({ changeControl: { maxFilesPerTurn: 3, planSlack: 5 } })).layer).toEqual({ maxFilesPerTurn: 3, planSlack: 5 })
  expect(sectionLayer(JSON.stringify({ changeControl: { planSlack: -1 } })).errors).toEqual(['planSlack must be a whole number from 0 to 1000'])
  expect(sectionLayer(JSON.stringify({ changeControl: [] })).errors).toEqual(['changeControl must be an object'])
  expect(() => sectionLayer('[1]')).toThrow()
  expect(DEFAULTS.maxFilesPerTurn).toBe(10)
  expect(DEFAULTS.planSlack).toBe(10)
})

test('noteBashWrites records each path once, newest last, created only when it was not there', () => {
  const first = noteBashWrites([], [{ path: 'a.txt', created: true }, { path: 'src/b.ts', created: false }], 5)
  expect(first.touched.map(t => [t.path, t.tool, t.edited, t.created])).toEqual([
    ['a.txt', 'Bash', true, true],
    ['src/b.ts', 'Bash', true, false],
  ])
  expect(first.last).toBe('edited b.ts')
  const again = noteBashWrites(first.touched, [{ path: 'a.txt', created: false }], 6)
  expect(again.touched.map(t => t.path)).toEqual(['src/b.ts', 'a.txt'])
  expect(again.touched[1]?.created).toBe(true)
})

test('the fail-closed refusal names /lk gates off and CLAUDE_MODS_DISABLE=loopkeeper', () => {
  const r = failClosedReason('throw', 'cwd unavailable')
  expect(r).toBe(
    'loopkeeper: the gates failed (throw: cwd unavailable) and refused this call rather than let it through unchecked. Tell the user; they can run /lk gates off, or set CLAUDE_MODS_DISABLE=loopkeeper.',
  )
})
