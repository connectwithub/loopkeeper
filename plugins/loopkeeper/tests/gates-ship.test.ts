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
/**
 * The refusal on the terminal or the desktop, whatever the preset: the request waits on the card above the prompt (the
 * terminal draws it too), or /lk approve answers it; the stage is named by its label.
 */
const gated = (what: string, stage: string) =>
  `loopkeeper: shipping is gated (${what}). The pipeline is at ${stage}. The user's yes is asked on the card above the prompt; ` +
  "the user can also type /lk approve. Stop and wait for the user's answer; do not retry it another way."
/** With nobody to ask (-p, no surface): the command only. */
const gatedNone = (what: string, stage: string) =>
  `loopkeeper: shipping is gated (${what}). The pipeline is at ${stage}. Ask the user to review the work and run /lk gates ship ok.`

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
  expect((await check($, bash('git push'))).reason).toBe(gated('git push', 'Checks'))
  // no gated ship stage: /lk approve still answers the request (Allow this git push once), so the text is the same
  w.atoms.stageStages = [{ id: 'plan', label: 'Sketch' }, { id: 'qa', label: 'Checks' }]
  expect((await check($, bash('git push'))).reason).toBe(gated('git push', 'Checks'))
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
  expect(r.reason).toBe(gatedNone('git push', 'QA'))
  w.atoms.stageShipOpen = true
  expect((await check($, bash('git push -u origin feature'))).decision).toBe('allow')
  expect(w.asked).toEqual([])
})

test('ship ok covers the next git push origin main (allowed and recorded, no question); the one after asks once', async ($, on) => {
  const w = world(on, { answers: ['Cancel'] })
  await startTurn($)
  held(w)
  expect(await lk($, 'gates ship ok')).toContain('the next push or merge to the default branch is covered')
  expect((await check($, bash('git push origin main'))).decision).toBe('allow')
  expect(w.asked).toEqual([])
  expect(w.state.get('gateMergeCredit')).toBe(false)
  expect(await lk($, 'gates text')).toContain('merge allowed push to the default branch · covered by the Ship approval or /lk gates merge ok')
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

// ---- The Ship approval is spent by the person's next message after something shipped under it -------------------

/** The gsd preset, a small task moved to Ship and approved: the Ship gate open, the merge credit given. */
async function atShip($: any, on: any, opts: Parameters<typeof world>[1] = {}): Promise<World> {
  const w = world(on, opts)
  w.store.set('loopkeeper:stage:preset:' + CWD, 'gsd')
  await startTurn($)
  await lk($, 'size small')
  await lk($, 'ship')
  expect(await lk($, 'approve')).toContain('Approved the Ship gate')
  return w
}
const USED = 'Ship approval used: the next commit or push needs a fresh OK.'
const submit = ($: any, text: string, origin?: unknown) => $.prompt.submit({ text, ...(origin ? { origin } : {}) } as never)

test('a commit under the Ship approval marks it used; the person\'s next prompt spends it and the push is held', { timeoutMs: 30_000 }, async ($, on) => {
  const w = await atShip($, on)
  expect(w.state.get('stageShipUsed')).toBe(false)
  // before anything shipped, a prompt such as "go ahead and push" spends nothing
  await submit($, 'I ran /lk approve, go ahead and push')
  expect(w.state.get('stageApproved')).toContain('ship')
  expect((await check($, bash('git commit -m x'))).decision).toBe('allow')
  expect(w.state.get('stageShipUsed')).toBe(true)
  expect(w.state.get('stageApproved')).toContain('ship')
  await submit($, 'thanks, now also tidy the README')
  expect(w.state.get('stageShipUsed')).toBe(false)
  expect(w.state.get('stageApproved')).not.toContain('ship')
  expect(w.state.get('gateMergeCredit')).toBe(false)
  expect(w.state.get('stageShipOpen')).toBe(false)
  expect(w.logs.some((l: string) => l.includes(USED))).toBe(true)
  expect((await check($, bash('git push -u origin feature'))).decision).toBe('deny')
})

test('with no live request, /lk approve at Ship after a spend re-approves it, resets the flag and restores the merge credit', { timeoutMs: 30_000 }, async ($, on) => {
  const w = await atShip($, on)
  await check($, bash('git commit -m x'))
  await submit($, 'next thing')
  expect(w.state.get('stageApproved')).not.toContain('ship')
  expect(await lk($, 'approve')).toContain('Approved the Ship gate')
  expect(w.state.get('stageApproved')).toContain('ship')
  expect(w.state.get('stageShipUsed')).toBe(false)
  expect(w.state.get('gateMergeCredit')).toBe(true)
  expect((await check($, bash('git commit -m y'))).decision).toBe('allow')
})

test('after a held push the first /lk approve gives a once-grant (the flag stays false) and the second re-approves', { timeoutMs: 30_000 }, async ($, on) => {
  const w = await atShip($, on)
  await check($, bash('git commit -m x'))
  await submit($, 'next thing')
  expect((await check($, bash('git push -u origin feature'))).decision).toBe('deny')
  expect(await lk($, 'approve')).toContain('Ship gate is still waiting')
  expect(w.state.get('stageShipUsed')).toBe(false)
  expect((await check($, bash('git push -u origin feature'))).decision).toBe('allow')
  expect(w.state.get('stageShipUsed')).toBe(false)
  expect(w.state.get('stageApproved')).not.toContain('ship')
  expect(await lk($, 'approve')).toContain('Approved the Ship gate')
  expect(w.state.get('stageApproved')).toContain('ship')
})

test('a plugin carry-on, an auto-continuation and a slash command do not spend the Ship approval', { timeoutMs: 30_000 }, async ($, on) => {
  const w = await atShip($, on)
  await check($, bash('git commit -m x'))
  await submit($, 'Carry on with the task', { kind: 'plugin' })
  await submit($, 'keep going', { kind: 'auto-continuation' })
  await submit($, '/some-command now', { kind: 'composer' })
  await submit($, '  /lk status')
  expect(w.state.get('stageShipUsed')).toBe(true)
  expect(w.state.get('stageApproved')).toContain('ship')
  await submit($, 'a real message', { kind: 'composer' })
  expect(w.state.get('stageApproved')).not.toContain('ship')
})

test('/lk gates ship ok still passes after the Ship approval is spent', { timeoutMs: 30_000 }, async ($, on) => {
  const w = await atShip($, on)
  await check($, bash('git commit -m x'))
  await submit($, 'next thing')
  expect((await check($, bash('git commit -m y'))).decision).toBe('deny')
  expect(await lk($, 'gates ship ok')).toContain('shipping approved for this session')
  expect((await check($, bash('git commit -m y'))).decision).toBe('allow')
  expect(w.state.get('stageShipUsed')).toBe(false)
})

test('the turn\'s end saves the mark; a resumed session has it back', { timeoutMs: 30_000 }, async ($, on) => {
  const w = await atShip($, on)
  await check($, bash('git commit -m x'))
  expect(w.state.get('stageShipUsed')).toBe(true)
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 10, isAborted: false, usage: null, reason: 'answer' } as never)
  const saved = w.store.get('loopkeeper:stage:project:' + CWD) as any
  expect(saved.shipUsed).toBe(true)
  expect(saved.approved).toContain('ship')
})

test('a resumed session restores stageShipUsed; older saved state reads as false', { timeoutMs: 30_000 }, async ($, on) => {
  const key = 'loopkeeper:stage:project:' + CWD
  const base = { stage: 'ship', at: 5, approved: ['validate-plan', 'ship'], verified: [], size: 'small', planVerdict: null, waived: [], filesTouched: [] }
  const w = world(on)
  w.store.set('loopkeeper:stage:preset:' + CWD, 'gsd')
  w.store.set(key, { ...base, shipUsed: true })
  await startTurn($)
  expect(w.state.get('stageShipUsed')).toBe(true)
  expect(w.state.get('stageCurrent')).toBe('ship')
})

test('older saved state (no shipUsed) resumes with the mark false', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  w.store.set('loopkeeper:stage:preset:' + CWD, 'gsd')
  w.store.set('loopkeeper:stage:project:' + CWD, { stage: 'ship', at: 5, approved: ['validate-plan', 'ship'], verified: [], size: 'small', planVerdict: null, waived: [], filesTouched: [] })
  await startTurn($)
  expect(w.state.get('stageShipUsed')).toBe(false)
})
