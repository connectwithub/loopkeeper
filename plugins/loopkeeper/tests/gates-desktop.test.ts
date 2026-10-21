// gates-desktop.test.ts: the gates off the terminal, and the merge credit. A question from a permission check is put
// only in the terminal (surfaces ['terminal']); on the desktop app (surfaces ['desktop']) it would never be answered,
// so the gates refuse, raise a request and say the user's yes is asked on the card above the prompt (or typed as
// /lk approve): a push or merge to the default branch, a protected "ask" path and the files-per-turn limit alike. The
// commands still work: the Ship approval (/lk approve) or /lk gates merge ok give a one-shot merge credit, /lk gates
// allow <path> and /lk gates max <n> grant the rest. Only the person grants any of them. The stage sets the credit at
// or into the ship stage and takes back an unused one on leaving it. The card's buttons: stage-approve.test.ts.
import { expect, test } from 'claude-code/testing'

import {
  BAND,
  bash,
  CWD,
  edit,
  lineOf,
  lk,
  pressBand,
  projectGates,
  start,
  startTurn,
  texts,
  tool,
  world,
  type Run,
  type World,
  type WorldOptions,
} from './world.ts'

const GSD = 'loopkeeper:stage:preset:' + CWD
const CARRY_ON = 'Carry on with the task from where you stopped.'
const MERGE_Q = 'Merge now? (loopkeeper: push to the default branch)'
const HELD =
  "loopkeeper: the push to the default branch was held: it needs the user's yes, asked on the card above the prompt; " +
  "the user can also type /lk approve. Stop and wait for the user's answer; do not retry it another way."
const COVERED = 'merge allowed push to the default branch · covered by the Ship approval or /lk gates merge ok'
const PUSH = 'git push origin main'
const OTHER = { kind: 'plugin', name: 'other' }
const SLOW = { timeoutMs: 20_000 }
const STAGE_PANE = {
  plugin: 'loopkeeper',
  component: 'Pane',
  requestId: 'loopkeeper-stage',
  surface: 'desktop',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Stage', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

type Verdict = { decision: string; reason?: string }
const setStage = ($: any, input: Record<string, unknown>) => tool($, 'set_stage', input)
const check = async ($: any, call: unknown): Promise<Verdict> => (await $.tool.check(call)) as Verdict

/** The desktop app: surfaces ['desktop']; `gsd` puts the pipeline in the gsd preset (its Ship stage is gated). */
function desktop(on: any, gsd = false, opts: WorldOptions = {}): World {
  const w = world(on, { now: 1_000_000, surfaces: ['desktop'], ...opts })
  if (gsd) w.store.set(GSD, 'gsd')
  return w
}

/** /lk from another plugin: its text. */
async function lkFrom($: any, args: string): Promise<string> {
  const r = (await $.command.run({ command: 'lk', args, origin: OTHER } as never)) as { text?: string }
  return String(r?.text ?? '')
}

/** The continue prompts loopkeeper submitted, once its timers have run. */
async function continued(w: World): Promise<unknown[]> {
  await w.clock.advance(5_000)
  return w.submitted.filter(s => typeof s.text === 'string' && s.text.endsWith(CARRY_ON)).map(s => s.text)
}

/** gh answers: PR #12 open with these checks. */
const gh = (checks: Array<{ name: string; bucket: string }>) => (argv: string[]): Run | undefined => {
  const cmd = argv.join(' ')
  if (cmd.startsWith('gh pr view')) return { exitCode: 0, stdout: JSON.stringify({ number: 12, state: 'OPEN' }) }
  if (cmd.startsWith('gh pr checks 12')) return { exitCode: checks.every(c => c.bucket === 'pass') ? 0 : 8, stdout: JSON.stringify(checks) }
  return undefined
}

// ---- The merge gate off the terminal ---------------------------------------------------------------------------

test('desktop: a push to main with no credit is refused naming the card and /lk approve, and nothing is asked', SLOW, async ($, on) => {
  const w = desktop(on, false, { answers: ['Merge'] })
  await startTurn($)
  const r = await check($, bash(PUSH))
  expect(r.decision).toBe('deny')
  expect(r.reason).toBe(HELD)
  expect(w.asked).toEqual([])
  expect(await lk($, 'gates text')).toContain("merge denied push to the default branch · needs the user's yes (no terminal to ask)")
  // a push to a feature branch is no merge
  expect((await check($, bash('git push -u origin feature'))).decision).toBe('allow')
})

test('desktop: /lk approve at the gsd Ship gate allows the next push, recorded; the one after is held again', SLOW, async ($, on) => {
  const w = desktop(on, true)
  await start($)
  await lk($, 'size small')
  expect(await lk($, 'ship')).toContain('to Ship')
  expect(await lk($, 'approve')).toBe('Approved the Ship gate; the pipeline may now move past it.')
  expect(w.state.get('gateMergeCredit')).toBe(true)
  expect((await check($, bash(PUSH))).decision).toBe('allow')
  expect(w.state.get('gateMergeCredit')).toBe(false)
  expect(await lk($, 'gates text')).toContain(COVERED)
  expect((await check($, bash(PUSH))).reason).toBe(HELD)
  expect(w.asked).toEqual([])
})

test('desktop: /lk approve at QA opens the Ship gate and moves there; the next push is allowed', SLOW, async ($, on) => {
  const w = desktop(on, true)
  await start($)
  await lk($, 'size small')
  expect(await lk($, 'qa')).toContain('to QA')
  expect(w.state.get('gateMergeCredit')).not.toBe(true)
  expect(await lk($, 'approve')).toBe('Approved the Ship gate and moved to Ship: Claude may commit, push or open a PR.')
  expect((await check($, bash(PUSH))).decision).toBe('allow')
  expect((await check($, bash(PUSH))).reason).toBe(HELD)
})

test('desktop: /lk gates merge ok from the person allows one push; from another plugin it is refused', SLOW, async ($, on) => {
  const w = desktop(on)
  await start($)
  expect(await lkFrom($, 'gates merge ok')).toBe('Only the user can allow a push or merge to the default branch.')
  expect(w.state.get('gateMergeCredit')).not.toBe(true)
  expect((await check($, bash(PUSH))).reason).toBe(HELD)
  expect(await lk($, 'gates merge maybe')).toBe('usage: /lk gates merge ok')
  expect(await lk($, 'gates merge ok')).toBe('The next push or merge to the default branch is allowed (once).')
  expect((await check($, bash(PUSH))).decision).toBe('allow')
  expect((await check($, bash(PUSH))).reason).toBe(HELD)
  expect(w.asked).toEqual([])
})

test('/lk gates ship ok from another plugin is refused: shipping stays held and no credit is given', SLOW, async ($, on) => {
  const w = desktop(on, true)
  await start($)
  expect(await lkFrom($, 'gates ship ok')).toBe('Only the user can approve shipping.')
  expect(w.store.has('loopkeeper:gates:shipOk:sess-1')).toBe(false)
  expect(w.state.get('gateMergeCredit')).not.toBe(true)
  expect((await check($, bash('git commit -m x'))).decision).toBe('deny')
  expect(await lk($, 'gates ship ok')).toContain('the next push or merge to the default branch is covered')
  expect((await check($, bash(PUSH))).decision).toBe('allow')
})

test('gh pr merge with a failing check is held even with a credit, and the credit is kept', SLOW, async ($, on) => {
  const w = desktop(on, false, { run: gh([{ name: 'unit', bucket: 'fail' }]) })
  await start($)
  await lk($, 'gates merge ok')
  const r = await check($, bash('gh pr merge 12'))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('CI is not green (failing: unit)')
  expect(w.state.get('gateMergeCredit')).toBe(true)
})

test('gh pr merge with a pending check is held even with a credit, and the credit is kept', SLOW, async ($, on) => {
  const w = desktop(on, false, { run: gh([{ name: 'unit', bucket: 'pending' }]) })
  await start($)
  await lk($, 'gates merge ok')
  const r = await check($, bash('gh pr merge 12'))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('CI is not green (pending: unit)')
  expect(w.state.get('gateMergeCredit')).toBe(true)
})

test('terminal: with a credit the push runs without the dialog; without one the Merge/Cancel dialog asks', SLOW, async ($, on) => {
  const w = world(on, { now: 1_000_000, answers: ['Cancel'] })
  await start($)
  await lk($, 'gates merge ok')
  expect((await check($, bash(PUSH))).decision).toBe('allow')
  expect(w.asked).toEqual([])
  const r = await check($, bash(PUSH))
  expect(r.reason).toContain('the user chose Cancel')
  expect(w.asked).toEqual([MERGE_Q])
})

// ---- The credit in the stage ----------------------------------------------------------------------------------

test('a Ship stage with no gate (default preset): /lk approve gives the credit and carries on (the credit is new)', SLOW, async ($, on) => {
  const w = desktop(on)
  await start($)
  await lk($, 'size small')
  expect(await lk($, 'qa')).toContain('to QA')
  expect(await lk($, 'approve')).toBe('QA has no gate to approve.')
  expect(await lk($, 'ship')).toContain('to Ship')
  expect(await lk($, 'approve')).toBe('Ship has no gate to approve; the next push or merge to the default branch is allowed.')
  expect(await continued(w)).toEqual(['The user ran /lk approve. Ship has no gate to approve; the next push or merge to the default branch is allowed. ' + CARRY_ON])
  expect((await check($, bash(PUSH))).decision).toBe('allow')
  // the Stage pane's Approve gate does the same, and says so in a toast
  const ui = await $.ui.mount(STAGE_PANE as never)
  await ui.press({ key: 'approve' })
  await ui.unmount()
  expect(w.toasts).toContain('Ship has no gate to approve; the next push or merge to the default branch is allowed.')
  // one continue prompt a turn (ADR 0012): the pane's press, in the same turn, sends no second one
  expect((await continued(w)).length).toBe(1)
  expect((await check($, bash(PUSH))).decision).toBe('allow')
  expect((await check($, bash(PUSH))).reason).toBe(HELD)
})

test('an already approved Ship gate: /lk approve gives the credit again (the second push), with no continue prompt', SLOW, async ($, on) => {
  const w = desktop(on, true)
  await start($)
  await lk($, 'size small')
  await lk($, 'ship')
  await lk($, 'approve')
  expect((await continued(w)).length).toBe(1)
  expect((await check($, bash(PUSH))).decision).toBe('allow')
  expect(await lk($, 'approve')).toBe('The Ship gate is already approved; the next push or merge to the default branch is allowed.')
  expect((await continued(w)).length).toBe(1)
  expect((await check($, bash(PUSH))).decision).toBe('allow')
})

test('/lk approve at Ship with a file budget still waiting approves the budget and gives no credit', SLOW, async ($, on) => {
  const w = desktop(on, true)
  await start($)
  await setStage($, { stage: 'plan', size: 'large', files: 41 })
  await $.tool.call({ tool: 'Agent', subagent_type: 'general-purpose', description: 'Plan validator: check the plan', prompt: 'x' } as never)
  // 41 planned files are over autoBudgetMax, so the budget waits behind the plan gate's verdict
  await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  for (const step of ['execute', 'validate', 'waive', 'qa', 'ship']) await lk($, step)
  expect(w.state.get('stageCurrent')).toBe('ship')
  expect(await lk($, 'approve')).toBe('Approved the file budget. File budget: 51 files a turn (41 planned + 10).')
  expect(w.state.get('gateMergeCredit')).not.toBe(true)
  // the Ship gate is still closed too, so the push is held
  expect((await check($, bash(PUSH))).decision).toBe('deny')
})

test('leaving the ship stage, /lk reset and a preset whose stages drop the current one take back an unused credit', SLOW, async ($, on) => {
  const w = desktop(on, true)
  await start($)
  await lk($, 'size small')
  await lk($, 'ship')
  await lk($, 'approve')
  expect(w.state.get('gateMergeCredit')).toBe(true)
  expect(await lk($, 'back')).toContain('to QA')
  expect(w.state.get('gateMergeCredit')).toBe(false)
  // back at Ship (its gate still approved): no credit until the user approves again
  await lk($, 'ship')
  expect((await check($, bash(PUSH))).reason).toBe(HELD)
  await lk($, 'approve')
  expect(w.state.get('gateMergeCredit')).toBe(true)
  expect(await lk($, 'reset')).toContain('Pipeline reset')
  expect(w.state.get('gateMergeCredit')).toBe(false)
  // the gsd Execute stage is not in the default preset: choosing it falls back to Plan, past moveTo
  await lk($, 'size small')
  expect(w.state.get('stageCurrent')).toBe('execute')
  await lk($, 'gates merge ok')
  expect(await lk($, 'preset default')).toContain('Plan → Build')
  expect(w.state.get('stageCurrent')).toBe('plan')
  expect(w.state.get('gateMergeCredit')).toBe(false)
})

// ---- Protected "ask" paths and the files-per-turn limit off the terminal ------------------------------------------

test('desktop: a protected ask path is refused naming the card and /lk approve; the person grants it with /lk gates allow', SLOW, async ($, on) => {
  const w = desktop(on, false, { answers: ['Allow once'] })
  await startTurn($)
  const adr = `${CWD}/docs/decisions/ADR-1.md`
  const r = await check($, edit(adr))
  expect(r.decision).toBe('deny')
  expect(r.reason).toBe(
    'loopkeeper: docs/decisions/ADR-1.md is protected (rule "docs/decisions/**": ask) and needs the user\'s yes, ' +
      "asked on the card above the prompt; the user can also type /lk approve. Stop and wait for the user's answer; do not edit it another way.",
  )
  expect(w.asked).toEqual([])
  // another plugin cannot grant it; a deny rule cannot be granted
  expect(await lkFrom($, 'gates allow docs/decisions/ADR-1.md')).toBe('Only the user can allow a protected path.')
  expect((await check($, edit(adr))).decision).toBe('deny')
  expect(await lk($, 'gates allow api/.env')).toBe('api/.env matches rule ".env*": deny. A deny rule cannot be granted; change the rule to edit it.')
  expect((await check($, edit(`${CWD}/api/.env`))).decision).toBe('deny')
  expect(await lk($, 'gates allow')).toBe('No protected path is allowed for this session. usage: /lk gates allow <path>')
  // the person: a path relative to the project root, or absolute
  expect(await lk($, 'gates allow docs/decisions/ADR-1.md')).toBe('docs/decisions/ADR-1.md is allowed for this session (rule "docs/decisions/**": ask).')
  expect(await lk($, `gates allow ${CWD}/db/migrations/001.sql`)).toBe('db/migrations/001.sql is allowed for this session (rule "**/migrations/**": ask).')
  expect((await check($, edit(adr))).decision).toBe('allow')
  expect((await check($, edit(`${CWD}/db/migrations/001.sql`))).decision).toBe('allow')
  expect((await check($, edit(`${CWD}/docs/decisions/ADR-2.md`))).decision).toBe('deny')
  expect(await lk($, 'gates allow')).toBe(
    'Protected paths allowed for this session: docs/decisions/ADR-1.md, db/migrations/001.sql. usage: /lk gates allow <path>',
  )
  expect(await lk($, 'gates text')).toContain('protected allowed docs/decisions/ADR-1.md · granted by /lk gates allow')
  expect(w.asked).toEqual([])
})

test('terminal: a protected ask path still asks, and a dismissed question says so', SLOW, async ($, on) => {
  const w = world(on, { answers: ['reject'] })
  await startTurn($)
  const r = await check($, edit(`${CWD}/docs/decisions/ADR-1.md`))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('was refused: the question was dismissed')
  expect(w.asked).toEqual(['loopkeeper: docs/decisions/ADR-1.md is protected (rule "docs/decisions/**"). Allow this Edit edit?'])
})

test('desktop: past the files-per-turn limit the edit is refused naming the card and /lk approve, without a question', SLOW, async ($, on) => {
  const w = desktop(on, false, { files: projectGates({ maxFilesPerTurn: 2 }), answers: ['Allow 1 more'] })
  await startTurn($)
  expect((await check($, edit(`${CWD}/src/a.ts`))).decision).toBe('allow')
  expect((await check($, edit(`${CWD}/src/b.ts`))).decision).toBe('allow')
  const r = await check($, edit(`${CWD}/src/c.ts`))
  expect(r.decision).toBe('deny')
  expect(r.reason).toBe(
    "loopkeeper stopped this edit: this turn already touched 2 files (src/a.ts, src/b.ts) and src/c.ts would exceed the limit of 2 files per turn, and more needs the user's yes, " +
      'asked on the card above the prompt; the user can also type /lk approve.\n' +
      "Stop editing now. Summarise what changed so far, list the files you still intend to touch and why, and wait for the user's answer before continuing.",
  )
  expect(w.asked).toEqual([])
  await w.clock.advance(300)
  expect(w.aborted).toEqual(['t1'])
  expect(await lk($, 'gates max 5')).toBe('maxFilesPerTurn is 5 for this session.')
  expect((await check($, edit(`${CWD}/src/c.ts`))).decision).toBe('allow')
})

// ---- Requests and their cards (plan approve-anywhere, Parts 1-2) ---------------------------------------------------
// The card's and the Gates pane's presses, /lk approve and expiry are in stage-approve.test.ts; here the gates' side:
// where a refusal says the request waits, what the card offers, and which calls a one-time yes is (not) spent on.

const ADR = `${CWD}/docs/decisions/ADR-1.md`
type Req = { id: string; kind: string; target: string; glob?: string; what: string }
const requests = (w: World): Req[] => (w.state.get('gateRequests') as Req[] | undefined) ?? []

/** Every request button under a drawn tree, as `key: label`. */
function requestButtons(el: any): string[] {
  if (el === null || el === undefined || typeof el !== 'object') return []
  const kids: any[] = Array.isArray(el.children) ? el.children : el.children === undefined ? [] : [el.children]
  const key = el.props?.key
  const own = typeof key === 'string' && key.startsWith('gate-request-') ? [`${key}: ${String(el.props?.label ?? '')}`] : []
  return [...own, ...kids.flatMap(requestButtons)]
}

/** What the desktop's AbovePrompt draws: its texts, its request buttons and whether the gates band line shows. */
async function above($: any): Promise<{ texts: string[]; buttons: string[]; band: boolean }> {
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const tree = await ui.drawn()
  await ui.unmount()
  return { texts: texts(tree), buttons: requestButtons(tree), band: lineOf(tree, 'gates') !== undefined }
}
const PROTECTED_BUTTONS = [
  'gate-request-r1-allow: Allow this file',
  'gate-request-r1-session: Allow all of docs/decisions/** for this session',
  'gate-request-r1-deny: Deny',
]

test('desktop: a protected ask refusal raises a request and draws its card above the prompt, also with the gates band off', SLOW, async ($, on) => {
  const w = desktop(on)
  await startTurn($)
  const r = await check($, edit(ADR))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('asked on the card above the prompt; the user can also type /lk approve')
  expect(requests(w)).toMatchObject([{ id: 'r1', kind: 'protected', target: 'docs/decisions/ADR-1.md', glob: 'docs/decisions/**', what: 'docs/decisions/ADR-1.md' }])
  let drawn = await above($)
  expect(drawn.band).toBe(true)
  expect(drawn.texts).toContain('loopkeeper · protected path')
  expect(drawn.texts).toContain('docs/decisions/ADR-1.md')
  expect(drawn.buttons).toEqual(PROTECTED_BUTTONS)
  // the band off: its line goes, the card stays
  await lk($, 'gates band off')
  drawn = await above($)
  expect(drawn.band).toBe(false)
  expect(drawn.texts).toContain('docs/decisions/ADR-1.md')
  expect(drawn.buttons).toEqual(PROTECTED_BUTTONS)
  expect(w.asked).toEqual([])
})

test('an app surface with no card (VS Code): the refusals name the Gates pane and /lk approve, and raise requests', SLOW, async ($, on) => {
  const w = world(on, { now: 1_000_000, surfaces: ['vscode'] })
  await startTurn($)
  expect((await check($, edit(ADR))).reason).toBe(
    'loopkeeper: docs/decisions/ADR-1.md is protected (rule "docs/decisions/**": ask) and needs the user\'s yes, ' +
      "asked in the Gates pane (/lk gates); the user can also type /lk approve. Stop and wait for the user's answer; do not edit it another way.",
  )
  expect((await check($, bash(PUSH))).reason).toBe(
    "loopkeeper: the push to the default branch was held: it needs the user's yes, asked in the Gates pane (/lk gates); " +
      "the user can also type /lk approve. Stop and wait for the user's answer; do not retry it another way.",
  )
  expect(requests(w).map(r => `${r.kind} ${r.target}`)).toEqual(['protected docs/decisions/ADR-1.md', 'merge push to the default branch'])
  expect(w.asked).toEqual([])
})

test('nobody to ask (-p): the refusals name the command only, never the card or /lk approve', SLOW, async ($, on) => {
  const w = world(on, { now: 1_000_000, surfaces: [] })
  await startTurn($)
  expect((await check($, edit(ADR))).reason).toBe(
    'loopkeeper: docs/decisions/ADR-1.md is protected (rule "docs/decisions/**": ask) and needs the user\'s yes. ' +
      'Ask the user to run /lk gates allow docs/decisions/ADR-1.md, which allows it for this session; do not edit it another way.',
  )
  expect((await check($, bash(PUSH))).reason).toBe(
    "loopkeeper: the push to the default branch was held: it needs the user's yes. Ask the user to run /lk gates merge ok, then run it again. " +
      'Do not retry it another way.',
  )
  expect(w.asked).toEqual([])
})

test('a path matching a granted ask glob and a deny glob is still refused; a deny refusal raises no request, so no Allow', SLOW, async ($, on) => {
  const w = desktop(on)
  await startTurn($)
  expect((await check($, edit(ADR))).decision).toBe('deny')
  await pressBand($, 'gate-request-r1-session')
  expect(w.state.get('gateGlobGrants')).toEqual(['docs/decisions/**'])
  expect((await check($, edit(`${CWD}/docs/decisions/ADR-2.md`))).decision).toBe('allow')
  // docs/decisions/.env matches docs/decisions/** (ask, granted) and .env* (deny): deny wins
  const r = await check($, edit(`${CWD}/docs/decisions/.env`))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('docs/decisions/.env is a protected path (rule ".env*": deny)')
  expect(requests(w)).toEqual([])
  const drawn = await above($)
  expect(drawn.buttons).toEqual([])
  expect(drawn.texts.some(t => t.includes('.env'))).toBe(false)
  expect(w.asked).toEqual([])
})

test('git merge origin/main on a feature branch is neither held nor spends the credit', SLOW, async ($, on) => {
  const w = desktop(on)
  await startTurn($)
  await lk($, 'gates merge ok')
  expect(w.state.get('gateMergeCredit')).toBe(true)
  expect((await check($, bash('git merge origin/main'))).decision).toBe('allow')
  expect((await check($, bash('git merge --no-ff main'))).decision).toBe('allow')
  expect(w.state.get('gateMergeCredit')).toBe(true)
  expect(requests(w)).toEqual([])
  // the credit is still there for the push
  expect((await check($, bash(PUSH))).decision).toBe('allow')
  expect(w.state.get('gateMergeCredit')).toBe(false)
})

test('desktop: with the current branch unknown, git merge main is held and raises a request (fail closed)', SLOW, async ($, on) => {
  const unknown = (argv: string[]): Run | undefined => (argv.join(' ') === 'git branch --show-current' ? { exitCode: 128, stdout: '' } : undefined)
  const w = desktop(on, false, { run: unknown })
  await startTurn($)
  const r = await check($, bash('git merge main'))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('the merge with the default branch was held')
  expect(requests(w).map(q => `${q.kind} ${q.target}`)).toEqual(['merge merge with the default branch'])
  // a ref naming no default branch is no merge to it
  expect((await check($, bash('git merge feature-2'))).decision).toBe('allow')
})

test('a merge credit is not spent by a call another rule refuses (a push chained with an edit to a deny path)', SLOW, async ($, on) => {
  const w = desktop(on)
  await startTurn($)
  await lk($, 'gates merge ok')
  const r = await check($, bash(`${PUSH} && echo x > .env`))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('(rule ".env*": deny)')
  expect(w.state.get('gateMergeCredit')).toBe(true)
  expect((await check($, bash(PUSH))).decision).toBe('allow')
  expect(w.state.get('gateMergeCredit')).toBe(false)
})

test('a ship once-grant is not spent by a call another rule refuses, nor by a call naming another ship command', SLOW, async ($, on) => {
  const w = desktop(on, true)
  await startTurn($)
  expect((await check($, bash('git commit -m x'))).decision).toBe('deny')
  const id = requests(w).find(q => q.kind === 'ship')!.id
  await pressBand($, `gate-request-${id}-allow`)
  expect(w.state.get('gateShipOnce')).toEqual(['git commit'])
  expect((await check($, bash('git commit -m x && echo x > .env'))).decision).toBe('deny')
  expect((await check($, bash('git commit -m x && npm publish'))).decision).toBe('deny')
  expect(w.state.get('gateShipOnce')).toEqual(['git commit'])
  expect((await check($, bash('git commit -m x'))).decision).toBe('allow')
  expect(w.state.get('gateShipOnce')).toEqual([])
})

test('gh pr merge with failing or pending CI is held even with "Allow pushes for this session"; green CI then runs unasked', SLOW, async ($, on) => {
  let checks = [{ name: 'unit', bucket: 'fail' }]
  const w = desktop(on, false, { run: argv => gh(checks)(argv) })
  await startTurn($)
  expect((await check($, bash(PUSH))).decision).toBe('deny')
  await pressBand($, 'gate-request-r1-session')
  expect(w.state.get('gateMergeSession')).toBe(true)
  let r = await check($, bash('gh pr merge 12'))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('CI is not green (failing: unit)')
  checks = [{ name: 'unit', bucket: 'pending' }]
  r = await check($, bash('gh pr merge 12'))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('CI is not green (pending: unit)')
  checks = [{ name: 'unit', bucket: 'pass' }]
  expect((await check($, bash('gh pr merge 12'))).decision).toBe('allow')
  expect((await check($, bash(PUSH))).decision).toBe('allow')
  expect(w.asked).toEqual([])
})

test('a once-approved git push origin main passes the merge gate too, with no second request', SLOW, async ($, on) => {
  const w = desktop(on, true)
  await startTurn($)
  const r = await check($, bash(PUSH))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('shipping is gated (git push)')
  expect(requests(w).map(q => q.kind)).toEqual(['ship'])
  await pressBand($, `gate-request-${requests(w)[0]!.id}-allow`)
  expect(w.state.get('gateShipOnce')).toEqual(['git push'])
  expect((await check($, bash(PUSH))).decision).toBe('allow')
  expect(requests(w)).toEqual([])
  expect(w.state.get('gateShipOnce')).toEqual([])
  expect(w.state.get('gateMergeCredit')).not.toBe(true)
  expect(await lk($, 'gates text')).toContain('merge allowed push to the default branch · covered by the ship once-grant')
  // spent: the next push is held by the ship gate again
  expect((await check($, bash(PUSH))).reason).toContain('shipping is gated (git push)')
  expect(w.asked).toEqual([])
})

test('terminal: the protected and merge dialogs ask as before, and raise no request', SLOW, async ($, on) => {
  const opts: string[][] = []
  const w = world(on, {
    now: 1_000_000,
    answers: ['Allow for session', 'Merge', 'Allow once', 'Cancel'],
    tool: (e: any) => {
      if (e?.tool === 'AskUserQuestion') opts.push((e.questions?.[0]?.options ?? []).map((o: any) => (typeof o === 'string' ? o : o?.label)))
      return undefined
    },
  })
  await startTurn($)
  expect((await check($, edit(ADR))).decision).toBe('allow')
  expect((await check($, edit(ADR))).decision).toBe('allow')
  expect((await check($, bash(PUSH))).decision).toBe('allow')
  expect((await check($, edit(`${CWD}/db/migrations/001.sql`))).decision).toBe('allow')
  const r = await check($, bash(PUSH))
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('the user chose Cancel')
  expect(w.asked).toEqual([
    'loopkeeper: docs/decisions/ADR-1.md is protected (rule "docs/decisions/**"). Allow this Edit edit?',
    MERGE_Q,
    'loopkeeper: db/migrations/001.sql is protected (rule "**/migrations/**"). Allow this Edit edit?',
    MERGE_Q,
  ])
  expect(opts).toEqual([
    ['Allow once', 'Allow for session', 'Deny'],
    ['Merge', 'Cancel'],
    ['Allow once', 'Allow for session', 'Deny'],
    ['Merge', 'Cancel'],
  ])
  expect(requests(w)).toEqual([])
})
