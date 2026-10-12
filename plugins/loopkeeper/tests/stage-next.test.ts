// stage-next.test.ts: the next-step sentence (lib/stageModel.ts nextStep) and where it shows: a notice line in the
// chat after an answered main turn (turn.complete logs it; the answer's text is unchanged), the hub and the Stage pane
// under the hero, and /lk status. Also the hub's other
// mods (run on the desktop, filled in the terminal) and the "ctrl+x tab" focus hint (once, in the terminal only).
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { DEFAULT_STAGES, GSD_STAGES, nextStep } from '../hooks/lib/stageModel.ts'
import type { NextState, Stage } from '../hooks/lib/stageModel.ts'
import { CWD, PROJECT_CONFIG, lk, start, world } from './world.ts'
import type { World, WorldOptions } from './world.ts'

const TOOL = 'mcp__loopkeeper__set_stage'
const GSD = { ['loopkeeper:stage:preset:' + CWD]: 'gsd' }

// The seven sentences, in the order nextStep tries them
const WAITING = 'Waiting for you: /lk approve (or a in /lk).'
const VALIDATOR = "A plan validator's consistent verdict opens the gate, or /lk approve."
const GATE = 'Waiting for you: /lk approve.'
const VERIFIER = 'A verifier subagent checks the work first.'
const SHIP = '/lk approve when you want Claude to commit, push or open a PR.'
const LAST = 'Last stage: ask Claude to commit, push or open a PR; /lk reset starts the next task.'
const next = (label: string) => 'Next: ' + label + '. Claude moves on when it starts that work, or /lk next.'
// case 7 when the next stage's gate waits: /lk approve opens it from the stage before
const ahead = (label: string) => 'Next: ' + label + '. Claude moves on when it starts that work, or /lk approve opens ' + label + ' now.'

// A custom preset: a gated middle stage, and a last stage that is not Ship
const CUSTOM: Stage[] = [
  { id: 'draft', label: 'Draft' },
  { id: 'review', label: 'Review', gate: true },
  { id: 'publish', label: 'Publish' },
]

const state = (stages: Stage[], current: string, over: Partial<NextState> = {}): NextState => ({
  stages,
  current,
  approved: [],
  verified: [],
  waived: [],
  size: 'large',
  planFiles: null,
  budget: 0,
  approval: 'auto',
  hold: false,
  shipOk: false,
  shipGate: true,
  ...over,
})

// ---- nextStep: the seven cases ------------------------------------------------------------------------------------

test('1. a gate or a budget waits for the user: ask mode, a hold, a waiting budget', () => {
  expect(nextStep(state(GSD_STAGES, 'validate-plan', { approval: 'ask' }))).toBe(WAITING)
  expect(nextStep(state(GSD_STAGES, 'validate-plan', { hold: true }))).toBe(WAITING)
  // the default preset has no plan gate: past Plan, a large task's planned budget waits
  expect(nextStep(state(DEFAULT_STAGES, 'build', { planFiles: 12 }))).toBe(WAITING)
  expect(nextStep(state(DEFAULT_STAGES, 'build', { planFiles: 12, budget: 22 }))).toBe(next('QA'))
})

test('2. gsd Validate plan in auto mode with no hold: a validator verdict or /lk approve opens it', () => {
  expect(nextStep(state(GSD_STAGES, 'validate-plan'))).toBe(VALIDATOR)
})

test('3. any other stage whose gate is not approved waits for /lk approve (a custom preset)', () => {
  expect(nextStep(state(CUSTOM, 'draft'))).toBe(ahead('Review'))
  expect(nextStep(state(CUSTOM, 'review'))).toBe(GATE)
  expect(nextStep(state(CUSTOM, 'review', { approved: ['review'] }))).toBe(next('Publish'))
})

test('4. a stage that needs a verifier: a verifier subagent checks the work first', () => {
  expect(nextStep(state(GSD_STAGES, 'validate'))).toBe(VERIFIER)
  expect(nextStep(state(GSD_STAGES, 'validate-plan', { approved: ['validate-plan'] }))).toBe(VERIFIER)
  expect(nextStep(state(GSD_STAGES, 'validate', { verified: ['validate'] }))).toBe(next('QA'))
})

test('5. gsd Ship before shipping is open; the stage approval or the gates ship ok override opens it', () => {
  expect(nextStep(state(GSD_STAGES, 'ship'))).toBe(SHIP)
  expect(nextStep(state(GSD_STAGES, 'ship', { approved: ['ship'] }))).toBe(LAST)
  expect(nextStep(state(GSD_STAGES, 'ship', { shipOk: true }))).toBe(LAST)
})

test('5. with the gates\' shipGate off nothing holds shipping: Ship reads as the last stage', () => {
  expect(nextStep(state(GSD_STAGES, 'ship', { shipGate: false }))).toBe(LAST)
  // a Ship stage that is not the last: the next stage
  const shipFirst: Stage[] = [{ id: 'ship', label: 'Ship', gate: true }, { id: 'retro', label: 'Retro' }]
  expect(nextStep(state(shipFirst, 'ship', { approved: ['ship'], shipGate: false }))).toBe(next('Retro'))
})

test('6. the last stage, whatever its id: the default Ship, a custom Publish', () => {
  expect(nextStep(state(DEFAULT_STAGES, 'ship'))).toBe(LAST)
  expect(nextStep(state(CUSTOM, 'publish'))).toBe(LAST)
})

test('6. a gate on a custom last stage holds no move: the last-stage case wins over the gate case', () => {
  const gatedLast: Stage[] = [{ id: 'draft', label: 'Draft' }, { id: 'publish', label: 'Publish', gate: true }]
  expect(nextStep(state(gatedLast, 'publish'))).toBe(LAST)
  expect(nextStep(state(gatedLast, 'draft'))).toBe(ahead('Publish'))
  // a waiting budget still asks for /lk approve, which approves it
  expect(nextStep(state(gatedLast, 'publish', { planFiles: 41 }))).toBe(WAITING)
})

test('7. otherwise the next stage, and how the pipeline gets there', () => {
  expect(nextStep(state(DEFAULT_STAGES, 'plan', { size: '' }))).toBe(next('Build'))
  expect(nextStep(state(GSD_STAGES, 'plan'))).toBe(ahead('Validate plan'))
  expect(nextStep(state(GSD_STAGES, 'qa'))).toBe(ahead('Ship'))
  // a stage id the list lacks reads as the first stage
  expect(nextStep(state(DEFAULT_STAGES, 'gone'))).toBe(next('Build'))
})

test('7. /lk approve is offered only for the next gate not yet approved, and not for a Ship gate that holds nothing', () => {
  // the next gate already approved (after /lk back): /lk next
  expect(nextStep(state(GSD_STAGES, 'plan', { approved: ['validate-plan'] }))).toBe(next('Validate plan'))
  expect(nextStep(state(CUSTOM, 'draft', { approved: ['review'] }))).toBe(next('Review'))
  // Ship with the gates' shipGate off, or ship ok on for the session
  expect(nextStep(state(GSD_STAGES, 'qa', { shipGate: false }))).toBe(next('Ship'))
  expect(nextStep(state(GSD_STAGES, 'qa', { shipOk: true }))).toBe(next('Ship'))
  // the default preset's Ship has no gate
  expect(nextStep(state(DEFAULT_STAGES, 'qa'))).toBe(next('Ship'))
  // a gate two stages ahead is not offered
  const far: Stage[] = [{ id: 'draft', label: 'Draft' }, { id: 'edit', label: 'Edit' }, { id: 'review', label: 'Review', gate: true }]
  expect(nextStep(state(far, 'draft'))).toBe(next('Edit'))
  expect(nextStep(state(far, 'edit'))).toBe(ahead('Review'))
})

test('a small task names the plan gate it waived; a held small task waived none', () => {
  const small = { size: 'small' as const, approved: ['validate-plan'], verified: ['validate-plan', 'validate'], waived: ['validate-plan', 'validate'] }
  expect(nextStep(state(GSD_STAGES, 'execute', small))).toBe(next('Validate') + ' Small task: the Validate plan gate is waived.')
  expect(nextStep(state(GSD_STAGES, 'validate-plan', { ...small, approved: [], hold: true }))).toBe(WAITING)
  expect(nextStep(state(DEFAULT_STAGES, 'build', { size: 'small' }))).toBe(next('QA'))
})

// ---- The notice line in the chat after an answered main turn -------------------------------------------------------

const ANSWER = 'Done: the parser reads both formats.'
const line = (stage: string, n: number, m: number, sentence: string) => 'loopkeeper · ' + stage + ' (' + n + ' of ' + m + ') · ' + sentence

// A world whose turn.complete answers as core does (the answer is the text), or with `beneath`'s text: a hook beneath
// that changed it
function nextWorld(on: any, opts: WorldOptions & { beneath?: (answer: string) => string } = {}): World {
  const { beneath, ...rest } = opts
  on('turn.complete', {}, ($: unknown, e: any) => ({ text: beneath ? beneath(String(e.answer)) : String(e.answer) }))
  return world(on, { now: 1_000_000, ...rest })
}

let turns = 0
// One main turn, started and ended: the text turn.complete resolved to, and the lines logged in the chat meanwhile
async function answered($: Engine, w: World, over: Record<string, unknown> = {}): Promise<{ text: string; logs: string[] }> {
  const turnId = 'turn-' + ++turns
  const from = w.logs.length
  await $.turn.start({ turnId, text: 'build it' } as never)
  const r = (await $.turn.complete({ turnId, answer: ANSWER, durationMs: 900, isAborted: false, reason: 'answer', ...over } as never)) as { text?: string }
  return { text: String(r?.text ?? ''), logs: w.logs.slice(from) }
}
// The answer unchanged with the next-step line logged after it, or with nothing logged
const shown = (l: string) => ({ text: ANSWER, logs: [l] })
const QUIET = { text: ANSWER, logs: [] as string[] }

const sizeLarge = ($: Engine) => $.tool.call({ tool: TOOL, stage: 'plan', size: 'large', note: 'add the parser' } as never)

test('the line shows once a task is in play: sized, or the stage past the first; the default preset to Ship', { timeoutMs: 20_000 }, async ($, on) => {
  const w = nextWorld(on)
  await start($)
  expect(await answered($, w)).toEqual(QUIET)
  await sizeLarge($)
  expect(await answered($, w)).toEqual(shown(line('Plan', 1, 4, next('Build'))))
  await lk($, 'reset')
  expect(await answered($, w)).toEqual(QUIET)
  await lk($, 'build')
  expect(await answered($, w)).toEqual(shown(line('Build', 2, 4, next('QA'))))
  await lk($, 'ship')
  expect(await answered($, w)).toEqual(shown(line('Ship', 4, 4, LAST)))
})

test('no line for a subagent turn, an interrupt, a refusal or an API error', { timeoutMs: 20_000 }, async ($, on) => {
  const w = nextWorld(on)
  await start($)
  await sizeLarge($)
  expect(await answered($, w, { agentId: 'agent-1' })).toEqual(QUIET)
  expect(await answered($, w, { reason: 'aborted', isAborted: true })).toEqual(QUIET)
  expect(await answered($, w, { reason: 'refusal', refusal: { category: null, explanation: null } })).toEqual(QUIET)
  expect(await answered($, w, { reason: 'error' })).toEqual(QUIET)
  expect(await answered($, w)).toEqual(shown(line('Plan', 1, 4, next('Build'))))
})

test('no line with no person at the prompt and no app surface attached (a plain -p run)', { timeoutMs: 20_000 }, async ($, on) => {
  const w = nextWorld(on, { surfaces: [] })
  await $.session.start({ cwd: CWD, surface: null, isInteractive: false } as never)
  await sizeLarge($)
  expect(await answered($, w)).toEqual(QUIET)
})

test('the desktop hosting Claude Code through the SDK (isInteractive false, a desktop surface) gets the line', { timeoutMs: 20_000 }, async ($, on) => {
  const w = nextWorld(on, { surfaces: ['desktop'] })
  await $.session.start({ cwd: CWD, surface: null, isInteractive: false } as never)
  await sizeLarge($)
  expect(await answered($, w)).toEqual(shown(line('Plan', 1, 4, next('Build'))))
})

test('no line with the kill switch on', { timeoutMs: 20_000 }, async ($, on) => {
  const w = nextWorld(on, { env: { CLAUDE_MODS_DISABLE: 'loopkeeper' } })
  await start($)
  await sizeLarge($)
  expect(await answered($, w)).toEqual(QUIET)
})

test('no line with pipeline.nextHint false', { timeoutMs: 20_000 }, async ($, on) => {
  const w = nextWorld(on, { files: { [PROJECT_CONFIG]: JSON.stringify({ pipeline: { nextHint: false } }) } })
  await start($)
  await sizeLarge($)
  expect(await answered($, w)).toEqual(QUIET)
  // the hub, the Stage pane and /lk status still say it
  expect(await lk($, 'status')).toContain(next('Build'))
})

test('a text a hook beneath changed stands as it is; the next step is logged on its own', { timeoutMs: 20_000 }, async ($, on) => {
  const w = nextWorld(on, { beneath: answer => 'TL;DR: ' + answer.slice(0, 4) })
  await start($)
  expect(await answered($, w)).toEqual({ text: 'TL;DR: Done', logs: [] })
  await sizeLarge($)
  expect(await answered($, w)).toEqual({ text: 'TL;DR: Done', logs: [line('Plan', 1, 4, next('Build'))] })
})

test("the line leaves the turn's text and usage that a hook beneath returned as they are", { timeoutMs: 20_000 }, async ($, on) => {
  const usage = { model: 'test-model', input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  on('turn.complete', {}, ($: unknown, e: any) => ({ text: String(e.answer), usage }))
  const w = world(on, { now: 1_000_000 })
  await start($)
  await sizeLarge($)
  const from = w.logs.length
  await $.turn.start({ turnId: 'turn-usage', text: 'build it' } as never)
  const r = (await $.turn.complete({ turnId: 'turn-usage', answer: ANSWER, durationMs: 900, isAborted: false, reason: 'answer' } as never)) as { text?: string; usage?: unknown }
  expect(r).toEqual({ text: ANSWER, usage })
  expect(w.logs.slice(from)).toEqual([line('Plan', 1, 4, next('Build'))])
})

test('gsd at Ship with a large budget waiting: /lk approve approves the budget first, the next one the Ship gate', { timeoutMs: 20_000 }, async ($, on) => {
  const w = nextWorld(on)
  for (const [k, v] of Object.entries(GSD)) w.store.set(k, v)
  await start($)
  await $.tool.call({ tool: TOOL, stage: 'plan', size: 'large', files: 41, note: 'add the parser' } as never)
  await $.tool.call({ tool: 'Agent', subagent_type: 'general-purpose', description: 'Plan validator: check the plan', prompt: 'x' } as never)
  // the validator's verdict opens the plan gate; 41 planned files are over autoBudgetMax, so the budget waits
  await $.tool.call({ tool: TOOL, stage: 'validate-plan', verdict: 'consistent' } as never)
  for (const step of ['execute', 'validate', 'waive', 'qa', 'ship']) await lk($, step)
  expect(await answered($, w)).toEqual(shown(line('Ship', 6, 6, WAITING)))
  expect(await lk($, 'approve')).toContain('Approved the file budget. File budget: 51 files a turn (41 planned + 10).')
  // shipping is still held
  expect(await answered($, w)).toEqual(shown(line('Ship', 6, 6, SHIP)))
  expect(await lk($, 'approve')).toContain('Approved the Ship gate')
  expect(await answered($, w)).toEqual(shown(line('Ship', 6, 6, LAST)))
})

test('gsd through the line: validator, ask mode, verifier, Ship, then /lk gates ship ok', { timeoutMs: 20_000 }, async ($, on) => {
  const w = nextWorld(on)
  for (const [k, v] of Object.entries(GSD)) w.store.set(k, v)
  await start($)
  await sizeLarge($)
  expect(await answered($, w)).toEqual(shown(line('Plan', 1, 6, ahead('Validate plan'))))
  await lk($, 'validate-plan')
  expect(await answered($, w)).toEqual(shown(line('Validate plan', 2, 6, VALIDATOR)))
  expect(await lk($, 'status')).toContain('Next: ' + VALIDATOR)
  await lk($, 'approval ask')
  expect(await answered($, w)).toEqual(shown(line('Validate plan', 2, 6, WAITING)))
  await lk($, 'approve')
  await lk($, 'execute')
  await lk($, 'validate')
  expect(await answered($, w)).toEqual(shown(line('Validate', 4, 6, VERIFIER)))
  await lk($, 'waive')
  await lk($, 'qa')
  await lk($, 'ship')
  expect(await answered($, w)).toEqual(shown(line('Ship', 6, 6, SHIP)))
  await lk($, 'gates ship ok')
  expect(await answered($, w)).toEqual(shown(line('Ship', 6, 6, LAST)))
})

test('gsd at Ship with the ship gate off for the session: the line says last stage', { timeoutMs: 20_000 }, async ($, on) => {
  const w = nextWorld(on)
  for (const [k, v] of Object.entries(GSD)) w.store.set(k, v)
  await start($)
  await sizeLarge($)
  for (const step of ['validate-plan', 'approve', 'execute', 'validate', 'waive', 'qa', 'ship']) await lk($, step)
  expect(await answered($, w)).toEqual(shown(line('Ship', 6, 6, SHIP)))
  await lk($, 'gates ship gate off')
  expect(await answered($, w)).toEqual(shown(line('Ship', 6, 6, LAST)))
})

// ---- The hub, the Stage pane, the other mods and the focus hint ---------------------------------------------------

type Node = { type?: string; props?: Record<string, any>; children?: unknown[] }
function textIn(node: unknown): string {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  const n = node as Node
  return (n.children ?? n.props?.children ?? []).map(textIn).join('')
}

const SURFACES = ['terminal', 'desktop'] as const
const pane = (requestId: string, title: string, surface: string) =>
  ({
    plugin: 'loopkeeper',
    component: 'Pane',
    requestId,
    surface,
    viewport: { columns: 120, rows: 40 },
    props: { title, isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  }) as never
const HINT = 'ctrl+x tab to focus the panel'

// A world for the hub: /agent-map and /where listed from lk-agent-map and lk-where-am-i; agent-map a known command
// (its runs recorded), where not; the composer empty; every opened pane without the focus
function modWorld(on: any, opts: WorldOptions = {}) {
  const ran: unknown[] = []
  on('command.run', { command: 'agent-map' }, ($: unknown, e: any) => {
    ran.push({ command: e.command, args: e.args })
    return { text: '' }
  })
  const w = world(on, { now: 1_000_000, ...opts })
  on('command.list', () => ({
    value: [
      { name: 'agent-map', description: 'Agents', source: 'plugin', plugin: 'lk-agent-map' },
      { name: 'where', description: 'Where', source: 'plugin', plugin: 'lk-where-am-i' },
    ],
  }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('ui.panes', () => ({ value: w.panes.filter(p => !p.startsWith('closed:')).slice(-1).map(id => ({ id, title: '', isShown: true, isFocused: false, isPlaced: true })) }))
  return { w, ran }
}

for (const surface of SURFACES) {
  test(`hub and Stage pane on ${surface}: the next-step sentence under the hero`, { timeoutMs: 20_000 }, async ($, on) => {
    const w = world(on, { now: 1_000_000 })
    for (const [k, v] of Object.entries(GSD)) w.store.set(k, v)
    await start($)
    await sizeLarge($)
    await lk($, 'validate-plan')
    for (const [id, title] of [['loopkeeper-hub', 'loopkeeper'], ['loopkeeper-stage', 'Stage']]) {
      const ui = await $.ui.mount(pane(id, title, surface))
      const drawn = (await ui.find({ key: 'next-step' })) as Node
      expect(textIn(drawn)).toBe(VALIDATOR)
      expect(await ui.find({ type: 'Text', text: VALIDATOR })).toBeDefined()
      await ui.unmount()
    }
  })

  test(`hub other mods on ${surface}: ${surface === 'terminal' ? 'fill the composer' : 'run the command; a refused run fills'}`, { timeoutMs: 20_000 }, async ($, on) => {
    const { w, ran } = modWorld(on, { surfaces: [surface] })
    await start($)
    await lk($, '')
    // the terminal's focus hint for the hub itself is the focus-hint test's
    w.toasts.splice(0)
    const ui = await $.ui.mount(pane('loopkeeper-hub', 'loopkeeper', surface))
    await ui.press({ key: 'mod-agents' })
    expect(w.panes.slice(-1)).toEqual(['closed:loopkeeper-hub'])
    if (surface === 'terminal') {
      expect(ran).toEqual([])
      expect(w.filled).toEqual(['/agent-map cards'])
      expect(w.toasts).toEqual(['Press Enter to open Agents'])
    } else {
      expect(ran).toEqual([{ command: 'agent-map', args: 'cards' }])
      expect(w.filled).toEqual([])
      expect(w.toasts).toEqual([])
      // /where is not a known command: the run is refused, so the composer gets it
      await ui.press({ key: 'mod-where' })
      expect(w.filled).toEqual(['/where'])
      expect(w.toasts).toEqual(['Press Enter to open Where'])
    }
    await ui.unmount()
  })

  test(`the focus hint on ${surface}: ${surface === 'terminal' ? 'once a session' : 'never'}`, { timeoutMs: 20_000 }, async ($, on) => {
    const { w } = modWorld(on, { surfaces: [surface] })
    await start($)
    await lk($, '')
    await lk($, 'stage')
    const ui = await $.ui.mount(pane('loopkeeper-stage', 'Stage', surface))
    await ui.press({ key: 'gates' })
    expect(w.panes.slice(-2)).toEqual(['closed:loopkeeper-stage', 'loopkeeper-gates'])
    await ui.unmount()
    expect(w.toasts).toEqual(surface === 'terminal' ? [HINT] : [])
  })
}

// The hub's rows hand the press's surface to the switch, so a desktop press in a session that also has a terminal
// shows no hint and a terminal press does. With no press (/lk), only a session drawn on the terminal alone gets it.
const ROWS = ['panel-stage', 'panel-gates', 'panel-files', 'panel-routes', 'panel-reviews', 'panel-decisions']

test("the hub's rows switch on the press's surface: none on a desktop press, once on a terminal press", { timeoutMs: 20_000 }, async ($, on) => {
  const { w } = modWorld(on, { surfaces: ['terminal', 'desktop'] })
  await start($)
  for (const key of ROWS) {
    const ui = await $.ui.mount(pane('loopkeeper-hub', 'loopkeeper', 'desktop'))
    await ui.press({ key })
    await ui.unmount()
  }
  expect(w.panes.filter(p => !p.startsWith('closed:'))).toEqual(['loopkeeper-stage', 'loopkeeper-gates', 'files', 'loopkeeper-routes', 'loopkeeper-review', 'loopkeeper-decisions'])
  expect(w.toasts).toEqual([])
  const ui = await $.ui.mount(pane('loopkeeper-hub', 'loopkeeper', 'terminal'))
  await ui.press({ key: 'panel-gates' })
  await ui.unmount()
  expect(w.toasts).toEqual([HINT])
})

test('/lk with no press: the hint only when every surface of the session is the terminal', { timeoutMs: 20_000 }, async ($, on) => {
  const { w } = modWorld(on, { surfaces: ['terminal', 'mobile'] })
  await start($)
  await lk($, '')
  await lk($, 'stage')
  expect(w.toasts).toEqual([])
})
