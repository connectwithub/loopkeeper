// The pure part of the review concern: ported from review-loop's loop.test.ts, plus the config layer.
import { describe, expect, test } from 'claude-code/testing'

import {
  LOG_FILE,
  PRUNE_MS,
  SUBJECTS_PREFIX,
  USAGE,
  contextText,
  presetFor,
  storeKeyOf,
  applyCycle,
  applyItem,
  bandOf,
  cycleInputOf,
  itemInputOf,
  historyText,
  jsonlLine,
  kindDefaultsFrom,
  kindsText,
  prune,
  sparkline,
  statusText,
  subjectsFrom,
  verdictOf,
  withKind,
} from '../hooks/lib/reviewModel.ts'
import type { Subjects } from '../hooks/lib/reviewModel.ts'

const D = { target: 9.0, maxCycles: 4 }
const T0 = 1_000_000

/** Runs cycles one after another and returns the subjects. */
function run(scores: number[], extra: Record<string, unknown> = {}): Subjects {
  let all: Subjects = {}
  scores.forEach((score, i) => {
    const out = applyCycle(all, cycleInputOf({ subject: 'login_page', score, ...extra }), D, T0 + i)
    if (!out.ok) throw new Error(out.reply)
    all = { ...all, [out.subject.name]: out.subject }
  })
  return all
}

describe('input', () => {
  test('missing subject, and a missing score for a score kind, are reported, not thrown', () => {
    const input = cycleInputOf({})
    expect(input.errors.join('; ')).toContain('"subject" is required')
    expect(applyCycle({}, input, D, T0).ok).toBe(false)
    const noScore = applyCycle({}, cycleInputOf({ subject: 'a' }), D, T0)
    expect(!noScore.ok && noScore.reply).toContain('"score" is required for kind critic')
    expect(applyCycle({}, cycleInputOf({ subject: 'a', kind: 'review' }), D, T0).ok).toBe(true)
  })

  test('scores outside 0–10 and bad verdicts are refused', () => {
    expect(cycleInputOf({ subject: 'a', score: 11 }).errors[0]).toContain('outside 0–10')
    expect(cycleInputOf({ subject: 'a', score: 5, verdict: 'maybe' }).errors[0]).toContain('verdict')
  })

  test('critic words map onto verdicts', () => {
    expect(verdictOf('SHIP')).toBe('ship')
    expect(verdictOf('ONE-MORE-POLISH')).toBe('iterate')
    expect(verdictOf('NEEDS-REWORK')).toBe('iterate')
    expect(verdictOf('stop')).toBe('stop')
  })

  test('review words map onto verdicts', () => {
    for (const w of ['consistent', 'pass', 'passed', 'ok', 'approve', 'approved', 'LGTM', 'green']) expect(verdictOf(w)).toBe('ship')
    for (const w of ['inconsistent', 'issues', 'needs-work', 'needs work', 'needs_changes', 'changes-requested', 'red', 'failing'])
      expect(verdictOf(w)).toBe('iterate')
    expect(verdictOf('whatever')).toBeUndefined()
  })

  test('bad kind and doneBy are refused', () => {
    expect(cycleInputOf({ subject: 'a', kind: 'nope', score: 5 }).errors[0]).toContain('"kind" must be one of')
    expect(cycleInputOf({ subject: 'a', kind: 'review', doneBy: 'vibes' }).errors[0]).toContain('"doneBy"')
  })

  test('null input is safe', () => {
    expect(itemInputOf(null).errors.length).toBe(2)
    expect(subjectsFrom(null, D)).toEqual({})
    expect(subjectsFrom({ x: { cycles: 'bad', items: [null, { text: '' }] } }, D).x?.cycles).toEqual([])
  })
})

describe('cycles', () => {
  test('auto-increment and history', () => {
    const s = run([7.1, 8.0, 8.4]).login_page!
    expect(s.cycles.map(c => c.cycle)).toEqual([1, 2, 3])
    const text = statusText({ login_page: s }, 'login_page')
    expect(text).toContain('review login_page · cycle 3/4')
    expect(text).toContain('scores: 7.1 → 8.0 → 8.4 (+0.4)')
    expect(text).toContain('target 9.0 not reached (0.6 short) · 1 cycle left')
  })

  test('an explicit cycle that exists replaces the score', () => {
    let all = run([7.0, 8.0])
    const out = applyCycle(all, cycleInputOf({ subject: 'login_page', cycle: 2, score: 8.2 }), D, T0 + 9)
    expect(out.ok).toBe(true)
    if (out.ok) {
      all = { login_page: out.subject }
      expect(out.subject.cycles.map(c => c.score)).toEqual([7.0, 8.2])
      expect(out.warnings[0]).toContain('already recorded')
    }
  })

  test('target reached', () => {
    const text = statusText(run([8.1, 9.2]))
    expect(text).toContain('target 9.0 reached: ready to ship')
    expect(text).not.toContain('not converging')
  })

  test('not converging at max cycles, and a fifth cycle is refused', () => {
    const all = run([7.0, 7.8, 8.2, 8.5])
    expect(statusText(all)).toContain('not converging: surface to the user')
    const out = applyCycle(all, cycleInputOf({ subject: 'login_page', score: 8.9 }), D, T0 + 9)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reply).toContain('Not recorded: cycle 5 is past the limit of 4')
  })

  test('target and maxCycles count only on the first cycle', () => {
    const all = run([7.0], { target: 8.5, maxCycles: 3 })
    expect(all.login_page!.target).toBe(8.5)
    expect(all.login_page!.maxCycles).toBe(3)
    const out = applyCycle(all, cycleInputOf({ subject: 'login_page', score: 7.5, maxCycles: 9 }), D, T0 + 5)
    expect(out.ok && out.subject.maxCycles).toBe(3)
    if (out.ok) expect(out.warnings.join(' ')).toContain('only the user changes it')
  })

  test('a shipped subject refuses more cycles', () => {
    const all = run([9.1], { verdict: 'ship' })
    expect(all.login_page!.status).toBe('ship')
    const out = applyCycle(all, cycleInputOf({ subject: 'login_page', score: 9.3 }), D, T0 + 5)
    expect(!out.ok && out.reply).toContain('is shipped')
  })
})

describe('items', () => {
  test('carry over until done; close with and without proof', () => {
    let all: Subjects = {}
    const first = applyCycle(
      all,
      cycleInputOf({
        subject: 'signup_form',
        score: 7.5,
        items: [{ text: 'Heading reads flat at 64px', priority: 'p0' }, { text: 'Button too small', priority: 'p2' }, 'Warm the stone'],
      }),
      D,
      T0,
    )
    if (!first.ok) throw new Error(first.reply)
    all = { signup_form: first.subject }
    const second = applyCycle(all, cycleInputOf({ subject: 'signup_form', score: 8.3, items: [{ text: 'Button too small', done: true }] }), D, T0 + 1)
    if (!second.ok) throw new Error(second.reply)
    all = { signup_form: second.subject }
    expect(second.subject.items.filter(i => !i.done).map(i => i.text)).toEqual(['Heading reads flat at 64px', 'Warm the stone'])

    const proofed = applyItem(all, itemInputOf({ subject: 'signup_form', text: 'heading reads', done: true, proof: 'shots/signup_form_64.png' }), D, T0 + 2)
    expect(proofed.ok).toBe(true)
    if (proofed.ok) {
      expect(proofed.reply).toContain('Closed: Heading reads flat at 64px ✓ shots/signup_form_64.png')
      all = { signup_form: proofed.subject }
    }
    const bare = applyItem(all, itemInputOf({ subject: 'signup_form', text: 'Warm the stone', done: true }), D, T0 + 3)
    expect(bare.ok && bare.reply).toContain('✓ (no proof)')
    if (bare.ok) all = { signup_form: bare.subject }
    const text = statusText(all, 'signup_form')
    expect(text).toContain('open items: none')
    expect(text).toContain('closed: 3 (2 without proof)')
  })

  test('open items list p0 first', () => {
    const out = applyCycle({}, cycleInputOf({ subject: 's', score: 6, items: [{ text: 'b', priority: 'p2' }, { text: 'a', priority: 'p0' }] }), D, T0)
    if (!out.ok) throw new Error(out.reply)
    expect(statusText({ s: out.subject })).toContain('- [p0] a\n- [p2] b')
  })

  test('an ambiguous close is refused with the candidates', () => {
    const out = applyCycle({}, cycleInputOf({ subject: 's', score: 6, items: ['fix heading edge', 'fix heading color'] }), D, T0)
    if (!out.ok) throw new Error(out.reply)
    const res = applyItem({ s: out.subject }, itemInputOf({ subject: 's', text: 'heading', done: true }), D, T0 + 1)
    expect(!res.ok && res.reply).toContain('matches 2 open items')
  })
})

describe('store and log shapes', () => {
  test('pruning drops subjects idle 14 days', () => {
    const all = run([7])
    expect(Object.keys(prune(all, T0 + PRUNE_MS - 10).kept)).toEqual(['login_page'])
    expect(prune(all, T0 + PRUNE_MS + 10).dropped).toEqual(['login_page'])
  })

  test('subjects survive a JSON round trip', () => {
    const all = run([7.1, 8.0], { items: [{ text: 'x', priority: 'p0' }] })
    expect(subjectsFrom(JSON.parse(JSON.stringify(all)), D)).toEqual(all)
  })

  test('jsonl line shape', () => {
    const s = run([7.1, 8.0]).login_page!
    const line = JSON.parse(jsonlLine(s, s.cycles[1]!, 'sess-1'))
    expect(Object.keys(line)).toEqual(['at', 'session', 'subject', 'kind', 'doneBy', 'cycle', 'maxCycles', 'score', 'target', 'delta', 'reached', 'verdict', 'open', 'closed', 'notes'])
    expect(line).toMatchObject({ subject: 'login_page', kind: 'critic', doneBy: 'score', cycle: 2, score: 8, target: 9, delta: '+0.9', reached: false, verdict: null })
  })
})

describe('band and sparkline', () => {
  test('band states', () => {
    expect(bandOf({})).toBeNull()
    expect(bandOf(run([7.1, 8.0, 8.4]))).toEqual({
      chips: [
        { text: 'login_page cycle 3/4', tone: 'info' },
        { text: '0 open', tone: 'muted' },
      ],
      right: ['8.4 → 9.0'],
    })
    expect(bandOf(run([8.0, 9.1]))?.chips[0]?.tone).toBe('ok')
    const bad = bandOf(run([7, 7, 7, 7]))
    expect(bad?.chips[0]).toEqual({ text: 'login_page cycle 4/4', tone: 'danger' })
    expect(bad?.right).toEqual(['7.0 → 9.0', 'not converging'])
    expect(bandOf(run([9.2], { verdict: 'ship' }))).toBeNull()
  })

  test('sparkline uses the eight blocks', () => {
    expect(sparkline([7.1, 8.0, 8.4])).toBe('▁▃▄')
    expect(sparkline([0, 10])).toBe('▁█')
    expect(sparkline([])).toBe('')
  })
})

/** Records item-kind rounds: each entry is the input for one review_cycle. */
function rounds(kind: string, inputs: Record<string, unknown>[], subject = 'PR-42'): Subjects {
  let all: Subjects = {}
  inputs.forEach((extra, i) => {
    const out = applyCycle(all, cycleInputOf({ subject, kind, ...extra }), {}, T0 + i)
    if (!out.ok) throw new Error(out.reply)
    all = { ...all, [out.subject.name]: out.subject }
  })
  return all
}

describe('kinds', () => {
  test('presets: doneBy, target and maxCycles per kind', () => {
    const want: Record<string, [string, number | undefined, number]> = {
      critic: ['score', 9, 4],
      review: ['items', undefined, 3],
      plan: ['items', undefined, 2],
      qa: ['items', undefined, 3],
      copy: ['score', 8.5, 3],
      design: ['score', 9, 4],
    }
    for (const [kind, [doneBy, target, max]] of Object.entries(want)) {
      const out = applyCycle({}, cycleInputOf({ subject: 's', kind, score: 5 }), {}, T0)
      if (!out.ok) throw new Error(out.reply)
      expect(out.subject).toMatchObject({ kind, doneBy, maxCycles: max })
      expect(out.subject.target).toBe(target)
    }
    expect(kindsText()).toContain('copy    score    8.5     3    edit pass')
  })

  test('user defaults beat the preset; doneBy can be overridden on the first cycle', () => {
    const out = applyCycle({}, cycleInputOf({ subject: 's', kind: 'copy', score: 5 }), { target: 9.5, maxCycles: 6 }, T0)
    expect(out.ok && out.subject).toMatchObject({ target: 9.5, maxCycles: 6 })
    const items = applyCycle({}, cycleInputOf({ subject: 's', kind: 'critic', doneBy: 'items' }), {}, T0)
    expect(items.ok && items.subject).toMatchObject({ kind: 'critic', doneBy: 'items', maxCycles: 4 })
    const score = applyCycle({}, cycleInputOf({ subject: 's', kind: 'review', doneBy: 'score', score: 7 }), {}, T0)
    expect(score.ok && score.subject.target).toBe(9)
  })

  test('the kind of a subject with cycles stays; the reply says who changes it', () => {
    const all = rounds('review', [{ items: ['a'] }])
    const out = applyCycle(all, cycleInputOf({ subject: 'PR-42', kind: 'critic', score: 9 }), D, T0 + 5)
    expect(out.ok && out.subject.kind).toBe('review')
    expect(out.ok && out.warnings.join(' ')).toContain('kind stays review')
  })

  test('withKind swaps the preset and keeps history and items', () => {
    const s = run([7, 8], { items: ['x'] }).login_page!
    const r = withKind(s, 'review', {}, T0 + 9)
    expect(r).toMatchObject({ kind: 'review', doneBy: 'items', maxCycles: 3 })
    expect(r.target).toBeUndefined()
    expect(r.cycles.length).toBe(2)
    expect(r.items.length).toBe(1)
    expect(withKind(r, 'copy', {}, T0 + 10)).toMatchObject({ doneBy: 'score', target: 8.5, maxCycles: 3 })
  })

  test('a subject created by review_item takes the kind of its first cycle', () => {
    const item = applyItem({}, itemInputOf({ subject: 'p', text: 'Fix auth' }), {}, T0)
    if (!item.ok) throw new Error(item.reply)
    const out = applyCycle({ p: item.subject }, cycleInputOf({ subject: 'p', kind: 'plan' }), {}, T0 + 1)
    expect(out.ok && out.subject).toMatchObject({ kind: 'plan', maxCycles: 2 })
    expect(out.ok && out.subject.items.length).toBe(1)
  })
})

describe('items kinds', () => {
  test('done when a cycle exists and no p0/p1 is open; p2 does not block', () => {
    const open = rounds('review', [{ items: [{ text: 'race in cache', priority: 'p1' }, { text: 'rename var', priority: 'p2' }] }])
    expect(statusText(open)).toContain('not done: 1 open p0/p1 item · 2 rounds left')
    const closed = applyItem(open, itemInputOf({ subject: 'PR-42', text: 'race in cache', done: true, proof: 'abc123' }), {}, T0 + 3)
    if (!closed.ok) throw new Error(closed.reply)
    const text = statusText({ 'PR-42': closed.subject })
    expect(text).toContain('done: no open p0/p1 items: ready to ship')
    expect(text).toContain('review PR-42 · round 1/3 · review')
    expect(text).not.toContain('not converging')
  })

  test('an iterate verdict keeps it open even with no items; ship with open p0/p1 warns but ships', () => {
    const iterating = rounds('qa', [{ verdict: 'issues' }])
    expect(statusText(iterating)).toContain('not done: last verdict was iterate')
    const out = applyCycle({}, cycleInputOf({ subject: 'x', kind: 'review', verdict: 'lgtm', items: [{ text: 'a', priority: 'p0' }, { text: 'b', priority: 'p1' }] }), {}, T0)
    expect(out.ok && out.subject.status).toBe('ship')
    expect(out.ok && out.warnings).toContain('shipped with 2 open p0/p1 items')
  })

  test('score is optional and shown when given; history shows open counts without scores', () => {
    const all = rounds('review', [
      { items: ['a', 'b', 'c', 'd', 'e'] },
      { items: [{ text: 'a', done: true }, { text: 'b', done: true }, { text: 'c', done: true }] },
      { items: [{ text: 'd', done: true }, { text: 'e', done: true }] },
    ])
    expect(historyText(all['PR-42']!)).toBe('5 open → 2 open → 0 open')
    expect(statusText(all)).toContain('open per round: 5 open → 2 open → 0 open')
    const scored = rounds('review', [{ score: 6.5 }, { score: 8, verdict: 'ship' }])
    expect(historyText(scored['PR-42']!)).toBe('6.5 → 8.0')
    expect(statusText(scored)).toContain('scores: 6.5 → 8.0 (+1.5)')
  })

  test('not converging at the limit; the next round is refused with the pass word', () => {
    const all = rounds('plan', [{ items: [{ text: 'a', priority: 'p0' }] }, {}])
    expect(statusText(all)).toContain('not converging: surface to the user. Do not run another validation pass; report the open items')
    const out = applyCycle(all, cycleInputOf({ subject: 'PR-42' }), {}, T0 + 9)
    expect(!out.ok && out.reply).toContain('Not recorded: round 3 is past the limit of 2')
    expect(!out.ok && out.reply).toContain('Do not run another validation pass')
  })

  test('every kind names its pass in the limit message and the not-converging line', () => {
    const words: Record<string, string> = { critic: 'critic pass', review: 'review round', plan: 'validation pass', qa: 'test run', copy: 'edit pass', design: 'design review' }
    for (const [kind, word] of Object.entries(words)) {
      const max = kind === 'plan' ? 2 : kind === 'review' || kind === 'qa' || kind === 'copy' ? 3 : 4
      const all = rounds(kind, Array.from({ length: max }, () => ({ score: 5, items: [{ text: 'z', priority: 'p0' }] })), 's')
      expect(statusText(all)).toContain(`Do not run another ${word}`)
      const out = applyCycle(all, cycleInputOf({ subject: 's', score: 5 }), {}, T0 + 99)
      expect(!out.ok && out.reply).toContain(`Do not run another ${word}`)
    }
  })

  test('target ignored for an items kind', () => {
    const out = applyCycle({}, cycleInputOf({ subject: 's', kind: 'plan', target: 8 }), {}, T0)
    expect(out.ok && out.warnings.join(' ')).toContain('target ignored')
  })
})

describe('items kinds: band and log', () => {
  test('band reads round n/max with the p0 count only when there is one', () => {
    const withP0 = rounds('review', [{ items: [{ text: 'a', priority: 'p0' }, { text: 'b', priority: 'p1' }, { text: 'c', priority: 'p2' }] }, {}])
    expect(bandOf(withP0)).toEqual({
      chips: [
        { text: 'PR-42 round 2/3', tone: 'info' },
        { text: '3 open', tone: 'warn' },
      ],
      right: ['1 p0'],
    })
    const noP0 = rounds('review', [{ items: [{ text: 'b', priority: 'p1' }] }])
    expect(bandOf(noP0)).toEqual({ chips: [{ text: 'PR-42 round 1/3', tone: 'info' }, { text: '1 open', tone: 'warn' }], right: [] })
    const minor = rounds('review', [{ items: [{ text: 'c', priority: 'p2' }] }])
    expect(bandOf(minor)?.chips[1]).toEqual({ text: '1 open', tone: 'muted' })
    const done = rounds('review', [{}])
    expect(bandOf(done)).toEqual({ chips: [{ text: 'PR-42 round 1/3', tone: 'ok' }, { text: '0 open', tone: 'muted' }], right: [] })
    const bad = rounds('plan', [{ items: [{ text: 'a', priority: 'p0' }] }, {}])
    expect(bandOf(bad)).toEqual({
      chips: [
        { text: 'PR-42 round 2/2', tone: 'danger' },
        { text: '1 open', tone: 'warn' },
      ],
      right: ['1 p0', 'not converging'],
    })
  })

  test('band right side counts the other active subjects', () => {
    const two = { ...run([7.1]), ...rounds('review', [{}]) }
    const band = bandOf(two)
    expect(band?.right[band.right.length - 1]).toBe('+1 more')
  })

  test('jsonl: kind, doneBy, score null and target null for items kinds', () => {
    const s = rounds('review', [{ items: ['a'] }])['PR-42']!
    const line = JSON.parse(jsonlLine(s, s.cycles[0]!, 'sess'))
    expect(line).toMatchObject({ kind: 'review', doneBy: 'items', score: null, target: null, reached: false, open: 1 })
  })
})

describe('stored subjects', () => {
  test('old subjects without kind load as critic/score; nothing malformed throws', () => {
    const old = { name: 'old', target: 8, maxCycles: 3, cycles: [{ cycle: 1, score: 7, at: 5 }, { cycle: 2, at: 6 }, 'junk'], items: [], status: 'active', updatedAt: 9 }
    const got = subjectsFrom({ old, bad: { kind: 42, doneBy: {}, cycles: [null, { cycle: 'x' }], target: 'zz' }, junk: 5 }, {})
    expect(got.old).toMatchObject({ kind: 'critic', doneBy: 'score', target: 8, maxCycles: 3 })
    expect(got.old!.cycles.length).toBe(1)
    expect(got.bad).toMatchObject({ kind: 'critic', doneBy: 'score', target: 9, maxCycles: 4 })
    expect(got.junk).toBeUndefined()
  })

  test('cycles without a score are valid for item kinds and survive a JSON round trip', () => {
    const all = rounds('review', [{ items: ['a'] }, { verdict: 'ship' }])
    const back = subjectsFrom(JSON.parse(JSON.stringify(all)), {})
    expect(back).toEqual(all)
    expect(back['PR-42']!.cycles.map(c => c.score)).toEqual([undefined, undefined])
  })
})

describe('names and keys', () => {
  test('the log file, the store prefix and the usage text carry the loopkeeper names', () => {
    expect(LOG_FILE).toBe('.claude/loopkeeper-review.jsonl')
    expect(SUBJECTS_PREFIX).toBe('loopkeeper:review:subjects:')
    expect(storeKeyOf('/work/project')).toBe('loopkeeper:review:subjects:/work/project')
    expect(storeKeyOf('')).toBe('loopkeeper:review:subjects:-')
    expect(USAGE).toContain('Usage: /reviews [text')
    expect(USAGE).not.toMatch(/\/review\b(?!s)/)
  })

  test('replies point the user to /reviews, never to the built-in /review', () => {
    const shipped = run([9.1], { verdict: 'ship' })
    const out = applyCycle(shipped, cycleInputOf({ subject: 'login_page', score: 9.3 }), D, T0 + 5)
    expect(!out.ok && out.reply).toContain('/reviews reopen login_page')
    const limit = applyCycle(run([7, 7, 7, 7]), cycleInputOf({ subject: 'login_page', score: 8 }), D, T0 + 9)
    expect(!limit.ok && limit.reply).toContain('/reviews max <n> login_page')
    expect(kindsText()).toContain('/reviews kind <subject> <kind>')
    for (const text of [statusText(shipped), kindsText(), USAGE]) expect(text).not.toMatch(/\/review\b(?!s)/)
  })
})

describe('config layer', () => {
  const KINDS_CONF = { critic: { target: 8, maxCycles: 2 }, plan: { maxCycles: 5 }, copy: { target: 7.5 } }

  test('kindDefaultsFrom keeps known kinds and valid numbers only', () => {
    expect(kindDefaultsFrom(KINDS_CONF)).toEqual(KINDS_CONF)
    expect(kindDefaultsFrom({ nope: { target: 5 }, qa: { target: 11, maxCycles: 0 }, review: 'x', design: { target: 'zz', maxCycles: 3 } })).toEqual({ design: { maxCycles: 3 } })
    expect(kindDefaultsFrom(null)).toEqual({})
    expect(kindDefaultsFrom([1, 2])).toEqual({})
  })

  test('precedence: preset < config kind < the /reviews override', () => {
    expect(presetFor('critic', {})).toEqual({ target: 9, maxCycles: 4 })
    expect(presetFor('critic', { kinds: KINDS_CONF })).toEqual({ target: 8, maxCycles: 2 })
    expect(presetFor('plan', { kinds: KINDS_CONF })).toEqual({ maxCycles: 5 })
    expect(presetFor('copy', { kinds: KINDS_CONF })).toEqual({ target: 7.5, maxCycles: 3 })
    expect(presetFor('critic', { kinds: KINDS_CONF, target: 9.5, maxCycles: 6 })).toEqual({ target: 9.5, maxCycles: 6 })
    // an item kind has no target of its own; a config target only matters if the first pass makes it a score loop
    const items = applyCycle({}, cycleInputOf({ subject: 'r', kind: 'review' }), { kinds: { review: { target: 8 } } }, T0)
    expect(items.ok && items.subject.target).toBeUndefined()
    const scored = applyCycle({}, cycleInputOf({ subject: 'r', kind: 'review', doneBy: 'score', score: 7 }), { kinds: { review: { target: 8 } } }, T0)
    expect(scored.ok && scored.subject.target).toBe(8)
  })

  test('a new subject starts with the config values, the first pass can still set its own', () => {
    const out = applyCycle({}, cycleInputOf({ subject: 's', score: 5 }), { kinds: KINDS_CONF }, T0)
    expect(out.ok && out.subject).toMatchObject({ kind: 'critic', target: 8, maxCycles: 2 })
    const own = applyCycle({}, cycleInputOf({ subject: 's', score: 5, target: 9.5, maxCycles: 7 }), { kinds: KINDS_CONF }, T0)
    expect(own.ok && own.subject).toMatchObject({ target: 9.5, maxCycles: 7 })
    const plan = applyCycle({}, cycleInputOf({ subject: 'p', kind: 'plan' }), { kinds: KINDS_CONF }, T0)
    expect(plan.ok && plan.subject).toMatchObject({ doneBy: 'items', maxCycles: 5 })
    expect(plan.ok && plan.subject.target).toBeUndefined()
  })

  test('the override beats the config; the config limit refuses the next round', () => {
    const over = applyCycle({}, cycleInputOf({ subject: 's', score: 5 }), { kinds: KINDS_CONF, maxCycles: 6 }, T0)
    expect(over.ok && over.subject.maxCycles).toBe(6)
    let all: Subjects = {}
    for (const score of [6, 7]) {
      const out = applyCycle(all, cycleInputOf({ subject: 's', score }), { kinds: KINDS_CONF }, T0)
      if (!out.ok) throw new Error(out.reply)
      all = { s: out.subject }
    }
    const refused = applyCycle(all, cycleInputOf({ subject: 's', score: 7.5 }), { kinds: KINDS_CONF }, T0 + 1)
    expect(!refused.ok && refused.reply).toContain('Not recorded: cycle 3 is past the limit of 2')
  })

  test('withKind and stored subjects use the config layer too', () => {
    const s = run([7]).login_page!
    expect(withKind(s, 'copy', { kinds: KINDS_CONF }, T0 + 1)).toMatchObject({ doneBy: 'score', target: 7.5, maxCycles: 3 })
    const got = subjectsFrom({ x: { name: 'x', kind: 'critic', cycles: [], items: [], target: 'bad', maxCycles: 'bad' } }, { kinds: KINDS_CONF })
    expect(got.x).toMatchObject({ target: 8, maxCycles: 2 })
  })

  test('the context block shows the limits and the target that apply', () => {
    const text = contextText({ kinds: KINDS_CONF })
    expect(text).toContain('Do not run more than maxCycles passes (critic 2, review 3, plan 5, qa 3)')
    expect(text).toContain('Score kinds aim for the target (default 8.0)')
    expect(contextText({ kinds: KINDS_CONF, maxCycles: 6, target: 9.5 })).toContain('(critic 6, review 6, plan 6, qa 6)')
  })
})
