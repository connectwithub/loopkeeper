// Review concern: bounded review and critique cycles, visible and enforced. Ported from review-loop.
//
// - session.start: loads this folder's subjects from $.store (pruning those idle 14 days), reads the
//   config file's review section, registers the three tools and /reviews
// - review_cycle / review_item / review_status are answered here in tool.call; stage's wrapper around
//   review_cycle reads the reviewSubjects atom afterwards
// - every cycle is appended to <cwd>/.claude/loopkeeper-review.jsonl (only this concern ever read it)
// - prompt.context carries a short block with the tool contract and the rule
// - the band shows the active loop; /reviews opens a pane or prints text; /lk status adds a line
// - the hub (/lk) draws a Reviews row (hotkey 5); the pane leads with the nav bar of every loopkeeper pane

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { mergeConfigText } from './lib/config.ts'
import { TONES, makeKit } from './lib/kit.ts'
import type { Elements, Tone } from './lib/kit.ts'
import { TOOL_FULL, joinText, projectConfigPath, storeKey, subOf, userConfigPath } from './lib/names.ts'
import { HUB_ID, HUB_ROWS, PANES } from './lib/panes.ts'
import {
  CONTEXT_BLOCK,
  KIND_NAMES,
  LOG_FILE,
  SUBJECTS_PREFIX,
  USAGE,
  absOf,
  activeSubjects,
  applyCycle,
  applyItem,
  bandOf,
  blocking,
  contextText,
  cycleInputOf,
  cycleReply,
  cyclesLeft,
  defaultsLine,
  doneItems,
  findSubject,
  fmt,
  historyText,
  itemInputOf,
  jsonlLine,
  kindDefaultsFrom,
  kindOf,
  kindsText,
  lastCycle,
  nameOf,
  notConverging,
  notConvergingToast,
  openItems,
  parseArgs,
  progressText,
  prune,
  reached,
  reachedToast,
  scoresOf,
  sparkline,
  statusText,
  storeKeyOf,
  subjectText,
  subjectsFrom,
  targetOf,
  unitOf,
  usedCycles,
  validMax,
  validTarget,
  withKind,
} from './lib/reviewModel.ts'
import type { Defaults, Item, KindDefaults, Subject, Subjects } from './lib/reviewModel.ts'

const PANE_ID = 'loopkeeper-review'
const BAND_KEY = storeKey('review', 'band')
const CONTEXT_KEY = storeKey('review', 'context')
const DEFAULTS_KEY = storeKey('review', 'defaults')

// Declared by string literal: the same keys as in types/index.d.ts, and stage reads reviewSubjects.
const reviewSubjects = atom({ plugin: 'loopkeeper', key: 'reviewSubjects' } as const, {} as Subjects)
const reviewCwd = atom({ plugin: 'loopkeeper', key: 'reviewCwd' } as const, '')
const reviewBand = atom({ plugin: 'loopkeeper', key: 'reviewBand' } as const, true)
const reviewContext = atom({ plugin: 'loopkeeper', key: 'reviewContext' } as const, true)
// only what the user set with /reviews target and /reviews max; the rest comes from the config file or the kind
const reviewDefaults = atom({ plugin: 'loopkeeper', key: 'reviewDefaults' } as const, {} as Defaults)
// The config file's review.kinds, sanitised: per kind target and maxCycles. Plain module state, re-read at
// every session start, /clear, /resume and /lk reload, so it needs no atom in the state contract.
const mem: { kinds: KindDefaults } = { kinds: {} }

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Both config files, merged. Local on purpose: $ is never passed across an import. */
async function readConfig($: EngineInterface) {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  const cwd = (await $.session.cwd().catch(() => undefined)) ?? ''
  const textOf = async (path: string): Promise<string | null> => {
    try {
      return (await $.fs.exists(path)) ? await $.fs.read(path) : null
    } catch {
      return null
    }
  }
  const user = home ? await textOf(userConfigPath(home)) : null
  const project = cwd ? await textOf(projectConfigPath(cwd)) : null
  return mergeConfigText(user, project)
}

/** The user's store override with the config layer, as the model's functions take them. */
async function defaultsOf($: EngineInterface): Promise<Defaults> {
  return { ...(await read($, reviewDefaults)), kinds: mem.kinds }
}

async function statusLine($: EngineInterface): Promise<string> {
  const all = Object.values(await read($, reviewSubjects))
  return `review ● ${all.filter(s => s.status === 'active').length} active of ${all.length} subjects`
}

const CONCERN_WORDS = ['stage', 'gates', 'files', 'routing', 'review', 'decisions']

/** `/lk band [concerns] on|off`: the review line, or '' when the words name other concerns only. */
async function bandShared($: EngineInterface, rest: string[]): Promise<string> {
  const words = rest.map(w => w.toLowerCase())
  const named = words.filter(w => CONCERN_WORDS.includes(w))
  if (named.length > 0 && !named.includes('review')) return ''
  const word = words.find(w => w === 'on' || w === 'off')
  if (!word) {
    const shown = await read($, reviewBand)
    return `The review band is ${shown ? 'on' : 'off'}. Usage: /lk band [review] on|off`
  }
  await update($, reviewBand, () => word === 'on')
  try {
    await $.store.set(BAND_KEY, word === 'on')
  } catch {
    return `The review band is ${word}. (this session only)`
  }
  return `The review band is ${word}.`
}

/** /lk and /loopkeeper: review owns no words of its own there; it adds its line to status, reload and band. */
async function lk($: EngineInterface, e: { args: string }, next: (e: any) => Promise<{ text?: string } | undefined>) {
  const { sub, rest } = subOf(e.args)
  if (sub === 'band') {
    const after = await next(e)
    let line: string
    try {
      line = await bandShared($, rest)
    } catch {
      line = 'loopkeeper: review could not answer "band".'
    }
    return { ...(after ?? {}), text: joinText(line, after?.text) }
  }
  if (sub === 'status') {
    const after = await next(e)
    return { ...(after ?? {}), text: joinText(await statusLine($), after?.text) }
  }
  if (sub === 'reload') {
    const after = await next(e)
    let line: string
    try {
      const { config } = await readConfig($)
      const kinds = kindDefaultsFrom(config.review.kinds)
      mem.kinds = kinds
      const n = Object.keys(kinds).length
      line = `review ● config reloaded: ${n} kind override${n === 1 ? '' : 's'}`
    } catch {
      line = 'review ● config not reloaded'
    }
    return { ...(after ?? {}), text: joinText(line, after?.text) }
  }
  return next(e)
}

const TOOLS = [
  {
    name: 'review_cycle',
    description:
      'Record one pass of a bounded loop (critic pass, code review round, plan validation, test run, copy edit, design review) ' +
      'for a subject (an asset name, a PR, a plan, a file set) and get its loop state back: cycle n/max, history, whether it is ' +
      'done, passes left and open items. Call it right after each pass. "kind" (first pass only, default critic) sets the rules: ' +
      'critic (score, target 9.0, 4 passes), design (score, 9.0, 4), copy (score, 8.5, 3), review (items, 3 rounds), plan ' +
      '(items, 2 passes), qa (items, 3 runs). Score kinds need "score" out of 10 and are done when it reaches the target; item ' +
      'kinds ("score" optional) are done when no p0 or p1 item is open. Leave "cycle" out to use the next number. List the ' +
      'findings in "items"; items carry over between cycles until marked done. kind, target and maxCycles count only on the ' +
      'first pass of a subject; afterwards only the user changes them. A pass past maxCycles is refused: when the reply says ' +
      '"not converging", stop iterating and surface to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'What is under review: asset name, PR, or file set' },
        cycle: { type: 'number', description: 'Cycle number, 1-based; omit to auto-increment' },
        kind: { type: 'string', enum: ['critic', 'review', 'plan', 'qa', 'copy', 'design'], description: 'What kind of loop this is (default critic); first pass only' },
        doneBy: { type: 'string', enum: ['score', 'items'], description: 'Override how the kind is done; first pass only' },
        score: { type: 'number', description: 'Score from 0 to 10; required for score kinds (critic, copy, design), optional for item kinds' },
        target: { type: 'number', description: 'Score that counts as done (kind default, 9.0 for critic); score kinds, first pass only' },
        maxCycles: { type: 'number', description: 'Most passes allowed (kind default, 4 for critic); first pass only' },
        verdict: { type: 'string', enum: ['ship', 'iterate', 'stop'], description: 'The reviewer verdict; consistent, pass, lgtm, approved also mean ship, and issues, needs-work, red, failing mean iterate' },
        items: {
          type: 'array',
          description: 'Prioritized findings or fixes from the pass',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              priority: { type: 'string', enum: ['p0', 'p1', 'p2'] },
              done: { type: 'boolean' },
            },
            required: ['text'],
          },
        },
        notes: { type: 'string', description: 'One or two lines from the critique worth keeping' },
      },
      required: ['subject'],
    },
  },
  {
    name: 'review_item',
    description:
      'Add an open item to a review subject, or close one with done: true and a proof (a file path, a command output ' +
      'excerpt, or a commit). Closing without proof is allowed but is shown as "(no proof)". done: false reopens an item.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'The review subject' },
        text: { type: 'string', description: 'The item text; when closing, the full text or a unique part of it' },
        done: { type: 'boolean', description: 'true closes the item, false reopens it' },
        proof: { type: 'string', description: 'Evidence the fix landed' },
        priority: { type: 'string', enum: ['p0', 'p1', 'p2'] },
      },
      required: ['subject', 'text'],
    },
  },
  {
    name: 'review_status',
    description: 'Show the review loop state of one subject, or of every subject in this project when "subject" is left out.',
    inputSchema: {
      type: 'object',
      properties: { subject: { type: 'string', description: 'The review subject; omit for all' } },
    },
  },
] as const

// ---------- the hub and the nav bar

// HUB_ID, HUB_ROWS and PANES (every loopkeeper pane in wiring order) come from lib/panes.ts.

// the "ctrl+x tab to focus the panel" toast showed this session (stage.ts's atom, shared by all six concern files)
const stageFocusHinted = atom({ plugin: 'loopkeeper', key: 'stageFocusHinted' } as const, false)

// Switch panes: close `fromId` first ('' closes nothing), since a focus request is refused while the person holds a
// pane, then open `toId` with the focus. The composer keeps the focus while it holds a draft: then a toast says how to
// reach the pane, once a session and only in the terminal (the press's `surface`; with no press, a session whose every
// surface is the terminal). False when the pane could not be opened.
async function switchTo($: EngineInterface, fromId: string, toId: string, title: string, surface?: unknown): Promise<boolean> {
  if (fromId) {
    try {
      await $.ui.close({ id: fromId })
    } catch {
      // already closed
    }
  }
  try {
    await $.ui.open({ id: toId, title, focus: true, closeOnEscape: true, ...(toId === HUB_ID ? { rows: HUB_ROWS } : {}) })
  } catch {
    return false
  }
  try {
    const pane = (await $.ui.panes()).find(p => p.id === toId)
    if (pane && !pane.isFocused && !(await read($, stageFocusHinted))) {
      const terminal = typeof surface === 'string' ? surface === 'terminal' : (await $.session.surfaces()).every(s => s === 'terminal')
      if (terminal) {
        await update($, stageFocusHinted, () => true)
        toast($, 'ctrl+x tab to focus the panel')
      }
    }
  } catch {
    // no list: no hint
  }
  return true
}

// The nav bar's items: every loopkeeper pane, a press switching from `fromId` to it
function navItems($: EngineInterface, fromId: string) {
  return PANES.map(p => ({
    key: p.key,
    label: p.label,
    hotkey: p.hotkey,
    onPress: async (e?: { surface?: unknown }) => {
      if (!(await switchTo($, fromId, p.id, p.title, e?.surface))) toast($, 'Could not open the ' + p.label + ' pane.')
    },
  }))
}

/** The hub row's words: the status line without its label (`1 active of 2 subjects`), and `band off` when hidden. */
async function hubWords($: EngineInterface): Promise<string> {
  const all = Object.values(await read($, reviewSubjects))
  const words = [`${all.filter(s => s.status === 'active').length} active of ${all.length} subjects`]
  if (!(await read($, reviewBand))) words.push('band off')
  return words.join(' · ')
}

export function wireReview(on: On): void {
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    await load($)
    for (const tool of TOOLS) {
      try {
        await $.tool.register({ ...tool, inputSchema: tool.inputSchema as any, isDeferred: false })
      } catch (err) {
        note($, `${tool.name} not registered: ${messageOf(err)}`)
      }
    }
    try {
      await $.command.register({
        name: 'reviews',
        description: 'Review loops: pane, or text | clear | kinds | kind | target | max | ship | reopen | stop | band | context',
        argumentHint: '[text | clear <subject> | kinds | kind <subject> <kind> | target <n> [subject] | max <n> [subject] | band on|off]',
        immediate: true,
      })
    } catch (err) {
      note($, '/reviews not registered: ' + messageOf(err))
    }
    return next(e)
  })

  // /clear, /resume and /branch reset $.state without a new session.start
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await load($)
    return next(e)
  }).catch(async () => ({}))

  on('tool.call', { tool: TOOL_FULL.reviewCycle }, async ($, e) => ({ result: await onCycle($, e) })).catch(
    async () => ({ result: 'Not recorded: loopkeeper review failed while recording the cycle.' }),
  )
  on('tool.call', { tool: TOOL_FULL.reviewItem }, async ($, e) => ({ result: await onItem($, e) })).catch(
    async () => ({ result: 'Not changed: loopkeeper review failed while updating the item.' }),
  )
  on('tool.call', { tool: TOOL_FULL.reviewStatus }, async ($, e) => {
    const name = nameOf((e as { subject?: unknown } | undefined)?.subject)
    return { result: statusText(await read($, reviewSubjects), name || undefined) }
  }).catch(async () => ({ result: 'loopkeeper: review could not read its state.' }))

  on('command.run', { command: 'reviews' }, async ($, e) => {
    try {
      return await onCommand($, e?.args)
    } catch (err) {
      return { text: 'loopkeeper: ' + messageOf(err) }
    }
  }).catch(async () => ({ text: 'loopkeeper: review could not run the command.' }))
  on('command.run', { command: 'lk' }, async ($, e, next) => lk($, e, next)).catch(async () => ({ text: 'loopkeeper: review could not run the command.' }))
  on('command.run', { command: 'loopkeeper' }, async ($, e, next) => lk($, e, next)).catch(async () => ({ text: 'loopkeeper: review could not run the command.' }))

  on('prompt.context', async ($, e, next) => {
    const below = await next(e)
    try {
      const blocks = Array.isArray(below?.blocks) ? below.blocks.filter(b => b?.name !== CONTEXT_BLOCK) : []
      if (!(await read($, reviewContext))) return { ...below, blocks }
      const text = contextText(await defaultsOf($))
      return { ...below, blocks: [...blocks, { name: CONTEXT_BLOCK, text }] }
    } catch {
      return below
    }
  })

  // The band: one kit line, `review  ● login_page cycle 3/4  ● 2 open   8.4 → 9.0` (bandOf names the tones).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const isOn = await read($, reviewBand)
    const band = isOn && !e?.props?.hasSurvey ? bandOf(await read($, reviewSubjects)) : null
    if (!band) return next(e)
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const kit = makeKit(ui as unknown as Elements, e.surface)
    const line = kit.line('review', band.chips, band.right) as never
    // Keep what the mods after this one draw in the band, under this line.
    const theirs = await next(e)
    if (!theirs) return line
    return Box({ flexDirection: 'column', children: [line, theirs] })
  })

  // The hub's Reviews row, above the later concerns' rows (next): `5: Reviews` and the status words, quiet. It
  // shows with the band off; a failure draws what the chain drew.
  on('ui.render', { component: 'Pane', requestId: HUB_ID }, async ($, e, next) => {
    let asked = false
    let theirs: unknown = null
    try {
      const ui = $.ui.resolve(e) as unknown as Elements
      const kit = makeKit(ui, e.surface)
      const row = kit.row({
        key: 'hub-reviews',
        left: [
          ui.Button({
            key: 'panel-reviews',
            label: 'Reviews',
            hotkey: '5',
            plain: true,
            onPress: async (press?: { surface?: unknown }) => {
              if (!(await switchTo($, HUB_ID, PANE_ID, 'Review loops', press?.surface))) toast($, 'Could not open the Reviews pane.')
            },
          }),
          kit.text(await hubWords($), { color: TONES.muted.fg, wrap: 'truncate' }),
        ],
      })
      asked = true
      theirs = await next(e)
      return (theirs === null || theirs === undefined ? row : kit.stack([row, theirs])) as never
    } catch {
      return (asked ? theirs : await next(e)) as never
    }
  })

  // The pane, drawn with the kit: the nav bar, a hero for the selected subject (the band's, else the newest),
  // a score gauge or an items bar, the cycle strip, tiles, the items, the other subjects, buttons.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    if (e?.requestId !== PANE_ID) return next(e)
    const ui = $.ui.resolve(e)
    const kit = makeKit(ui as unknown as Elements, e.surface)
    const el = ui as unknown as Elements
    // kit v3: a piece that keeps its width beside wrapping text, and a full-width Svg bar where the surface draws Svg
    const keep = (child: unknown) => el.Box({ flexShrink: 0, children: [child] })
    const svgBars = e.surface !== 'terminal' && typeof el.Svg === 'function'
    const all = await read($, reviewSubjects)
    const subjects = Object.values(all).sort((a, b) => b.updatedAt - a.updatedAt)
    const defaults = await read($, reviewDefaults)
    const closePane = {
      key: 'close',
      label: 'Close pane',
      hotkey: 'c',
      plain: true,
      onPress: async () => {
        try {
          await $.ui.close({ id: PANE_ID })
        } catch {
          // already closed
        }
      },
    }
    const subjectButtons = (s: Subject) => [
      { key: 'ship:' + s.name, label: 'Mark shipped', plain: true, onPress: async () => void (await setStatus($, s.name, 'ship')) },
      { key: 'reopen:' + s.name, label: 'Reopen', plain: true, onPress: async () => void (await setStatus($, s.name, 'active')) },
      { key: 'stop:' + s.name, label: 'Close', plain: true, onPress: async () => void (await setStatus($, s.name, 'stop')) },
    ]

    // the nav bar leads every drawing of the pane
    const nav = kit.nav(navItems($, PANE_ID), 'reviews')

    const s = activeSubjects(all)[0] ?? subjects[0]
    if (!s) {
      return kit.page([
        nav,
        kit.hero({ kicker: 'review loop', title: 'No reviews yet', sub: 'Claude records one with review_cycle after each pass.', tone: 'muted' }),
        kit.text(defaultsLine(defaults), { color: TONES.muted.fg }),
        kit.buttons([closePane]),
      ]) as never
    }

    const last = lastCycle(s)
    const used = usedCycles(s)
    const unit = unitOf(s)
    const open = openItems(s)
    const p0 = open.filter(i => i.priority === 'p0').length
    const isDone = reached(s)
    const state = stateOf(s)
    const heroTone: Tone = isDone || s.status === 'ship' ? 'ok' : notConverging(s) ? 'danger' : s.status === 'stop' ? 'muted' : 'info'
    const sub =
      `${unit} ${used}/${s.maxCycles} · ` +
      (s.doneBy === 'score' ? `target ${fmt(targetOf(s))}` : `${p0 ? `${p0} p0 · ` : ''}${open.length} open`) +
      (state === 'active' ? '' : ` · ${state}`)

    // Score kinds: the last score as a gauge out of 10. Item kinds: how many items are closed. On Svg surfaces the
    // bar is kit.progress, full width, above its figure; the terminal keeps the text bar beside it.
    const meter = (ratio: number, tone: Tone, figure: string, right: string): unknown =>
      svgBars
        ? kit.stack([kit.progress(ratio, { tone }), kit.row({ key: 'gauge', left: [kit.text(figure, { bold: true })], right })])
        : kit.row({ key: 'gauge', left: [kit.bar(ratio, { width: 20, tone }), kit.text(figure, { bold: true })], right })
    let gauge: unknown = null
    if (s.doneBy === 'score') {
      const score = last?.score
      gauge =
        score === undefined
          ? kit.text('no scores yet', { color: TONES.muted.fg })
          : meter(score / 10, score >= targetOf(s) ? 'ok' : 'warn', fmt(score), `target ${fmt(targetOf(s))}`)
    } else if (s.items.length) {
      const closed = s.items.length - open.length
      gauge = meter(closed / s.items.length, blocking(s) ? 'warn' : 'ok', `${closed}/${s.items.length} closed`, 'until no open p0/p1')
    }

    const spark = sparkline(scoresOf(s))
    const historyTone: Tone | null = isDone ? 'ok' : notConverging(s) ? 'danger' : null
    const strip = kit.row({
      key: 'cycles',
      left: Array.from({ length: Math.max(s.maxCycles, used) }, (_, n) => {
        const i = n + 1
        const tone: Tone = i < used ? 'ok' : i === used ? (s.status === 'active' && !isDone ? 'info' : 'ok') : 'muted'
        return kit.badge(circled(i), tone)
      }),
    })
    const history = kit.row({
      key: 'history',
      left: [kit.text(historyText(s), historyTone ? { color: TONES[historyTone].fg, wrap: 'truncate' } : { wrap: 'truncate' })],
      right: spark ? [kit.text(spark, { color: TONES.info.fg })] : undefined,
    })

    const verdict = last?.verdict
    const tiles = kit.tiles([
      { label: unit === 'round' ? 'Round' : 'Cycle', value: `${used}/${s.maxCycles}`, tone: notConverging(s) ? 'danger' : 'info' },
      s.doneBy === 'score'
        ? { label: 'Score', value: last?.score === undefined ? '–' : fmt(last.score), tone: isDone ? 'ok' : 'warn' }
        : { label: 'Open', value: String(open.length), tone: open.length ? 'warn' : 'ok' },
      s.doneBy === 'score'
        ? { label: 'Target', value: fmt(targetOf(s)), tone: 'muted' }
        : { label: 'P0', value: String(p0), tone: p0 ? 'danger' : 'muted' },
      { label: 'Verdict', value: verdict ?? '–', tone: verdict === 'ship' ? 'ok' : verdict === 'stop' ? 'danger' : verdict === 'iterate' ? 'warn' : 'muted' },
    ])

    const items = [...open, ...doneItems(s)]
    const itemRows: unknown[] = items.length
      ? items.map((i, n) =>
          kit.row({
            key: `item-${n}`,
            align: 'center',
            left: [
              keep(kit.pill(i.priority, PRIORITY_TONE[i.priority])),
              keep(kit.text(i.done ? '✓' : '○', i.done ? { color: TONES.ok.fg } : { color: TONES.muted.fg })),
              kit.text(i.text, i.done ? { color: TONES.muted.fg, wrap: 'wrap' } : { wrap: 'wrap' }),
            ],
            right: i.done ? i.proof ?? '(no proof)' : undefined,
          }),
        )
      : [kit.text('no items', { color: TONES.muted.fg })]

    const others = subjects.filter(o => o.name !== s.name)
    const otherRows = others.map(o => {
      const st = stateOf(o)
      return kit.stack([
        kit.row({
          key: 'subject-' + o.name,
          left: [kit.text(o.name, { bold: true, wrap: 'truncate' }), kit.text(o.kind, { color: TONES.muted.fg }), kit.badge(st, STATE_TONE[st])],
          right: progressText(o),
        }),
        kit.buttons(subjectButtons(o)),
      ])
    })

    // kit 3.1: the other subjects' blocks one row apart (list), each block tight inside
    return kit.page([
      nav,
      kit.hero({ kicker: 'review loop', title: `${s.name} · ${s.kind}`, sub, tone: heroTone }),
      gauge,
      strip,
      history,
      tiles,
      kit.stack([kit.section(`Items · ${items.length}`, open.length ? `${open.length} open` : 'none open'), ...itemRows]),
      kit.buttons(subjectButtons(s)),
      others.length ? kit.stack([kit.section(`Subjects · ${others.length}`), kit.list(otherRows)]) : null,
      kit.row({ left: [kit.text(defaultsLine(defaults), { color: TONES.muted.fg })], right: [kit.buttons([closePane])] }),
    ]) as never
  })
}

// ---------- drawing (pure) ----------

const PRIORITY_TONE: Record<Item['priority'], Tone> = { p0: 'danger', p1: 'warn', p2: 'muted' }

type State = 'active' | 'shipped' | 'stopped' | 'not converging'
const STATE_TONE: Record<State, Tone> = { active: 'info', shipped: 'ok', stopped: 'muted', 'not converging': 'danger' }

/** The word the pane uses for where a subject's loop stands. */
function stateOf(s: Subject): State {
  return s.status === 'ship' ? 'shipped' : s.status === 'stop' ? 'stopped' : notConverging(s) ? 'not converging' : 'active'
}

/** ① … ⑳ for 1 to 20, then (21) and up. */
function circled(n: number): string {
  return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : `(${n})`
}

// ---------- handlers ----------

async function onCycle($: EngineInterface, e: unknown): Promise<string> {
  const input = cycleInputOf(e)
  const now = await nowMs($)
  const outcome = applyCycle(await read($, reviewSubjects), input, await defaultsOf($), now)
  if (!outcome.ok) {
    if (outcome.reply.includes('past the limit')) toast($, `review ${input.subject}: cycle limit reached, surface to the user`)
    return outcome.reply
  }
  const s = outcome.subject
  await save($, s)
  await appendLog($, s, outcome.cycle)
  if (notConverging(s) && s.status === 'active') {
    toast($, notConvergingToast(s))
  } else if (reached(s) && s.status === 'active') {
    toast($, reachedToast(s))
  }
  return cycleReply(s, outcome.warnings)
}

async function onItem($: EngineInterface, e: unknown): Promise<string> {
  const outcome = applyItem(await read($, reviewSubjects), itemInputOf(e), await defaultsOf($), await nowMs($))
  if (!outcome.ok) return outcome.reply
  await save($, outcome.subject)
  return outcome.reply
}

async function onCommand($: EngineInterface, args: unknown): Promise<{ text?: string }> {
  const { verb, rest } = parseArgs(args)
  if (verb === '' || verb === 'open' || verb === 'pane') {
    try {
      await $.ui.open({ id: PANE_ID, title: 'Review loops', focus: true, closeOnEscape: true })
    } catch (err) {
      return { text: 'Could not open the pane: ' + messageOf(err) }
    }
    return {}
  }
  if (verb === 'text' || verb === 'status') {
    return { text: statusText(await read($, reviewSubjects), nameOf(rest.join(' ')) || undefined) }
  }
  if (verb === 'clear') {
    const name = nameOf(rest.join(' '))
    if (!name) return { text: 'Usage: /reviews clear <subject>' }
    const subjects = await read($, reviewSubjects)
    const s = findSubject(subjects, name)
    if (!s) return { text: statusText(subjects, name) }
    await update($, reviewSubjects, all => {
      const copy = { ...all }
      delete copy[s.name]
      return copy
    })
    await persist($)
    return { text: `Cleared ${s.name}.` }
  }
  if (verb === 'kinds') return { text: kindsText() }
  if (verb === 'kind') {
    const kind = kindOf(rest[rest.length - 1])
    const name = nameOf(rest.slice(0, -1).join(' '))
    if (!name || !kind) return { text: 'Usage: /reviews kind <subject> <kind>, where kind is ' + KIND_NAMES.join(', ') + '.' }
    const subjects = await read($, reviewSubjects)
    const s = findSubject(subjects, name)
    if (!s) return { text: statusText(subjects, name) }
    const changed = withKind(s, kind, await defaultsOf($), await nowMs($))
    await save($, changed)
    return { text: `${s.name} is now kind ${kind} (${changed.doneBy === 'score' ? `done by score, target ${fmt(changed.target ?? 0)}` : 'done by items'}, max ${changed.maxCycles}).\n\n${subjectText(changed)}` }
  }
  if (verb === 'target' || verb === 'max') {
    const isTarget = verb === 'target'
    const value = isTarget ? validTarget(rest[0]) : validMax(rest[0])
    if (value === undefined) {
      const d = await read($, reviewDefaults)
      return {
        text: isTarget
          ? `Default target is ${d.target !== undefined ? fmt(d.target) : 'set by kind (critic 9.0, copy 8.5, design 9.0)'}. Use /reviews target <0–10> [subject].`
          : `Default max is ${d.maxCycles !== undefined ? d.maxCycles : 'set by kind (critic 4, review 3, plan 2, qa 3, copy 3, design 4)'}. Use /reviews max <1–20> [subject].`,
      }
    }
    const name = nameOf(rest.slice(1).join(' '))
    if (name) {
      const s = findSubject(await read($, reviewSubjects), name)
      if (!s) return { text: statusText(await read($, reviewSubjects), name) }
      if (isTarget && s.doneBy === 'items') return { text: `${s.name} is kind ${s.kind}, done by items: it has no score target. Use /reviews kind ${s.name} critic to score it.` }
      const changed: Subject = { ...s, ...(isTarget ? { target: value } : { maxCycles: value }), updatedAt: await nowMs($) }
      await save($, changed)
      return { text: (isTarget ? `Target for ${s.name} is now ${fmt(value)}.` : `Max cycles for ${s.name} is now ${value}.`) + '\n\n' + subjectText(changed) }
    }
    const d = await read($, reviewDefaults)
    const saved: Defaults = isTarget ? { ...d, target: value } : { ...d, maxCycles: value }
    await update($, reviewDefaults, () => saved)
    $.ui.invalidate('prompt.context')
    try {
      await $.store.set(DEFAULTS_KEY, saved)
    } catch (err) {
      return { text: `Default ${verb} ${isTarget ? fmt(value) : value} for this session; not saved: ${messageOf(err)}` }
    }
    return {
      text: `Default ${verb} is now ${isTarget ? fmt(value) : value} for new ${isTarget ? 'score-kind ' : ''}subjects, over the kind presets. Existing subjects keep theirs; add a subject name to change one.`,
    }
  }
  if (verb === 'ship' || verb === 'reopen' || verb === 'stop') {
    const name = nameOf(rest.join(' '))
    if (!name) return { text: `Usage: /reviews ${verb} <subject>` }
    return { text: await setStatus($, name, verb === 'ship' ? 'ship' : verb === 'stop' ? 'stop' : 'active') }
  }
  if (verb === 'band' || verb === 'context') {
    const isBand = verb === 'band'
    const label = isBand ? 'Band' : 'Context block'
    const word = (rest[0] ?? '').toLowerCase()
    if (word !== 'on' && word !== 'off') {
      const isOn = isBand ? await read($, reviewBand) : await read($, reviewContext)
      return { text: `${label} is ${isOn ? 'on' : 'off'}. Use /reviews ${verb} on|off.` }
    }
    const isOn = word === 'on'
    if (isBand) await update($, reviewBand, () => isOn)
    else {
      await update($, reviewContext, () => isOn)
      $.ui.invalidate('prompt.context')
    }
    try {
      await $.store.set(isBand ? BAND_KEY : CONTEXT_KEY, isOn)
    } catch (err) {
      return { text: `${label} ${word} for this session; not saved: ${messageOf(err)}` }
    }
    return { text: `${label} ${word}.` }
  }
  return { text: USAGE }
}

/** Ship, reopen or stop a subject. Reopening at the cycle limit grants one more cycle. */
async function setStatus($: EngineInterface, name: string, status: Subject['status']): Promise<string> {
  const s = findSubject(await read($, reviewSubjects), name)
  if (!s) return statusText(await read($, reviewSubjects), name)
  const changed: Subject = { ...s, status, updatedAt: await nowMs($) }
  let extra = ''
  if (status === 'active' && cyclesLeft(changed) === 0 && !reached(changed)) {
    changed.maxCycles = usedCycles(changed) + 1
    extra = ` with one more cycle (max ${changed.maxCycles})`
  }
  await save($, changed)
  const word = status === 'ship' ? 'Marked shipped' : status === 'stop' ? 'Closed' : 'Reopened'
  return `${word}: ${s.name}${extra}.`
}

// ---------- state, store and log ----------

/** Logs a dim line in the transcript, never throwing. */
function note($: EngineInterface, text: string): void {
  try {
    const r: unknown = $.ui.log('loopkeeper: ' + text)
    if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(undefined, () => {})
  } catch {
    // nothing to do
  }
}

/** Shows a toast, never throwing. */
function toast($: EngineInterface, text: string): void {
  try {
    const r: unknown = $.ui.toast(text, { timeoutMs: 6000 })
    if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(undefined, () => {})
  } catch {
    // nothing to do
  }
}

async function nowMs($: EngineInterface): Promise<number> {
  try {
    const ms = Number(await $.clock.now())
    if (Number.isFinite(ms) && ms > 0) return ms
  } catch {
    // fall back to the wall clock
  }
  return Date.now()
}

async function storeGet($: EngineInterface, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch {
    return undefined
  }
}

/** Loads settings and this folder's subjects into $.state, pruning old ones in every project. */
async function load($: EngineInterface): Promise<void> {
  let cwd = ''
  try {
    cwd = String((await $.session.cwd()) ?? '')
  } catch {
    cwd = ''
  }
  await update($, reviewCwd, () => cwd)
  const band = await storeGet($, BAND_KEY)
  await update($, reviewBand, () => band !== false)
  const context = await storeGet($, CONTEXT_KEY)
  await update($, reviewContext, () => context !== false)
  const rawDefaults = (await storeGet($, DEFAULTS_KEY)) as { target?: unknown; maxCycles?: unknown } | undefined
  const rawTarget = validTarget(rawDefaults?.target)
  const rawMax = validMax(rawDefaults?.maxCycles)
  const override: Defaults = { ...(rawTarget !== undefined ? { target: rawTarget } : {}), ...(rawMax !== undefined ? { maxCycles: rawMax } : {}) }
  await update($, reviewDefaults, () => override)
  // the config files' per-kind layer; a broken file leaves the presets
  let kinds: KindDefaults = {}
  try {
    kinds = kindDefaultsFrom((await readConfig($)).config.review.kinds)
  } catch {
    kinds = {}
  }
  mem.kinds = kinds
  const defaults: Defaults = { ...override, kinds }

  const now = await nowMs($)
  const mine = storeKeyOf(cwd)
  let keys: string[] = [mine]
  try {
    const all = await $.store.keys()
    if (Array.isArray(all)) keys = [...new Set([mine, ...all.filter(k => typeof k === 'string' && k.startsWith(SUBJECTS_PREFIX))])]
  } catch {
    // only this folder
  }
  for (const key of keys) {
    const raw = await storeGet($, key)
    if (raw === undefined) continue
    const { kept, dropped } = prune(subjectsFrom(raw, defaults), now)
    if (key === mine) await update($, reviewSubjects, () => kept)
    try {
      if (!Object.keys(kept).length) await $.store.delete(key)
      else if (dropped.length) await $.store.set(key, kept)
    } catch {
      // pruning the store is best effort
    }
  }
}

/** Puts one subject in $.state and mirrors this folder's subjects to $.store. */
async function save($: EngineInterface, s: Subject): Promise<void> {
  await update($, reviewSubjects, all => {
    const copy = { ...all }
    const old = findSubject(copy, s.name)
    if (old && old.name !== s.name) delete copy[old.name]
    copy[s.name] = s
    return copy
  })
  await persist($)
}

async function persist($: EngineInterface): Promise<void> {
  try {
    const cwd = await read($, reviewCwd)
    const subjects = await read($, reviewSubjects)
    if (Object.keys(subjects).length) await $.store.set(storeKeyOf(cwd), subjects)
    else await $.store.delete(storeKeyOf(cwd))
  } catch (err) {
    note($, 'not saved to the store: ' + messageOf(err))
  }
}

/** Appends one line to <cwd>/.claude/loopkeeper-review.jsonl; silent when it cannot. */
async function appendLog($: EngineInterface, s: Subject, c: Subject['cycles'][number]): Promise<void> {
  try {
    const cwd = await read($, reviewCwd)
    if (!cwd) return
    const path = absOf(cwd, LOG_FILE)
    let session = 'unknown'
    try {
      const id = await $.session.id()
      if (typeof id === 'string' && id) session = id
    } catch {
      // keep unknown
    }
    let existing = ''
    if ((await $.fs.exists(path)) === true) {
      const text: unknown = await $.fs.read(path)
      if (typeof text !== 'string') return
      existing = text
    }
    const sep = existing && !existing.endsWith('\n') ? '\n' : ''
    await $.fs.write(path, existing + sep + jsonlLine(s, c, session) + '\n')
  } catch {
    // skip silently: the log is a convenience
  }
}
