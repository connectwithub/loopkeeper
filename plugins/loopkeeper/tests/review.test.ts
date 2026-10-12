// The review concern end to end: tools, store and log, /reviews, the pane, the band, the context block,
// kinds, and the config layer. Ported from review-loop's register.test.ts onto the shared fixture.
import { describe, expect, test } from 'claude-code/testing'

import { TONES } from '../hooks/lib/kit.ts'
import { reviewWorld } from './review-world.ts'
import { BAND, CWD, PROJECT_CONFIG, USER_CONFIG, bandLineOf, lineOf, linePlain, lk, start, tool } from './world.ts'

const DAY = 24 * 60 * 60 * 1000
// the shared fixture's mock clock starts here
const NOW = 1_000
const LOG = `${CWD}/.claude/loopkeeper-review.jsonl`
const SUBJECTS_KEY = `loopkeeper:review:subjects:${CWD}`
const PANE_ID = 'loopkeeper-review'

const cycle = async ($: any, input: Record<string, unknown>) => String((await tool($, 'review_cycle', input)).result)
const item = async ($: any, input: Record<string, unknown>) => String((await tool($, 'review_item', input)).result)
const status = async ($: any, input: Record<string, unknown> = {}) => String((await tool($, 'review_status', input)).result)
const reviews = async ($: any, args: string) => String(((await $.command.run({ command: 'reviews', args })) as any).text ?? '')

describe('tools', () => {
  test('registers the three tools', { timeoutMs: 20_000 }, async ($, on) => {
    const w = reviewWorld(on)
    await start($)
    expect(w.tools.map(t => t.name).filter(n => n.startsWith('review_'))).toEqual(['review_cycle', 'review_item', 'review_status'])
  })

  test('review_cycle auto-increments and replies with the state', { timeoutMs: 20_000 }, async ($, on) => {
    reviewWorld(on)
    await start($)
    await cycle($, { subject: 'login_page', score: 7.1 })
    await cycle($, { subject: 'login_page', score: 8.0 })
    const out = await cycle($, { subject: 'login_page', score: 8.4, items: [{ text: 'Shield rim too thin', priority: 'p0' }] })
    expect(out).toContain('review login_page · cycle 3/4')
    expect(out).toContain('scores: 7.1 → 8.0 → 8.4 (+0.4)')
    expect(out).toContain('1 cycle left')
    expect(out).toContain('- [p0] Shield rim too thin')
  })

  test('not converging at the fourth cycle: message and toast; the fifth is refused', { timeoutMs: 20_000 }, async ($, on) => {
    const w = reviewWorld(on)
    await start($)
    for (const score of [7, 7.5, 8, 8.2]) await cycle($, { subject: 'signup_form', score })
    expect(await status($, { subject: 'signup_form' })).toContain('not converging: surface to the user')
    expect(w.toasts.some(t => t.includes('not converging'))).toBe(true)
    expect(await cycle($, { subject: 'signup_form', score: 8.6 })).toContain('Not recorded: cycle 5 is past the limit of 4')
  })

  test('target reached', async ($, on) => {
    const w = reviewWorld(on)
    await start($)
    const out = await cycle($, { subject: 'signup_form', score: 9.1 })
    expect(out).toContain('target 9.0 reached')
    expect(w.toasts).toContain('review signup_form: target 9.0 reached')
  })

  test('review_item closes with and without proof', { timeoutMs: 20_000 }, async ($, on) => {
    reviewWorld(on)
    await start($)
    await cycle($, { subject: 'signup_form', score: 7, items: ['Heading flat', 'Button small'] })
    expect(await item($, { subject: 'signup_form', text: 'Heading flat', done: true, proof: 'abc1234' })).toContain('✓ abc1234')
    expect(await item($, { subject: 'signup_form', text: 'Button small', done: true })).toContain('(no proof)')
    expect(await item($, { subject: 'signup_form' })).toContain('"text" is required')
  })

  test('review_status for all and for an unknown subject', async ($, on) => {
    reviewWorld(on)
    await start($)
    expect(await status($)).toContain('No reviews yet')
    await cycle($, { subject: 'a', score: 5 })
    await cycle($, { subject: 'b', score: 6 })
    const all = await status($)
    expect(all).toContain('review a · cycle 1/4')
    expect(all).toContain('review b · cycle 1/4')
    expect(await status($, { subject: 'zzz' })).toBe('No review for "zzz". Known: a, b.')
  })

  test('other tools pass through', async ($, on) => {
    reviewWorld(on)
    await start($)
    expect(await $.tool.call({ tool: 'mcp__elsewhere__noop', command: 'ls' })).toEqual({ result: 'ran' })
  })
})

describe('store and log', () => {
  test('subjects are mirrored to the store by cwd and survive a restart', async ($, on) => {
    const w = reviewWorld(on)
    await start($)
    await cycle($, { subject: 'signup_form', score: 7.4 })
    expect(Object.keys(w.store.get(SUBJECTS_KEY) as object)).toEqual(['signup_form'])
    await $.classic.SessionStart({ source: 'clear' })
    expect(await status($, { subject: 'signup_form' })).toContain('scores: 7.4')
  })

  test('subjects idle 14 days are pruned at start, in every project', async ($, on) => {
    const w = reviewWorld(on)
    const now = NOW
    const old = { name: 'old', target: 9, maxCycles: 4, cycles: [{ cycle: 1, score: 6, at: 1 }], items: [], status: 'active', updatedAt: now - 15 * DAY }
    const fresh = { ...old, name: 'fresh', updatedAt: now - DAY }
    w.store.set(SUBJECTS_KEY, { old, fresh })
    w.store.set('loopkeeper:review:subjects:/elsewhere', { old })
    w.store.set('loopkeeper:review:subjects:/other', { fresh, old })
    await start($)
    expect(Object.keys(w.store.get(SUBJECTS_KEY) as object)).toEqual(['fresh'])
    expect(w.store.has('loopkeeper:review:subjects:/elsewhere')).toBe(false)
    expect(Object.keys(w.store.get('loopkeeper:review:subjects:/other') as object)).toEqual(['fresh'])
    expect(await status($)).not.toContain('review old')
  })

  test('nothing is migrated from the old bare keys, and other keys are never touched', async ($, on) => {
    const w = reviewWorld(on)
    const now = NOW
    const stale = { name: 'stale', target: 9, maxCycles: 4, cycles: [{ cycle: 1, score: 6, at: 1 }], items: [], status: 'active', updatedAt: now - 30 * DAY }
    const live = { ...stale, name: 'live', updatedAt: now }
    w.store.set(`subjects:${CWD}`, { live })
    w.store.set('subjects:/elsewhere', { stale })
    w.store.set('band', false)
    w.store.set('loopkeeper:stage:subjects:/work', { stale })
    await start($)
    expect(await status($)).toContain('No reviews yet')
    expect(w.store.get(`subjects:${CWD}`)).toEqual({ live })
    expect(w.store.has('subjects:/elsewhere')).toBe(true)
    expect(w.store.has('loopkeeper:stage:subjects:/work')).toBe(true)
    const ui = await $.ui.mount(BAND)
    await cycle($, { subject: 'x', score: 7 })
    expect(lineOf(await ui.drawn(), 'review')?.chips[0]?.text).toBe('● x cycle 1/4')
    await ui.unmount()
  })

  test('each cycle appends one jsonl line', async ($, on) => {
    const w = reviewWorld(on, { files: { [LOG]: '{"earlier":true}' } })
    await start($)
    await cycle($, { subject: 'signup_form', score: 7, notes: 'heading flat' })
    await cycle($, { subject: 'signup_form', score: 8.1, verdict: 'iterate' })
    const lines = w.files[LOG]!.trim().split('\n')
    expect(lines.length).toBe(3)
    expect(lines[0]).toBe('{"earlier":true}')
    expect(JSON.parse(lines[2]!)).toMatchObject({ session: 'sess-1', subject: 'signup_form', cycle: 2, score: 8.1, delta: '+1.1', verdict: 'iterate', reached: false })
    expect(JSON.parse(lines[1]!).notes).toBe('heading flat')
  })

  test('the log is not the old review-loop file', async ($, on) => {
    const w = reviewWorld(on)
    await start($)
    await cycle($, { subject: 'signup_form', score: 7 })
    expect(Object.keys(w.files)).toEqual([LOG])
  })

  test('a failed log write is skipped silently', async ($, on) => {
    reviewWorld(on, { failWrite: true })
    await start($)
    expect(await cycle($, { subject: 'signup_form', score: 7 })).toContain('cycle 1/4')
  })
})

describe('/reviews', () => {
  test('text, target, max, clear', async ($, on) => {
    reviewWorld(on)
    await start($)
    await cycle($, { subject: 'signup_form', score: 7 })
    expect(await reviews($, 'text')).toContain('review signup_form · cycle 1/4')
    expect(await reviews($, 'max 6 signup_form')).toContain('Max cycles for signup_form is now 6.')
    expect(await reviews($, 'target 8.5')).toContain('Default target is now 8.5')
    expect(await cycle($, { subject: 'new', score: 8.6 })).toContain('target 8.5 reached')
    expect(await reviews($, 'clear signup_form')).toBe('Cleared signup_form.')
    expect(await reviews($, 'text signup_form')).toContain('No review for "signup_form"')
    expect(await reviews($, 'nope')).toContain('Usage: /reviews')
  })

  test('reopen at the limit grants one more cycle', async ($, on) => {
    reviewWorld(on)
    await start($)
    for (const score of [6, 6, 6, 6]) await cycle($, { subject: 'm', score })
    expect(await reviews($, 'reopen m')).toBe('Reopened: m with one more cycle (max 5).')
    expect(await cycle($, { subject: 'm', score: 7 })).toContain('cycle 5/5')
  })

  test('the pane shows history, sparkline, items and buttons', async ($, on) => {
    const w = reviewWorld(on)
    await start($)
    await cycle($, { subject: 'hero', score: 7.1, items: [{ text: 'Footer', priority: 'p1' }, { text: 'Header', priority: 'p0' }] })
    await cycle($, { subject: 'hero', score: 8.0 })
    await item($, { subject: 'hero', text: 'Footer', done: true, proof: 'out/footer.png' })
    expect(await $.command.run({ command: 'reviews', args: '' })).toEqual({})
    expect(w.panes).toEqual([PANE_ID])
    const ui = await $.ui.mount({
      plugin: 'loopkeeper',
      component: 'Pane',
      requestId: PANE_ID,
      surface: 'terminal',
      viewport: { columns: 120, rows: 40 },
      props: { title: 'Review loops', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: '7.1 → 8.0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^[▁▂▃▄▅▆▇█]{2}$/ })).toBeDefined()
    // the item rows are drawn with the kit (tests/review-pane.test.ts checks their structure): the texts and the proof
    expect(await ui.find({ type: 'Text', text: 'Header' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Footer' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'out/footer.png' })).toBeDefined()
    await ui.press({ key: 'ship:hero' })
    expect(await status($, { subject: 'hero' })).toContain('shipped')
    await ui.press({ key: 'reopen:hero' })
    expect(await status($, { subject: 'hero' })).not.toContain('shipped')
    await ui.press({ key: 'stop:hero' })
    expect(await status($, { subject: 'hero' })).toContain('stopped')
    await ui.press({ key: 'close' })
    expect(w.panes).toEqual([PANE_ID, `closed:${PANE_ID}`])
    await ui.unmount()
  })

  test('the command is registered as reviews, never as the built-in review or loop', async ($, on) => {
    const w = reviewWorld(on)
    await start($)
    expect(w.registered).toContain('reviews')
    expect(w.attempted).not.toContain('review')
    expect(w.attempted).not.toContain('loop')
    expect(await reviews($, 'nope')).not.toMatch(/\/review\b(?!s)/)
  })

  test('/lk status carries the review line and /lk reload re-reads the config', async ($, on) => {
    const w = reviewWorld(on)
    await start($)
    await cycle($, { subject: 'signup_form', score: 7 })
    expect(await lk($, 'status')).toContain('review ● 1 active of 1 subjects')
    expect(await lk($, 'reload')).toContain('review ● config reloaded: 0 kind overrides')
    w.files[PROJECT_CONFIG] = JSON.stringify({ review: { kinds: { critic: { maxCycles: 2 } } } })
    expect(await lk($, 'reload', 'loopkeeper')).toContain('review ● config reloaded: 1 kind override')
    expect(await cycle($, { subject: 'later', score: 5 })).toContain('cycle 1/2')
  })
})

describe('band', () => {
  test('hidden with no active subject, then the line, then the error tone, hidden once shipped', async ($, on) => {
    reviewWorld(on)
    await start($)
    const ui = await $.ui.mount(BAND)
    expect(lineOf(await ui.drawn(), 'review')).toBeUndefined()
    await cycle($, { subject: 'login_page', score: 7.1, items: ['a', 'b'] })
    await cycle($, { subject: 'login_page', score: 8.0 })
    await cycle($, { subject: 'login_page', score: 8.4 })
    let line = lineOf(await ui.drawn(), 'review')
    expect(linePlain(line)).toBe('review  ● login_page cycle 3/4  ● 2 open   8.4 → 9.0')
    expect(line?.label).toEqual({ text: 'review', color: undefined, bold: true })
    // the subject chip is info while it runs; the open chip warns while a p1 is open; the right side is quiet
    expect(line?.chips.map(c => c.color)).toEqual([TONES.info.fg, TONES.warn.fg])
    expect(line?.right?.color).toBe(TONES.muted.fg)
    await cycle($, { subject: 'login_page', score: 8.5 })
    line = lineOf(await ui.drawn(), 'review')
    expect(linePlain(line)).toBe('review  ● login_page cycle 4/4  ● 2 open   8.5 → 9.0 · not converging')
    expect(line?.chips[0]?.color).toBe(TONES.danger.fg)
    await reviews($, 'ship login_page')
    expect(lineOf(await ui.drawn(), 'review')).toBeUndefined()
    await ui.unmount()
  })

  test('band off hides it and is saved', async ($, on) => {
    const w = reviewWorld(on)
    await start($)
    await cycle($, { subject: 'x', score: 9.5 })
    expect(await reviews($, 'band off')).toBe('Band off.')
    expect(w.store.get('loopkeeper:review:band')).toBe(false)
    const ui = await $.ui.mount(BAND)
    expect(lineOf(await ui.drawn(), 'review')).toBeUndefined()
    await reviews($, 'band on')
    expect(w.store.get('loopkeeper:review:band')).toBe(true)
    const line = lineOf(await ui.drawn(), 'review')
    expect(linePlain(line)).toBe('review  ● x cycle 1/4  ● 0 open   9.5 → 9.0')
    expect(line?.chips.map(c => c.color)).toEqual([TONES.ok.fg, TONES.muted.fg])
    await ui.unmount()
  })

  test('the stored band switch is read at start, which is what /lk band review will set', async ($, on) => {
    const w = reviewWorld(on)
    w.store.set('loopkeeper:review:band', false)
    await start($)
    await cycle($, { subject: 'x', score: 7 })
    const ui = await $.ui.mount(BAND)
    expect(lineOf(await ui.drawn(), 'review')).toBeUndefined()
    expect(await reviews($, 'band')).toBe('Band is off. Use /reviews band on|off.')
    await ui.unmount()
  })
})

describe('prompt.context', () => {
  const block = async ($: any) =>
    (await $.prompt.context({ blocks: [{ name: 'reviewLoop', text: 'stale' }], instructionFiles: [] })).blocks.filter(
      (b: { name: string }) => b.name === 'reviewLoop',
    )

  test('one block with the contract and the rule when on, none when off', async ($, on) => {
    const w = reviewWorld(on)
    await start($)
    const blocks = await block($)
    expect(blocks.length).toBe(1)
    expect(blocks[0].text).toContain('after each pass call review_cycle')
    expect(blocks[0].text).toContain('Do not run more than maxCycles passes (critic 4, review 3, plan 2, qa 3)')
    expect(blocks[0].text).toContain('Score kinds aim for the target (default 9.0)')
    // stage records a plan verdict itself now, so the block no longer tells the model to call set_stage
    expect(blocks[0].text).not.toContain('set_stage')
    expect(blocks[0].text).not.toContain('validate-plan')
    expect(blocks[0].text).toContain('stop and surface to the user')
    expect(blocks[0].text.split('\n').length).toBeLessThanOrEqual(6)
    expect(await reviews($, 'context off')).toBe('Context block off.')
    expect(w.store.get('loopkeeper:review:context')).toBe(false)
    expect(await block($)).toEqual([])
  })

  test('the limits in the block follow the config file and the /reviews override', async ($, on) => {
    reviewWorld(on, { files: { [USER_CONFIG]: JSON.stringify({ review: { kinds: { plan: { maxCycles: 5 }, critic: { target: 8 } } } }) } })
    await start($)
    const [conf] = await block($)
    expect(conf.text).toContain('(critic 4, review 3, plan 5, qa 3)')
    expect(conf.text).toContain('(default 8.0)')
    await reviews($, 'max 6')
    expect((await block($))[0].text).toContain('(critic 6, review 6, plan 6, qa 6)')
  })
})

describe('kinds through the tools and /reviews', () => {
  test('critic, review and plan calls reply in their own words', async ($, on) => {
    const w = reviewWorld(on)
    await start($)
    expect(await cycle($, { subject: 'hero', score: 7.2 })).toContain('review hero · cycle 1/4 · critic')
    const review = await cycle($, { subject: 'PR-42', kind: 'review', verdict: 'issues', items: [{ text: 'race in cache', priority: 'p0' }, 'naming'] })
    expect(review).toContain('review PR-42 · round 1/3 · review')
    expect(review).toContain('not done: 2 open p0/p1 items · 2 rounds left')
    const plan = await cycle($, { subject: 'plan-a', kind: 'plan', verdict: 'consistent' })
    expect(plan).toContain('done: no open p0/p1 items')
    expect(plan).toContain('shipped') // verdict consistent maps to ship, which ends the loop
    expect(w.toasts.some(t => t.includes('plan-a'))).toBe(false)
    expect(await cycle($, { subject: 'hero2', score: undefined })).toContain('"score" is required for kind critic')
  })

  test('limit refusal and toast use the kind words', async ($, on) => {
    const w = reviewWorld(on)
    await start($)
    await cycle($, { subject: 'p', kind: 'plan', items: [{ text: 'gap', priority: 'p0' }] })
    await cycle($, { subject: 'p' })
    expect(w.toasts).toContain('review p: not converging after 2/2 rounds (1 open p0/p1)')
    expect(await cycle($, { subject: 'p' })).toContain('Do not run another validation pass')
  })

  test('/reviews kinds, kind, and target on an items subject', async ($, on) => {
    reviewWorld(on)
    await start($)
    const kinds = await reviews($, 'kinds')
    expect(kinds).toContain('review  items')
    expect(kinds).toContain('design review')
    await cycle($, { subject: 'my page', kind: 'review', items: ['a'] })
    expect(await reviews($, 'target 8 my page')).toContain('no score target')
    const changed = await reviews($, 'kind my page copy')
    expect(changed).toContain('my page is now kind copy (done by score, target 8.5, max 3)')
    expect(await reviews($, 'kind my page nope')).toContain('Usage: /reviews kind')
    expect(await reviews($, 'kind ghost copy')).toContain('No review for "ghost"')
    expect(await reviews($, 'kind')).toContain('Usage: /reviews kind')
  })

  test('the band and pane show the kind', async ($, on) => {
    reviewWorld(on)
    await start($)
    await cycle($, { subject: 'PR-42', kind: 'review', items: [{ text: 'a', priority: 'p0' }, 'b', 'c'] })
    expect(linePlain(await bandLineOf($, 'review'))).toBe('review  ● PR-42 round 1/3  ● 3 open   1 p0')
    const ui = await $.ui.mount({
      plugin: 'loopkeeper',
      component: 'Pane',
      requestId: PANE_ID,
      surface: 'terminal',
      viewport: { columns: 120, rows: 40 },
      props: { title: 'Review loops', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: 'PR-42 · review' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'round 1/3 · 1 p0 · 3 open' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '3 open' })).toBeDefined()
    await ui.unmount()
  })

  test('jsonl lines carry kind and doneBy; score is null without one', async ($, on) => {
    const w = reviewWorld(on)
    await start($)
    await cycle($, { subject: 'PR-42', kind: 'review', items: ['a'] })
    const line = JSON.parse(w.files[LOG]!.trim().split('\n')[0]!)
    expect(line).toMatchObject({ kind: 'review', doneBy: 'items', score: null, target: null })
  })

  test('the user max default applies to every kind; target default to score kinds only', async ($, on) => {
    const w = reviewWorld(on)
    await start($)
    await reviews($, 'max 5')
    await reviews($, 'target 7')
    expect(w.store.get('loopkeeper:review:defaults')).toEqual({ maxCycles: 5, target: 7 })
    expect(await cycle($, { subject: 'a', kind: 'plan' })).toContain('round 1/5')
    expect(await cycle($, { subject: 'b', kind: 'copy', score: 7.5 })).toContain('target 7.0 reached')
  })
})

describe('config layer', () => {
  const user = { review: { kinds: { critic: { target: 8, maxCycles: 2 }, plan: { maxCycles: 4 } } } }

  test('config kinds set the target and limit of new subjects', async ($, on) => {
    reviewWorld(on, { files: { [USER_CONFIG]: JSON.stringify(user) } })
    await start($)
    expect(await cycle($, { subject: 'hero', score: 8.2 })).toContain('target 8.0 reached')
    expect(await cycle($, { subject: 'hero2', score: 5 })).toContain('cycle 1/2')
    expect(await cycle($, { subject: 'plan-a', kind: 'plan', items: [{ text: 'gap', priority: 'p0' }] })).toContain('round 1/4')
    expect(await cycle($, { subject: 'qa-a', kind: 'qa' })).toContain('round 1/3')
  })

  test('the project file beats the user file, per kind', async ($, on) => {
    reviewWorld(on, { files: { [USER_CONFIG]: JSON.stringify(user), [PROJECT_CONFIG]: JSON.stringify({ review: { kinds: { critic: { target: 7, maxCycles: 5 } } } }) } })
    await start($)
    expect(await cycle($, { subject: 'hero', score: 7.5 })).toContain('target 7.0 reached')
    expect(await cycle($, { subject: 'hero2', score: 5 })).toContain('cycle 1/5')
    expect(await cycle($, { subject: 'plan-a', kind: 'plan' })).toContain('round 1/4')
  })

  test('the /reviews override beats the config; subjects already running keep their numbers', async ($, on) => {
    reviewWorld(on, { files: { [USER_CONFIG]: JSON.stringify(user) } })
    await start($)
    await cycle($, { subject: 'running', score: 5 })
    await reviews($, 'max 6')
    await reviews($, 'target 9.5')
    expect(await cycle($, { subject: 'running', score: 6 })).toContain('cycle 2/2')
    const fresh = await cycle($, { subject: 'fresh', score: 9.1 })
    expect(fresh).toContain('cycle 1/6')
    expect(fresh).toContain('target 9.5 not reached')
  })

  test('the config applies after a restart to subjects stored without usable numbers', async ($, on) => {
    const w = reviewWorld(on, { files: { [USER_CONFIG]: JSON.stringify(user) } })
    w.store.set(SUBJECTS_KEY, { odd: { name: 'odd', kind: 'critic', cycles: [{ cycle: 1, score: 6, at: 900 }], items: [], target: 'bad', maxCycles: 'bad', status: 'active', updatedAt: 900 } })
    await start($)
    expect(await status($, { subject: 'odd' })).toContain('cycle 1/2')
  })

  test('a broken or odd config leaves the presets', async ($, on) => {
    reviewWorld(on, { files: { [USER_CONFIG]: '{ nope', [PROJECT_CONFIG]: JSON.stringify({ review: { kinds: { critic: { target: 99, maxCycles: 0 }, bogus: { target: 3 } } } }) } })
    await start($)
    expect(await cycle($, { subject: 'hero', score: 5 })).toContain('cycle 1/4')
    expect(await status($, { subject: 'hero' })).toContain('target 9.0')
  })
})
