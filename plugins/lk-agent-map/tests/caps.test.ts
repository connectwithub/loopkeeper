// 0.6.2: the caps in the plugin's settings (/config), their order against the files and
// /agent-map cap, /agent-map cap reset, the config.set guard, and the pane's Caps block.
import { expect, test } from 'claude-code/testing'

import { CAPS_HINT } from '../hooks/pane'
import { PANE, setup, spawn, start } from './fixtures'

const cmd = async ($: any, args: string) => (await $.command.run({ command: 'agent-map', args })).text as string
const capsLine = (c: { concurrent: string; turn: string; session: string; returned: string; warn: number }) =>
  'agent-map caps: concurrent ' + c.concurrent + ' (now 0) · turn ' + c.turn + ' (now 0) · session ' + c.session + ' (now 0) · returned ' + c.returned +
  ' (now 0) · warn at ' + c.warn + '% · waiting grace 4000 ms'
const DEFAULTS = capsLine({ concurrent: '4', turn: '8', session: '40', returned: '150k', warn: 75 })
const KEYS = ['maxConcurrent', 'maxPerTurn', 'maxPerSession', 'warnAt', 'maxReturnedTokens'] as const

/** The Caps block as drawn: each row's text by cap, every Text on the page. */
async function capsBlock($: any, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ ...PANE, surface })
  const rows: Record<string, string> = {}
  for (const k of KEYS) rows[k] = String((await ui.find({ key: 'cap-' + k }))?.text ?? '')
  const texts = ((await ui.findAll({ type: 'Text' })) as { text: string }[]).map(t => t.text)
  await ui.unmount()
  return { rows, texts }
}

test('the cap settings flow into the caps, 0 means no cap, and the pane names each source', { options: { maxConcurrent: 2, maxPerTurn: 5, warnAtPercent: 50, maxReturnedTokens: 0 } }, async ($, on) => {
  setup(on)
  await start($)
  expect(await cmd($, 'cap')).toBe(capsLine({ concurrent: '2', turn: '5', session: '40', returned: 'off', warn: 50 }))
  await spawn($, { toolUseId: 'tu-1', description: 'a', type: 'general-purpose', model: 'sonnet' })
  await spawn($, { toolUseId: 'tu-2', description: 'b', type: 'general-purpose', model: 'sonnet' })
  expect((await spawn($, { toolUseId: 'tu-3', description: 'c', type: 'general-purpose', model: 'sonnet' })).deny).toContain('concurrency cap reached (2/2)')
  for (const surface of ['terminal', 'desktop'] as const) {
    const { rows, texts } = await capsBlock($, surface)
    expect(rows.maxConcurrent).toContain('Max running at once')
    expect(rows.maxConcurrent).toContain('2')
    expect(rows.maxConcurrent).toContain('settings')
    expect(rows.maxPerTurn).toContain('settings')
    expect(rows.maxPerSession).toContain('40')
    expect(rows.maxPerSession).toContain('default')
    expect(rows.warnAt).toContain('50%')
    expect(rows.maxReturnedTokens).toContain('no cap')
    expect(rows.maxReturnedTokens).toContain('settings')
    expect(texts).toContain('CAPS')
    expect(texts).toContain('FROM SETTINGS')
    expect(texts).toContain(CAPS_HINT)
    expect(texts.join(' ')).not.toContain('/plugin configure')
  }
})

test("the /config rows win over the register values; other plugins' rows are left alone", { options: { maxConcurrent: 2 } }, async ($, on) => {
  const world = setup(on)
  world.configRows = [
    { key: 'theme', value: 'dark' },
    { key: 'lk-agent-map@loopkeeper.maxConcurrent', value: 3 },
    { key: 'lk-agent-map@inline.warnAtPercent', value: 90 },
    { key: 'other.maxPerTurn', value: 1 },
    { key: 'lk-agent-map-extra.maxPerSession', value: 1 },
  ]
  await start($)
  expect(await cmd($, 'cap')).toBe(capsLine({ concurrent: '3', turn: '8', session: '40', returned: '150k', warn: 90 }))
})

test('the user file, the project file and a saved override still win over the settings', { options: { maxConcurrent: 2, maxPerTurn: 5, maxPerSession: 30 } }, async ($, on) => {
  const world = setup(on)
  world.files.set('/home/tester/.claude/agent-map.json', JSON.stringify({ maxPerSession: 20 }))
  world.files.set('/work/.claude/agent-map.json', JSON.stringify({ maxPerTurn: 12 }))
  await start($)
  expect(await cmd($, 'cap concurrent 6')).toBe('agent-map: concurrent cap set to 6')
  expect(await cmd($, 'cap')).toBe(capsLine({ concurrent: '6', turn: '12', session: '20', returned: '150k', warn: 75 }))
  const { rows, texts } = await capsBlock($)
  expect(rows.maxConcurrent).toContain('saved (/agent-map cap)')
  expect(rows.maxPerTurn).toContain('project file')
  expect(rows.maxPerSession).toContain('user file')
  expect(rows.warnAt).toContain('default')
  expect(texts).toContain('FROM SAVED (/AGENT-MAP CAP), PROJECT FILE, USER FILE')
})

test('invalid settings are ignored and the defaults stand', { options: { maxConcurrent: -1, maxPerTurn: 2.5, warnAtPercent: 0, maxReturnedTokens: -5 } }, async ($, on) => {
  const world = setup(on)
  world.configRows = [
    { key: 'lk-agent-map.maxPerSession', value: 'ten' },
    { key: 'lk-agent-map.warnAtPercent', value: 150 },
  ]
  await start($)
  expect(await cmd($, 'cap')).toBe(DEFAULTS)
  const { rows, texts } = await capsBlock($)
  for (const k of KEYS) expect(rows[k]).toContain('default')
  expect(texts).toContain('DEFAULTS')
})

test('cap reset clears one saved override or all of them, and the settings value comes back', { options: { maxConcurrent: 3, maxPerTurn: 6 } }, async ($, on) => {
  const world = setup(on)
  await start($)
  expect(await cmd($, 'cap concurrent 7')).toBe('agent-map: concurrent cap set to 7')
  expect(await cmd($, 'cap turn 9')).toBe('agent-map: turn cap set to 9')
  expect(world.store.get('caps')).toEqual({ maxConcurrent: 7, maxPerTurn: 9 })

  expect(await cmd($, 'cap reset concurrent')).toBe('agent-map: concurrent cap reset to 3 (settings)')
  expect(world.store.get('caps')).toEqual({ maxPerTurn: 9 })
  expect((await capsBlock($)).rows.maxConcurrent).toContain('settings')

  expect(await cmd($, 'cap reset')).toBe('agent-map: saved caps cleared. ' + capsLine({ concurrent: '3', turn: '6', session: '40', returned: '150k', warn: 75 }))
  expect(world.store.get('caps')).toEqual({})
  expect(await cmd($, 'cap reset session')).toBe('agent-map: session cap reset to 40 (default)')
  expect(await cmd($, 'cap reset bogus')).toContain('Usage: /agent-map cap')
  expect(await cmd($, 'cap reset toString')).toContain('Usage: /agent-map cap')
  expect(await cmd($, 'cap toString 3')).toContain('Usage: /agent-map cap')
})

test('the config.set guard refuses an out-of-range cap, and the caps follow a value that is written', async ($, on) => {
  const world = setup(on)
  world.configRows = [
    { key: 'theme', value: 'dark' },
    { key: 'lk-agent-map@loopkeeper.maxConcurrent', value: 4 },
    { key: 'lk-agent-map@loopkeeper.warnAtPercent', value: 75 },
  ]
  await start($)
  for (const value of [-2, 2.5]) {
    expect((await $.config.set({ key: 'lk-agent-map@loopkeeper.maxConcurrent', value })).deny).toBe(
      'agent-map: maxConcurrent takes a whole number, 0 or more (0 means no cap)',
    )
  }
  for (const value of [0, 101]) {
    expect((await $.config.set({ key: 'lk-agent-map@loopkeeper.warnAtPercent', value })).deny).toBe('agent-map: warnAtPercent takes a number from 1 to 100')
  }
  expect(world.configRows[1].value).toBe(4)
  expect(world.configRows[2].value).toBe(75)

  expect(await $.config.set({ key: 'lk-agent-map@loopkeeper.maxConcurrent', value: 1 })).toEqual({ value: 1 })
  expect(await cmd($, 'cap')).toBe(capsLine({ concurrent: '1', turn: '8', session: '40', returned: '150k', warn: 75 }))
  expect((await capsBlock($)).rows.maxConcurrent).toContain('settings')
  // Another row is not this guard's
  expect(await $.config.set({ key: 'theme', value: 'light' })).toEqual({ value: 'light' })
})

test('a settings file changed outside /config loads the caps again', async ($, on) => {
  const world = setup(on)
  world.configRows = [{ key: 'lk-agent-map@loopkeeper.maxPerTurn', value: 8 }]
  await start($)
  expect(await cmd($, 'cap')).toBe(DEFAULTS)
  world.configRows[0].value = 3
  await $.classic.ConfigChange({ hook_event_name: 'ConfigChange', source: 'user_settings' })
  expect(await cmd($, 'cap')).toBe(capsLine({ concurrent: '4', turn: '3', session: '40', returned: '150k', warn: 75 }))
})
