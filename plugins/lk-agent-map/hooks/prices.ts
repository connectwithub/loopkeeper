// Model prices for agent-map's cost estimates. Pure: nothing here touches `$`.
import type { PriceRow, TokenCounts } from '../types'

// USD per million tokens, list prices as of 2026-10 (partly confirmed; override with "prices" in ~/.claude/agent-map.json): [family, input, output, cacheRead, cacheWrite1h]
export const PRICES: Array<[string, number, number, number, number]> = [
  ['fable-5-1', 10, 50, 1.0, 20],
  ['opus-5-5', 4, 20, 0.2, 8],
  ['opus-5', 5, 25, 0.5, 10],
  ['opus-4', 5, 25, 0.5, 10],
  ['sonnet-5-5', 2, 10, 0.2, 4],
  ['sonnet-5', 2, 10, 0.2, 4],
  ['sonnet', 3, 15, 0.3, 6],
  ['haiku-5-5', 1, 5, 0.1, 2],
  ['haiku', 1, 5, 0.1, 2],
]

export const PRICES_DATE = '2026-10'

export type Price = { family: string; input: number; output: number; cacheRead: number; cacheWrite: number }

/** A model id as the table matches it: lower case, dots as dashes (`claude-opus-4.5` reads as `claude-opus-4-5`). */
function normal(model: string): string {
  return String(model || '').toLowerCase().replace(/\./g, '-')
}

/** The price of the first family the model id contains, longest family names first; null when none matches. */
export function priceOf(model: string, table: readonly PriceRow[] = PRICES): Price | null {
  const id = normal(model)
  if (!id) return null
  const rows = [...table].sort((a, b) => b[0].length - a[0].length)
  for (const [family, input, output, cacheRead, cacheWrite] of rows) {
    if (family && id.includes(family)) return { family, input, output, cacheRead, cacheWrite }
  }
  return null
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** input×in + output×out + cacheRead×read + cacheCreate×write, per million tokens; null for a model the table doesn't know. */
export function costUsd(tokens: TokenCounts | undefined, model: string, table: readonly PriceRow[] = PRICES): number | null {
  const p = priceOf(model, table)
  if (!p) return null
  const t = tokens ?? { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
  return (n(t.input) * p.input + n(t.output) * p.output + n(t.cacheRead) * p.cacheRead + n(t.cacheCreate) * p.cacheWrite) / 1_000_000
}

const okPrice = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** One override row: `[in, out, cacheRead, cacheWrite]` or `{ input, output, cacheRead, cacheWrite }`. */
function rowOf(family: string, v: unknown): PriceRow | undefined {
  if (Array.isArray(v)) {
    const [i, o, r, w] = v
    return v.length === 4 && okPrice(i) && okPrice(o) && okPrice(r) && okPrice(w) ? [family, i, o, r, w] : undefined
  }
  if (v && typeof v === 'object') {
    const x = v as Record<string, unknown>
    return okPrice(x.input) && okPrice(x.output) && okPrice(x.cacheRead) && okPrice(x.cacheWrite)
      ? [family, x.input, x.output, x.cacheRead, x.cacheWrite]
      : undefined
  }
  return undefined
}

/**
 * Lays the valid rows of a config file's `prices` object over `base`, by family:
 * `{ "opus-5-5": [4, 20, 0.2, 8], "my-model": { "input": 1, "output": 5, "cacheRead": 0.1, "cacheWrite": 2 } }`.
 * A family the table lacks is added; anything malformed is ignored.
 */
export function mergePrices(base: readonly PriceRow[], over: unknown): PriceRow[] {
  const out: PriceRow[] = base.map(r => [...r] as PriceRow)
  if (!over || typeof over !== 'object' || Array.isArray(over)) return out
  for (const [rawFamily, v] of Object.entries(over as Record<string, unknown>)) {
    const family = normal(rawFamily).trim()
    if (!family) continue
    const row = rowOf(family, v)
    if (!row) continue
    const i = out.findIndex(r => r[0] === family)
    if (i >= 0) out[i] = row
    else out.push(row)
  }
  return out
}
