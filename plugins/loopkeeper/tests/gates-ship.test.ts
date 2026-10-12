// gates-ship.test.ts: the ship gate. Ported from change-control's ship tests (17); names changed (loopkeeper:,
// /lk approve, /lk gates …, loopkeeper:gates: store keys). ADR 0004: the stage machine is always present, so the
// pipeline-stage $.state the old world answered is now the stage atoms (stagePlanDone, stageShipOpen, stageCurrent),
// seeded after the session starts (the stage writes them at session start). The four "pipeline-stage absent"
// fallback-question cases are replaced by their stage-atom equivalents: no question is ever asked about shipping.
import { expect, test } from 'claude-code/testing'

import { contextText, DEFAULTS, shipCommands } from '../hooks/lib/gateRules.ts'
import { TONES } from '../hooks/lib/kit.ts'
import { bare } from '../hooks/lib/shell.ts'
import { GSD_STAGES } from '../hooks/lib/stageModel.ts'
import { bandLineOf, bash, CWD, edit, linePlain, lk, projectGates, startTurn, world, type World } from './world.ts'

const MERGE_Q = 'Merge now? (loopkeeper: push to the default branch)'
const OVERRIDES = 'loopkeeper:gates:overrides:sess-1'
/** The refusal with the gsd preset's gated Ship stage; the stage is named by its label. */
const gated = (what: string, stage: string) =>
  `loopkeeper: shipping is gated (${what}). The pipeline is at ${stage}. Ask the user to review the work and run /lk approve at QA or Ship ` +
  '(it opens the Ship gate; a waiting file budget comes first), or /lk gates ship ok.'

/** As the stage leaves its atoms in QA of the gsd preset, with its gated Ship stage ahead: the plan done, shipping held. */
function held(w: World): void {
  w.atoms.stageStages = GSD_STAGES.map(s => ({ ...s }))
  w.atoms.stageApproved = ['validate-plan']
  w.atoms.stagePlanDone = true
  w.atoms.stageShipOpen = false
  w.atoms.stageCurrent = 'qa'
}

type Verdict = { decision: string; reason?: string }
const check = async ($: any, call: unknown): Promise<Verdict> => (await $.tool.check(call)) as Verdict

// ---- Rules ---------------------------------------------------------------------------

test('shipCommands finds every shipping command, through wrappers, and none in a heredoc or quotes', () => {
  const ships = (cmd: string) => shipCommands(bare(cmd))
  expect(ships('git add a.ts && git commit -m "x" && git push')).toEqual(['git commit', 'git push'])
  expect(ships('gh pr create --fill')).toEqual(['gh pr create'])
  expect(ships('gh pr merge 3 --squash')).toEqual(['gh pr merge'])
  expect(ships('gh release create v1.0.0')).toEqual(['gh release create'])
  for (const c of ['npm publish', 'pnpm publish --access public', 'yarn publish', 'cargo publish', 'twine upload dist/*', 'pip upload x']) {
    expect(ships(c).length).toBe(1)
  }
  expect(ships('sudo -E env CI=1 git push origin feature')).toEqual(['git push'])
  expect(ships('cat <<EOF > notes.md\ngit commit -m x\nnpm publish\nEOF')).toEqual([])
  expect(ships('echo "git commit and git push later"')).toEqual([])
  expect(ships('git status && git log --oneline')).toEqual([])
  expect(ships('npm run build')).toEqual([])
})

test('the context block mentions the ship gate in one line, and stays within 8 lines', () => {
  const text = contextText({ ...DEFAULTS, requirePlan: true, blockAddAll: true })
  expect(text.split('\n').length <= 8).toBe(true)
  expect(text.split('\n').filter(l => l.includes('Shipping')).length).toBe(1)
  expect(contextText({ ...DEFAULTS, shipGate: false })).not.toContain('Shipping')
})

// ---- Held and opened by the stage's stageShipOpen -------------------------------------------

test('ship gate: held while stageShipOpen is false, with the stage in the reason', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, { answers: ['Yes'] })
  await startTurn($)
  held(w)
  for (const [cmd, what] of [
    ['git commit -m "x"', 'git commit'],
    ['git push -u origin feature', 'git push'],
    ['gh pr create --fill', 'gh pr create'],
    ['npm publish', 'npm publish'],
  ] as const) {
    const r = await check($, bash(cmd))
    expect(r.decision).toBe('deny')
    expect(r.reason).toBe(gated(what, 'QA'))
  }
  expect(w.asked).toEqual([])
  expect((await check($, bash('git status && git diff'))).decision).toBe('allow')
})

test('ship gate: the reason names the stages by their labels, from a custom preset too', async ($, on) => {
  const w = world(on)
  await startTurn($)
  held(w)
  w.atoms.stageStages = [
    { id: 'plan', label: 'Sketch' },
    { id: 'build', label: 'Make' },
    { id: 'qa', label: 'Checks' },
    { id: 'ship', label: 'Release', gate: true },
  ]
  w.atoms.stageApproved = []
  expect((await check($, bash('git push'))).reason).toBe(
    'loopkeeper: shipping is gated (git push). The pipeline is at Checks. Ask the user to review the work and run /lk approve at Checks or Release ' +
      '(it opens the Release gate; a waiting file budget comes first), or /lk gates ship ok.',
  )
  // no gated ship stage: /lk approve cannot open shipping, so only ship ok is named
  w.atoms.stageStages = [{ id: 'plan', label: 'Sketch' }, { id: 'qa', label: 'Checks' }]
  expect((await check($, bash('git push'))).reason).toBe(
    'loopkeeper: shipping is gated (git push). The pipeline is at Checks. Ask the user to review the work and run /lk gates ship ok.',
  )
})

test('ship gate: open when stageShipOpen is true', async ($, on) => {
  const w = world(on)
  await startTurn($)
  w.atoms.stagePlanDone = true
  w.atoms.stageShipOpen = true
  w.atoms.stageCurrent = 'ship'
  expect((await check($, bash('git commit -m "x" && git push -u origin feature'))).decision).toBe('allow')
  expect(w.asked).toEqual([])
})

test('ship gate: a heredoc that contains "git commit" does not trigger it', async ($, on) => {
  const w = world(on)
  await startTurn($)
  held(w)
  const r = await check($, bash("cat <<'EOF' > notes.md\nthen git commit -m done and git push\nEOF"))
  expect(r.decision).toBe('allow')
  expect(w.asked).toEqual([])
})

test('ship gate: subagents are held too', async ($, on) => {
  const w = world(on)
  await startTurn($)
  held(w)
  const r = await check($, { ...bash('git commit -m x'), agentId: 'agent-1' })
  expect(r.decision).toBe('deny')
})

// ---- The stage is always present (ADR 0004): no fallback question ------------------------------
// change-control asked "commit or publish now?" when pipeline-stage was absent. Each of those four tests becomes the
// stage-atom case it stood for.

test('the stage at its defaults (no gated Ship stage) leaves shipping open: commit and push run with no question', async ($, on) => {
  const w = world(on, { answers: ['Yes'] })
  await startTurn($)
  expect(w.atoms.stageShipOpen).toBeUndefined()
  expect((await check($, bash('git commit -m "x" && git push -u origin feature'))).decision).toBe('allow')
  expect(w.asked).toEqual([])
  expect(w.state.get('stageShipOpen')).toBe(true)
})

test("the stage's own gated Ship stage holds shipping, with no question; approving Ship opens it", { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on, { answers: ['No'] })
  w.store.set('loopkeeper:stage:preset:' + CWD, 'gsd')
  await startTurn($)
  expect(w.state.get('stageShipOpen')).toBe(false)
  const r = await check($, bash('git commit -m x'))
  expect(r.decision).toBe('deny')
  expect(r.reason).toBe(gated('git commit', 'Plan'))
  expect(w.asked).toEqual([])
  // a small task waives the plan gate and the verifier, so the pipeline may move on to Ship and approve it
  await lk($, 'size small')
  expect(await lk($, 'ship')).toContain('to Ship')
  expect(await lk($, 'approve')).toContain('Approved the Ship gate')
  expect(w.state.get('stageShipOpen')).toBe(true)
  expect((await check($, bash('git commit -m x'))).decision).toBe('allow')
  expect(w.asked).toEqual([])
})

test('nobody to ask: held shipping is refused the same way, open shipping runs, and nothing is asked', async ($, on) => {
  const w = world(on, { surfaces: [] })
  await startTurn($)
  held(w)
  const r = await check($, bash('git push -u origin feature'))
  expect(r.decision).toBe('deny')
  expect(r.reason).toBe(gated('git push', 'QA'))
  w.atoms.stageShipOpen = true
  expect((await check($, bash('git push -u origin feature'))).decision).toBe('allow')
  expect(w.asked).toEqual([])
})

test('the merge gate still applies on top of an open ship gate: git push origin main asks once, never twice', async ($, on) => {
  const w = world(on, { answers: ['Cancel'] })
  await startTurn($)
  held(w)
  await lk($, 'gates ship ok')
  const r = await check($, bash('git push origin main'))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('the user chose Cancel')
  expect(w.asked).toEqual([MERGE_Q])
})

// ---- Commands -------------------------------------------------------------------------

test('/lk gates ship ok opens the gate for the session and is kept in $.store', async ($, on) => {
  const w = world(on)
  await startTurn($)
  held(w)
  expect((await check($, bash('git commit -m x'))).decision).toBe('deny')
  expect(await lk($, 'gates ship ok')).toContain('shipping approved for this session')
  expect(w.store.get('loopkeeper:gates:shipOk:sess-1')).toBe(true)
  expect((await check($, bash('git commit -m x'))).decision).toBe('allow')
  expect(await lk($, 'gates text')).toContain('Ship: open (/lk gates ship ok)')
})

test('/lk gates ship gate off|on is a session override', async ($, on) => {
  const w = world(on)
  await startTurn($)
  held(w)
  expect(await lk($, 'gates ship gate off')).toBe('shipGate is off for this session.')
  expect(w.store.get(OVERRIDES)).toEqual({ shipGate: false })
  expect((await check($, bash('git commit -m x'))).decision).toBe('allow')
  await lk($, 'gates ship gate on')
  expect((await check($, bash('git commit -m x'))).decision).toBe('deny')
  expect(await lk($, 'gates ship maybe')).toContain('usage')
})

test('shipGate false in the project config turns it off', async ($, on) => {
  const w = world(on, { files: projectGates({ shipGate: false }) })
  await startTurn($)
  held(w)
  expect((await check($, bash('npm publish'))).decision).toBe('allow')
})

test('/lk gates plan required on|off switches requirePlan for the session', async ($, on) => {
  const w = world(on)
  await startTurn($)
  w.atoms.stagePlanDone = false
  w.atoms.stageCurrent = 'plan'
  w.atoms.stageShipOpen = false
  expect((await check($, edit(`${CWD}/src/a.ts`))).decision).toBe('allow')
  expect(await lk($, 'gates plan required on')).toContain('requirePlan is on for this session')
  expect(w.store.get(OVERRIDES)).toEqual({ requirePlan: true })
  expect((await check($, edit(`${CWD}/src/b.ts`))).decision).toBe('deny')
  await lk($, 'gates plan required off')
  expect((await check($, edit(`${CWD}/src/b.ts`))).decision).toBe('allow')
  expect(await lk($, 'gates text')).toContain('requirePlan: off  [session]')
})

test('gsd flow: plan required, stagePlanDone opens edits, stageShipOpen opens commits', async ($, on) => {
  const w = world(on)
  await startTurn($)
  Object.assign(w.atoms, { stagePlanDone: false, stageCurrent: 'validate-plan', stageShipOpen: false })
  await lk($, 'gates plan required on')
  expect((await check($, edit(`${CWD}/src/a.ts`))).decision).toBe('deny')
  w.atoms.stagePlanDone = true
  w.atoms.stageCurrent = 'execute'
  expect((await check($, edit(`${CWD}/src/a.ts`))).decision).toBe('allow')
  expect((await check($, bash('git commit -m x'))).decision).toBe('deny')
  w.atoms.stageCurrent = 'ship'
  w.atoms.stageShipOpen = true
  expect((await check($, bash('git commit -m x'))).decision).toBe('allow')
})

// ---- Band (kit v2: theme keys, no dimColor) --------------------------------------------------

test('the band ends with a ship chip: ship held in the warning tone, ship open in the ok tone', async ($, on) => {
  const w = world(on)
  await startTurn($)
  w.atoms.stageShipOpen = false
  let l = await bandLineOf($, 'gates')
  expect(linePlain(l)).toBe('gates  ● 0/10 files  ● merge gate  ● ship held')
  expect(l?.chips[2]).toEqual({ text: '● ship held', color: TONES.warn.fg, bold: true })
  w.atoms.stageShipOpen = true
  l = await bandLineOf($, 'gates', 'desktop')
  expect(linePlain(l)).toBe('gates  ● 0/10 files  ● merge gate  ● ship open')
  expect(l?.chips[2]).toEqual({ text: '● ship open', color: TONES.ok.fg, bold: true })
})

test('the band has no ship chip when the ship gate is off', async ($, on) => {
  world(on, { files: projectGates({ shipGate: false }) })
  await startTurn($)
  expect(linePlain(await bandLineOf($, 'gates'))).toBe('gates  ● 0/10 files  ● merge gate')
})
