// lk-where-am-i: one line above the prompt with the repo, branch, worktree,
// dirtiness, the account's usage windows and the prompt-cache clock.
//
// session.start          registers /where, loads settings, starts the 60 s tick,
//                        refreshes git in the background
// classic.SessionStart   the same after /clear, /resume, /branch (state was reset)
// classic.CwdChanged     refreshes git when the session's directory moves
// turn.start/complete    marks the main loop busy; refreshes git after each turn
// turn.step              stamps the end of each main-loop model request (cache clock)
// session.measure        reads rateLimits and cost, one toast per window at 90%
// command.run            /where and its subcommands
// ui.render              the band (AbovePrompt) and the /where pane
//
// Observe only: every hook passes its event on unchanged, and every git call is
// capped, caught, and run in the background so no turn waits on it.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Location, RateWindow, Settings } from '../types'
import {
  DEFAULT_TTL_MIN,
  HELP,
  bandLine,
  countLines,
  folderOnly,
  isLinkedWorktree,
  basename,
  nextWarned,
  parseBranch,
  parseCount,
  parseDefaultBranch,
  parseLastCommit,
  parseRevParse,
  parseSha,
  parseWorktrees,
  repoName,
  sanitizeTtl,
  sanitizeWindows,
  summaryText,
  toastText,
} from './where'
import { TONES, makeKit } from './kit'
import type { Elements, Tone } from './kit'
import { cacheRow, locationRows, paneHero, paneTiles, usageRows, worktreeRows } from './pane'

type Api = EngineInterface
type Run = { exitCode: number; stdout: string; stderr: string }

const PLUGIN = 'lk-where-am-i'
const PANE = 'where-am-i'
const SETTINGS_KEY = 'settings'
const CONFIG_FILE = 'where-am-i.json'
/** The quiet theme color (the kit's): labels and secondary text in the pane. */
const QUIET = 'inactive'
/** Each git call is killed after this long; a status line must never wait on git. */
export const GIT_TIMEOUT_MS = 2000
export const TICK_MS = 60_000

const locAtom = atom({ plugin: 'lk-where-am-i', key: 'loc' } as const, null as Location | null)
const windowsAtom = atom({ plugin: 'lk-where-am-i', key: 'windows' } as const, [] as RateWindow[])
const costAtom = atom({ plugin: 'lk-where-am-i', key: 'costUsd' } as const, null as number | null)
const warnedAtom = atom({ plugin: 'lk-where-am-i', key: 'warned' } as const, {} as Record<string, boolean>)
const lastStepAtom = atom({ plugin: 'lk-where-am-i', key: 'lastStep' } as const, null as number | null)
const nowAtom = atom({ plugin: 'lk-where-am-i', key: 'now' } as const, 0)
const bandAtom = atom({ plugin: 'lk-where-am-i', key: 'band' } as const, true)
const ttlAtom = atom({ plugin: 'lk-where-am-i', key: 'ttlMin' } as const, DEFAULT_TTL_MIN)
const ttlSourceAtom = atom({ plugin: 'lk-where-am-i', key: 'ttlSource' } as const, 'default')
const cwdAtom = atom({ plugin: 'lk-where-am-i', key: 'cwd' } as const, '')

// Module-level: lost on reload, which only means one extra refresh.
let inflight: Promise<void> | null = null
let busy = false
let timer: { cancel(): void } | undefined

async function nowMs($: Api): Promise<number> {
  try {
    const n = await $.clock.now()
    if (typeof n === 'number' && Number.isFinite(n)) return n
  } catch {
    // fall through
  }
  return Date.now()
}

async function currentCwd($: Api): Promise<string> {
  try {
    const c = await $.session.cwd()
    if (typeof c === 'string' && c) {
      await update($, cwdAtom, () => c)
      return c
    }
  } catch {
    // fall back to what session.start reported
  }
  return read($, cwdAtom)
}

/** Runs git with the short cap; null when it could not start or timed out. */
async function git($: Api, cwd: string, args: string[]): Promise<Run | null> {
  try {
    const r = (await $.process.run(['git', ...args], { cwd: cwd || undefined, timeoutMs: GIT_TIMEOUT_MS })) as Run
    if (!r || typeof r.exitCode !== 'number') return null
    return { exitCode: r.exitCode, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
  } catch {
    return null
  }
}

/** Reads every location field from git. Never throws. */
export async function readLocation($: Api, cwd: string, at: number): Promise<Location> {
  const top = await git($, cwd, ['rev-parse', '--absolute-git-dir', '--git-common-dir', '--show-toplevel'])
  const paths = top && top.exitCode === 0 ? parseRevParse(top.stdout, cwd) : null
  if (!paths) return folderOnly(cwd, at)

  const [sym, sha, status, up, ahead, last, origin, wts] = await Promise.all([
    git($, cwd, ['symbolic-ref', '--short', '-q', 'HEAD']),
    git($, cwd, ['rev-parse', '--short', 'HEAD']),
    git($, cwd, ['--no-optional-locks', 'status', '--porcelain']),
    git($, cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    git($, cwd, ['rev-list', '--count', '@{upstream}..HEAD']),
    git($, cwd, ['log', '-1', '--format=%ct%x00%s']),
    git($, cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
    git($, cwd, ['worktree', 'list', '--porcelain']),
  ])

  const linked = isLinkedWorktree(paths)
  const commit = last && last.exitCode === 0 ? parseLastCommit(last.stdout) : null
  const upstreamName = up && up.exitCode === 0 ? up.stdout.trim() || null : null
  const upstream: Location['upstream'] = !up ? 'unknown' : upstreamName ? 'set' : 'none'
  return {
    isRepo: true,
    cwd,
    folder: basename(cwd),
    repo: repoName(paths),
    toplevel: paths.toplevel,
    branch: parseBranch(sym),
    sha: parseSha(sha),
    isLinkedWorktree: linked,
    worktreeName: linked ? basename(paths.toplevel) : null,
    dirty: status && status.exitCode === 0 ? countLines(status.stdout) : null,
    upstream,
    upstreamName,
    ahead: upstream === 'set' && ahead && ahead.exitCode === 0 ? parseCount(ahead.stdout) : null,
    lastCommitAt: commit ? commit.at : null,
    lastSubject: commit ? commit.subject : null,
    defaultBranch: parseDefaultBranch(origin),
    worktrees: wts && wts.exitCode === 0 ? parseWorktrees(wts.stdout) : [],
    checkedAt: at,
  }
}

async function doRefresh($: Api): Promise<void> {
  const at = await nowMs($)
  await update($, nowAtom, () => at)
  const cwd = await currentCwd($)
  const loc = await readLocation($, cwd, at)
  await update($, locAtom, () => loc)
  try {
    const u = await $.session.usage()
    if (u && typeof u === 'object') await takeUsage($, (u as { rateLimits?: unknown }).rateLimits, (u as { cost?: unknown }).cost)
  } catch {
    // session.measure will bring the figures
  }
}

/** Refreshes everything; concurrent callers share one run. Never rejects. */
export function refresh($: Api): Promise<void> {
  if (inflight) return inflight
  const run = doRefresh($)
    .catch(() => {})
    .finally(() => {
      if (inflight === run) inflight = null
    })
  inflight = run
  return run
}

/** Stores the usage windows and cost, then shows any one-time 90% toast. */
async function takeUsage($: Api, rateLimits: unknown, cost: unknown): Promise<void> {
  // An empty or missing list keeps the last reading: off a subscription there is none.
  const windows = sanitizeWindows(rateLimits)
  if (windows.length > 0) await update($, windowsAtom, () => windows)
  const usd = cost && typeof cost === 'object' ? (cost as { usd?: unknown }).usd : undefined
  if (typeof usd === 'number' && Number.isFinite(usd)) await update($, costAtom, () => usd)
  if (windows.length === 0) return
  const before = await read($, warnedAtom)
  const { warned, toast } = nextWarned(before, windows)
  await update($, warnedAtom, () => warned)
  if (toast.length === 0) return
  const at = await nowMs($)
  for (const w of toast) {
    try {
      await $.ui.toast(toastText(w, at))
    } catch {
      // a toast is a courtesy
    }
  }
}

async function readSettings($: Api): Promise<Settings> {
  try {
    const s = await $.store.get(SETTINGS_KEY)
    return s && typeof s === 'object' ? (s as Settings) : {}
  } catch {
    return {}
  }
}

/** ~/.claude/where-am-i.json (or $CLAUDE_CONFIG_DIR/where-am-i.json); null when absent or bad. */
async function readConfigFile($: Api): Promise<{ path: string; cfg: Record<string, unknown> } | null> {
  try {
    const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || ((await $.env.get('HOME')) ? (await $.env.get('HOME')) + '/.claude' : '')
    if (!dir) return null
    const path = dir.replace(/[\\/]+$/, '') + '/' + CONFIG_FILE
    if (!(await $.fs.exists(path))) return null
    const cfg = JSON.parse(String(await $.fs.read(path)))
    return cfg && typeof cfg === 'object' ? { path, cfg } : null
  } catch {
    return null
  }
}

/** Defaults, then ~/.claude/where-am-i.json, then what /where saved. */
async function loadSettings($: Api): Promise<void> {
  let ttl = DEFAULT_TTL_MIN
  let source = 'default'
  let band = true
  const file = await readConfigFile($)
  if (file) {
    const t = sanitizeTtl(file.cfg.cacheTtlMin)
    if (t !== null) {
      ttl = t
      source = '~/.claude/' + CONFIG_FILE
    }
    if (typeof file.cfg.band === 'boolean') band = file.cfg.band
  }
  const saved = await readSettings($)
  const st = sanitizeTtl(saved.cacheTtlMin)
  if (st !== null) {
    ttl = st
    source = '/where cache'
  }
  if (typeof saved.band === 'boolean') band = saved.band
  await update($, ttlAtom, () => ttl)
  await update($, ttlSourceAtom, () => source)
  await update($, bandAtom, () => band)
}

async function saveSetting($: Api, patch: Settings): Promise<void> {
  const saved = await readSettings($)
  await $.store.set(SETTINGS_KEY, { ...saved, ...patch })
  await loadSettings($)
}

function startTick($: Api): void {
  try {
    timer?.cancel()
  } catch {
    // an old timer from a previous load
  }
  try {
    timer = $.clock.every(TICK_MS, () => {
      void (async () => {
        const at = await nowMs($)
        await update($, nowAtom, () => at)
        // Git is checked only while idle; during a turn, turn.complete does it.
        if (!busy) await refresh($)
      })().catch(() => {})
    })
  } catch {
    timer = undefined
  }
}

async function onStart($: Api, cwd: string): Promise<void> {
  if (cwd) await update($, cwdAtom, () => cwd)
  await loadSettings($)
  startTick($)
  void refresh($).catch(() => {})
}

function snapshot($: Api) {
  return Promise.all([
    read($, locAtom),
    read($, windowsAtom),
    read($, nowAtom),
    read($, lastStepAtom),
    read($, ttlAtom),
    read($, costAtom),
    read($, ttlSourceAtom),
  ]).then(([loc, windows, now, lastStep, ttlMin, costUsd, ttlSource]) => ({
    loc,
    windows,
    nowMs: now,
    lastStepMs: lastStep,
    ttlMin,
    costUsd,
    ttlSource,
  }))
}

async function runCommand($: Api, args: string): Promise<{ text?: string }> {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const sub = (words[0] ?? '').toLowerCase()
  const arg = (words[1] ?? '').toLowerCase()
  if (sub === '') {
    void refresh($).catch(() => {})
    await $.ui.open({ id: PANE, title: 'Where am I', focus: true, closeOnEscape: true })
    return {}
  }
  if (sub === 'text') {
    await refresh($)
    return { text: summaryText(await snapshot($)) }
  }
  if (sub === 'refresh') {
    await refresh($)
    return { text: 'where-am-i: checked again.' }
  }
  if (sub === 'band') {
    if (arg !== 'on' && arg !== 'off') return { text: 'Use /where band on or /where band off.' }
    await saveSetting($, { band: arg === 'on' })
    return { text: (await read($, bandAtom)) ? 'Band shown above the prompt.' : 'Band hidden.' }
  }
  if (sub === 'cache') {
    const t = sanitizeTtl(words[1] ?? '')
    if (t === null) return { text: 'Give the cache TTL in minutes, such as /where cache 60 or /where cache 5.' }
    await saveSetting($, { cacheTtlMin: t })
    return { text: `Prompt-cache TTL set to ${await read($, ttlAtom)} minutes.` }
  }
  return { text: HELP }
}

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    try {
      await onStart($, typeof e.cwd === 'string' ? e.cwd : '')
    } catch {
      // the band starts empty and fills on the next refresh
    }
    try {
      await $.command.register({
        name: 'where',
        description: 'Where am I: repo, branch, worktree, usage windows, prompt cache. text, refresh, band on|off, cache <min>',
        argumentHint: '[text | refresh | band on|off | cache <min>]',
        immediate: true,
      })
    } catch {
      // the name is taken: the band still works
    }
    return next(e)
  })

  // /clear, /resume and /branch reset $.state without a session.start.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try {
      const c = (e as { cwd?: unknown }).cwd
      await onStart($, typeof c === 'string' ? c : '')
    } catch {
      // nothing to do
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.CwdChanged', async ($, e, next) => {
    try {
      const c = (e as { new_cwd?: unknown }).new_cwd
      if (typeof c === 'string' && c) await update($, cwdAtom, () => c)
      void refresh($).catch(() => {})
    } catch {
      // observe only
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (!(e as { agentId?: unknown }).agentId) busy = true
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    try {
      if (!(e as { agentId?: unknown }).agentId) {
        const at = await nowMs($)
        await update($, lastStepAtom, () => at)
        await update($, nowAtom, () => at)
      }
    } catch {
      // the cache clock just keeps its last reading
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      if (!(e as { agentId?: unknown }).agentId) {
        busy = false
        void refresh($).catch(() => {})
      }
    } catch {
      // observe only
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    try {
      const at = await nowMs($)
      await update($, nowAtom, () => at)
      await takeUsage($, (e as { rateLimits?: unknown }).rateLimits, (e as { cost?: unknown }).cost)
    } catch {
      // observe only
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    try {
      timer?.cancel()
    } catch {
      // already gone
    }
    timer = undefined
    return next(e)
  })

  on('command.run', { command: 'where' }, async ($, e) => {
    try {
      return await runCommand($, typeof e.args === 'string' ? e.args : '')
    } catch (err) {
      return { text: 'where-am-i: ' + (err instanceof Error ? err.message : String(err)) }
    }
  })

  // The band: one kit line, `acme-repo@main  ● 5h 34%  ● 7d 12%  ● cache 41m      3 dirty · 2↑ · 14m since
  // commit`: the bold location, the usage windows and the cache as chips (muted, warn from 80%, danger
  // from 95%, warn under 5 cache minutes), the rest quiet on the right (default text once a window is
  // at danger). Other plugins' bands stack under it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const props = (e.props ?? {}) as { hasSurvey?: boolean }
    if (props.hasSurvey === true || !(await read($, bandAtom))) return next(e)
    const band = bandLine(await snapshot($))
    const theirs = await next(e)
    if (!band) return theirs
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const kit = makeKit(ui as unknown as Elements, e.surface)
    const drawn = (
      band.urgent && band.right.length > 0
        ? Box({
            flexDirection: 'row',
            justifyContent: 'space-between',
            columnGap: 2,
            children: [
              kit.line(band.label, band.chips) as ReturnType<typeof Box>,
              kit.text(band.right.join(' · '), { wrap: 'truncate' }) as ReturnType<typeof Box>,
            ],
          })
        : kit.line(band.label, band.chips, band.right)
    ) as ReturnType<typeof Box>
    const line = Box({ key: 'where-am-i-band', flexDirection: 'column', children: [drawn] })
    if (!theirs) return line
    return Box({ flexDirection: 'column', children: [line, theirs] })
  })

  // The /where pane, drawn with the kit: where you are, the band's numbers as tiles,
  // then location, usage windows, prompt cache and worktrees under headers with counts;
  // the worktree marks are pills. A page: one row between blocks, each section's rows tight.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const snap = await snapshot($)
    const kit = makeKit($.ui.resolve(e) as unknown as Elements, e.surface)
    const quiet = (s: string) => kit.text(s, { color: QUIET, wrap: 'truncate' })
    const toned = (s: string, tone?: Tone) => kit.text(s, tone ? { color: TONES[tone].fg, wrap: 'truncate' } : { wrap: 'truncate' })

    const hero = paneHero(snap)
    const loc = locationRows(snap)
    const w = Math.max(0, ...loc.map(r => r.label.length))
    const usage = usageRows(snap)
    const cache = cacheRow(snap)
    const wts = worktreeRows(snap.loc)

    const sections: unknown[] = [
      kit.stack([
        kit.header('Location', String(loc.length)),
        ...loc.map(r => kit.row({ key: 'loc-' + r.label, left: [quiet(r.label.padEnd(w)), toned(r.value, r.tone)] })),
      ]),
      kit.stack([
        kit.header('Usage', String(usage.length)),
        ...(usage.length > 0
          ? usage.map(u => kit.row({ key: u.key, left: [kit.text(u.label.padEnd(5), { bold: true }), kit.bar(u.ratio, { tone: u.tone })], right: u.right }))
          : [quiet('no rate-limit reading yet')]),
      ]),
      kit.stack([
        kit.header('Prompt cache'),
        kit.row({ key: 'cache', left: [toned(cache.value, cache.tone)], right: cache.right }),
      ]),
    ]
    if (wts.length > 0) {
      sections.push(
        kit.stack([
          kit.header('Worktrees', String(wts.length)),
          ...wts.map(t =>
            kit.row({
              key: t.key,
              left: [
                t.here ? toned('●', 'info') : quiet('○'),
                kit.text(t.path, { bold: t.here, wrap: 'truncate' }),
                t.here ? kit.pill('here', 'info') : null,
                ...t.flags.map(f => kit.pill(f, 'warn')),
              ],
              right: t.head,
            }),
          ),
        ]),
      )
    }

    return kit.page([
      kit.hero({ kicker: 'where you are', title: hero.title, sub: hero.sub, tone: hero.tone }),
      kit.tiles(paneTiles(snap)),
      ...sections,
      kit.buttons([
        { key: 'refresh', label: 'Refresh', hotkey: 'r', plain: true, onPress: () => refresh($) },
        { key: 'close', label: 'Close', hotkey: 'c', plain: true, onPress: () => $.ui.close({ id: PANE }) },
      ]),
    ]) as never
  })
}
