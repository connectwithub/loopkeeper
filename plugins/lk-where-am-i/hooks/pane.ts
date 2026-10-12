// lk-where-am-i: the /where pane's view model. Pure: it reads the same snapshot the band
// and /where text read and returns strings and tones; register.ts draws them with the kit.
// Nothing here takes `$`.

import type { Location } from '../types'
import type { Tone } from './kit'
import { type BandInput, type Row, cacheState, detailRows, fmtLeft, kindLabel, levelOf, liveWindows, locationParts } from './where'

export type PaneInput = BandInput & { costUsd: number | null; ttlSource: string }

export type Hero = { title: string; sub?: string; tone: Tone }
export type Tile = { label: string; value: string; tone?: Tone }
export type UsageRow = { key: string; label: string; ratio: number; tone: Tone; right: string }
export type WorktreeRow = { key: string; here: boolean; path: string; head: string; flags: string[] }
export type CacheRow = { value: string; tone?: Tone; right: string }

function trimSlashes(p: string): string {
  const t = String(p ?? '').replace(/[\\/]+$/, '')
  return t === '' && p !== '' ? '/' : t
}

function levelTone(pct: number): Tone {
  return levelOf(pct)
}

/** The hero: `repo@branch ⑂wt:name` over `3 dirty · 2↑ · 14m since commit`; the folder outside git. */
export function paneHero(input: PaneInput): Hero {
  const loc = input.loc
  if (!loc) return { title: 'Nothing known yet', sub: 'Git is read in the background; press Refresh to check now.', tone: 'muted' }
  const parts = locationParts(loc, input.nowMs).map(p => p.map(s => s.text).join(''))
  if (!loc.isRepo) return { title: parts[0] ?? loc.folder, sub: loc.cwd || undefined, tone: 'muted' }
  const sub = parts.slice(1).join(' · ')
  return { title: parts[0] ?? loc.repo, sub: sub || undefined, tone: 'info' }
}

/** Changed · Unpushed · Cache · Cost: the numbers the band already shows, one tile each. */
export function paneTiles(input: PaneInput): Tile[] {
  const loc = input.loc && input.loc.isRepo ? input.loc : null
  const dirty = loc ? loc.dirty : null
  const changed: Tile =
    dirty === null ? { label: 'Changed', value: '—', tone: 'muted' } : { label: 'Changed', value: String(dirty), tone: dirty > 0 ? 'warn' : 'ok' }
  let unpushed: Tile = { label: 'Unpushed', value: '—', tone: 'muted' }
  if (loc && loc.upstream === 'none' && loc.branch) unpushed = { label: 'Unpushed', value: 'no upstream', tone: 'muted' }
  else if (loc && loc.ahead !== null) unpushed = { label: 'Unpushed', value: String(loc.ahead), tone: loc.ahead > 0 ? 'warn' : 'ok' }
  const c = cacheState(input.lastStepMs, input.nowMs, input.ttlMin)
  const cache: Tile =
    c.kind === 'unknown'
      ? { label: 'Cache', value: '—', tone: 'muted' }
      : c.kind === 'cold'
        ? { label: 'Cache', value: 'cold', tone: 'muted' }
        : { label: 'Cache', value: fmtLeft(c.leftMs) + ' left', tone: c.kind === 'low' ? 'warn' : 'ok' }
  const usd = input.costUsd
  const cost: Tile =
    usd !== null && usd > 0 ? { label: 'Cost', value: `$${usd.toFixed(2)}`, tone: 'accent' } : { label: 'Cost', value: '—', tone: 'muted' }
  return [changed, unpushed, cache, cost]
}

/** The location rows of detailRows (everything before the usage, cost and cache rows), unchanged. */
export function locationRows(input: PaneInput): Row[] {
  return detailRows(input).filter(r => r.label !== 'Usage' && !r.label.startsWith('Usage ') && r.label !== 'Session cost' && r.label !== 'Prompt cache')
}

/** One row per live usage window, 5h then 7d, with the ratio for a bar and the reset time. */
export function usageRows(input: PaneInput): UsageRow[] {
  return liveWindows(input.windows, input.nowMs).map(w => {
    const t = w.resetsAt ? Date.parse(w.resetsAt) : NaN
    const reset = Number.isFinite(t) && t > 0 ? `resets in ${fmtLeft(t - input.nowMs)}` : ''
    return { key: 'usage-' + w.kind, label: kindLabel(w.kind), ratio: w.percentUsed / 100, tone: levelTone(w.percentUsed), right: reset }
  })
}

/** The prompt-cache row: time left (or cold, or no request yet) and where the TTL came from. */
export function cacheRow(input: PaneInput): CacheRow {
  const c = cacheState(input.lastStepMs, input.nowMs, input.ttlMin)
  const right = `TTL ${input.ttlMin}m from ${input.ttlSource}`
  if (c.kind === 'unknown') return { value: 'no request yet', right }
  if (c.kind === 'cold') return { value: 'cold', right }
  return { value: `${fmtLeft(c.leftMs)} left`, tone: c.kind === 'low' ? 'warn' : undefined, right }
}

/** The worktrees as worktreeLines lists them, split into parts (`here` marks this one). */
export function worktreeRows(loc: Location | null): WorktreeRow[] {
  if (!loc || !loc.isRepo || loc.worktrees.length === 0) return []
  return loc.worktrees.map(w => ({
    key: 'wt-' + w.path,
    here: trimSlashes(w.path) === trimSlashes(loc.toplevel),
    path: w.path,
    head: w.bare ? 'bare' : w.branch ?? (w.head ? `detached ${w.head.slice(0, 7)}` : 'detached'),
    flags: [w.locked ? 'locked' : '', w.prunable ? 'prunable' : ''].filter(Boolean),
  }))
}
