// Routing: spawns routed by role, the config merge, /lk routing words, the rules block, the band, the pane and
// GSD mode's loop across stage and gates (ported from gsd-orchestrator's register tests).
import { expect, test } from 'claude-code/testing'

import { LOOP_RULES, RULES, RULES_BLOCK, loopRules } from '../hooks/lib/loopRules.ts'
import { TONES } from '../hooks/lib/kit.ts'
import { loopEffects } from '../hooks/lib/routingFormat.ts'
import { BAND, CWD, PROJECT_CONFIG, USER_CONFIG, bandLineOf, lineOf, linePlain, lk, start, world } from './world.ts'
import type { World, WorldOptions } from './world.ts'

const SLOW = { timeoutMs: 20_000 }

/** Store keys of the routing switches, by their old gsd-orchestrator names. */
const KEY = {
  mode: 'loopkeeper:routing:mode',
  loop: 'loopkeeper:routing:loop',
  band: 'loopkeeper:routing:band',
  overrides: 'loopkeeper:routing:overrides',
  approval: `loopkeeper:stage:approval:${CWD}`,
} as const

/** A world with these routing switches already stored, as an earlier session left them. */
function routeWorld(on: any, stored: Partial<Record<keyof typeof KEY, unknown>> = {}, opts: WorldOptions = {}): World {
  const w = world(on, opts)
  for (const [k, v] of Object.entries(stored)) w.store.set(KEY[k as keyof typeof KEY], v)
  return w
}

/** A spawn as the Agent tool would raise it. */
function spawnOf(description: string, prompt = 'Do the task.', extra: Record<string, unknown> = {}) {
  return {
    tool_use_id: 'toolu_1',
    prompt,
    description,
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-main-model',
    background: false,
    fork: false,
    ...extra,
  } as any
}

/** The context the engine hands prompt.context, with a claudeMd block. */
const CONTEXT = {
  blocks: [
    { name: 'claudeMd', text: 'x' },
    { name: 'currentDate', text: 'today' },
  ],
  instructionFiles: [],
} as any

const PANE = {
  plugin: 'loopkeeper',
  component: 'Pane',
  requestId: 'loopkeeper-routes',
  viewport: { columns: 120, rows: 40 },
  props: {
    title: 'Routing',
    isFocused: true,
    bodyColumns: 100,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

/** Every string inside a drawn element, in order. */
function textIn(node: unknown): string {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  const n = node as { children?: unknown[]; props?: { children?: unknown[] } }
  return (n.children ?? n.props?.children ?? []).map(textIn).join('')
}

test('on: agent.spawn sets the routed model id', SLOW, async ($, on) => {
  const w = routeWorld(on, { mode: true })
  await start($)

  await $.agent.spawn(spawnOf('Survey the repo layout'))
  await $.agent.spawn(spawnOf('Design the caching strategy'))
  await $.agent.spawn(spawnOf('Implement the form'))

  expect(w.spawned.map(s => s.model)).toEqual(['haiku', 'opus', 'sonnet'])
})

test('on: an explicit model is respected unless override is set', SLOW, async ($, on) => {
  const w = routeWorld(on, { mode: true })
  await start($)
  await $.agent.spawn(spawnOf('Survey the repo layout', 'Look around.', { model: 'opus' }))
  expect(w.spawned[0]?.model).toBe('opus')
})

test('override: true replaces the explicit model', SLOW, async ($, on) => {
  const w = routeWorld(on, { mode: true }, { files: { [USER_CONFIG]: JSON.stringify({ routing: { override: true } }) } })
  await start($)
  await $.agent.spawn(spawnOf('Survey the repo layout', 'Look around.', { model: 'opus' }))
  expect(w.spawned[0]?.model).toBe('haiku')
})

test('a tag wins over keywords and an explicit model', SLOW, async ($, on) => {
  const w = routeWorld(on, { mode: true })
  await start($)
  await $.agent.spawn(spawnOf('Survey the repo [model:opus]', 'Look.', { model: 'haiku' }))
  await $.agent.spawn(spawnOf('List files', 'Then decide [role:hard].'))
  expect(w.spawned.map(s => s.model)).toEqual(['opus', 'opus'])
})

test('off: spawns pass through unchanged and are recorded as off', SLOW, async ($, on) => {
  const w = routeWorld(on, { mode: false })
  await start($)
  await $.agent.spawn(spawnOf('Design the caching strategy'))
  await $.agent.spawn(spawnOf('Survey', 'x', { model: 'sonnet' }))
  expect(w.spawned.map(s => s.model)).toEqual([undefined, 'sonnet'])
  const status = await lk($, 'text')
  expect(status).toContain('GSD orchestrator: off')
  expect(status).toContain(' off ')
})

test('config merge order: user file, then project file, then /lk route', SLOW, async ($, on) => {
  const w = routeWorld(on, { mode: true }, {
    files: {
      [USER_CONFIG]: JSON.stringify({ routing: { models: { opus: 'claude-opus-custom' }, roles: { recon: 'sonnet', verify: 'opus' } } }),
      [PROJECT_CONFIG]: JSON.stringify({ routing: { roles: { recon: 'opus' } } }),
    },
  })
  await start($)
  await lk($, 'route verify haiku')

  const status = await lk($, 'text')
  expect(status).toMatch(/recon\s+→ claude-opus-custom\s+\.claude\/loopkeeper\.json/)
  expect(status).toMatch(/verify\s+→ haiku\s+session \(\/lk route\)/)
  expect(status).toMatch(/execute\s+→ sonnet\s+default/)
  expect(w.store.get(KEY.overrides)).toEqual({ verify: 'haiku' })

  await $.agent.spawn(spawnOf('Survey the repo layout'))
  expect(w.spawned[0]?.model).toBe('claude-opus-custom')

  await lk($, 'route reset')
  const after = await lk($, 'text')
  expect(after).toMatch(/verify\s+→ claude-opus-custom\s+~\/\.claude\/loopkeeper\.json/)
})

test('a broken config file is skipped', SLOW, async ($, on) => {
  const w = routeWorld(on, { mode: true }, { files: { [PROJECT_CONFIG]: '{ not json' } })
  await start($)
  await $.agent.spawn(spawnOf('Design it'))
  expect(w.spawned[0]?.model).toBe('opus')
})

test('/lk explain prints the classification', SLOW, async ($, on) => {
  routeWorld(on)
  await start($)
  const out = await lk($, 'explain Review the diff and fix the lint errors')
  expect(out).toContain('→ verify → sonnet (sonnet)')
  expect(out).toContain('verify 2 (review, lint)')
  expect(out).toContain('execute 1 (fix)')
})

test('rules: added to the context when on', SLOW, async ($, on) => {
  routeWorld(on, { mode: true, loop: false })
  await start($)
  const context = await $.prompt.context(CONTEXT)
  const files = context.instructionFiles ?? []
  expect(files.length).toBe(1)
  expect(files[0]?.kind).toBe('user')
  expect(files[0]?.path.endsWith('/hooks/lib/loopRules.ts')).toBe(true)
  expect(files[0]?.content).toContain(RULES)
})

test('rules: a block of their own when claudeMd was rewritten above', SLOW, async ($, on) => {
  routeWorld(on, { mode: true, loop: false })
  await start($)
  const context = await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'today' }] } as any)
  expect(context.blocks.find(b => b.name === RULES_BLOCK)?.text).toBe(RULES)
})

test('rules: absent when off, and /lk on adds them', SLOW, async ($, on) => {
  routeWorld(on, { mode: false, loop: false })
  await start($)
  const off = await $.prompt.context(CONTEXT)
  expect(off.instructionFiles ?? []).toEqual([])
  expect(off.blocks.some(b => b.name === RULES_BLOCK)).toBe(false)

  expect(await lk($, 'on')).toContain('mode on')
  const onNow = await $.prompt.context(CONTEXT)
  expect(onNow.instructionFiles?.[0]?.content).toContain(RULES)
})

test('band: one line, on and off, and /lk band routing off hides it', SLOW, async ($, on) => {
  const w = routeWorld(on, { mode: true })
  await start($)
  await $.agent.spawn(spawnOf('Survey the repo layout'))

  const line = await bandLineOf($, 'routing')
  expect(linePlain(line)).toBe('routing  ● on  ● loop   recon→haiku · exec→sonnet · verify→sonnet · hard→opus · routed 1')
  expect(line?.label).toEqual({ text: 'routing', color: undefined, bold: true })
  expect(line?.chips).toEqual([
    { text: '● on', color: TONES.ok.fg, bold: true },
    { text: '● loop', color: TONES.info.fg, bold: true },
  ])
  expect(line?.right?.color).toBe(TONES.muted.fg)

  await lk($, 'off')
  const off = await bandLineOf($, 'routing')
  expect(linePlain(off)).toBe('routing  ● off')
  expect(off?.chips[0]?.color).toBe(TONES.muted.fg)
  expect(off?.chips[0]?.bold).toBeUndefined()

  expect(await lk($, 'band routing off')).toBe('The routing band is off.')
  expect(w.store.get(KEY.band)).toBe(false)
  const hidden = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(lineOf(await hidden.drawn(), 'routing')).toBeUndefined()
  expect(await hidden.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
})

test('pane: shows the table and decisions, and Toggle mode flips the mode', SLOW, async ($, on) => {
  const w = routeWorld(on, { mode: true })
  await start($)
  await $.agent.spawn(spawnOf('Design the caching strategy'))
  expect(await lk($, 'routes')).toBe('')
  expect(w.panes).toContain('loopkeeper-routes')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    expect(textIn(await ui.find({ key: 'route-hard' }))).toMatch(/hard.*→ opus/)
    expect(textIn(await ui.find({ key: 'spawn-0' }))).toMatch(/hard.*Design the caching strategy.*routed.*→ opus/)
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'toggle' })
  // the loop is on, so the stage and the gates must follow: the words wait in the prompt box for Enter
  expect(w.filled).toEqual(['/lk off'])
  await lk($, 'off')
  expect(w.store.get(KEY.mode)).toBe(false)
  expect(await ui.find({ type: 'Text', text: '○ Orchestrator off' })).toBeDefined()
})

// ---------------------------------------------------------------------------
// The GSD loop: /lk on|off and /lk loop switch the stage preset and the plan gate directly (ADR 0004).

test('loop: on by default, /lk loop off|on is saved and shown in /lk text', SLOW, async ($, on) => {
  const w = routeWorld(on)
  await start($)
  expect(await lk($, 'text')).toContain('loop on')

  await lk($, 'loop off')
  expect(w.store.get(KEY.loop)).toBe(false)
  const off = await lk($, 'text')
  expect(off).toContain('· loop off ·')

  await lk($, 'loop on')
  expect(w.store.get(KEY.loop)).toBe(true)
  const onText = await lk($, 'text')
  expect(onText).toContain('· loop on ·')
  expect(onText).toContain('stage preset gsd + gates plan required on')
  expect(await lk($, 'loop maybe')).toBe('Usage: /lk loop on|off')
})

test('loop: a saved loop off survives a new session', SLOW, async ($, on) => {
  routeWorld(on, { loop: false })
  await start($)
  expect(await lk($, 'text')).toContain('· loop off ·')
})

test('/lk on switches the stage to preset gsd and requires a plan, /lk off the reverse; nothing is sent', SLOW, async ($, on) => {
  const w = routeWorld(on, { mode: false })
  await start($)
  expect(await lk($, 'status')).toContain('preset default')

  const answer = await lk($, 'on')
  expect(answer).toContain('Loop on')
  // one combined reply: the stage's part, then the gates', then routing's
  const at = ['Pipeline preset gsd', 'gates: plan required on', 'GSD orchestrator mode on'].map(t => answer.indexOf(t))
  expect(at.every(i => i >= 0)).toBe(true)
  expect([...at].sort((a, b) => a - b)).toEqual(at)
  const onStatus = await lk($, 'status')
  expect(onStatus).toContain('preset gsd')
  expect(onStatus).toContain('plan ✗')

  const offAnswer = await lk($, 'off')
  expect(offAnswer).toContain('Pipeline preset default')
  expect(offAnswer).toContain('gates: plan required off')
  const offStatus = await lk($, 'status')
  expect(offStatus).toContain('preset default')
  expect(offStatus).toContain('plan –')
  expect(w.toasts.filter(t => /sent|not available/.test(t))).toEqual([])
})

test('loop off: /lk on and off leave the stage preset and the plan gate alone', SLOW, async ($, on) => {
  routeWorld(on, { mode: false, loop: false })
  await start($)
  const answer = await lk($, 'on')
  expect(answer).not.toContain('Pipeline preset')
  expect(answer).not.toContain('plan required')
  expect(await lk($, 'status')).toContain('preset default')
  await lk($, 'off')
  const status = await lk($, 'status')
  expect(status).toContain('preset default')
  expect(status).toContain('plan –')
})

test('a part that fails is named and the others still switch (was: missing mods named in the toast)', SLOW, async ($, on) => {
  // the gates cannot save their session override: their part fails, the stage's and routing's go through
  routeWorld(on, { mode: false }, { refuseStore: ['loopkeeper:gates:overrides'] })
  await start($)
  const answer = await lk($, 'on')
  expect(answer).toContain('loopkeeper: the gates could not answer "on".')
  expect(answer).toContain('Pipeline preset gsd')
  expect(answer).toContain('GSD orchestrator mode on')
  const status = await lk($, 'status')
  expect(status).toContain('preset gsd')
  expect(status).toContain('routing ● on')
})

test('a session that starts with mode and loop on starts in the loop, once', SLOW, async ($, on) => {
  routeWorld(on, { mode: true })
  await start($)
  const first = await lk($, 'status')
  expect(first).toContain('preset gsd')
  expect(first).toContain('plan ✗')
  await start($)
  await $.classic.SessionStart({ source: 'clear', cwd: CWD } as never)
  const again = await lk($, 'status')
  expect(again).toContain('preset gsd')
  expect(again).toContain('plan ✗')
  expect(again).toContain('routing ● on')
})

test('pane: Toggle mode switches the stage and the gates as /lk on does', SLOW, async ($, on) => {
  const w = routeWorld(on, { mode: false })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /mode on:\s+stage preset gsd · gates plan required on/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /mode off: stage preset default · gates plan required off/ })).toBeDefined()
  await ui.press({ key: 'toggle' })
  expect(w.filled).toEqual(['/lk on'])
  expect(w.toasts).toContain('Press Enter to run /lk on: the stage and the gates switch with routing.')
  await lk($, w.filled[0]!.replace('/lk ', ''))
  expect(w.store.get(KEY.mode)).toBe(true)
  const status = await lk($, 'status')
  expect(status).toContain('preset gsd')
  expect(status).toContain('plan ✗')
  await ui.press({ key: 'loop' })
  expect(w.filled[1]).toBe('/lk loop off')
  await lk($, 'loop off')
  expect(w.store.get(KEY.loop)).toBe(false)
  expect(await ui.find({ type: 'Text', text: /Loop off/ })).toBeDefined()
  expect(await lk($, 'status')).toContain('preset default')
})

test('rules: the loop text when loop is on, the old text when off', SLOW, async ($, on) => {
  routeWorld(on, { mode: true })
  await start($)
  const withLoop = await $.prompt.context(CONTEXT)
  const content = withLoop.instructionFiles?.[0]?.content ?? ''
  expect(content).toContain(LOOP_RULES)
  expect(content).toContain('Every task runs this loop')
  expect(content).toContain('/lk approve')
  expect(content).not.toContain(RULES)
  expect(LOOP_RULES.split('\n').length < 30).toBe(true)

  await lk($, 'loop off')
  const without = await $.prompt.context(CONTEXT)
  expect(without.instructionFiles?.[0]?.content).toContain(RULES)
  expect(without.instructionFiles?.[0]?.content).not.toContain('Every task runs this loop')
})

test('band: an on chip and a loop chip when both are on, no loop chip when loop is off', SLOW, async ($, on) => {
  routeWorld(on, { mode: true })
  await start($)
  expect(linePlain(await bandLineOf($, 'routing'))).toMatch(/^routing {2}● on {2}● loop {3}recon→haiku · exec→sonnet/)

  await lk($, 'loop off')
  const noLoop = await bandLineOf($, 'routing')
  expect(linePlain(noLoop)).toMatch(/^routing {2}● on {3}recon→haiku/)
  expect(noLoop?.chips.map(c => c.text)).toEqual(['● on'])
})

// ---------------------------------------------------------------------------
// The sized loop and plan approval.

test('rules: the sized loop asks for a size first and names the verdict, under 30 lines', () => {
  expect(LOOP_RULES).toContain("size:'small'|'large'")
  expect(LOOP_RULES).toContain("verdict:'consistent'|'issues'")
  expect(LOOP_RULES).toContain('When unsure, large.')
  expect(LOOP_RULES).toContain('/lk approve')
  expect(LOOP_RULES.split('\n').length < 30).toBe(true)
  expect(RULES).not.toContain('size')
})

test('rules: plan material and an Artifact plan page are allowed while planning, and are not shipping', () => {
  expect(LOOP_RULES).toContain('Artifact')
  expect(LOOP_RULES).toContain('not shipping')
  expect(LOOP_RULES).toContain('No code edits yet. Plan material is allowed:')
  expect(LOOP_RULES).toContain('ask the user before any commit, push, PR, release or package publish (an Artifact page is not shipping)')
  expect(LOOP_RULES).not.toContain('PR or publish;')
  expect(LOOP_RULES.split('\n').length < 30).toBe(true)
})

test('loopEffects: what /lk on and /lk off switch; the approval mode is never part of it (was: loopCommands)', () => {
  expect(loopEffects(true)).toEqual(['stage preset gsd', 'gates plan required on'])
  expect(loopEffects(false)).toEqual(['stage preset default', 'gates plan required off'])
  expect([...loopEffects(true), ...loopEffects(false)].some(x => x.includes('approval'))).toBe(false)
})

test('/lk approval ask is the one approval mode: saved, shown, and named in the rules (was: forwarded)', SLOW, async ($, on) => {
  const w = routeWorld(on, { mode: false })
  await start($)
  expect(await lk($, 'approval')).toContain('Plan approval: auto')
  expect(await lk($, 'approval later')).toBe('Usage: /lk approval auto|ask')
  expect(await lk($, 'approval ask')).toContain('Plan approval: ask')
  expect(w.store.get(KEY.approval)).toBe('ask')
  expect(await lk($, 'text')).toContain('Plan approval: ask')

  await lk($, 'on')
  expect(w.toasts.filter(t => t.includes('approval'))).toEqual([])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /^Plan approval: ask/ })).toBeDefined()
  await ui.unmount()
  const context = await $.prompt.context(CONTEXT)
  expect(context.instructionFiles?.[0]?.content).toContain('(plan approval: ask)')
})

test('a saved approval mode is in force when a session starts in the loop', SLOW, async ($, on) => {
  routeWorld(on, { mode: true, approval: 'ask' })
  await start($)
  expect(await lk($, 'status')).toContain('Plan approval: ask')
  const context = await $.prompt.context(CONTEXT)
  expect(context.instructionFiles?.[0]?.content).toContain(loopRules({ approval: 'ask' }))
})

// ---------------------------------------------------------------------------
// New in loopkeeper: the rules text as shipped, the kill switch, and the shared words across concerns.

test('the loop rules, word for word as shipped (slack 10, approval auto)', () => {
  expect(LOOP_RULES).toBe(
    [
      'GSD orchestrator mode is on. You are the orchestrator and auditor, not the worker.',
      '(Main conversation only; a subagent started with the Agent tool ignores this block.)',
      'Every task runs this loop; loopkeeper records and enforces it through set_stage (plan approval: auto).',
      "0 Size it first: call set_stage {stage:'plan', size:'small'|'large', files: <how many files the plan touches>, note:'<one-line plan>'}.",
      '  Approving the plan approves a file budget of that many files plus 10; the plan validator checks the count.',
      '  small = one clear change in at most 3 files with no design choice or new behaviour (a typo, a rename,',
      '  a config value, a question, a one-off command). Everything else is large. When unsure, large.',
      '1 Small: the one-line plan is enough; go straight to Execute (the plan gate and the verifier are waived;',
      '  the pipeline pushes a small task back to Plan if it grows past 3 files). Then QA and Ship as below.',
      '2 Large, Plan: state Goal, Steps, Done-when and the files to touch. No code edits yet. Plan material is allowed:',
      '  a plan page under the scratchpad, .claude/plans/ or docs/plans/, published with the Artifact tool for the user to read',
      '  and answer its questions in; that is not shipping.',
      '3 Validate plan: spawn a plan validator subagent (fresh context; call it a validator or reviewer) to check',
      '  the plan against the ask and the code for gaps, conflicts and wrong files. Record its result with',
      "  set_stage {stage:'validate-plan', verdict:'consistent'|'issues', note}; a review_cycle pass of kind plan",
      '  with no open p0 or p1 also records it. Consistent opens the gate by',
      '  itself unless the user wants to approve plans (approval mode ask, or the prompt asked to wait): then ask',
      '  them to run /lk approve. Issues: fix the plan and validate again.',
      '4 Execute: delegate the work to subagents (reconnaissance and multi-file edits); run independent ones in',
      '  parallel in one message. Models are routed by role (recon → haiku, execute/verify → sonnet, hard → opus);',
      '  do not set a model unless overriding with [model:opus] or [role:hard].',
      '5 Validate execution: spawn a verifier subagent with fresh context to check the work against Done-when;',
      '  fix and re-verify. Record each pass with review_cycle (kind plan|review|qa|critic) when that tool exists.',
      '6 QA: run the tests and the build; fix failures.',
      '7 Ship: ask the user before any commit, push, PR, release or package publish (an Artifact page is not shipping);',
      '  shipping commands are held until /lk approve at Ship or the stage before it.',
      'Audit every subagent result before presenting it (paths, numbers, no secrets or client names).',
      'Report each unit of work as Goal / Status / Decisions / Next; record settled decisions with record_decision when it exists.',
    ].join('\n'),
  )
  expect(LOOP_RULES).not.toContain('/pipeline')
  expect(LOOP_RULES).not.toContain('pipeline-stage')
})

test('the rules name the plan slack from config and the stage approval mode', SLOW, async ($, on) => {
  routeWorld(on, { mode: true }, { files: { [PROJECT_CONFIG]: JSON.stringify({ changeControl: { planSlack: 7 } }) } })
  await start($)
  const content = (await $.prompt.context(CONTEXT)).instructionFiles?.[0]?.content ?? ''
  expect(content).toContain('a file budget of that many files plus 7;')
  expect(content).toContain('(plan approval: auto)')
  await lk($, 'approval ask')
  const after = (await $.prompt.context(CONTEXT)).instructionFiles?.[0]?.content ?? ''
  expect(after).toBe(loopRules({ slack: 7, approval: 'ask' }) + '\n')
})

test('CLAUDE_MODS_DISABLE=loopkeeper: spawns are not routed, the band and /lk say so, the rules stay', SLOW, async ($, on) => {
  const w = routeWorld(on, { mode: true }, { env: { CLAUDE_MODS_DISABLE: 'other,loopkeeper' } })
  await start($)
  await $.agent.spawn(spawnOf('Design the caching strategy'))
  expect(w.spawned.map(s => s.model)).toEqual([undefined])
  expect(await lk($, 'text')).toContain('Spawns are not routed: CLAUDE_MODS_DISABLE names loopkeeper')
  expect(await lk($, 'status')).toContain('routing ● on · loop on · spawn routing off (CLAUDE_MODS_DISABLE)')
  const line = await bandLineOf($, 'routing')
  expect(linePlain(line)).toBe('routing  ● routing off (CLAUDE_MODS_DISABLE)')
  expect(line?.chips[0]?.color).toBe(TONES.muted.fg)
  expect((await $.prompt.context(CONTEXT)).instructionFiles?.[0]?.content).toContain('Every task runs this loop')
  expect(await lk($, 'off')).toContain('GSD orchestrator mode off')
  expect(await lk($, 'on')).toContain('Spawns are not routed while CLAUDE_MODS_DISABLE names loopkeeper.')
})

test('/lk text: the stage, then the gates, then routing, in one reply', SLOW, async ($, on) => {
  routeWorld(on, { mode: true })
  await start($)
  const text = await lk($, 'text')
  const at = ['stage ●', 'gates ●', 'Active rules [source]:', 'GSD orchestrator: on', 'Routing table:'].map(t => text.indexOf(t))
  expect(at.every(i => i >= 0)).toBe(true)
  expect([...at].sort((a, b) => a - b)).toEqual(at)
  expect(text).not.toContain('unknown sub-command')
  expect(text).not.toContain('review ●')
  expect(await lk($, 'text', 'loopkeeper')).toBe(text)
})

test('/lk band off turns every band off in one reply; /lk band routing on only routing', SLOW, async ($, on) => {
  const w = routeWorld(on)
  await start($)
  const off = await lk($, 'band off')
  for (const line of ['The stage band is off.', 'The gates band is off.', 'The routing band is off.', 'The review band is off.', 'decisions ● band off']) {
    expect(off).toContain(line)
  }
  expect(off).not.toContain('unknown sub-command')
  expect(w.store.get(KEY.band)).toBe(false)
  expect(w.store.get('loopkeeper:review:band')).toBe(false)

  const one = await lk($, 'band routing on')
  expect(one).toBe('The routing band is on.')
  expect(w.store.get(KEY.band)).toBe(true)
  expect(w.store.get('loopkeeper:review:band')).toBe(false)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  const tree = await ui.drawn()
  expect(linePlain(lineOf(tree, 'routing'))).toBe('routing  ● off')
  expect(lineOf(tree, 'gates')).toBeUndefined()
  await ui.unmount()
  expect(await lk($, 'band review on')).toBe('The review band is on.')
})

test('/lk reload re-reads every concern in one reply, routing included', SLOW, async ($, on) => {
  const files: Record<string, string> = {}
  routeWorld(on, { mode: true }, { files })
  await start($)
  files[PROJECT_CONFIG] = JSON.stringify({ routing: { roles: { recon: 'opus' } } })
  const text = await lk($, 'reload')
  expect(text).toMatch(/Routing config re-read\. Routing table:\n\s+recon\s+→ opus\s+\.claude\/loopkeeper\.json/)
  for (const part of ['gates: reloaded', 'review ● config reloaded', 'decisions ● reloaded']) expect(text).toContain(part)
  expect(text.indexOf('gates: reloaded')).toBeLessThan(text.indexOf('Routing config re-read'))
  expect(text.indexOf('Routing config re-read')).toBeLessThan(text.indexOf('review ● config reloaded'))
})

test('/lk route and /lk explain answer their usage for bad words; /lk route reset drops overrides', SLOW, async ($, on) => {
  const w = routeWorld(on, { overrides: { hard: 'sonnet' } })
  await start($)
  expect(await lk($, 'route')).toBe('Usage: /lk route <recon|execute|verify|hard|default> <haiku|sonnet|opus|model-id> | /lk route reset')
  expect(await lk($, 'route boss opus')).toContain('Usage: /lk route')
  expect(await lk($, 'route hard bad/model')).toContain('Usage: /lk route')
  expect(await lk($, 'explain')).toBe('Usage: /lk explain <description or prompt text>')
  expect(await lk($, 'text')).toMatch(/hard\s+→ sonnet\s+session \(\/lk route\)/)
  const reset = await lk($, 'route reset')
  expect(reset).toMatch(/^Overrides dropped\. Routing table:\n\s+recon/)
  expect(reset).toMatch(/hard\s+→ opus\s+default/)
  expect(w.store.has(KEY.overrides)).toBe(false)
})
