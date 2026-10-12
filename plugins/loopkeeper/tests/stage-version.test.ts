// stage-version.test.ts: the minimum Claude Code version note (ADR 0007). An older base is named on the stage band
// and in `/lk status`; a new enough, newer, dev or unknown build gives no note. tests/world.ts answers 2.1.294 unless
// the world's `version` option says otherwise.
import { expect, test } from 'claude-code/testing'

import { BAND, lk, start, texts, world } from './world.ts'

const NOTE = 'needs Claude Code 2.1.294+, found '

test('an older Claude Code is named on the stage band and in /lk status', async ($, on) => {
  world(on, { version: '2.1.290' })
  await start($)
  const ui = await $.ui.mount(BAND)
  const shown = texts(await ui.drawn()).join(' ')
  expect(shown).toContain(NOTE + '2.1.290')
  await ui.unmount()
  const status = await lk($, 'status')
  expect(status).toContain('Warning: loopkeeper needs Claude Code 2.1.294+, found 2.1.290.')
})

test('the note is about the base version the session reports, not a later one', async ($, on) => {
  world(on, { version: '2.0.99' })
  await start($)
  expect(await lk($, 'status')).toContain('found 2.0.99.')
})

const QUIET: Array<[string, string]> = [
  ['2.1.294', 'the minimum itself'],
  ['2.1.300', 'a newer version'],
  ['2.2.0', 'a newer minor version'],
  ['2.1.290-dev', 'a dev build of an older version'],
  ['2.1.294-dev', 'a dev build of the minimum'],
  ['unknown', 'an unknown version'],
  ['', 'an empty version'],
]

for (const [version, why] of QUIET) {
  test(`${JSON.stringify(version)} (${why}) gives no version note on the band or in /lk status`, async ($, on) => {
    world(on, { version })
    await start($)
    const ui = await $.ui.mount(BAND)
    expect(texts(await ui.drawn()).join(' ')).not.toContain('needs Claude Code')
    await ui.unmount()
    expect(await lk($, 'status')).not.toContain('needs Claude Code')
  })
}
