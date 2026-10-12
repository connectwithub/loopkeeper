// gates.test.ts: the edit guard, ported from change-control's guard.test.ts. Files per turn (with the base set to 6
// so every figure of the source stays), protected paths, the plan gate on the stage atoms (ADR 0004), plan material,
// the switches and config, the kill switch, fail-closed, and the changeControl rules block.
import { expect, test } from 'claude-code/testing'

import { GSD_STAGES } from '../hooks/lib/stageModel.ts'
import { bash, CWD, edit, lk, PROJECT_CONFIG, projectGates, startTurn, USER_CONFIG, world } from './world.ts'

const ASK_FILES = 'loopkeeper: this turn already touched 6 files. Allow more?'
/** Many guarded calls per test; under a loaded parallel run the 5 s default is too tight. */
const SLOW = { timeoutMs: 20_000 }
/** The source's default limit was 6; the new default is 10 (ADR 0011), so these tests set the base to 6. */
const SIX = (extra: Record<string, unknown> = {}) => projectGates({ maxFilesPerTurn: 6, ...extra })
const six = async ($: any) => {
  for (let i = 1; i <= 6; i++) expect((await $.tool.check(edit(`${CWD}/src/f${i}.ts`))).decision).toBe('allow')
}

// ---- Files per turn ----------------------------------------------------------------

test('six distinct files pass; the same file twice counts once', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Stop'], files: SIX() })
  await startTurn($)
  await six($)
  expect((await $.tool.check(edit(`${CWD}/src/f1.ts`, 'Write'))).decision).toBe('allow')
  expect(w.asked).toEqual([])
})

test('the 7th file asks; "Allow 1 more" lets exactly one more through', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Allow 1 more', 'Stop'], files: SIX() })
  await startTurn($)
  await six($)
  expect((await $.tool.check(edit(`${CWD}/src/f7.ts`))).decision).toBe('allow')
  expect(w.asked).toEqual([ASK_FILES])
  const eighth: any = await $.tool.check(edit(`${CWD}/src/f8.ts`))
  expect(w.asked.length).toBe(2)
  expect(w.asked[1]).toBe('loopkeeper: this turn already touched 7 files. Allow more?')
  expect(eighth.decision).toBe('deny')
})

test('"Allow rest of turn" stops asking until the next turn', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Allow rest of turn'], files: SIX() })
  await startTurn($)
  await six($)
  for (let i = 7; i <= 10; i++) expect((await $.tool.check(edit(`${CWD}/src/f${i}.ts`))).decision).toBe('allow')
  expect(w.asked.length).toBe(1)
  await $.turn.start({ text: 'next', turnId: 't2' })
  await six($)
  await $.tool.check(edit(`${CWD}/src/g7.ts`))
  expect(w.asked.length).toBe(2)
})

test('"Stop" denies and aborts the turn 250 ms later', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Stop'], files: SIX() })
  await startTurn($)
  await six($)
  const r: any = await $.tool.check(edit(`${CWD}/src/f7.ts`))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('stopped this edit')
  expect(r.reason).toContain('src/f7.ts')
  expect(r.reason).toContain('ask the user before continuing')
  expect(w.aborted).toEqual([])
  await w.clock.advance(250)
  expect(w.aborted).toEqual(['t1'])
})

test('a dismissed question is a Stop', SLOW, async ($, on) => {
  world(on, { answers: ['reject'], files: SIX() })
  await startTurn($)
  await six($)
  const r: any = await $.tool.check(edit(`${CWD}/src/f7.ts`))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('dismissed')
})

test('non-interactive: deny and abort without asking', SLOW, async ($, on) => {
  const w = world(on, { surfaces: [], files: SIX() })
  await startTurn($)
  await six($)
  const r: any = await $.tool.check(edit(`${CWD}/src/f7.ts`))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('non-interactive')
  expect(w.asked).toEqual([])
  await w.clock.advance(300)
  expect(w.aborted).toEqual(['t1'])
  // only once per turn
  await $.tool.check(edit(`${CWD}/src/f8.ts`))
  await w.clock.advance(300)
  expect(w.aborted).toEqual(['t1'])
})

test('turn.start resets the count', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Stop'], files: SIX() })
  await startTurn($)
  await six($)
  await $.turn.start({ text: 'again', turnId: 't2' })
  await six($)
  expect(w.asked).toEqual([])
})

test('Bash writes count: sed -i, redirection, tee, cp, mv, touch, rm', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Stop'], files: SIX() })
  await startTurn($)
  expect((await $.tool.check(bash("sed -i 's/a/b/' a.ts b.ts && echo x > c.txt"))).decision).toBe('allow')
  expect((await $.tool.check(bash('cat x | tee d.txt; cp e f.txt; mv g h.txt'))).decision).toBe('allow')
  const r: any = await $.tool.check(bash('touch i.txt j.txt && rm k.txt'))
  expect(r.decision).toBe('deny')
  expect(w.asked).toEqual([ASK_FILES])
})

test('NotebookEdit and MultiEdit count by their path', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Stop'], files: projectGates({ maxFilesPerTurn: 1 }) })
  await startTurn($)
  expect((await $.tool.check(edit(`${CWD}/n.ipynb`, 'NotebookEdit'))).decision).toBe('allow')
  expect((await $.tool.check(edit(`${CWD}/m.ts`, 'MultiEdit'))).decision).toBe('deny')
  expect(w.asked).toEqual(['loopkeeper: this turn already touched 1 files. Allow more?'])
})

test('a call the rules beneath already deny is passed through, not asked about or counted', SLOW, async ($, on) => {
  const w = world(on, { below: 'deny', answers: ['Stop'], files: SIX() })
  await startTurn($)
  for (let i = 1; i <= 8; i++) expect((await $.tool.check(edit(`${CWD}/src/f${i}.ts`))).decision).toBe('deny')
  expect((await $.tool.check(edit(`${CWD}/.env`))).decision).toBe('deny')
  expect(w.asked).toEqual([])
})

test('an "ask" from the rules beneath is kept when the gates allow', SLOW, async ($, on) => {
  world(on, { below: 'ask' })
  await startTurn($)
  expect((await $.tool.check(edit(`${CWD}/src/a.ts`))).decision).toBe('ask')
})

test('a permission query (no tool_use_id) is not counted', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Stop'], files: SIX() })
  await startTurn($)
  for (let i = 1; i <= 10; i++) await $.tool.check({ tool: 'Edit', input: { file_path: `${CWD}/q${i}.ts` } })
  await six($)
  expect(w.asked).toEqual([])
})

const sub = (file: string) => ({ ...edit(file), agentId: 'agent-1' })

test('default: a subagent edit beyond the limit passes and is not counted', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Stop'], files: SIX() })
  await startTurn($)
  await six($)
  for (let i = 7; i <= 9; i++) expect((await $.tool.check(sub(`${CWD}/src/s${i}.ts`) as any)).decision).toBe('allow')
  expect(w.asked).toEqual([])
  expect(await lk($, 'gates text')).toContain('Files touched this turn (6/6):')
  // protected paths still apply to subagents
  expect((await $.tool.check(sub(`${CWD}/.env`) as any)).decision).toBe('deny')
})

test('countSubagents true: a subagent edit is counted and asked', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Stop'], files: SIX({ countSubagents: true }) })
  await startTurn($)
  await six($)
  expect((await $.tool.check(sub(`${CWD}/src/s7.ts`) as any)).decision).toBe('deny')
  expect(w.asked).toEqual([ASK_FILES])
})

// ---- Protected paths ------------------------------------------------------------------

test('protected deny names the glob and tells Claude to ask the user', SLOW, async ($, on) => {
  const w = world(on)
  await startTurn($)
  const r: any = await $.tool.check(edit(`${CWD}/.env.local`, 'Write'))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('rule ".env*": deny')
  expect(r.reason).toContain('Ask the user')
  expect(w.asked).toEqual([])
})

test('protected deny also covers Bash writes', SLOW, async ($, on) => {
  world(on)
  await startTurn($)
  const r: any = await $.tool.check(bash('echo KEY=1 >> api/.env'))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('api/.env')
})

test('protected ask: "Allow once" allows this call and asks again next time', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Allow once'] })
  await startTurn($)
  expect((await $.tool.check(edit(`${CWD}/docs/decisions/ADR-1.md`))).decision).toBe('allow')
  expect((await $.tool.check(edit(`${CWD}/docs/decisions/ADR-1.md`))).decision).toBe('allow')
  expect(w.asked.length).toBe(2)
  expect(w.asked[0]).toContain('docs/decisions/ADR-1.md is protected (rule "docs/decisions/**")')
})

test('protected ask: "Allow for session" asks once per path', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Allow for session'] })
  await startTurn($)
  await $.tool.check(edit(`${CWD}/db/migrations/001.sql`))
  await $.turn.start({ text: 'next', turnId: 't2' })
  expect((await $.tool.check(edit(`${CWD}/db/migrations/001.sql`))).decision).toBe('allow')
  expect(w.asked.length).toBe(1)
  await $.tool.check(edit(`${CWD}/db/migrations/002.sql`))
  expect(w.asked.length).toBe(2)
})

test('protected ask: "Deny" refuses', SLOW, async ($, on) => {
  world(on, { answers: ['Deny'] })
  await startTurn($)
  const r: any = await $.tool.check(edit(`${CWD}/docs/decisions/ADR-2.md`))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('the user chose Deny')
})

test('protected ask with nobody to ask refuses', SLOW, async ($, on) => {
  const w = world(on, { surfaces: [] })
  await startTurn($)
  const r: any = await $.tool.check(edit(`${CWD}/docs/decisions/ADR-2.md`))
  expect(r.decision).toBe('deny')
  expect(w.asked).toEqual([])
})

// ---- Plan gate ----------------------------------------------------------------------

const PLAN = projectGates({ requirePlan: true })
/** The requirePlan refusal's tail with the gsd preset's gated Validate plan stage. */
const GATED_HOW =
  " and ask the user to approve it: /lk approve opens the pipeline's Validate plan gate (from Plan or Validate plan), " +
  'or /lk gates plan ok allows edits for this session without it.'

test('requirePlan refuses edits until a plan exists, telling Claude to present one', SLOW, async ($, on) => {
  const w = world(on, { files: PLAN })
  await startTurn($)
  const r: any = await $.tool.check(edit(`${CWD}/src/a.ts`))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('Present a short plan')
  expect(r.reason).toContain('or ask the user for /lk gates plan ok')
  expect(w.asked).toEqual([])
})

test('plan gate: satisfied by an ExitPlanMode call', SLOW, async ($, on) => {
  world(on, { files: PLAN })
  await startTurn($)
  await $.tool.call({ tool: 'ExitPlanMode', allowedPrompts: [] })
  expect((await $.tool.check(edit(`${CWD}/src/a.ts`))).decision).toBe('allow')
})

test('plan gate: satisfied by /lk gates plan ok', SLOW, async ($, on) => {
  world(on, { files: PLAN })
  await startTurn($)
  expect(await lk($, 'gates plan ok')).toContain('plan approved')
  expect((await $.tool.check(edit(`${CWD}/src/a.ts`))).decision).toBe('allow')
})

// ADR 0004: the stage's signal is stagePlanDone, not "the current stage is not plan".
test('plan gate: satisfied by the stage atom stagePlanDone', SLOW, async ($, on) => {
  const w = world(on, { files: PLAN })
  await startTurn($)
  // as the stage leaves them once it moved past an approved plan (seeded after its session start)
  Object.assign(w.atoms, { stagePlanDone: true, stageCurrent: 'execute', stageShipOpen: false })
  expect((await $.tool.check(edit(`${CWD}/src/a.ts`))).decision).toBe('allow')
})

test('plan gate: the stage past plan but stagePlanDone false does not satisfy it, and says to run /lk approve', SLOW, async ($, on) => {
  const w = world(on, { files: PLAN })
  await startTurn($)
  Object.assign(w.atoms, { stageStages: GSD_STAGES.map(s => ({ ...s })), stagePlanDone: false, stageCurrent: 'validate-plan', stageShipOpen: false })
  const r: any = await $.tool.check(edit(`${CWD}/src/a.ts`))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('Goal, Steps, Done-when, and the files you will touch')
  expect(r.reason).toContain(GATED_HOW)
})

// The source's "pipeline-stage absent" case: the stage is always there now (ADR 0004), so its defaults stand in.
test('plan gate: the stage at its defaults (no plan approved yet) does not satisfy it', SLOW, async ($, on) => {
  world(on, { files: PLAN })
  await startTurn($)
  const r: any = await $.tool.check(edit(`${CWD}/src/a.ts`))
  expect(r.decision).toBe('deny')
  // the default stages gate no plan stage: /lk approve has nothing to open, so it is not named
  expect(r.reason).toContain(', then move the pipeline past Plan with set_stage, or ask the user for /lk gates plan ok.')
  expect(r.reason.includes('/lk approve')).toBe(false)
})

/** A custom preset with its own labels: the texts name these, never "Plan", "Validate plan" or "Ship". */
const CUSTOM = [
  { id: 'plan', label: 'Sketch' },
  { id: 'validate-plan', label: 'Plan review', gate: true },
  { id: 'build', label: 'Make' },
  { id: 'qa', label: 'Checks' },
  { id: 'ship', label: 'Release', gate: true },
]

test('plan gate texts: a preset with a plan gate names /lk approve and its stages; one without names set_stage', SLOW, async ($, on) => {
  const w = world(on, { files: PLAN })
  await startTurn($)
  const reason = async () => ((await $.tool.check(edit(`${CWD}/src/a.ts`))) as { reason: string }).reason
  const head =
    'loopkeeper: edits are refused until a plan is approved in this session (requirePlan is on). ' +
    'Do not try another tool to make this change. Present a short plan (Goal, Steps, Done-when, and the files you will touch)'
  Object.assign(w.atoms, { stageStages: GSD_STAGES.map(s => ({ ...s })), stagePlanDone: false, stageCurrent: 'plan' })
  expect(await reason()).toBe(head + GATED_HOW)
  w.atoms.stageStages = CUSTOM.map(s => ({ ...s }))
  expect(await reason()).toBe(
    head +
      " and ask the user to approve it: /lk approve opens the pipeline's Plan review gate (from Sketch or Plan review), " +
      'or /lk gates plan ok allows edits for this session without it.',
  )
  // no gated plan stage: moving past the plan stage is what opens edits
  w.atoms.stageStages = [{ id: 'plan', label: 'Sketch' }, { id: 'build', label: 'Make' }]
  expect(await reason()).toBe(head + ', then move the pipeline past Sketch with set_stage, or ask the user for /lk gates plan ok.')
})

test('/lk gates plan ok: while a plan gate is pending the reply says it is separate; otherwise it does not', SLOW, async ($, on) => {
  const w = world(on, { files: PLAN })
  await startTurn($)
  const OK = 'plan approved for this session: edits may go ahead.'
  const separate = (gate: string) =>
    ` The pipeline's ${gate} gate is separate: moving past it still needs /lk approve ` +
    "(in approval mode auto, a plan validator's consistent verdict also opens it)."
  // the default stages gate no plan stage
  expect(await lk($, 'gates plan ok')).toBe(OK)
  Object.assign(w.atoms, { stageStages: GSD_STAGES.map(s => ({ ...s })), stagePlanDone: false, stageCurrent: 'plan' })
  expect(await lk($, 'gates plan ok')).toBe(OK + separate('Validate plan'))
  expect((await $.tool.check(edit(`${CWD}/src/a.ts`))).decision).toBe('allow')
  w.atoms.stageStages = CUSTOM.map(s => ({ ...s }))
  expect(await lk($, 'gates plan ok')).toBe(OK + separate('Plan review'))
  // the plan gate already passed: nothing pending
  Object.assign(w.atoms, { stageApproved: ['validate-plan'], stagePlanDone: true, stageCurrent: 'build' })
  expect(await lk($, 'gates plan ok')).toBe(OK)
})

// ---- The project root: a shell `cd` moves the session's folder, not the project root ------------------------------

test('after a cd into a subfolder, plan material is still recognised from the project root', SLOW, async ($, on) => {
  const w = world(on, { files: PLAN })
  await startTurn($)
  w.cd(`${CWD}/packages/app`)
  expect((await $.tool.check(edit(`${CWD}/.claude/plans/x.md`, 'Write'))).decision).toBe('allow')
  expect((await $.tool.check(bash('echo plan > ../../docs/plans/y.md'))).decision).toBe('allow')
  const code: any = await $.tool.check(edit(`${CWD}/packages/app/src/a.ts`, 'Write'))
  expect(code.decision).toBe('deny')
  const out = await lk($, 'gates text')
  expect(out).toContain('plan allowed .claude/plans/x.md · plan material')
  expect(out).toContain('plan denied packages/app/src/a.ts')
})

test('after a cd into a subfolder, a protected path still asks', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Deny'] })
  await startTurn($)
  w.cd(`${CWD}/packages/app`)
  const r: any = await $.tool.check(edit(`${CWD}/docs/decisions/x.md`, 'Write'))
  expect(r.decision).toBe('deny')
  expect(w.asked).toEqual(['loopkeeper: docs/decisions/x.md is protected (rule "docs/decisions/**"). Allow this Write edit?'])
})

test('a relative Bash target is placed from where the command runs: a leading cd, or the session moved by one', SLOW, async ($, on) => {
  const w = world(on, { files: projectGates({ protected: [{ glob: 'pkg/**', action: 'deny' }] }) })
  await startTurn($)
  const reason = async (command: string) => ((await $.tool.check(bash(command))) as { reason?: string }).reason ?? ''
  expect(await reason('cd pkg && echo x > out.txt')).toContain('pkg/out.txt is a protected path (rule "pkg/**": deny)')
  w.cd(`${CWD}/pkg`)
  expect(await reason('echo x > more.txt')).toContain('pkg/more.txt is a protected path (rule "pkg/**": deny)')
  expect(await reason('echo x > ../top.txt')).toBe('')
})

// ---- Plan material (ADR 0005: one list, changeControl.planPaths; the scratchpad always) ----------------------------

const SCRATCH_PLAN = '/tmp/claude-1000/x/y/scratchpad/plan.html'
const CODE_REASON =
  'loopkeeper: edits are refused until a plan is approved in this session (requirePlan is on). ' +
  'Do not try another tool to make this change. Present a short plan (Goal, Steps, Done-when, and the files you will touch), ' +
  'then move the pipeline past Plan with set_stage, or ask the user for /lk gates plan ok.'

test('plan material: the scratchpad plan page is allowed under requirePlan while a code file is still refused', SLOW, async ($, on) => {
  const w = world(on, { files: PLAN })
  await startTurn($)
  Object.assign(w.atoms, { stagePlanDone: false, stageCurrent: 'plan', stageShipOpen: false })
  const code: any = await $.tool.check(edit(`${CWD}/src/a.ts`, 'Write'))
  expect(code.decision).toBe('deny')
  expect(code.reason).toBe(CODE_REASON)
  expect((await $.tool.check(edit(SCRATCH_PLAN, 'Write'))).decision).toBe('allow')
  expect((await $.tool.check(edit(SCRATCH_PLAN))).decision).toBe('allow')
  for (const f of ['.claude/plans/p.md', 'docs/plans/p.html', 'src/x.plan.md', 'y.plan.html']) {
    expect((await $.tool.check(edit(`${CWD}/${f}`, 'Write'))).decision).toBe('allow')
  }
  expect((await $.tool.check(edit(`${CWD}/docs/planning.md`, 'Write'))).decision).toBe('deny')
  const out = await lk($, 'gates text')
  expect(out).toContain(`plan allowed ${SCRATCH_PLAN} · plan material`)
  expect(out).toContain('plan denied src/a.ts')
})

test('plan material does not count toward maxFilesPerTurn', SLOW, async ($, on) => {
  const w = world(on, { files: projectGates({ maxFilesPerTurn: 1 }), answers: ['Stop'] })
  await startTurn($)
  expect((await $.tool.check(edit(SCRATCH_PLAN, 'Write'))).decision).toBe('allow')
  expect((await $.tool.check(edit(`${CWD}/docs/plans/p.md`, 'Write'))).decision).toBe('allow')
  expect((await $.tool.check(edit(`${CWD}/src/a.ts`))).decision).toBe('allow')
  expect((await $.tool.check(edit(`${CWD}/.claude/plans/q.md`, 'Write'))).decision).toBe('allow')
  expect(w.asked).toEqual([])
  expect((await $.tool.check(edit(`${CWD}/src/b.ts`))).decision).toBe('deny')
  expect(w.asked).toEqual(['loopkeeper: this turn already touched 1 files. Allow more?'])
})

test('plan material: a protected path still wins', SLOW, async ($, on) => {
  const w = world(on, {
    files: projectGates({ requirePlan: true, planPaths: ['docs/plans/**', '.env*'], protected: [{ glob: 'docs/plans/secret/**', action: 'deny' }] }),
    answers: ['Deny'],
  })
  await startTurn($)
  const r: any = await $.tool.check(edit(`${CWD}/docs/plans/secret/p.md`, 'Write'))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('rule "docs/plans/secret/**": deny')
  const env: any = await $.tool.check(edit(`${CWD}/.env.plan`, 'Write'))
  expect(env.decision).toBe('deny')
  expect(env.reason).toContain('rule ".env*": deny')
  expect((await $.tool.check(edit(`${CWD}/docs/plans/ok.md`, 'Write'))).decision).toBe('allow')
  expect(w.asked).toEqual([])
})

test('planPaths from config replace the defaults; /lk gates plan paths prints them and their source', SLOW, async ($, on) => {
  world(on, { files: projectGates({ requirePlan: true, planPaths: ['design/**'] }) })
  await startTurn($)
  expect((await $.tool.check(edit(`${CWD}/design/plan.html`, 'Write'))).decision).toBe('allow')
  expect((await $.tool.check(edit(`${CWD}/docs/plans/p.md`, 'Write'))).decision).toBe('deny')
  expect((await $.tool.check(edit(SCRATCH_PLAN, 'Write'))).decision).toBe('allow')
  const out = await lk($, 'gates plan paths')
  expect(out).toContain('[.claude/loopkeeper.json]:')
  expect(out).toContain('  design/**')
  expect(out).toContain('/tmp/claude-*/**')
})

test('a bad planPaths falls back to the defaults and is named', SLOW, async ($, on) => {
  const w = world(on, { files: projectGates({ requirePlan: true, planPaths: 'docs/**' }) })
  await startTurn($)
  expect((await $.tool.check(edit(`${CWD}/docs/plans/p.md`, 'Write'))).decision).toBe('allow')
  expect((await $.tool.check(edit(`${CWD}/docs/other.md`, 'Write'))).decision).toBe('deny')
  expect(w.toasts.some(t => t.includes('planPaths must be a list'))).toBe(true)
  expect(await lk($, 'gates plan paths')).toContain('[default]:')
})

// ---- Switches, config, kill switch, fail closed -----------------------------------------

test('/lk gates off lets everything through; on restores it', SLOW, async ($, on) => {
  world(on)
  await startTurn($)
  await lk($, 'gates off')
  expect((await $.tool.check(edit(`${CWD}/.env`))).decision).toBe('allow')
  await lk($, 'gates on')
  expect((await $.tool.check(edit(`${CWD}/.env`))).decision).toBe('deny')
})

test('/lk gates max <n> is a session override kept in $.store', SLOW, async ($, on) => {
  const w = world(on, { answers: ['Stop'], files: projectGates({ maxFilesPerTurn: 9 }) })
  await startTurn($)
  expect(await lk($, 'gates max 2')).toContain('2')
  expect(w.store.get('loopkeeper:gates:overrides:sess-1')).toEqual({ maxFilesPerTurn: 2 })
  await $.tool.check(edit(`${CWD}/a.ts`))
  await $.tool.check(edit(`${CWD}/b.ts`))
  expect((await $.tool.check(edit(`${CWD}/c.ts`))).decision).toBe('deny')
  expect(w.asked).toEqual(['loopkeeper: this turn already touched 2 files. Allow more?'])
  expect(await lk($, 'gates text')).toContain('maxFilesPerTurn: 2  [session]')
})

test('config merge: project file over user file, with sources in /lk gates text', SLOW, async ($, on) => {
  world(on, {
    files: {
      ...projectGates({ maxFilesPerTurn: 3, protected: [{ glob: 'infra/**', action: 'deny' }] }),
      [USER_CONFIG]: JSON.stringify({ changeControl: { maxFilesPerTurn: 8, blockAddAll: true } }),
    },
  })
  await startTurn($)
  const out = await lk($, 'gates text')
  expect(out).toContain('maxFilesPerTurn: 3  [.claude/loopkeeper.json]')
  expect(out).toContain('blockAddAll: on  [~/.claude/loopkeeper.json]')
  expect(out).toContain('protected infra/**: deny  [.claude/loopkeeper.json]')
  expect(out).toContain('protected .env*: deny  [default]')
  expect((await $.tool.check(edit(`${CWD}/infra/main.tf`))).decision).toBe('deny')
})

test('a broken config file is ignored with a toast, defaults stand', SLOW, async ($, on) => {
  const w = world(on, { files: { [PROJECT_CONFIG]: '{ not json' } })
  await startTurn($)
  expect(w.toasts.join(' ')).toContain('not a JSON object')
  expect((await $.tool.check(edit(`${CWD}/.env`))).decision).toBe('deny')
})

test('kill switch: CLAUDE_MODS_DISABLE=loopkeeper in a list makes every gate a pass-through', SLOW, async ($, on) => {
  const w = world(on, { env: { CLAUDE_MODS_DISABLE: 'other, loopkeeper' }, answers: ['Stop'] })
  await startTurn($)
  expect((await $.tool.check(edit(`${CWD}/.env`))).decision).toBe('allow')
  for (let i = 1; i <= 12; i++) await $.tool.check(edit(`${CWD}/k${i}.ts`))
  expect((await $.tool.check(bash('gh pr merge 3'))).decision).toBe('allow')
  expect(w.asked).toEqual([])
})

test('kill switch: CLAUDE_MODS_DISABLE=all', SLOW, async ($, on) => {
  world(on, { env: { CLAUDE_MODS_DISABLE: 'all' } })
  await startTurn($)
  expect((await $.tool.check(edit(`${CWD}/.env`))).decision).toBe('allow')
})

test('fail closed: a guard that throws before any session start denies with a clear reason', SLOW, async ($, on) => {
  world(on, { breakCwd: true })
  const r: any = await $.tool.check(edit(`${CWD}/src/a.ts`))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('the gates failed')
  expect(r.reason).toContain('CLAUDE_MODS_DISABLE=loopkeeper')
})

// ---- prompt.context --------------------------------------------------------------------

test('prompt.context adds one named block and replaces a stale one', SLOW, async ($, on) => {
  world(on, { files: SIX() })
  await startTurn($)
  const out: any = await $.prompt.context({
    blocks: [
      { name: 'claudeMd', text: 'x' },
      { name: 'changeControl', text: 'stale' },
    ],
    instructionFiles: [],
  })
  const mine = out.blocks.filter((b: any) => b.name === 'changeControl')
  expect(mine.length).toBe(1)
  expect(mine[0].text).toContain('At most 6 distinct files')
  expect(mine[0].text.split('\n').length <= 8).toBe(true)
  expect(out.blocks[0].name).toBe('claudeMd')
})

test('prompt.context drops a stale block when the gates are off', SLOW, async ($, on) => {
  world(on)
  await startTurn($)
  await lk($, 'gates off')
  const out: any = await $.prompt.context({ blocks: [{ name: 'changeControl', text: 'stale' }], instructionFiles: [] })
  // the other concerns add blocks of their own; none of them is the gates' block
  expect(out.blocks.filter((b: any) => b.name === 'changeControl')).toEqual([])
})
