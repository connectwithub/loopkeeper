// stage.test.ts: the stage machine, ported from pipeline-stage's tests (52). Names changed only: /pipeline is /lk,
// the tool is mcp__loopkeeper__set_stage, store keys are loopkeeper:stage:<old key>, the pipeline config is the
// pipeline section of .claude/loopkeeper.json, plan paths are changeControl.planPaths, and band tones are kit v2 tones.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  bandSegments,
  checkMove,
  DEFAULT_PLAN_PATHS,
  fitBand,
  heuristicTarget,
  isPlanMaterial,
  parseConfig,
  pipelineFromLayers,
  planPathsOf,
  plainOf,
  wantsHold,
} from '../hooks/lib/stageModel.ts'
import { mergeConfigText } from '../hooks/lib/config.ts'
import { CWD, PROJECT_CONFIG, USER_CONFIG, start, world } from './world.ts'
import type { World, WorldOptions } from './world.ts'

const TOOL = 'mcp__loopkeeper__set_stage'
const key = (k: string) => 'loopkeeper:stage:' + k
const PROJECT = key('project:' + CWD)
const PRESET = key('preset:' + CWD)
const APPROVAL = key('approval:' + CWD)

const GATED = {
  stages: [
    { id: 'plan', label: 'Plan' },
    { id: 'build', label: 'Build' },
    { id: 'qa', label: 'QA', gate: true },
    { id: 'ship', label: 'Ship' },
  ],
  auto: true,
}

const BAND = {
  plugin: 'loopkeeper',
  component: 'AbovePrompt',
  surface: 'terminal',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const PANE = {
  plugin: 'loopkeeper',
  component: 'Pane',
  surface: 'terminal',
  requestId: 'loopkeeper-stage',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Stage', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

// The shared world with a pipeline section (null for no config file), more config sections, and saved store entries
function stageWorld(
  on: any,
  pipeline: Record<string, unknown> | null,
  store: Record<string, unknown> = {},
  more: Record<string, unknown> = {},
  opts: WorldOptions = {},
): World {
  const config = pipeline === null ? more : { pipeline, ...more }
  const files = Object.keys(config).length === 0 ? {} : { [PROJECT_CONFIG]: JSON.stringify(config) }
  const w = world(on, { now: 1_000_000, locked: ['locked.ts'], ...opts, files: { ...files, ...(opts.files ?? {}) } })
  for (const [k, v] of Object.entries(store)) w.store.set(k, v)
  return w
}

async function cmd($: Engine, args: string): Promise<string> {
  const out = (await $.command.run({ command: 'lk', args })) as { text?: string }
  return out?.text ?? ''
}

// The label of the stage the band marks as current
async function currentLabel($: Engine): Promise<string> {
  const ui = await $.ui.mount(BAND)
  const el = await ui.find({ type: 'Text', text: /^● / })
  await ui.unmount()
  return String(el?.children?.[0] ?? '').replace(/^● /, '')
}

// Every string inside a drawn element, in order
function textIn(node: unknown): string {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  const n = node as { children?: unknown[]; props?: { children?: unknown[] } }
  return (n.children ?? n.props?.children ?? []).map(textIn).join('')
}

async function bandLine($: Engine): Promise<string> {
  const ui = await $.ui.mount(BAND)
  const line = textIn(await ui.find({ key: 'stage-band' }))
  await ui.unmount()
  return line
}

test('uses the default plan → build → qa → ship stages when there is no config file', { timeoutMs: 20_000 }, async ($, on) => {
  const w = stageWorld(on, null)
  await start($)
  expect(w.looked).toContain(PROJECT_CONFIG)
  expect(w.looked).toContain(USER_CONFIG)
  expect(await currentLabel($)).toBe('Plan')
  expect(await cmd($, 'reload')).toContain('default stages: plan, build, qa, ship')
})

test('reads stages and gates from the pipeline section of .claude/loopkeeper.json', { timeoutMs: 20_000 }, async ($, on) => {
  stageWorld(on, {
    stages: [{ id: 'design', label: 'Design' }, { id: 'code', label: 'Code', gate: true }, { id: 'release', label: 'Release' }],
    auto: false,
  })
  await start($)
  expect(await currentLabel($)).toBe('Design')
  const line = await bandLine($)
  expect(line).toContain('○ Code ⚑')
  expect(line).toContain('manual')
  expect(await cmd($, 'reload')).toContain('from .claude/loopkeeper.json: design, code, release')
})

test('a malformed config falls back to the default stages', () => {
  expect(parseConfig('{nope').source).toBe('default')
  expect(parseConfig('{"stages": []}').stages.map(s => s.id)).toEqual(['plan', 'build', 'qa', 'ship'])
  expect(parseConfig(JSON.stringify(GATED)).stages[2]).toEqual({ id: 'qa', label: 'QA', gate: true })
})

test('Claude moves the stage with the set_stage tool', { timeoutMs: 20_000 }, async ($, on) => {
  stageWorld(on, null)
  await start($)
  const out = (await $.tool.call({ tool: TOOL, stage: 'build', note: 'implement the parser' } as never)) as { result?: string; deny?: string }
  expect(out.result).toContain('Moved from Plan to Build')
  expect(await currentLabel($)).toBe('Build')

  const bad = (await $.tool.call({ tool: TOOL, stage: 'deploy' } as never)) as { deny?: string }
  expect(bad.deny).toContain('Valid stage ids: plan, build, qa, ship')
  expect(await currentLabel($)).toBe('Build')

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Build · tool · implement the parser/ })).toBeDefined()
  await ui.unmount()
})

test('/lk moves by id, next and back, opens the hub with no argument and the Stage pane with stage', async ($, on) => {
  const w = stageWorld(on, null)
  await start($)
  expect(await cmd($, 'next')).toBe('Moved from Plan to Build.')
  expect(await cmd($, 'qa')).toBe('Moved from Build to QA.')
  expect(await cmd($, 'back')).toBe('Moved from QA to Build.')
  expect(await cmd($, 'back')).toBe('Moved from Build to Plan.')
  expect(await cmd($, 'back')).toBe('Already at the first stage.')
  // an unknown word goes down the /lk chain, whose end answers it once
  expect(await cmd($, 'nonsense')).toContain('unknown sub-command')
  expect(await cmd($, '')).toBe('')
  expect(w.panes).toEqual(['loopkeeper-hub'])
  expect(await cmd($, 'stage')).toBe('')
  expect(w.panes).toEqual(['loopkeeper-hub', 'loopkeeper-stage'])
})

test('a gate blocks the tool and /lk next until /lk approve', { timeoutMs: 20_000 }, async ($, on) => {
  stageWorld(on, GATED)
  await start($)
  await cmd($, 'qa')
  const held = (await $.tool.call({ tool: TOOL, stage: 'ship' } as never)) as { deny?: string; result?: string }
  expect(held.deny).toContain('/lk approve')
  expect(await cmd($, 'next')).toContain('gate is not approved')
  expect(await currentLabel($)).toBe('QA')
  expect(await bandLine($)).toContain('QA ⚑')

  expect(await cmd($, 'approve')).toContain('Approved the QA gate')
  const moved = (await $.tool.call({ tool: TOOL, stage: 'ship' } as never)) as { result?: string }
  expect(moved.result).toContain('Moved from QA to Ship')
})

test('approve says so when the current stage has no gate', async ($, on) => {
  stageWorld(on, GATED)
  await start($)
  expect(await cmd($, 'approve')).toBe('Plan has no gate to approve.')
})

test('a gate also holds automatic moves, with one toast', async ($, on) => {
  const w = stageWorld(on, GATED)
  await start($)
  await cmd($, 'qa')
  const before = w.toasts.length
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "x"' })
  await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(await currentLabel($)).toBe('QA')
  expect(w.toasts.length - before).toBe(1)
  await cmd($, 'approve')
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "x"' })
  expect(await currentLabel($)).toBe('Ship')
})

test('heuristics: ExitPlanMode and edits leave Plan for Build', async ($, on) => {
  stageWorld(on, null)
  await start($)
  await $.tool.call({ tool: 'ExitPlanMode', plan: 'p' } as never)
  expect(await currentLabel($)).toBe('Build')
  await cmd($, 'plan')
  await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' } as never)
  expect(await currentLabel($)).toBe('Build')
})

test('heuristics: test runners and verifying agents move to QA, git commit to Ship', { timeoutMs: 20_000 }, async ($, on) => {
  stageWorld(on, null)
  await start($)
  await cmd($, 'build')
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  expect(await currentLabel($)).toBe('Build')
  await $.tool.call({ tool: 'Bash', command: 'pnpm test --run' })
  expect(await currentLabel($)).toBe('QA')
  await cmd($, 'build')
  await $.tool.call({ tool: 'Agent', subagent_type: 'general-purpose', description: 'Verify the parser', prompt: 'x' } as never)
  expect(await currentLabel($)).toBe('QA')
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "parser"' })
  expect(await currentLabel($)).toBe('Ship')
})

test('heuristics never move backwards, and edits outside Plan change nothing', async ($, on) => {
  stageWorld(on, null)
  await start($)
  await cmd($, 'qa')
  await $.tool.call({ tool: 'Write', file_path: 'a.ts', content: 'x' } as never)
  await $.tool.call({ tool: 'ExitPlanMode', plan: 'p' } as never)
  await $.tool.call({ tool: 'EnterPlanMode' } as never)
  expect(await currentLabel($)).toBe('QA')
})

test('heuristics: EnterPlanMode moves forward to a Plan stage', async ($, on) => {
  stageWorld(on, { stages: [{ id: 'idea', label: 'Idea' }, { id: 'plan', label: 'Plan' }, { id: 'build', label: 'Build' }] })
  await start($)
  await $.tool.call({ tool: 'EnterPlanMode' } as never)
  expect(await currentLabel($)).toBe('Plan')
})

test('heuristics stay off with /lk auto off', async ($, on) => {
  stageWorld(on, null)
  await start($)
  expect(await cmd($, 'auto off')).toBe('Automatic stage moves are off.')
  await $.tool.call({ tool: 'ExitPlanMode', plan: 'p' } as never)
  expect(await currentLabel($)).toBe('Plan')
})

test('the heuristic rules match the documented commands', () => {
  const role = (call: Record<string, unknown>, cur = 'build') => heuristicTarget(call, cur)
  for (const command of ['npm test', 'npm run test', 'pnpm test', 'npx vitest run', 'jest', 'pytest -q', 'go test ./...', 'cargo test', 'npx playwright test', 'claude plugin test .', 'claude plugin validate .']) {
    expect(role({ tool: 'Bash', command })).toBe('qa')
  }
  for (const command of ['git commit -m x', 'git push origin main', 'gh pr create --fill']) {
    expect(role({ tool: 'Bash', command })).toBe('ship')
  }
  expect(role({ tool: 'Agent', subagent_type: 'code-reviewer' })).toBe('qa')
  expect(role({ tool: 'Agent', subagent_type: 'Explore', description: 'find files' })).toBeUndefined()
  expect(role({ tool: 'MultiEdit' }, 'plan')).toBe('build')
  expect(role({ tool: 'NotebookEdit' }, 'qa')).toBeUndefined()
  expect(checkMove([{ id: 'a', label: 'A', gate: true }, { id: 'b', label: 'B' }], [], 'a', 'b').ok).toBe(false)
})

test('the stage is saved in the store under a key for the project', async ($, on) => {
  const w = stageWorld(on, null)
  await start($)
  await cmd($, 'qa')
  expect(w.store.get(PROJECT)).toMatchObject({ stage: 'qa', approved: [] })
})

test('a new session resumes the saved stage with a resume entry', async ($, on) => {
  stageWorld(on, GATED, { [PROJECT]: { stage: 'qa', at: 5, approved: ['qa'] } })
  await start($)
  expect(await currentLabel($)).toBe('QA')
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /QA · resume/ })).toBeDefined()
  expect(textIn(await ui.find({ key: 'gate-qa' }))).toMatch(/⚑ QA.*approved/)
  await ui.unmount()
})

test('after /clear the saved stage comes back', async ($, on) => {
  stageWorld(on, null, { [PROJECT]: { stage: 'build', at: 5, approved: [] } })
  await $.classic.SessionStart({ source: 'clear' } as never)
  expect(await currentLabel($)).toBe('Build')
})

test('the band names the current stage and how long it has been there', async ($, on) => {
  const w = stageWorld(on, GATED)
  await start($)
  await cmd($, 'build')
  await w.clock.advance(12 * 60_000)
  const line = await bandLine($)
  expect(line).toContain('stage ✓ Plan ─ ● Build ─ ○ QA ⚑ ─ ○ Ship · in Build 12m')
})

test('/lk band off hides the band and is saved', async ($, on) => {
  const w = stageWorld(on, null)
  await start($)
  // band is a shared word: the stage's line comes first, the other concerns add theirs
  expect(await cmd($, 'band off')).toContain('The stage band is off.')
  expect(w.store.get(key('band'))).toBe(false)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'stage-band' })).toBeUndefined()
  await ui.unmount()
  await cmd($, 'band on')
  expect(await currentLabel($)).toBe('Plan')
})

test('the band fits narrow terminals on one line', () => {
  const segs = bandSegments({
    stages: [{ id: 'plan', label: 'Plan' }, { id: 'build', label: 'Build' }],
    current: 'build',
    approved: [],
    history: [{ stage: 'build', at: 0, by: 'tool' }],
    now: 3_600_000 + 5 * 60_000,
    auto: true,
  })
  expect(plainOf(segs)).toBe('stage ✓ Plan ─ ● Build · in Build 1h 5m')
})

test('pane buttons move, approve, reset and close', async ($, on) => {
  stageWorld(on, GATED)
  await start($)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'next' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'next' })
  expect(await currentLabel($)).toBe('QA')
  await ui.press({ key: 'approve' })
  await ui.press({ key: 'next' })
  expect(await currentLabel($)).toBe('Ship')
  await ui.press({ key: 'back' })
  expect(await currentLabel($)).toBe('QA')
  await ui.press({ key: 'reset' })
  expect(await currentLabel($)).toBe('Plan')
  await ui.press({ key: 'close' })
  await ui.unmount()
})

test('heuristics skip tool calls a subagent makes', async ($, on) => {
  stageWorld(on, null)
  await start($)
  await $.tool.call({ tool: 'ExitPlanMode', plan: 'p', agentId: 'agent-1' } as never)
  expect(await currentLabel($)).toBe('Plan')
  await $.tool.call({ tool: 'ExitPlanMode', plan: 'p' } as never)
  expect(await currentLabel($)).toBe('Build')
})

// ---- 0.2: presets, verifier agents, derived state ---------------------------------------

// The derived atoms the gates read, as /lk status prints them from $.state
async function derived($: Engine): Promise<string> {
  const text = await cmd($, 'status')
  return (/planDone \w+ · shipOpen \w+/.exec(text) ?? [''])[0]
}

const verifier = { tool: 'Agent', subagent_type: 'general-purpose', description: 'Verify the work against Done-when', prompt: 'x' }

test('/lk preset gsd switches the stages and is saved for the project; default restores them', async ($, on) => {
  const w = stageWorld(on, null)
  await start($)
  const out = await cmd($, 'preset gsd')
  expect(out).toContain('Plan → Validate plan → Execute → Validate → QA → Ship')
  expect(w.store.get(PRESET)).toBe('gsd')
  expect(await cmd($, 'reload')).toContain('preset gsd: plan, validate-plan, execute, validate, qa, ship')
  expect(await bandLine($)).toContain('stage ● Plan ─ ○ Validate plan ⚑ ⇄ ─ ○ Execute ─ ○ Validate ⇄ ─ ○ QA ─ ○ Ship ⚑ · in Plan')
  expect(await cmd($, 'preset nope')).toContain('Unknown preset "nope"')
  expect(await cmd($, 'preset default')).toContain('Plan → Build → QA → Ship')
  expect(w.store.get(PRESET)).toBe('default')
  expect(await cmd($, 'status')).toContain('preset default')
})

test('a preset chosen before wins over the file at session start; without one the file wins', async ($, on) => {
  stageWorld(on, GATED, { [PRESET]: 'gsd' })
  await start($)
  expect(await cmd($, 'status')).toContain('preset gsd')
})

test("the file's explicit stages win when no preset was chosen; its presets are offered", async ($, on) => {
  stageWorld(on, { stages: GATED.stages, presets: { tiny: { stages: [{ id: 'plan' }, { id: 'ship', gate: true }] } } })
  await start($)
  expect(await cmd($, 'status')).toContain('preset file')
  expect(await cmd($, 'preset')).toContain('Presets: default, gsd, tiny, file')
  expect(await cmd($, 'preset tiny')).toContain('plan → ship')
  expect(await cmd($, 'preset file')).toContain('Plan → Build → QA → Ship')
})

test('gsd: ExitPlanMode waits at the Validate plan gate; approval then an edit moves to Execute', async ($, on) => {
  stageWorld(on, null, { [PRESET]: 'gsd' })
  await start($)
  expect(await derived($)).toBe('planDone false · shipOpen false')
  await $.tool.call({ tool: 'ExitPlanMode', plan: 'p' } as never)
  expect(await currentLabel($)).toBe('Validate plan')
  await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' } as never)
  expect(await currentLabel($)).toBe('Validate plan')
  expect(await cmd($, 'status')).toContain("Next: A plan validator's consistent verdict opens the gate, or /lk approve.")
  expect(await derived($)).toBe('planDone false · shipOpen false')
  expect(await cmd($, 'approve')).toContain('Approved the Validate plan gate')
  expect(await derived($)).toBe('planDone true · shipOpen false')
  await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' } as never)
  expect(await currentLabel($)).toBe('Execute')
  expect(await derived($)).toBe('planDone true · shipOpen false')
})

test('requiresAgent refuses the tool and /lk next until a matching Agent call completes in the stage', async ($, on) => {
  stageWorld(on, null, { [PRESET]: 'gsd' })
  await start($)
  await cmd($, 'validate-plan')
  await cmd($, 'approve')
  await cmd($, 'execute')
  await cmd($, 'validate')
  const held = (await $.tool.call({ tool: TOOL, stage: 'qa' } as never)) as { deny?: string }
  expect(held.deny).toContain('spawn a verifier subagent (a reviewer, validator or critic with fresh context)')
  expect(held.deny).toContain('Done-when')
  expect(await cmd($, 'next')).toContain('needs a verifier')
  await $.tool.call({ tool: 'Bash', command: 'pnpm test' })
  expect(await currentLabel($)).toBe('Validate')
  // an agent that does not match, and a matching one a subagent makes, do not count
  await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', description: 'find files', prompt: 'x' } as never)
  await $.tool.call({ ...verifier, agentId: 'agent-1' } as never)
  expect(await cmd($, 'next')).toContain('needs a verifier')
  expect(await bandLine($)).toContain('● Validate ⇄')
  await $.tool.call(verifier as never)
  expect(await cmd($, 'status')).toContain('Verifier: Validate plan satisfied, Validate satisfied')
  await $.tool.call({ tool: 'Bash', command: 'pnpm test' })
  expect(await currentLabel($)).toBe('QA')
  const ui = await $.ui.mount(PANE)
  expect(textIn(await ui.find({ key: 'verifier-validate' }))).toMatch(/⇄ Validate verifier.*verified/)
  expect(await ui.find({ type: 'Text', text: /verified by general-purpose: Verify the work/ })).toBeDefined()
  await ui.unmount()
})

test('a refused Agent call does not satisfy requiresAgent; re-entering the stage needs a fresh verifier', async ($, on) => {
  on('tool.call', { tool: 'Agent' }, ($: unknown, e: any, next: any) => (e.description === 'refused review' ? { deny: 'no' } : next(e)))
  stageWorld(on, null, { [PRESET]: 'gsd' })
  await start($)
  await cmd($, 'validate-plan')
  await cmd($, 'approve')
  await cmd($, 'execute')
  // a verifier spawned during Execute moves the stage machine to Validate and, once done, satisfies it
  await $.tool.call(verifier as never)
  expect(await currentLabel($)).toBe('Validate')
  expect(await cmd($, 'next')).toBe('Moved from Validate to QA.')
  await cmd($, 'execute')
  await cmd($, 'validate')
  await $.tool.call({ tool: 'Agent', description: 'refused review', prompt: 'x' } as never)
  expect(await cmd($, 'next')).toContain('needs a verifier')
  expect(await cmd($, 'waive')).toContain('satisfied by the user')
  expect(await cmd($, 'next')).toBe('Moved from Validate to QA.')
})

test('gsd: git commit and gh pr create never move to the gated Ship; they are noted; shipOpen after approval', async ($, on) => {
  stageWorld(on, null, { [PRESET]: 'gsd' })
  await start($)
  await cmd($, 'validate-plan')
  await cmd($, 'approve')
  await cmd($, 'execute')
  await cmd($, 'validate')
  await cmd($, 'waive')
  await cmd($, 'qa')
  expect(await derived($)).toBe('planDone true · shipOpen false')
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "x"' })
  expect(await currentLabel($)).toBe('QA')
  let ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Ship · auto · ship attempted, held by the Ship gate: from Bash/ })).toBeDefined()
  await ui.unmount()
  expect(await cmd($, 'ship')).toBe('Moved from QA to Ship.')
  expect(await derived($)).toBe('planDone true · shipOpen false')
  await cmd($, 'approve')
  expect(await derived($)).toBe('planDone true · shipOpen true')
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /shipped: from Bash/ })).toBeDefined()
  await ui.unmount()
  await cmd($, 'back')
  expect(await derived($)).toBe('planDone true · shipOpen false')
})

test('derived atoms with the default stages: shipOpen always, planDone past Plan', async ($, on) => {
  stageWorld(on, null)
  await start($)
  expect(await derived($)).toBe('planDone false · shipOpen true')
  await cmd($, 'build')
  expect(await derived($)).toBe('planDone true · shipOpen true')
  await cmd($, 'reset')
  expect(await derived($)).toBe('planDone false · shipOpen true')
})

test('/lk status names the stage, gates and what holds the next move', async ($, on) => {
  stageWorld(on, GATED)
  await start($)
  await cmd($, 'qa')
  const text = await cmd($, 'status')
  expect(text).toContain('stage ● QA (3 of 4) · preset file · auto on')
  expect(text).toContain('Gates: QA pending')
  expect(text).toContain('Next: Waiting for you: /lk approve.')
  await cmd($, 'approve')
  expect(await cmd($, 'status')).toContain('Next: Ship. Claude moves on when it starts that work, or /lk next.')
})

test('the gsd band shortens labels on narrow terminals', () => {
  const input = {
    stages: [],
    current: 'build',
    approved: [],
    history: [],
    now: 0,
    auto: true,
  }
  const gsd = [
    { id: 'plan', label: 'Plan' },
    { id: 'validate-plan', label: 'Validate plan', gate: true },
    { id: 'execute', label: 'Execute' },
    { id: 'validate', label: 'Validate', requiresAgent: 'verif' },
    { id: 'qa', label: 'QA' },
    { id: 'ship', label: 'Ship', gate: true },
  ]
  const full = plainOf(fitBand({ ...input, stages: gsd, current: 'execute', approved: ['validate-plan'], history: [{ stage: 'execute', at: 0, by: 'tool' as const }], now: 8 * 60_000 }, 200))
  expect(full).toBe('stage ✓ Plan ─ ✓ Validate plan ⚑ ─ ● Execute ─ ○ Validate ⇄ ─ ○ QA ─ ○ Ship ⚑ · in Execute 8m')
  const narrow = plainOf(fitBand({ ...input, stages: gsd, current: 'execute', approved: ['validate-plan'] }, 84))
  expect(narrow).toBe('stage ✓ Plan ─ ✓ Valid… ⚑ ─ ● Execute ─ ○ Valid… ⇄ ─ ○ QA ─ ○ Ship ⚑ · in Execute')
  const tiny = plainOf(fitBand({ ...input, stages: gsd, current: 'execute', approved: ['validate-plan'] }, 60))
  expect(tiny).toBe('stage ✓ ─ ✓ ⚑ ─ ● Execute ─ ○ ⇄ ─ ○ ─ ○ ⚑ · in Execute')
  // kit v2 tones: a satisfied verifier mark is drawn in the ok tone
  const verified = bandSegments({ ...input, stages: gsd, current: 'qa', verified: ['validate'] })
  expect(verified.find(s => s.text === ' ⇄')?.tone).toBe('ok')
  // requiresAgent is kept when it compiles as a regex, dropped when it does not
  const parsed = parseConfig(JSON.stringify({ stages: [{ id: 'a', requiresAgent: 'review' }, { id: 'b', requiresAgent: '(' }] }))
  expect(parsed.stages).toEqual([{ id: 'a', label: 'a', requiresAgent: 'review' }, { id: 'b', label: 'b' }])
})

// ---- 0.3: task size, the growth guard, plan verdicts and automatic gate approval ----------

const GSD = { [PRESET]: 'gsd' }
let uses = 0
const editOf = (file: string, tool = 'Edit') => ({
  tool,
  input: tool === 'NotebookEdit' ? { notebook_path: file, new_source: 'x' } : { file_path: file, old_string: 'a', new_string: 'b' },
  tool_use_id: 'u' + ++uses,
})
const validator = { tool: 'Agent', subagent_type: 'general-purpose', description: 'Plan validator: check the plan', prompt: 'x' }

async function setStage($: Engine, input: Record<string, unknown>): Promise<{ result?: string; deny?: string }> {
  return (await $.tool.call({ tool: TOOL, ...input } as never)) as { result?: string; deny?: string }
}

test('wantsHold matches the ways a prompt asks to approve the plan, and nothing else', () => {
  for (const text of [
    'Refactor the parser, but wait for my approval before editing',
    'wait for the go-ahead',
    'Ask me first.',
    'ask before you change anything',
    'I want to review the plan',
    'Approve my plan? No: let me approve the plan',
    'check with me on the design',
    'confirm with me before starting',
    "Don't start until I say so",
    'dont proceed until the tests pass',
    'plan only, no code',
    'Just the plan please',
    'just plan it',
    'Review the plan first, then build it',
  ]) {
    expect(wantsHold(text)).toBe(true)
  }
  for (const text of [
    'Fix the typo in README',
    'Plan the migration and do it',
    'wait for the build to finish',
    'ask the API first',
    undefined,
    // a prompt that only mentions approving a plan, without asking to do it first
    "Why doesn't it auto continue once I approve the plan?",
    'Does the user approve the plan gate?',
  ]) {
    expect(wantsHold(text)).toBe(false)
  }
})

test('size small waives the plan gate and the verifier and moves to Execute', async ($, on) => {
  stageWorld(on, null, GSD)
  await start($)
  const out = await setStage($, { stage: 'plan', size: 'small', note: 'fix the typo in README' })
  expect(out.result).toBe(
    'Small task: the plan gate and the verifier are waived; in Execute. A small task may touch at most 3 files; past that it is pushed back to Plan.',
  )
  expect(await currentLabel($)).toBe('Execute')
  expect(await derived($)).toBe('planDone true · shipOpen false')
  // the waived verifier mark survives entering Validate the first time
  expect((await setStage($, { stage: 'validate' })).result).toContain('Moved from Execute to Validate')
  expect((await setStage($, { stage: 'qa' })).result).toContain('Moved from Validate to QA')
  // the ship gate is never waived
  expect((await setStage($, { stage: 'ship' })).result).toContain('Moved from QA to Ship')
  expect(await derived($)).toBe('planDone true · shipOpen false')
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /small task: plan gate waived/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /small task: verifier waived/ })).toBeDefined()
  await ui.unmount()
})

test('size small: entering Validate a second time needs a real verifier', async ($, on) => {
  stageWorld(on, null, GSD)
  await start($)
  await setStage($, { stage: 'plan', size: 'small' })
  await setStage($, { stage: 'validate' })
  await setStage($, { stage: 'execute' })
  await setStage($, { stage: 'validate' })
  expect((await setStage($, { stage: 'qa' })).deny).toContain('needs a verifier')
})

test('the growth guard denies a small task its 4th file, moves back to Plan and clears the size', async ($, on) => {
  stageWorld(on, null, GSD)
  await start($)
  await setStage($, { stage: 'plan', size: 'small' })
  for (const f of ['a.ts', 'b.ts', '/work/project/c.ts', 'a.ts', './b.ts']) {
    expect((await $.tool.check(editOf(f) as never)).decision).toBe('allow')
  }
  expect(await cmd($, 'status')).toContain('Size: small (3/3 files)')
  // a subagent's edit counts the same
  const r = (await $.tool.check({ ...editOf('d.ts', 'Write'), agentId: 'agent-1' } as never)) as { decision: string; reason?: string }
  expect(r.decision).toBe('deny')
  expect(r.reason).toBe(
    "loopkeeper: this task was sized small but would now touch a 4th file (d.ts); a small task is at most 3 files. Call set_stage {stage:'plan', size:'large'} and run the loop (plan → validate plan → execute), or the user can run /lk size large or /lk small-max <n>.",
  )
  expect(await currentLabel($)).toBe('Plan')
  expect(await derived($)).toBe('planDone false · shipOpen false')
  const status = await cmd($, 'status')
  expect(status).toContain('Size: unsized')
  expect(status).toContain('Gates: Validate plan pending, Ship pending')
  expect(status).toContain('Verifier: Validate plan needed, Validate needed')
  // not small any more: no limit
  for (const f of ['d.ts', 'e.ts', 'f.ts', 'g.ts']) expect((await $.tool.check(editOf(f) as never)).decision).toBe('allow')
})

test('/lk small-max and size large lift the limit; the guard leaves a refusal from below alone', async ($, on) => {
  stageWorld(on, null, GSD, {}, { tool: e => (e.file_path === 'locked.ts' ? { deny: 'locked' } : undefined) })
  await start($)
  expect(await cmd($, 'small-max 1')).toBe('A small task may now touch at most 1 file (this session).')
  expect(await cmd($, 'small-max 50')).toContain('from 1 to 20')
  expect(await cmd($, 'size small')).toContain('at most 1 file;')
  // the check refuses locked.ts beneath the guard, then the refused call settles: its reservation is released
  const locked = editOf('locked.ts')
  expect(((await $.tool.check(locked as never)) as { reason?: string }).reason).toBe('locked')
  expect(((await $.tool.call({ tool: 'Edit', file_path: 'locked.ts', old_string: 'a', new_string: 'b', tool_use_id: locked.tool_use_id } as never)) as { deny?: string }).deny).toBe('locked')
  expect((await $.tool.check(editOf('a.ts') as never)).decision).toBe('allow')
  expect((await $.tool.check(editOf('b.ts') as never)).decision).toBe('deny')
  expect(await cmd($, 'size large')).toContain('Sized large')
  expect((await $.tool.check(editOf('b.ts') as never)).decision).toBe('allow')
  expect(await cmd($, 'size medium')).toBe('Usage: /lk size small|large')
})

test('set_stage plan without a size reminds Claude to size the task under gsd only', async ($, on) => {
  stageWorld(on, null, GSD)
  await start($)
  expect((await setStage($, { stage: 'plan' })).result).toBe('Already in Plan. Size the task: call set_stage again with size small or large.')
  expect((await setStage($, { stage: 'plan', size: 'huge' })).deny).toBe('Pass `size` as small or large.')
  const large = await setStage($, { stage: 'plan', size: 'large' })
  expect(large.result).toContain('Sized large')
  expect(await cmd($, 'status')).toContain('Size: large')
  expect(await cmd($, 'preset default')).toContain('Plan → Build')
  expect((await setStage($, { stage: 'plan' })).result).toBe('Already in Plan.')
})

test('a consistent verdict without a validator keeps the gate', async ($, on) => {
  stageWorld(on, null, GSD)
  await start($)
  await setStage($, { stage: 'plan', size: 'large' })
  const out = await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  expect(out.result).toBe(
    'Moved from Plan to Validate plan. Recorded: plan consistent, but no validator subagent has completed since Plan began. Spawn one whose type or description matches /valid|review|verif|critic|audit|plan/i, then call set_stage validate-plan with the verdict again, or ask the user to run /lk approve.',
  )
  expect(await derived($)).toBe('planDone false · shipOpen false')
  const held = await setStage($, { stage: 'execute' })
  expect(held.deny).toContain("record it with set_stage {stage:'validate-plan', verdict:'consistent'}")
  expect(await cmd($, 'status')).toContain('Plan verdict: consistent by no validator at')
})

test('a validator that completed during Plan (carry) lets a consistent verdict open the gate', async ($, on) => {
  const w = stageWorld(on, null, GSD)
  await start($)
  await setStage($, { stage: 'plan', size: 'large', note: 'add the cache' })
  await $.tool.call(validator as never)
  // the validator does not move the pipeline out of Plan
  expect(await currentLabel($)).toBe('Plan')
  const out = await setStage($, { stage: 'validate-plan', verdict: 'consistent', note: 'validator found no gaps' })
  // the file budget's sentence that follows is the budget concern's (tests/stage-budget.test.ts)
  expect(out.result).toContain(
    'Moved from Plan to Validate plan. Plan validated by general-purpose: Plan validator: check the plan; the Validate plan gate is open (approval mode auto). Continue with set_stage execute.',
  )
  expect(w.toasts).toContain('Plan validated; gate opened automatically')
  expect(await derived($)).toBe('planDone true · shipOpen false')
  expect((await setStage($, { stage: 'execute' })).result).toContain('Moved from Validate plan to Execute')
  expect(await derived($)).toBe('planDone true · shipOpen false')
  const status = await cmd($, 'status')
  expect(status).toMatch(/Plan verdict: consistent by general-purpose: Plan validator: check the plan at \d\d:\d\d/)
  expect(w.store.get(PROJECT)).toMatchObject({ size: 'large', planVerdict: { ok: true } })
})

test('a validator in Validate plan and an issues verdict; then consistent opens the gate', async ($, on) => {
  stageWorld(on, null, GSD)
  await start($)
  await setStage($, { stage: 'plan', size: 'large' })
  await setStage($, { stage: 'validate-plan' })
  await $.tool.call(validator as never)
  expect((await setStage($, { stage: 'validate-plan', verdict: 'issues' })).result).toBe(
    'Recorded: the plan has issues. Fix the plan (set_stage plan with a note) and validate again.',
  )
  expect(await cmd($, 'status')).toContain('Plan verdict: issues')
  expect((await setStage($, { stage: 'validate-plan', verdict: 'consistent' })).result).toContain('the Validate plan gate is open')
})

test('approval ask holds the gate after a consistent verdict until /lk approve', async ($, on) => {
  const w = stageWorld(on, null, GSD)
  await start($)
  expect(await cmd($, 'approval ask')).toContain('Plan approval: ask')
  expect(w.store.get(APPROVAL)).toBe('ask')
  await setStage($, { stage: 'plan', size: 'large' })
  await $.tool.call(validator as never)
  const out = await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  expect(out.result).toContain(
    'Recorded: plan consistent (validated by general-purpose: Plan validator: check the plan). The user approves plans themselves here (approval mode ask): ask them to run /lk approve.',
  )
  expect(await cmd($, 'status')).toContain('Plan approval: ask')
  expect((await setStage($, { stage: 'execute' })).deny).toContain('/lk approve')
  await cmd($, 'approve')
  expect((await setStage($, { stage: 'execute' })).result).toContain('Moved from Validate plan to Execute')
})

test('approval ask can come from the pipeline section of .claude/loopkeeper.json; the saved mode wins over it', async ($, on) => {
  stageWorld(on, { approval: 'ask', smallMaxFiles: 5 }, GSD)
  await start($)
  const status = await cmd($, 'status')
  expect(status).toContain('Plan approval: ask')
  expect(await cmd($, 'size small')).toContain('at most 5 files')
  expect(await cmd($, 'approval auto')).toContain('Plan approval: auto')
  expect(await cmd($, 'reload')).not.toContain('no "stages" list')
  expect(await cmd($, 'status')).toContain('Plan approval: auto')
})

test('a prompt that asks to wait holds the gate; /lk approve clears the hold', async ($, on) => {
  const w = stageWorld(on, null, GSD)
  await start($)
  const sent = await $.prompt.submit({ text: 'Add caching to the API client. Wait for my approval before you edit.' } as never)
  expect((sent as { text?: string }).text).toBe('Add caching to the API client. Wait for my approval before you edit.')
  expect(w.toasts).toContain('loopkeeper: plan approval will wait for you (asked in the prompt)')
  await setStage($, { stage: 'plan', size: 'large' })
  expect(await cmd($, 'status')).toContain('Plan approval: held by this prompt')
  await $.tool.call(validator as never)
  const out = await setStage($, { stage: 'validate-plan', verdict: 'consistent' })
  expect(out.result).toContain('The user approves plans themselves here (this prompt asked to wait): ask them to run /lk approve.')
  expect(await derived($)).toBe('planDone false · shipOpen false')
  await cmd($, 'approve')
  expect(await cmd($, 'status')).toContain('Plan approval: auto')
  expect((await setStage($, { stage: 'execute' })).result).toContain('Moved from Validate plan to Execute')
  expect(await derived($)).toBe('planDone true · shipOpen false')
})

test('a held prompt keeps a small task at the plan gate; the next task spends the hold', async ($, on) => {
  stageWorld(on, null, GSD)
  await start($)
  await $.prompt.submit({ text: 'Rename the flag, but ask me first' } as never)
  const out = await setStage($, { stage: 'plan', size: 'small' })
  expect(out.result).toBe(
    'Small task, but this prompt asked to wait for approval: the verifier is waived and the pipeline waits in Validate plan. Ask the user to run /lk approve.',
  )
  expect(await currentLabel($)).toBe('Validate plan')
  await cmd($, 'approve')
  expect((await setStage($, { stage: 'execute' })).result).toContain('Moved from Validate plan to Execute')
  // a hold bound to one task does not carry over to the next one
  await $.prompt.submit({ text: 'Rename the other flag, but ask me first' } as never)
  await setStage($, { stage: 'plan', size: 'large' })
  expect(await cmd($, 'status')).toContain('held by this prompt')
  await setStage($, { stage: 'plan', size: 'large' })
  expect(await cmd($, 'status')).toContain('Plan approval: auto')
})

test('/lk reset clears size, verdict, hold, carry, waiver and files', async ($, on) => {
  stageWorld(on, null, GSD)
  await start($)
  await $.prompt.submit({ text: 'plan only' } as never)
  await setStage($, { stage: 'plan', size: 'small' })
  await $.tool.check(editOf('a.ts') as never)
  await $.tool.call(validator as never)
  await cmd($, 'reset')
  const status = await cmd($, 'status')
  expect(status).toContain('Size: unsized')
  expect(status).toContain('Plan approval: auto')
  expect(status).toContain('Plan verdict: none')
  expect(status).toContain('Verifier: Validate plan needed, Validate needed')
  // no carried validator either
  expect((await setStage($, { stage: 'validate-plan', verdict: 'consistent' })).result).toContain('no validator subagent has completed')
})

test('status lines and the band show the size', async ($, on) => {
  stageWorld(on, null, GSD)
  await start($)
  let status = await cmd($, 'status')
  expect(status).toContain('Size: unsized')
  expect(status).toContain('Plan approval: auto')
  expect(status).toContain('Plan verdict: none')
  expect(await bandLine($)).not.toContain('small')
  await setStage($, { stage: 'plan', size: 'small' })
  await $.tool.check(editOf('a.ts') as never)
  await $.tool.check(editOf('b.ts') as never)
  status = await cmd($, 'status')
  expect(status).toContain('Size: small (2/3 files)')
  expect(await bandLine($)).toMatch(/· in Execute <1m · small$/)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: 'small 2/3' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'auto' })).toBeDefined()
  await ui.unmount()
  await setStage($, { stage: 'plan', size: 'large' })
  expect(await bandLine($)).not.toContain('small')
  const segs = bandSegments({ stages: [{ id: 'plan', label: 'Plan' }], current: 'plan', approved: [], history: [], now: 0, auto: false, size: 'small' })
  expect(plainOf(segs)).toBe('stage ● Plan · in Plan · small · manual')
})

test('a resumed session keeps the size, verdict and files; the gsd gate message names the verdict', async ($, on) => {
  stageWorld(on, null, {
    ...GSD,
    [PROJECT]: { stage: 'execute', at: 5, approved: ['validate-plan'], verified: ['validate-plan', 'validate'], size: 'small', planVerdict: null, waived: ['validate', 'validate-plan'], filesTouched: ['a.ts', 'b.ts', 'c.ts'] },
  })
  await start($)
  expect(await cmd($, 'status')).toContain('Size: small (3/3 files)')
  expect((await $.tool.check(editOf('d.ts') as never)).decision).toBe('deny')
  const gsd = parseConfig(JSON.stringify({ stages: [{ id: 'plan' }, { id: 'validate-plan', gate: true }, { id: 'execute' }] })).stages
  const msg = checkMove(gsd, [], 'validate-plan', 'execute')
  expect(msg.ok ? '' : msg.message).toContain("set_stage {stage:'validate-plan', verdict:'consistent'}")
  const other = checkMove(GATED.stages, [], 'qa', 'ship')
  expect(other.ok ? '' : other.message).not.toContain('verdict')
})

// ---- Plan material (0.3.1) ---------------------------------------------------------------

const SCRATCH_PLAN = '/tmp/claude-1000/x/y/scratchpad/plan.html'

test('a small task: plan material is never counted; a 4th file that is plan material is allowed', async ($, on) => {
  const w = stageWorld(on, null, GSD)
  await start($)
  await setStage($, { stage: 'plan', size: 'small' })
  for (const f of ['a.ts', 'b.ts', 'c.ts']) expect((await $.tool.check(editOf(f) as never)).decision).toBe('allow')
  for (const f of [SCRATCH_PLAN, 'docs/plans/p.md', CWD + '/.claude/plans/q.html', 'src/x.plan.md']) {
    expect((await $.tool.check(editOf(f, 'Write') as never)).decision).toBe('allow')
  }
  expect(await cmd($, 'status')).toContain('Size: small (3/3 files)')
  expect(await currentLabel($)).toBe('Execute')
  expect((await $.tool.check(editOf('d.ts') as never)).decision).toBe('deny')
  expect(w.toasts.some(t => t.includes('outgrew'))).toBe(true)
})

test('the heuristic ignores plan material: writing the plan page in Plan neither moves nor toasts', async ($, on) => {
  const w = stageWorld(on, null, GSD)
  await start($)
  await $.tool.call({ tool: 'Write', file_path: SCRATCH_PLAN, content: '<html>' } as never)
  await $.tool.call({ tool: 'Edit', file_path: 'docs/plans/p.md', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: CWD + '/.claude/plans/n.ipynb', new_source: 'x' } as never)
  expect(await currentLabel($)).toBe('Plan')
  expect(w.toasts.filter(t => t.includes('/lk approve'))).toEqual([])
  // a code file still reads as building and is held at the gate
  await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'a', new_string: 'b' } as never)
  expect(w.toasts.filter(t => t.includes('/lk approve')).length).toBe(1)
  // the pure rule
  expect(heuristicTarget({ tool: 'Write', file_path: SCRATCH_PLAN }, 'plan', CWD)).toBeUndefined()
  expect(heuristicTarget({ tool: 'MultiEdit', file_path: 'src/x.plan.html' }, 'validate-plan', CWD)).toBeUndefined()
  expect(heuristicTarget({ tool: 'Write', file_path: 'src/a.ts' }, 'plan', CWD)).toBe('build')
  expect(heuristicTarget({ tool: 'Write', file_path: 'design/p.md' }, 'plan', CWD, ['design/**'])).toBeUndefined()
})

test('planPaths: config key parsing, the status line and isPlanMaterial', async ($, on) => {
  // the key is changeControl.planPaths; setting it alone is no config problem and no pipeline error
  const cc = { changeControl: { planPaths: [' design/** '] } }
  expect(planPathsOf(cc.changeControl.planPaths)).toEqual(['design/**'])
  expect(mergeConfigText(null, JSON.stringify(cc)).problems).toEqual([])
  expect(pipelineFromLayers(undefined, cc).error).toBeUndefined()
  for (const bad of ['design/**', [''], [3], {}]) expect(planPathsOf(bad)).toBeUndefined()
  expect(isPlanMaterial(SCRATCH_PLAN, CWD)).toBe(true)
  expect(isPlanMaterial('/tmp/other/plan.html', CWD)).toBe(false)
  expect(isPlanMaterial(CWD + '/docs/plans/a.md', CWD)).toBe(true)
  expect(isPlanMaterial('docs/planning.md', CWD)).toBe(false)
  expect(isPlanMaterial('docs/plans/a.md', CWD, ['design/**'])).toBe(false)
  stageWorld(on, null, GSD, { changeControl: { planPaths: ['design/**'] } })
  await start($)
  expect(await cmd($, 'status')).toContain('Plan material: design/** + scratchpad')
  await setStage($, { stage: 'plan', size: 'small' })
  for (const f of ['a.ts', 'b.ts', 'c.ts', 'design/plan.html']) expect((await $.tool.check(editOf(f) as never)).decision).toBe('allow')
  expect((await $.tool.check(editOf('docs/plans/p.md') as never)).decision).toBe('deny')
})

test('the status line for plan material shows only when the preset has a validate-plan stage', async ($, on) => {
  stageWorld(on, null)
  await start($)
  expect(await cmd($, 'status')).not.toContain('Plan material')
  await cmd($, 'preset gsd')
  expect(await cmd($, 'status')).toContain('Plan material: ' + DEFAULT_PLAN_PATHS.join(', ') + ' + scratchpad')
})
