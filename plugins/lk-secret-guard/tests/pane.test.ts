// pane.test.ts: the /secret-guard pane and the band, drawn with the kit, on both surfaces.
// Every value is fake: FAKE credentials are assembled at run time (tests/world.ts), the
// generic secret is `sk-test-000-fake`, and the deny words are made-up nonsense.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { TONES, pillSvg } from '../hooks/kit'
import type { Tone } from '../hooks/kit'
import { BAND, FAKE, PANE, bandSeen, projectConfig, walk, world } from './world'

type Node = { type: string; props: Record<string, unknown>; children: unknown[] }

const SURFACES = ['terminal', 'desktop'] as const
const CONFIG = projectConfig({ deny: ['Zorblax', 'Quuxcorp'], warn: ['Flimflam'], disabledKinds: ['jwt'] })

const write = (content: string, file_path = 'src/x.ts') => ({ tool: 'Write', file_path, content })

/** A deny word blocked in README.md, a generic secret allowed once, then an AWS key blocked for agent-7. */
async function fill($: Engine) {
  await $.tool.call(write('Zorblax', 'README.md'))
  await $.tool.call(write('const password = "sk-test-000-fake"'))
  await $.tool.call({ ...write(FAKE.aws), agentId: 'agent-7' })
}

test('the pane draws the last block as the hero, tiles, recent rows with outcome badges, rules and config', async ($, on) => {
  world(on, { files: CONFIG, answer: 'Allow once' })
  await fill($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    const tree = await ui.drawn()
    // a pill: an Svg chip on the desktop (alt = its text), a `● text` chip in the tone on the terminal
    const pill = async (text: string, tone: Tone) => {
      if (surface === 'desktop') {
        const svg = [...walk(tree)].find(n => n.type === 'Svg' && n.props.alt === text)
        expect(svg?.props.source).toBe(pillSvg(text, tone))
        return svg
      }
      const chip = (await ui.find({ type: 'Text', text: `● ${text}` })) as Node | undefined
      expect(chip?.props.color).toBe(TONES[tone].fg)
      return chip
    }
    expect(await ui.find({ type: 'Text', text: 'secret guard' })).toBeDefined()
    const title = (await ui.find({ type: 'Text', text: 'Blocked AWS access key in src/x.ts' })) as Node | undefined
    expect(title?.props.color).toBe(TONES.danger.fg)
    expect(await ui.find({ type: 'Text', text: /^\d\d:\d\d:\d\d · AKIA…456 · agent agent-7$/ })).toBeDefined()
    // Tiles: Blocked 2 · Allowed 1 · Rules 12 (10 built-in on, jwt off, plus the deny and warn lists).
    for (const t of ['Blocked', 'Allowed', 'Rules', '2', '1', '12']) expect(await ui.find({ type: 'Text', text: t })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Status: ON' })).toBeDefined()
    // Recent decisions, newest first, each with its outcome pill.
    expect(await ui.find({ type: 'Text', text: 'Recent · 3' })).toBeDefined()
    expect(await pill('blocked', 'danger')).toBeDefined()
    expect(await pill('asked → allowed', 'warn')).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'hard-coded secret' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'in README.md (Zo…x)' })).toBeDefined()
    // Rules: one row per built-in kind with its source pill, the word lists counted, jwt off.
    expect(await ui.find({ type: 'Text', text: 'Rules · 12' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 off' })).toBeDefined()
    expect(await ui.find({ key: 'rule-aws-access-key' })).toBeDefined()
    expect(await pill('built-in', 'muted')).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2 deny word(s)' })).toBeDefined()
    expect(await pill('config', 'accent')).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Config · 1' })).toBeDefined()
    // no fills outside the kit's pills, no dimColor, no named colors
    expect(JSON.stringify(tree)).not.toMatch(/dimColor|backgroundColor|"(yellow|white|gray|grey|black|subtle)"/)
    expect(await ui.find({ type: 'Text', text: '/work/.claude/secret-guard.json' })).toBeDefined()
    // Never a raw value, never a word from the lists.
    for (const raw of [FAKE.aws, 'sk-test-000-fake', 'Zorblax', 'Quuxcorp', 'Flimflam']) {
      expect(await ui.find({ type: 'Text', text: new RegExp(raw) })).toBeUndefined()
    }
    await ui.unmount()
  }
})

test('Close closes the pane on both surfaces', async ($, on) => {
  const w = world(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    await ui.press({ key: 'close' })
    await ui.unmount()
  }
  expect(w.closed).toEqual(['secret-guard', 'secret-guard'])
})

test('the pane is a page: hero, tiles, status, each section and the buttons one row apart, the rows of a section tight', async ($, on) => {
  world(on, { files: CONFIG, answer: 'Allow once' })
  await fill($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    const root = (await ui.drawn()) as Node
    expect(root.props).toMatchObject({ flexDirection: 'column', rowGap: 1 })
    const blocks = root.children as Node[]
    // hero, tiles, status, Recent, Rules, Config, buttons
    expect(blocks).toHaveLength(7)
    for (const section of blocks.slice(3, 6)) expect(section.props).toEqual({ flexDirection: 'column' })
    expect(blocks[6].props).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, rowGap: 1 })
    await ui.unmount()
  }
})

test('with nothing blocked the hero says so, and turns red when the guard is off', async ($, on) => {
  world(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    const title = (await ui.find({ type: 'Text', text: 'Nothing blocked yet' })) as Node | undefined
    expect(title?.props.color).toBe(TONES.ok.fg)
    expect(await ui.find({ type: 'Text', text: 'Recent · 0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'No decisions yet this session' })).toBeDefined()
    await ui.unmount()
  }
  await $.command.run({ command: 'secret-guard', args: 'off' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    expect(((await ui.find({ type: 'Text', text: 'Nothing blocked yet' })) as Node | undefined)?.props.color).toBe(TONES.danger.fg)
    expect(await ui.find({ type: 'Text', text: 'The guard is off for this session · /secret-guard on to resume' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Status: OFF for this session' })).toBeDefined()
    await ui.unmount()
  }
})

test('the band is one kit line on both surfaces and stacks Claude Code content under it', async ($, on) => {
  world(on, { files: CONFIG, answer: 'Allow once' })
  await fill($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface } as never)
    expect(bandSeen(await ui.find({ key: 'secret-guard-band' }))).toEqual({
      text: 'secret-guard  ● 2 blocked  ● 1 allowed',
      tones: [TONES.danger.fg, TONES.ok.fg],
      bold: true,
    })
    expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
    expect(JSON.stringify(await ui.drawn())).not.toMatch(/dimColor|backgroundColor|"(yellow|white|gray|grey|black|subtle)"/)
    await ui.unmount()
  }
  await $.command.run({ command: 'secret-guard', args: 'off' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface } as never)
    // off is urgent: the danger chip, then how to resume in the default text color
    expect(bandSeen(await ui.find({ key: 'secret-guard-band' }))).toEqual({
      text: 'secret-guard  ● off for this session',
      tones: [TONES.danger.fg],
      bold: true,
      right: '/secret-guard on to resume',
      rightColor: undefined,
    })
    expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
    await ui.unmount()
  }
})
