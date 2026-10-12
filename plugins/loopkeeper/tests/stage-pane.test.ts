// stage-pane.test.ts: the Stage pane and the stage band as the kit draws them, in the terminal and the desktop app.
// Ported from pipeline-stage's pane tests (2). Names changed only, plus kit v2: badges are '● text', case is kept
// (no upper-cased eyebrows or section titles), colors are theme keys (TONES) on both surfaces, no fills or dimColor.
// Kit v3: the bar under the stepper is a kit.progress Svg on the desktop; the terminal keeps the text bar.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { TONES } from '../hooks/lib/kit.ts'
import { CWD, start, world } from './world.ts'

const TOOL = 'mcp__loopkeeper__set_stage'
const SURFACES = ['terminal', 'desktop'] as const

const PANE = {
  plugin: 'loopkeeper',
  component: 'Pane',
  requestId: 'loopkeeper-stage',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Stage', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const BAND = {
  plugin: 'loopkeeper',
  component: 'AbovePrompt',
  viewport: { columns: 140, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

// A large task sized in Plan under the saved gsd preset, then moved to the Validate plan gate, which waits for approval
async function atPlanGate($: Engine, on: any): Promise<void> {
  const w = world(on, { now: 1_000_000 })
  w.store.set('loopkeeper:stage:preset:' + CWD, 'gsd')
  await start($)
  await $.tool.call({ tool: TOOL, stage: 'plan', size: 'large', note: 'add the parser' } as never)
  await $.command.run({ command: 'lk', args: 'validate-plan' })
}

async function status($: Engine): Promise<string> {
  const out = (await $.command.run({ command: 'lk', args: 'status' })) as { text?: string }
  return out?.text ?? ''
}

// The node and every node under it
function nodesIn(node: unknown): Node[] {
  if (!node || typeof node !== 'object') return []
  const n = node as Node & { props?: { children?: unknown[] } }
  return [n, ...(n.children ?? n.props?.children ?? []).flatMap(nodesIn)]
}

function textIn(node: unknown): string {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  const n = node as Node & { props?: { children?: unknown[] } }
  return (n.children ?? n.props?.children ?? []).map(textIn).join('')
}

for (const surface of SURFACES) {
  test(`pane on ${surface}: hero, stepper with the current stage, tiles, gates, history; Approve gate approves it`, { timeoutMs: 20_000 }, async ($, on) => {
    await atPlanGate($, on)
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    expect(await ui.find({ type: 'Text', text: 'stage' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Validate plan' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /preset gsd · auto on/ })).toBeDefined()
    // the next-step sentence, its own line under the hero
    expect(textIn(await ui.find({ key: 'next-step' }))).toBe("A plan validator's consistent verdict opens the gate, or /lk approve.")

    // the stepper: done, current (a waiting gate, so warn) and future stages as badges joined by ─
    const stepper = (await ui.find({ key: 'stepper' })) as Node
    expect(textIn(stepper)).toContain('Plan')
    expect(textIn(stepper)).toContain(' ─ ')
    const current = nodesIn(stepper).find(c => c.type === 'Text' && /^\W*● Validate plan ⚑ ⇄\W*$/.test(textIn(c))) as Node
    expect(current).toBeDefined()
    expect(current.props?.color).toBe(TONES.warn.fg)
    const done = nodesIn(stepper).find(c => c.type === 'Text' && /^\W*✓ Plan\W*$/.test(textIn(c))) as Node
    expect(done.props?.color).toBe(TONES.ok.fg)
    // kit 3.1: the pane is a page, one row between its blocks
    expect(((await ui.drawn()) as Node).props).toMatchObject({ flexDirection: 'column', rowGap: 1 })
    // the bar of the stages done: the text bar on the terminal, a full-width kit.progress Svg on the desktop
    const bars = nodesIn(await ui.drawn()).filter(n => n.type === 'Svg')
    if (surface === 'terminal') {
      expect(textIn(await ui.find({ key: 'progress' }))).toContain('17%')
      expect(bars).toEqual([])
    } else {
      const bar = bars.find(n => n.props?.alt === '17%')
      expect(bar?.props).toMatchObject({ alt: '17%', height: 6 })
      expect(bar?.props?.width).toBeUndefined()
      expect(textIn(await ui.find({ key: 'progress' }))).toContain('in Validate plan for ')
    }

    // tiles, sections and rows
    expect(await ui.find({ type: 'Text', text: '2 of 6' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'large' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Gates' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^History · \d+$/ })).toBeDefined()
    expect(textIn(await ui.find({ key: 'gate-validate-plan' }))).toMatch(/⚑ Validate plan.*press a to approve.*waiting/)
    expect(textIn(await ui.find({ key: 'gate-ship' }))).toMatch(/waiting/)
    expect(textIn(await ui.find({ key: 'history-0' }))).toMatch(/Validate plan · command/)

    // Approve gate does what it always did
    expect(await status($)).toContain('Gates: Validate plan pending')
    await ui.press({ key: 'approve' })
    expect(await status($)).toContain('Gates: Validate plan approved')
    await ui.unmount()
    const after = await $.ui.mount({ ...PANE, surface } as never)
    expect(textIn(await after.find({ key: 'gate-validate-plan' }))).toMatch(/approved/)
    expect(textIn(await after.find({ key: 'verifier-validate-plan' }))).toMatch(/verified/)
    await after.press({ key: 'next' })
    await after.unmount()
    const moved = await $.ui.mount({ ...PANE, surface } as never)
    expect(await moved.find({ type: 'Text', text: 'Execute' })).toBeDefined()
    expect(textIn(await moved.find({ key: 'next-step' }))).toBe('Next: Validate. Claude moves on when it starts that work, or /lk next.')
    await moved.unmount()
  })
}

test('the band draws the same text on both surfaces and keeps what later mods draw under it', async ($, on) => {
  await atPlanGate($, on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface } as never)
    const line = (await ui.find({ key: 'stage-band' })) as Node
    expect(textIn(line)).toBe('stage ✓ Plan ─ ● Validate plan ⚑ ⇄ ─ ○ Execute ─ ○ Validate ⇄ ─ ○ QA ─ ○ Ship ⚑ · in Validate plan <1m')
    const cur = nodesIn(line).find(c => c.type === 'Text' && textIn(c) === '● Validate plan') as Node
    expect(cur.props).toMatchObject({ color: TONES.info.fg, bold: true })
    // the band grammar: the label bold in the default color, the right side quiet
    const label = nodesIn(line).find(c => c.type === 'Text' && textIn(c) === 'stage ') as Node
    expect(label.props.bold).toBe(true)
    expect(label.props.color).toBeUndefined()
    const right = nodesIn(line).find(c => c.type === 'Text' && textIn(c) === ' · in Validate plan <1m') as Node
    expect(right.props.color).toBe(TONES.muted.fg)
    expect(right.props.dimColor).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
    await ui.unmount()
  }
})
