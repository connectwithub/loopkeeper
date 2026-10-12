// lk-pr-watch: the pure parts. Parsers for `gh pr view --json` and the GraphQL poll, the diff
// between two polls, the band text, the poll cadence, config merging and the /pr command parser.
// Nothing here touches $, so tests call these directly.
//
// Borrowed (MIT, Copyright (c) 2026 Seza Akgün, github.com/sezaakgun/cc-pr-tracker): the GraphQL
// query shape, toCheck's buckets, the lineage key, latestPerName, clean() and linkable(). The
// query adds completedAt so the pane can show a duration.

import type { Bucket, Check, Config, NotifyKind, Snapshot, Watched } from '../types'

export const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/
/** A prompt that is nothing but PR URLs (one or more, any whitespace). */
export const ONLY_URLS = new RegExp(`^\\s*(${PR_URL.source}\\S*\\s*)+$`)

export const VIEW_FIELDS = 'number,url,title,state,isDraft,mergeable,reviewDecision,headRefName,baseRefName'

/** One call per PR: state, merge state, review decision and the check rollup of the head commit. */
export const QUERY = `query($o: String!, $r: String!, $n: Int!) {
  repository(owner: $o, name: $r) { pullRequest(number: $n) {
    number title state isDraft mergeable mergeStateStatus reviewDecision
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { name status conclusion detailsUrl startedAt completedAt checkSuite { app { slug } workflowRun { event workflow { name } } } }
      ... on StatusContext { context state targetUrl createdAt }
    } } } } } }
  } }
}`

export const DEFAULTS: Config = {
  pollSec: 120,
  hotPollSec: 30,
  notifyOn: ['failed', 'green', 'review', 'merged'],
  appendNoteOnFailure: true,
}

/** How long after a push polling stays hot. */
export const HOT_MS = 20 * 60_000

const KINDS: readonly NotifyKind[] = ['failed', 'green', 'review', 'merged']

// ---------- small guards ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
// GitHub text goes to the terminal as-is, so control characters are dropped first
// eslint-disable-next-line no-control-regex
export const clean = (s: string): string => s.replace(/[\x00-\x1f\x7f]/g, '')

/** A Link refuses the whole tree unless its href is canonical https (or http://localhost). */
export function linkable(href: string): boolean {
  try {
    const u = new URL(href)
    return u.href === href && (u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === 'localhost'))
  } catch {
    return false
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ---------- PR URLs ----------

export type PrRef = { owner: string; repo: string; number: number; url: string; id: string }

export function refOf(owner: string, repo: string, number: number): PrRef {
  return { owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}`, id: `${owner}/${repo}#${number}` }
}

/** The first GitHub PR URL in the text, or null. */
export function parsePrUrl(text: string): PrRef | null {
  const m = PR_URL.exec(typeof text === 'string' ? text : '')
  if (!m) return null
  const n = Number(m[3])
  return Number.isInteger(n) && n > 0 ? refOf(m[1], m[2], n) : null
}

/** Every distinct PR URL in a prompt that is only PR URLs; [] for any other prompt. */
export function bareUrls(text: string): PrRef[] {
  if (typeof text !== 'string' || !ONLY_URLS.test(text)) return []
  const seen = new Set<string>()
  const out: PrRef[] = []
  for (const m of text.matchAll(new RegExp(PR_URL.source, 'g'))) {
    const r = parsePrUrl(m[0])
    if (r && !seen.has(r.id)) {
      seen.add(r.id)
      out.push(r)
    }
  }
  return out
}

// ---------- gh pr view ----------

export type PrView = {
  number: number
  url: string
  title: string
  state: string
  isDraft: boolean
  mergeable: string
  reviewDecision: string
  headRefName: string
  baseRefName: string
}

/** Parses `gh pr view --json <VIEW_FIELDS>` output; null when it is not a PR. */
export function parsePrView(stdout: string): PrView | null {
  const j = parseJson(stdout)
  if (!isObj(j)) return null
  const number = typeof j.number === 'number' ? j.number : Number(j.number)
  const url = str(j.url)
  if (!Number.isInteger(number) || number <= 0 || !parsePrUrl(url)) return null
  return {
    number,
    url,
    title: clean(str(j.title)),
    state: str(j.state) || 'OPEN',
    isDraft: j.isDraft === true,
    mergeable: str(j.mergeable) || 'UNKNOWN',
    reviewDecision: str(j.reviewDecision),
    headRefName: str(j.headRefName),
    baseRefName: str(j.baseRefName),
  }
}

/** True when gh says the branch simply has no PR (as opposed to auth or network trouble). */
export function isNoPr(stderr: string): boolean {
  return /no (open )?pull requests? found/i.test(typeof stderr === 'string' ? stderr : '')
}

// ---------- GraphQL ----------

type Context = Record<string, unknown>

const sub = (o: unknown, k: string): Record<string, unknown> | undefined => {
  const v = isObj(o) ? o[k] : undefined
  return isObj(v) ? v : undefined
}

const lineage = (c: Context): string => {
  const suite = sub(c, 'checkSuite')
  const run = sub(suite, 'workflowRun')
  return [str(c.__typename), str(sub(suite, 'app')?.slug), str(sub(run, 'workflow')?.name), str(run?.event), str(c.name) || str(c.context)].join('\u0000')
}

const startOf = (c: Context): string => str(c.startedAt) || str(c.createdAt) || (c.status === 'COMPLETED' ? '' : '~')

/** Keeps the latest run per check lineage (a re-run replaces the old one). */
export function latestPerName(contexts: readonly Context[]): Context[] {
  const latest = new Map<string, Context>()
  for (const c of contexts) {
    if (!isObj(c)) continue
    const key = lineage(c)
    const seen = latest.get(key)
    if (!seen || startOf(c) >= startOf(seen)) latest.set(key, c)
  }
  return [...latest.values()]
}

/** The same buckets `gh pr checks` derives. */
export function toCheck(c: Context): Check {
  const key = lineage(c)
  if (c.__typename === 'StatusContext') {
    const s = str(c.state)
    const bucket: Bucket = s === 'SUCCESS' ? 'pass' : s === 'PENDING' || s === 'EXPECTED' ? 'pending' : 'fail'
    return { key, name: clean(str(c.context)), bucket, link: str(c.targetUrl), startedAt: str(c.createdAt), completedAt: '' }
  }
  const conclusion = str(c.conclusion)
  const bucket: Bucket =
    c.status !== 'COMPLETED'
      ? 'pending'
      : conclusion === 'SUCCESS' || conclusion === 'NEUTRAL'
        ? 'pass'
        : conclusion === 'SKIPPED'
          ? 'skipping'
          : conclusion === 'CANCELLED'
            ? 'cancel'
            : 'fail'
  return { key, name: clean(str(c.name)), bucket, link: str(c.detailsUrl), startedAt: str(c.startedAt), completedAt: str(c.completedAt) }
}

export type GraphqlParse = { snap: Snapshot } | { error: string }

/** Parses the `gh api graphql` response for QUERY. */
export function parseGraphql(stdout: string): GraphqlParse {
  const j = parseJson(stdout)
  if (!isObj(j)) return { error: 'gh returned no JSON' }
  if (Array.isArray(j.errors) && j.errors.length) {
    const first = j.errors[0]
    return { error: clean(str(isObj(first) ? first.message : '')) || 'GraphQL error' }
  }
  const pr = sub(sub(sub(j, 'data'), 'repository'), 'pullRequest')
  if (!pr) return { error: 'PR not found' }
  const commits = sub(pr, 'commits')
  const nodes = Array.isArray(commits?.nodes) ? commits.nodes : []
  const last = nodes[nodes.length - 1]
  const rollup = sub(sub(last, 'commit'), 'statusCheckRollup')
  const ctx = sub(rollup, 'contexts')
  const raw = Array.isArray(ctx?.nodes) ? (ctx.nodes as Context[]) : []
  const number = typeof pr.number === 'number' ? pr.number : Number(pr.number)
  return {
    snap: {
      number: Number.isInteger(number) ? number : 0,
      title: clean(str(pr.title)),
      state: str(pr.state) || 'OPEN',
      isDraft: pr.isDraft === true,
      mergeable: str(pr.mergeable) || 'UNKNOWN',
      mergeStateStatus: str(pr.mergeStateStatus) || 'UNKNOWN',
      reviewDecision: str(pr.reviewDecision),
      checks: latestPerName(raw).map(toCheck),
    },
  }
}

/** The argv for one poll. -f keeps owner and repo as strings; -F sends the number as an Int. */
export function graphqlArgv(w: { owner: string; repo: string; number: number }): string[] {
  return ['gh', 'api', 'graphql', '-f', `query=${QUERY}`, '-f', `o=${w.owner}`, '-f', `r=${w.repo}`, '-F', `n=${w.number}`]
}

// ---------- counts, diff ----------

export type Counts = { total: number; pass: number; fail: number; pending: number; skipped: number }

export function countsOf(snap: Snapshot | null): Counts {
  const c: Counts = { total: 0, pass: 0, fail: 0, pending: 0, skipped: 0 }
  for (const k of snap?.checks ?? []) {
    c.total += 1
    if (k.bucket === 'pass') c.pass += 1
    else if (k.bucket === 'fail' || k.bucket === 'cancel') c.fail += 1
    else if (k.bucket === 'pending') c.pending += 1
    else c.skipped += 1
  }
  return c
}

/** Every check finished and none failed (skipped checks do not count against). */
export function isGreen(snap: Snapshot | null): boolean {
  const c = countsOf(snap)
  return c.total > 0 && c.fail === 0 && c.pending === 0 && c.pass > 0
}

export type Transition =
  | { kind: 'failed'; check: Check }
  | { kind: 'green' }
  | { kind: 'review'; from: string; to: string }
  | { kind: 'merged' }

/** What changed between two polls. The first poll (prev null) reports nothing. */
export function diff(prev: Snapshot | null, next: Snapshot): Transition[] {
  if (!prev) return []
  const out: Transition[] = []
  if (next.state === 'MERGED' && prev.state !== 'MERGED') out.push({ kind: 'merged' })
  const before = new Map(prev.checks.map(c => [c.key, c.bucket]))
  for (const c of next.checks) {
    const was = before.get(c.key)
    if ((c.bucket === 'fail' || c.bucket === 'cancel') && was !== 'fail' && was !== 'cancel') out.push({ kind: 'failed', check: c })
  }
  if (isGreen(next) && !isGreen(prev)) out.push({ kind: 'green' })
  if (next.reviewDecision !== prev.reviewDecision) out.push({ kind: 'review', from: prev.reviewDecision, to: next.reviewDecision })
  return out
}

// ---------- words ----------

export function reviewText(decision: string): string {
  if (decision === 'APPROVED') return 'approved'
  if (decision === 'CHANGES_REQUESTED') return 'changes requested'
  if (decision === 'REVIEW_REQUIRED') return 'review required'
  return 'no review'
}

export function mergeText(snap: Snapshot): string {
  if (snap.state === 'MERGED') return 'merged'
  if (snap.state === 'CLOSED') return 'closed'
  if (snap.isDraft) return 'draft'
  if (snap.mergeable === 'CONFLICTING') return 'conflicts'
  if (snap.mergeable === 'MERGEABLE') return snap.mergeStateStatus === 'BEHIND' ? 'mergeable (behind)' : 'mergeable'
  return 'mergeability unknown'
}

/** A PR's level, named by the kit tone it is drawn in. */
export type Level = 'ok' | 'warn' | 'danger'

/** A kit tone name (the kit's Tone, without importing the kit into the pure parts). */
export type ToneName = 'info' | 'ok' | 'warn' | 'danger' | 'muted' | 'accent'

export function levelOf(snap: Snapshot | null): Level {
  if (!snap) return 'warn'
  if (snap.state === 'MERGED') return 'ok'
  if (snap.state === 'CLOSED') return 'danger'
  const c = countsOf(snap)
  if (c.fail > 0 || snap.reviewDecision === 'CHANGES_REQUESTED' || snap.mergeable === 'CONFLICTING') return 'danger'
  if (c.pending > 0 || snap.isDraft || snap.mergeable !== 'MERGEABLE' || snap.reviewDecision === 'REVIEW_REQUIRED') return 'warn'
  return 'ok'
}

/** `PR #42 ● checks 3/5 ✓ 1 ✗ · review: changes requested · mergeable` */
export function bandText(w: Watched): string {
  const head = `PR #${w.number}`
  const s = w.snap
  if (!s) return `${head} ● ${w.error ? `gh failed: ${w.error}` : 'loading…'}`
  const c = countsOf(s)
  const checks = c.total === 0 ? 'no checks' : `checks ${c.pass}/${c.total} ✓${c.fail ? ` ${c.fail} ✗` : ''}${c.pending ? ` ${c.pending} …` : ''}`
  return `${head} ● ${checks} · review: ${reviewText(s.reviewDecision)} · ${mergeText(s)}${w.error ? ' · refresh failed' : ''}`
}

/** The PR the band shows: the current branch's first, else the first added. */
export function primaryOf(prs: readonly Watched[]): Watched | undefined {
  return prs.find(p => p.source === 'branch') ?? prs[0]
}

/** The tone of a review decision's chip. */
export const REVIEW_TONE: Record<string, ToneName> = { APPROVED: 'ok', CHANGES_REQUESTED: 'danger', REVIEW_REQUIRED: 'warn' }

/** The tone of mergeText's words. */
function mergeTone(snap: Snapshot): ToneName {
  if (snap.state === 'MERGED') return 'ok'
  if (snap.state === 'CLOSED' || snap.mergeable === 'CONFLICTING') return 'danger'
  if (snap.isDraft || snap.mergeable !== 'MERGEABLE') return 'muted'
  return snap.mergeStateStatus === 'BEHIND' ? 'warn' : 'ok'
}

/**
 * The band's parts, drawn as kit.line(label, chips, right): `PR #42  ● checks 3/5 ✓ 1 ✗  ● changes
 * requested  ● mergeable      +1 more`. Each chip carries its own tone; the right side is drawn in
 * the default text color when the PR is urgent (level danger), else quiet.
 */
export type BandParts = { label: string; chips: { text: string; tone: ToneName }[]; right: string[]; urgent: boolean }

/** The band for the primary PR (the branch's, else the first added), or null when none is watched. */
export function bandParts(prs: readonly Watched[]): BandParts | null {
  const p = primaryOf(prs)
  if (!p) return null
  const label = `PR #${p.number}`
  const more = prs.length > 1 ? [`+${prs.length - 1} more`] : []
  const s = p.snap
  if (!s) {
    const chips = [p.error ? { text: 'gh failed', tone: 'danger' as const } : { text: 'loading…', tone: 'muted' as const }]
    return { label, chips, right: [...(p.error ? [p.error] : []), ...more], urgent: Boolean(p.error) }
  }
  const c = countsOf(s)
  const checks =
    c.total === 0
      ? { text: 'no checks', tone: 'muted' as const }
      : {
          text: `checks ${c.pass}/${c.total} ✓${c.fail ? ` ${c.fail} ✗` : ''}${c.pending ? ` ${c.pending} …` : ''}`,
          tone: c.fail ? ('danger' as const) : c.pending ? ('warn' as const) : ('ok' as const),
        }
  const review = { text: reviewText(s.reviewDecision), tone: REVIEW_TONE[s.reviewDecision] ?? 'muted' }
  const merge = { text: mergeText(s), tone: mergeTone(s) }
  const level = levelOf(s)
  return { label, chips: [checks, review, merge], right: [...(p.error ? ['refresh failed'] : []), ...more], urgent: level === 'danger' }
}

export function toastText(w: Watched, t: Transition): string {
  const head = `PR #${w.number}`
  if (t.kind === 'failed') return `${head}: check "${t.check.name}" failed`
  if (t.kind === 'green') return `${head}: all checks green`
  if (t.kind === 'merged') return `${head} merged`
  return `${head}: review ${reviewText(t.to)}`
}

/** The one-line note Claude reads on its next turn. Check names are GitHub data, quoted. */
export function failureNote(w: Watched, c: Check): string {
  const name = JSON.stringify(c.name.slice(0, 100))
  return `[pr-watch: automated notice, not typed by the user] Check ${name} failed on PR #${w.number} (${w.owner}/${w.repo})${c.link ? `: ${c.link}` : ''}`
}

/** "1m 23s" between two ISO times; '' when either is missing. */
export function durationOf(c: Check, now: number): string {
  const a = Date.parse(c.startedAt)
  if (!Number.isFinite(a)) return ''
  const b = c.completedAt ? Date.parse(c.completedAt) : now
  if (!Number.isFinite(b) || b < a) return ''
  const s = Math.round((b - a) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Each bucket's glyph and the kit tone it is drawn in. */
export const ICON: Record<Bucket, [string, ToneName]> = {
  pass: ['✓', 'ok'],
  fail: ['✗', 'danger'],
  pending: ['●', 'warn'],
  skipping: ['○', 'muted'],
  cancel: ['⊘', 'danger'],
}

/** Plain text for /pr text. */
export function summaryText(prs: readonly Watched[], now: number): string {
  if (!prs.length) return 'pr-watch: no PR watched. Push a branch with a PR, paste a PR URL, or run /pr add <url|number>.'
  const out: string[] = []
  for (const w of prs) {
    out.push(`${w.id} ${w.url}`)
    const s = w.snap
    if (!s) {
      out.push(`  ${w.error ? `gh failed: ${w.error}` : 'not polled yet'}`)
      continue
    }
    out.push(`  ${s.title}`)
    out.push(`  ${bandText(w)}`)
    for (const c of s.checks) {
      const d = durationOf(c, now)
      out.push(`    ${ICON[c.bucket][0]} ${c.name} ${c.bucket}${d ? ` ${d}` : ''}${c.link ? ` ${c.link}` : ''}`)
    }
    if (w.error) out.push(`  last refresh failed: ${w.error}`)
  }
  return out.join('\n')
}

// ---------- cadence ----------

/** Milliseconds between polls: hotPollSec while hot and a check is pending, else pollSec. */
export function cadenceMs(cfg: Config, prs: readonly Watched[], now: number, hotUntil: number): number {
  const pending = prs.some(p => countsOf(p.snap).pending > 0 || p.snap === null)
  return (now < hotUntil && pending ? cfg.hotPollSec : cfg.pollSec) * 1000
}

export function isDue(cfg: Config, prs: readonly Watched[], now: number, hotUntil: number, lastPoll: number): boolean {
  return prs.length > 0 && now - lastPoll >= cadenceMs(cfg, prs, now, hotUntil)
}

// ---------- Bash commands that matter ----------

/** gh pr create, git push or gh pr merge: look for the branch's PR again. */
export function isDiscoveryCommand(cmd: string): boolean {
  return typeof cmd === 'string' && /\bgh\s+pr\s+(create|merge)\b|\bgit\s+push\b/.test(cmd)
}

/** gh pr create or git push: CI starts, so poll fast for a while. */
export function isPushCommand(cmd: string): boolean {
  return typeof cmd === 'string' && /\bgh\s+pr\s+create\b|\bgit\s+push\b/.test(cmd)
}

// ---------- config ----------

function secs(v: unknown, lo: number, hi: number): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : undefined
}

/** Keeps the valid fields of one config file. */
export function sanitize(raw: unknown): Partial<Config> {
  if (!isObj(raw)) return {}
  const out: Partial<Config> = {}
  const p = secs(raw.pollSec, 15, 3600)
  if (p !== undefined) out.pollSec = p
  const h = secs(raw.hotPollSec, 10, 3600)
  if (h !== undefined) out.hotPollSec = h
  if (Array.isArray(raw.notifyOn)) out.notifyOn = KINDS.filter(k => (raw.notifyOn as unknown[]).includes(k))
  if (typeof raw.appendNoteOnFailure === 'boolean') out.appendNoteOnFailure = raw.appendNoteOnFailure
  return out
}

export function mergeConfig(user: unknown, project: unknown): Config {
  return { ...DEFAULTS, ...sanitize(user), ...sanitize(project) }
}

// ---------- /pr ----------

export type PrCommand =
  | { kind: 'open' }
  | { kind: 'text' }
  | { kind: 'refresh' }
  | { kind: 'add'; ref: PrRef }
  | { kind: 'add-number'; number: number }
  | { kind: 'rm'; target: string }
  | { kind: 'band'; on: boolean }
  | { kind: 'help'; reason: string }

export const HELP =
  'Usage: /pr (open the pane) · /pr add <url|number> · /pr rm <number|owner/repo#n> · /pr refresh · /pr band on|off · /pr text'

export function parseCommand(args: string): PrCommand {
  const words = (typeof args === 'string' ? args : '').trim().split(/\s+/).filter(Boolean)
  const verb = (words[0] ?? '').toLowerCase()
  const arg = words.slice(1).join(' ')
  if (verb === '') return { kind: 'open' }
  if (verb === 'text') return { kind: 'text' }
  if (verb === 'refresh') return { kind: 'refresh' }
  if (verb === 'add') {
    const ref = parsePrUrl(arg)
    if (ref) return { kind: 'add', ref }
    const n = Number(arg.replace(/^#/, ''))
    if (arg && Number.isInteger(n) && n > 0) return { kind: 'add-number', number: n }
    return { kind: 'help', reason: `Not a PR URL or number: "${arg}".` }
  }
  if (verb === 'rm' || verb === 'remove') {
    if (!arg) return { kind: 'help', reason: 'Name the PR to stop watching.' }
    return { kind: 'rm', target: arg }
  }
  if (verb === 'band') {
    const v = arg.toLowerCase()
    if (v === 'on' || v === 'off') return { kind: 'band', on: v === 'on' }
    return { kind: 'help', reason: 'Use /pr band on or /pr band off.' }
  }
  const ref = parsePrUrl(verb)
  if (ref) return { kind: 'add', ref }
  return { kind: 'help', reason: `Unknown subcommand "${verb}".` }
}

/** Which watched PRs a /pr rm target names: a number, #number, owner/repo#n or a URL. */
export function matchTarget(prs: readonly Watched[], target: string): Watched[] {
  const t = target.trim()
  const ref = parsePrUrl(t)
  if (ref) return prs.filter(p => p.id === ref.id)
  if (t.includes('#') && t.includes('/')) return prs.filter(p => p.id === t)
  const n = Number(t.replace(/^#/, ''))
  return Number.isInteger(n) ? prs.filter(p => p.number === n) : []
}

export function newWatched(ref: PrRef, source: Watched['source']): Watched {
  return { id: ref.id, url: ref.url, owner: ref.owner, repo: ref.repo, number: ref.number, source, snap: null, error: '', polledAt: 0 }
}
