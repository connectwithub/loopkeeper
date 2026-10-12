// pr-watch: PR and CI state for the current branch above the prompt, with a note to Claude
// when a check fails.
//
// session.start        loads config, registers /pr, starts the poll timer, finds the branch's PR
// classic.SessionStart after /clear, /resume or /branch ($.state was reset): the same again
// tool.call (Bash)     after `gh pr create`, `git push` or `gh pr merge`: finds the PR again;
//                      a push or create opens a 20 minute "hot" window of faster polling
// prompt.submit        a prompt that is only PR URLs is consumed ({ drop }) and they are watched
// command.run          /pr and its subcommands
// ui.render            the one-line band above the prompt and the /pr pane
//
// All gh work runs in the background (`void work($).catch(() => {})`): no turn waits on it.
// Helpers that take $ are top-level functions so static analysis can read them.
//
// Borrowed (MIT, Copyright (c) 2026 Seza Akgün, github.com/sezaakgun/cc-pr-tracker): the GraphQL
// poll and diff approach, the bare-URL { drop }, $.session.append for a failure note, attempt().

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Config, Snapshot, Watched } from '../types'
import { TONES, makeKit } from './kit'
import type { Elements, Tone } from './kit'
import {
  DEFAULTS,
  HELP,
  HOT_MS,
  ICON,
  VIEW_FIELDS,
  REVIEW_TONE,
  bandParts,
  bandText,
  bareUrls,
  countsOf,
  diff,
  durationOf,
  failureNote,
  graphqlArgv,
  isDiscoveryCommand,
  isDue,
  isNoPr,
  isPushCommand,
  levelOf,
  linkable,
  matchTarget,
  mergeConfig,
  mergeText,
  newWatched,
  parseCommand,
  parseGraphql,
  parsePrUrl,
  parsePrView,
  primaryOf,
  reviewText,
  summaryText,
  toastText,
} from './pr'
import type { PrRef, Transition } from './pr'

const PANE = 'pr-watch'
const CONFIG_FILE = '.claude/pr-watch.json'
const BAND_KEY = 'band'
/** The timer ticks this often and polls only when the cadence says a poll is due. */
const TICK_MS = 10_000
const GH_TIMEOUT_MS = 30_000

const prsAtom = atom({ plugin: 'lk-pr-watch', key: 'prs' } as const, [] as Watched[])
const configAtom = atom({ plugin: 'lk-pr-watch', key: 'config' } as const, DEFAULTS)
const bandAtom = atom({ plugin: 'lk-pr-watch', key: 'band' } as const, true)
const cwdAtom = atom({ plugin: 'lk-pr-watch', key: 'cwd' } as const, '')
const hotAtom = atom({ plugin: 'lk-pr-watch', key: 'hotUntil' } as const, 0)
const lastPollAtom = atom({ plugin: 'lk-pr-watch', key: 'lastPoll' } as const, 0)

type Api = EngineInterface
type Run = { exitCode: number; stdout: string; stderr: string }

// Module variables: lost on a reload, which is fine (session.start starts them again).
let timer: { cancel(): void } | undefined
let polling = false
const logged = new Set<string>()

/** Runs f; on failure logs once per name and resolves undefined (calls newer than a build). */
async function attempt<T>($: Api, what: string, f: () => Promise<T>): Promise<T | undefined> {
  try {
    return await f()
  } catch (err) {
    if (!logged.has(what)) {
      logged.add(what)
      try {
        $.ui.log(`pr-watch: ${what} unavailable: ${err instanceof Error ? err.message : String(err)}`)
      } catch {
        // nothing to tell
      }
    }
    return undefined
  }
}

async function run($: Api, argv: string[]): Promise<Run> {
  try {
    const cwd = await read($, cwdAtom)
    const r = await $.process.run(argv, cwd ? { cwd, timeoutMs: GH_TIMEOUT_MS } : { timeoutMs: GH_TIMEOUT_MS })
    return {
      exitCode: typeof r?.exitCode === 'number' ? r.exitCode : 1,
      stdout: typeof r?.stdout === 'string' ? r.stdout : '',
      stderr: typeof r?.stderr === 'string' ? r.stderr : '',
    }
  } catch (err) {
    return { exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
}

async function now($: Api): Promise<number> {
  try {
    const t = await $.clock.now()
    return typeof t === 'number' ? t : 0
  } catch {
    return 0
  }
}

async function readJsonFile($: Api, path: string): Promise<unknown> {
  try {
    if (!(await $.fs.exists(path))) return null
    return JSON.parse(String(await $.fs.read(path)))
  } catch {
    return null
  }
}

/** Defaults, then ~/.claude/pr-watch.json, then <cwd>/.claude/pr-watch.json. */
async function loadConfig($: Api): Promise<Config> {
  let home = ''
  try {
    home = String((await $.env.get('HOME')) ?? '')
  } catch {
    home = ''
  }
  const cwd = await read($, cwdAtom)
  const user = home ? await readJsonFile($, home.replace(/\/+$/, '') + '/' + CONFIG_FILE) : null
  const project = cwd ? await readJsonFile($, cwd.replace(/\/+$/, '') + '/' + CONFIG_FILE) : null
  const cfg = mergeConfig(user, project)
  await update($, configAtom, () => cfg)
  return cfg
}

async function loadBand($: Api): Promise<void> {
  try {
    const v = await $.store.get(BAND_KEY)
    await update($, bandAtom, () => v !== false)
  } catch {
    // keep what the band had
  }
}

/** Adds a PR, or upgrades a user-added one to the branch's. A new branch PR replaces the old one. */
async function upsert($: Api, ref: PrRef, source: Watched['source']): Promise<boolean> {
  let added = false
  await update($, prsAtom, (list: Watched[]) => {
    let out = source === 'branch' ? list.filter(p => p.source !== 'branch' || p.id === ref.id) : list
    const at = out.findIndex(p => p.id === ref.id)
    if (at < 0) {
      added = true
      out = [...out, newWatched(ref, source)]
    } else if (source === 'branch' && out[at].source !== 'branch') {
      out = out.map((p, i) => (i === at ? { ...p, source: 'branch' as const } : p))
    }
    return out
  })
  return added
}

/** Finds the current branch's PR with `gh pr view` and, unless told not to, polls it at once. */
async function discover($: Api, pollNow = true): Promise<void> {
  const r = await run($, ['gh', 'pr', 'view', '--json', VIEW_FIELDS])
  if (r.exitCode !== 0) {
    // No PR for this branch: stop showing the old branch's. Auth or network trouble: keep it.
    if (isNoPr(r.stderr)) await update($, prsAtom, (list: Watched[]) => list.filter(p => p.source !== 'branch'))
    return
  }
  const view = parsePrView(r.stdout)
  const ref = view ? parsePrUrl(view.url) : null
  if (!ref) return
  await upsert($, ref, 'branch')
  if (pollNow) await pollOne($, ref.id)
}

/** Finds PR <number> in the cwd's repo with `gh pr view <number>`. */
async function lookupNumber($: Api, n: number): Promise<PrRef | string> {
  const r = await run($, ['gh', 'pr', 'view', String(n), '--json', VIEW_FIELDS])
  if (r.exitCode !== 0) return r.stderr.trim() || `gh exited ${r.exitCode}`
  const view = parsePrView(r.stdout)
  const ref = view ? parsePrUrl(view.url) : null
  return ref ?? 'gh returned no PR'
}

/** Toasts the transitions config asks for and appends one note per newly failed check. */
async function announce($: Api, w: Watched, ts: Transition[]): Promise<void> {
  if (!ts.length) return
  const cfg = await read($, configAtom)
  const failed = ts.filter((t): t is Extract<Transition, { kind: 'failed' }> => t.kind === 'failed')
  for (const t of ts) {
    if (!cfg.notifyOn.includes(t.kind)) continue
    try {
      $.ui.toast(toastText(w, t), { timeoutMs: 8000 })
    } catch {
      // a toast is best effort
    }
  }
  if (cfg.appendNoteOnFailure) {
    for (const t of failed) {
      const text = failureNote(w, t.check)
      await attempt($, '$.session.append', () => $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }))
    }
  }
}

/** One GraphQL poll of one watched PR, diffed against the previous one. */
async function pollOne($: Api, id: string): Promise<void> {
  const before = (await read($, prsAtom)).find(p => p.id === id)
  if (!before) return
  const r = await run($, graphqlArgv(before))
  const t = await now($)
  const parsed = r.exitCode === 0 ? parseGraphql(r.stdout) : { error: r.stderr.trim() || `gh exited ${r.exitCode}` }
  let after: Watched | undefined
  let ts: Transition[] = []
  await update($, prsAtom, (list: Watched[]) =>
    list.map(p => {
      if (p.id !== id) return p
      if ('error' in parsed) {
        after = { ...p, error: parsed.error.slice(0, 200), polledAt: t }
      } else {
        ts = diff(p.snap, parsed.snap)
        after = { ...p, snap: parsed.snap, error: '', polledAt: t }
      }
      return after
    }),
  )
  if (after) await announce($, after, ts)
}

/** Polls every watched PR, one at a time; a second call while one runs returns at once. */
async function pollAll($: Api): Promise<void> {
  if (polling) return
  polling = true
  try {
    const ids = (await read($, prsAtom)).map(p => p.id)
    for (const id of ids) await pollOne($, id)
  } finally {
    polling = false
    const t = await now($)
    await update($, lastPollAtom, () => t)
  }
}

/** The timer's tick: polls when the cadence (hot or normal) says a poll is due. */
async function tick($: Api): Promise<void> {
  const prs = await read($, prsAtom)
  if (!prs.length || polling) return
  const cfg = await read($, configAtom)
  const t = await now($)
  if (isDue(cfg, prs, t, await read($, hotAtom), await read($, lastPollAtom))) await pollAll($)
}

function startTimer($: Api): void {
  try {
    timer?.cancel()
  } catch {
    // an old timer from before a reload is already gone
  }
  timer = $.clock.every(TICK_MS, () => {
    void tick($).catch(() => {})
  })
}

async function setUp($: Api, cwd: string): Promise<void> {
  if (cwd) await update($, cwdAtom, () => cwd)
  await loadConfig($)
  await loadBand($)
  const t = await now($)
  // A fresh session (or one whose lastPoll predates this clock) counts from now.
  const last = await read($, lastPollAtom)
  if (!last || last > t) await update($, lastPollAtom, () => t)
}

function openUrl($: Api, url: string): void {
  void (async () => {
    const r = await run($, ['xdg-open', url])
    if (r.exitCode !== 0) {
      const mac = await run($, ['open', url])
      if (mac.exitCode !== 0) $.ui.toast(`pr-watch: could not open ${url}`)
    }
  })().catch(() => {})
}

function copyUrl($: Api, url: string, surface?: 'terminal' | 'desktop' | 'vscode' | 'mobile'): void {
  void (async () => {
    // $.ui.copy arrived in 2.1.289: on an older build the call fails and attempt() says so once
    const res = await attempt($, '$.ui.copy', () => $.ui.copy(surface ? { text: url, surface } : { text: url }))
    $.ui.toast(res?.isCopied ? `Copied ${url}` : `Could not copy (needs Claude Code 2.1.289+): ${url}`, { timeoutMs: 3000 })
  })().catch(() => {})
}

async function removeIds($: Api, ids: string[]): Promise<void> {
  await update($, prsAtom, (list: Watched[]) => list.filter(p => !ids.includes(p.id)))
}

/** /pr and its subcommands. */
async function runCommand($: Api, args: string): Promise<{ text?: string }> {
  const cmd = parseCommand(args)
  if (cmd.kind === 'open') {
    await $.ui.open({ id: PANE, title: 'PR watch', focus: true, closeOnEscape: true })
    return {}
  }
  if (cmd.kind === 'text') return { text: summaryText(await read($, prsAtom), await now($)) }
  if (cmd.kind === 'refresh') {
    await discover($, false)
    await pollAll($)
    const n = (await read($, prsAtom)).length
    return { text: n ? `Refreshed ${n} PR${n === 1 ? '' : 's'}.` : 'No PR found for this branch, and none watched.' }
  }
  if (cmd.kind === 'add' || cmd.kind === 'add-number') {
    const ref = cmd.kind === 'add' ? cmd.ref : await lookupNumber($, cmd.number)
    if (typeof ref === 'string') return { text: `pr-watch: could not find PR #${cmd.kind === 'add-number' ? cmd.number : ''}: ${ref}` }
    const added = await upsert($, ref, 'user')
    await pollOne($, ref.id)
    const w = (await read($, prsAtom)).find(p => p.id === ref.id)
    return { text: `${added ? 'Watching' : 'Already watching'} ${ref.id}${w ? `: ${bandText(w)}` : ''}` }
  }
  if (cmd.kind === 'rm') {
    const hit = matchTarget(await read($, prsAtom), cmd.target)
    if (!hit.length) return { text: `pr-watch: no watched PR matches "${cmd.target}".` }
    await removeIds($, hit.map(p => p.id))
    return { text: `Stopped watching ${hit.map(p => p.id).join(', ')}.` }
  }
  if (cmd.kind === 'band') {
    await attempt($, '$.store.set', () => $.store.set(BAND_KEY, cmd.on))
    await update($, bandAtom, () => cmd.on)
    return { text: cmd.on ? 'PR band shown above the prompt.' : 'PR band hidden.' }
  }
  return { text: `${cmd.reason} ${HELP}` }
}

type SurfaceName = 'terminal' | 'desktop' | 'vscode' | 'mobile'
type PrState = 'open' | 'draft' | 'merged' | 'closed' | 'failing'

const STATE_TONE: Record<PrState, Tone> = { open: 'info', draft: 'muted', merged: 'ok', closed: 'muted', failing: 'danger' }
/** Secondary text: the theme's quiet key. */
const QUIET = TONES.muted.fg

/** open, draft, merged, closed, or failing (open with a failed check). */
function stateOf(s: Snapshot): PrState {
  if (s.state === 'MERGED') return 'merged'
  if (s.state === 'CLOSED') return 'closed'
  if (countsOf(s).fail > 0) return 'failing'
  return s.isDraft ? 'draft' : 'open'
}

/** 'polled just now', 'polled 40s ago', 'polled 5m ago', 'polled 2h ago', 'not polled yet' (clock times). */
function ageText(polledAt: number, at: number): string {
  if (!polledAt) return 'not polled yet'
  const s = Math.max(0, Math.round((at - polledAt) / 1000))
  if (s < 10) return 'polled just now'
  if (s < 60) return `polled ${s}s ago`
  if (s < 3600) return `polled ${Math.floor(s / 60)}m ago`
  return `polled ${Math.floor(s / 3600)}h ago`
}

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    try {
      await setUp($, typeof e.cwd === 'string' ? e.cwd : '')
    } catch {
      // defaults stay
    }
    try {
      startTimer($)
    } catch {
      // no polling, the commands still work
    }
    void discover($).catch(() => {})
    try {
      await $.command.register({
        name: 'pr',
        description: 'PR watch: open the pane, or add, rm, refresh, band on|off, text',
        argumentHint: '[add <url|number> | rm <number> | refresh | band on|off | text]',
        immediate: true,
      })
    } catch {
      // the name is taken: the band and the notes still work
    }
    return next(e)
  })

  // /clear, /resume and /branch reset $.state without a session.start
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try {
      await setUp($, typeof e.cwd === 'string' ? e.cwd : '')
    } catch {
      // defaults stay
    }
    void discover($).catch(() => {})
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    try {
      const command = typeof e.command === 'string' ? e.command : ''
      if (!('deny' in r && r.deny) && isDiscoveryCommand(command)) {
        if (isPushCommand(command)) {
          const t = await now($)
          await update($, hotAtom, () => t + HOT_MS)
        }
        void discover($).catch(() => {})
      }
    } catch {
      // observing only
    }
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    let refs: PrRef[] = []
    try {
      refs = bareUrls(typeof e.text === 'string' ? e.text : '')
    } catch {
      refs = []
    }
    if (!refs.length) return next(e)
    const said: string[] = []
    for (const ref of refs) {
      let added = false
      try {
        added = await upsert($, ref, 'user')
      } catch {
        added = false
      }
      said.push(`${added ? 'watching' : 'already watching'} ${ref.id}`)
      void pollOne($, ref.id).catch(() => {})
    }
    return { drop: `pr-watch: ${said.join(', ')}` }
  })

  on('command.run', { command: 'pr' }, async ($, e) => {
    try {
      return await runCommand($, typeof e.args === 'string' ? e.args : '')
    } catch (err) {
      return { text: 'pr-watch: ' + (err instanceof Error ? err.message : String(err)) }
    }
  })

  // The band, one kit line: the PR number in bold, the checks, review and merge chips each in its own
  // tone, then the rest on the right side: in the default text color when the PR is urgent (a failed
  // check, changes requested, a conflict), else quiet (kit.line draws its right side quiet).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const band = await read($, bandAtom)
    const prs = await read($, prsAtom)
    const parts = band && !(e.props && e.props.hasSurvey) ? bandParts(prs) : null
    if (!parts) return next(e)
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const kit = makeKit(ui as unknown as Elements, e.surface)
    const right = parts.right.join(' · ')
    const drawn = (
      parts.urgent && right
        ? Box({
            flexDirection: 'row',
            justifyContent: 'space-between',
            columnGap: 2,
            children: [kit.line(parts.label, parts.chips) as ReturnType<typeof Box>, kit.text(right, { wrap: 'truncate' }) as ReturnType<typeof Box>],
          })
        : kit.line(parts.label, parts.chips, parts.right)
    ) as ReturnType<typeof Box>
    const line = Box({ key: 'pr-watch-band', flexDirection: 'column', children: [drawn] })
    const theirs = await next(e)
    if (!theirs) return line
    return Box({ flexDirection: 'column', children: [line, theirs] })
  })

  // The pane, drawn with the kit: a hero for the branch's PR (else the first), tiles over every
  // watched PR, then one card per PR (state, checks bar, review, age, checks, buttons). A page:
  // one row between blocks; the cards are a list, one row apart, their rows tight.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const prs = await read($, prsAtom)
    const ui = $.ui.resolve(e)
    const { Link } = ui
    const kit = makeKit(ui as unknown as Elements, e.surface)
    const t = Date.now()
    const clockNow = await now($)
    const bottom = kit.buttons([
      { key: 'refresh', label: 'Refresh now', hotkey: 'r', plain: true, onPress: () => void (async () => { await discover($, false); await pollAll($) })().catch(() => {}) },
      { key: 'close', label: 'Close', hotkey: 'c', plain: true, onPress: () => $.ui.close({ id: PANE }) },
    ])
    const top = primaryOf(prs)
    if (!top) {
      return kit.page([
        kit.hero({ kicker: 'pull requests', title: 'No PR watched', sub: 'Push a branch with a PR, paste a PR URL, or run /pr add <url|number>.', tone: 'muted' }),
        bottom,
      ]) as never
    }

    const where = (w: Watched) => `${w.owner}/${w.repo} · ${w.source === 'branch' ? 'this branch' : 'added'}`
    const hero = kit.hero({
      kicker: 'pull requests',
      title: `#${top.number} ${top.snap ? top.snap.title : ''}`.trim(),
      sub: `${top.snap ? stateOf(top.snap) : top.error ? 'gh failed' : 'loading…'} · ${where(top)}`,
      tone: top.snap ? levelOf(top.snap) : 'muted',
    })

    const open = prs.filter(w => w.snap?.state === 'OPEN')
    const all = prs.map(w => countsOf(w.snap))
    const total = all.reduce((n, c) => n + c.total, 0)
    const passing = all.reduce((n, c) => n + c.pass, 0)
    const failing = all.reduce((n, c) => n + c.fail, 0)
    const awaiting = open.filter(w => w.snap?.reviewDecision === 'REVIEW_REQUIRED').length
    const tiles = kit.tiles([
      { label: 'Open', value: String(open.length), tone: open.length ? 'info' : 'muted' },
      { label: 'Checks passing', value: `${passing}/${total}`, tone: total && passing === total ? 'ok' : 'muted' },
      { label: 'Failing', value: String(failing), tone: failing ? 'danger' : 'muted' },
      { label: 'Awaiting review', value: String(awaiting), tone: awaiting ? 'warn' : 'muted' },
    ])

    const cards = prs.map(w => {
      const s = w.snap
      const children: unknown[] = []
      const state = s ? stateOf(s) : w.error ? 'gh failed' : 'loading'
      children.push(
        kit.row({
          left: [kit.pill(state, s ? STATE_TONE[state as PrState] : w.error ? 'danger' : 'muted'), kit.text(`#${w.number} ${s ? s.title : ''}`.trim(), { bold: true, wrap: 'truncate-end' })],
          right: where(w),
          align: 'center',
        }),
      )
      if (!s) {
        if (w.error) children.push(kit.text(`gh failed: ${w.error}`, { color: QUIET, wrap: 'wrap' }))
      } else {
        const c = countsOf(s)
        children.push(
          c.total
            ? kit.row({
                left: [kit.bar(c.pass / c.total, { width: 20, tone: c.fail ? 'danger' : c.pending ? 'warn' : 'ok' }), kit.text(`${c.pass}/${c.total} checks`, { bold: true })],
                right: [c.fail ? `${c.fail} failing` : '', c.pending ? `${c.pending} running` : ''].filter(Boolean).join(' · '),
              })
            : kit.text('no checks reported', { color: QUIET }),
        )
        children.push(
          kit.row({
            left: [kit.pill(reviewText(s.reviewDecision), REVIEW_TONE[s.reviewDecision] ?? 'muted'), kit.text(`${mergeText(s)} · ${s.mergeStateStatus.toLowerCase()}`, { color: QUIET, wrap: 'truncate' })],
            right: ageText(w.polledAt, clockNow),
            align: 'center',
          }),
        )
        for (const c of s.checks) {
          const [icon, tone] = ICON[c.bucket] ?? (['?', 'muted'] as const)
          const d = durationOf(c, t)
          children.push(
            kit.row({
              key: `check-${w.number}-${c.key}`,
              left: [
                kit.text(icon, { color: TONES[tone].fg }),
                linkable(c.link) ? Link({ href: c.link, label: c.name || '(unnamed)' }) : kit.text(c.name || '(unnamed)', { wrap: 'truncate-end' }),
              ],
              right: `${c.bucket}${d ? ` · ${d}` : ''}`,
            }),
          )
        }
        if (w.error) children.push(kit.text(`refresh failed: ${w.error}`, { color: TONES.danger.fg, wrap: 'wrap' }))
      }
      children.push(linkable(w.url) ? Link({ href: w.url, label: w.url }) : kit.text(w.url, { color: QUIET }))
      children.push(
        kit.buttons([
          { key: `open-${w.number}`, label: 'Open in browser', onPress: () => openUrl($, w.url) },
          { key: `copy-${w.number}`, label: 'Copy URL', onPress: (press?: unknown) => copyUrl($, w.url, (press as { surface?: SurfaceName } | undefined)?.surface) },
          { key: `rm-${w.number}`, label: 'Stop watching', onPress: () => removeIds($, [w.id]) },
        ]),
      )
      return kit.card({ children })
    })

    // the Watched header sits tight above its cards; the cards keep one row between them
    return kit.page([hero, tiles, kit.stack([kit.section(`Watched · ${prs.length}`), kit.list(cards)]), bottom]) as never
  })
}
