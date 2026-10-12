import { expect, test } from 'claude-code/testing'

import { TONES } from '../hooks/kit'
import { BAND, FAKE, PANE, bandSeen, projectConfig, world } from './world'

const write = (content: string, file_path = 'src/x.ts') => ({ tool: 'Write', file_path, content })

test('the band stays empty until the first block or warning', async ($, on) => {
  world(on)
  const ui = await $.ui.mount(BAND as any)
  expect(await ui.find({ type: 'Text', text: /secret-guard/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  await ui.unmount()
})

test('the band counts blocks and allows in one line', async ($, on) => {
  world(on, { answer: 'Allow once' })
  await $.tool.call(write(FAKE.aws))
  await $.tool.call(write(FAKE.github))
  await $.tool.call(write(`const bearer = "${FAKE.jwt}"`))
  const ui = await $.ui.mount(BAND as any)
  expect(bandSeen(await ui.find({ key: 'secret-guard-band' }))).toEqual({
    text: 'secret-guard  ● 2 blocked  ● 1 allowed',
    tones: [TONES.danger.fg, TONES.ok.fg],
    bold: true,
  })
  await ui.unmount()
})

test('/secret-guard band off hides the band and saves the choice', async ($, on) => {
  const w = world(on)
  await $.tool.call(write(FAKE.aws))
  const out: any = await $.command.run({ command: 'secret-guard', args: 'band off' })
  expect(out.text).toContain('band off')
  expect(w.store.get('band')).toBe(false)
  const ui = await $.ui.mount(BAND as any)
  expect(await ui.find({ key: 'secret-guard-band' })).toBeUndefined()
  await ui.unmount()
})

test('the saved band setting is loaded at session start', async ($, on) => {
  const w = world(on)
  w.store.set('band', false)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call(write(FAKE.aws))
  const ui = await $.ui.mount(BAND as any)
  expect(await ui.find({ key: 'secret-guard-band' })).toBeUndefined()
  await ui.unmount()
})

test('/secret-guard off shows an urgent band: a danger chip and how to resume in the default text color', async ($, on) => {
  world(on)
  await $.command.run({ command: 'secret-guard', args: 'off' })
  const ui = await $.ui.mount(BAND as any)
  expect(bandSeen(await ui.find({ key: 'secret-guard-band' }))).toEqual({
    text: 'secret-guard  ● off for this session',
    tones: [TONES.danger.fg],
    bold: true,
    right: '/secret-guard on to resume',
    rightColor: undefined,
  })
  await ui.unmount()
})

test('the pane shows status, config, counts and masked rows, never the raw value', async ($, on) => {
  world(on, { files: projectConfig({ deny: ['Zorblax'] }) })
  await $.tool.call({ ...write(FAKE.aws), agentId: 'agent-7' })
  await $.tool.call(write('Zorblax', 'README.md'))
  const opened: any = await $.command.run({ command: 'secret-guard', args: '' })
  expect(opened).toEqual({})
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: 'Status: ON' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '/work/.claude/secret-guard.json' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Blocked' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'in src/x.ts (AKIA…456)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'agent agent-7' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /deny-listed word in README\.md/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: new RegExp(FAKE.aws) })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Zorblax/ })).toBeUndefined()
  expect(await ui.find({ key: 'close' })).toBeDefined()
  await ui.press({ key: 'close' })
  await ui.unmount()
})

test('/secret-guard test reports what would happen, masked', async ($, on) => {
  world(on)
  const out: any = await $.command.run({
    command: 'secret-guard',
    args: `test key=${FAKE.stripe} and ${FAKE.jwt}`,
  })
  expect(out.text).toContain('would BLOCK: Stripe live key (sk_l…')
  expect(out.text).toContain('would ASK (warn): JWT')
  expect(out.text.includes(FAKE.stripe)).toBe(false)
  expect(out.text.includes(FAKE.jwt)).toBe(false)
  const clean: any = await $.command.run({ command: 'secret-guard', args: 'test hello world' })
  expect(clean.text).toContain('nothing in that text would be flagged')
})

test('/secret-guard reload reports the files it found without listing words', async ($, on) => {
  world(on, { files: projectConfig({ deny: ['Zorblax', 'Quuxcorp'], publicPaths: ['README'] }) })
  const out: any = await $.command.run({ command: 'secret-guard', args: 'reload' })
  expect(out.text).toContain('reloaded /work/.claude/secret-guard.json')
  expect(out.text).toContain('2 deny word(s)')
  expect(out.text.includes('Zorblax')).toBe(false)
})

test('an unknown subcommand prints usage', async ($, on) => {
  world(on)
  const out: any = await $.command.run({ command: 'secret-guard', args: 'dance' })
  expect(out.text).toContain('usage: /secret-guard')
})
