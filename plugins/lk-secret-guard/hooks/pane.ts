// secret-guard: the pane's view model. Pure: it reads the log rows and the merged config
// the hooks already keep and returns strings and tones; register.ts draws them with the kit.
// Nothing here takes `$`, and nothing here ever reads a deny or warn word: only their counts.

import type { LogRow } from '../types'
import type { Tone } from './kit'
import { KIND_IDS, PATTERNS, type Config } from './patterns'

export type Outcome = { label: string; tone: Tone }
export type RuleRow = { key: string; name: string; source: 'built-in' | 'config'; right: string; on: boolean }

/** The newest decision that blocked a call, or null. */
export function lastBlocked(rows: readonly LogRow[]): LogRow | null {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].action === 'blocked') return rows[i]
  return null
}

/** The outcome badge of a log row: blocked (danger), allowed (ok), asked then allowed once (warn). */
export function outcomeOf(action: LogRow['action']): Outcome {
  if (action === 'blocked') return { label: 'blocked', tone: 'danger' }
  if (action === 'warned-allowed') return { label: 'asked → allowed', tone: 'warn' }
  return { label: 'allowed', tone: 'ok' }
}

/** Where the word lists apply, as rulesSummary words it. */
export function wordScope(c: Config): string {
  return c.publicPaths === null ? 'everywhere' : `only in ${c.publicPaths.length} public path(s)`
}

/**
 * One row per built-in pattern id (on, or off when disabledKinds lists it), then one row per
 * non-empty word list from the config files, counted and never listed.
 */
export function ruleRows(c: Config): RuleRow[] {
  const disabled = new Set(c.disabledKinds)
  const rows: RuleRow[] = KIND_IDS.map(id => {
    const p = PATTERNS.find(x => x.id === id)!
    const on = !disabled.has(id)
    return { key: 'rule-' + id, name: p.kind, source: 'built-in', right: on ? p.action : 'off', on }
  })
  if (c.deny.length > 0) {
    rows.push({ key: 'rule-deny-words', name: `${c.deny.length} deny word(s)`, source: 'config', right: `block · ${wordScope(c)}`, on: true })
  }
  if (c.warn.length > 0) {
    rows.push({ key: 'rule-warn-words', name: `${c.warn.length} warn word(s)`, source: 'config', right: `warn · ${wordScope(c)}`, on: true })
  }
  return rows
}

/** The rules in force: rule rows that are on. */
export function activeRules(c: Config): number {
  return ruleRows(c).filter(r => r.on).length
}
