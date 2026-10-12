// Model prices for token-budget's cache figures. Pure: no mods API.
//
// A model id is matched to the first family it contains, longest family first, so
// 'claude-opus-5-5' is opus-5-5 and not opus-5. An unknown model has no price, and the
// figures that need one are left out rather than guessed.

// USD per million tokens, list prices as of 2026-10 (partly confirmed; override with "prices" in ~/.claude/token-budget.json): [family, input, output, cacheRead, cacheWrite1h]
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

/** One family's prices, USD per million tokens: [input, output, cacheRead, cacheWrite1h]. */
export type PriceRow = [number, number, number, number]
/** Families from the config's "prices", replacing or adding to the table. */
export type PriceOverrides = Record<string, PriceRow>

export type Price = { family: string; input: number; output: number; cacheRead: number; cacheWrite1h: number }

/** The table with the overrides applied: a known family is replaced, a new one added. */
export function priceTable(overrides?: PriceOverrides | null): Array<[string, number, number, number, number]> {
  const rows = new Map<string, PriceRow>()
  for (const [family, a, b, c, d] of PRICES) rows.set(family, [a, b, c, d])
  if (overrides && typeof overrides === 'object') {
    for (const family of Object.keys(overrides)) {
      const row = overrides[family]
      if (Array.isArray(row) && row.length === 4) rows.set(family.toLowerCase(), row)
    }
  }
  return [...rows.entries()].map(([family, [a, b, c, d]]) => [family, a, b, c, d])
}

/** The prices of the first family the model id contains, longest family first; null when none matches. */
export function priceOf(model: string | null | undefined, overrides?: PriceOverrides | null): Price | null {
  const id = typeof model === 'string' ? model.toLowerCase() : ''
  if (!id) return null
  const rows = priceTable(overrides).sort((x, y) => y[0].length - x[0].length)
  const row = rows.find(r => id.includes(r[0]))
  if (!row) return null
  return { family: row[0], input: row[1], output: row[2], cacheRead: row[3], cacheWrite1h: row[4] }
}

/** What re-writing `contextTokens` to the cache costs at the model's 1-hour cache-write price; null without a price. */
export function coldWriteUsd(
  contextTokens: number,
  model: string | null | undefined,
  overrides?: PriceOverrides | null,
): number | null {
  const p = priceOf(model, overrides)
  if (!p) return null
  const tokens = typeof contextTokens === 'number' && Number.isFinite(contextTokens) && contextTokens > 0 ? contextTokens : 0
  return (tokens * p.cacheWrite1h) / 1e6
}

/** The fields of a usage object (turn.step's or a model call's) that a price applies to. */
export type UsageLike = {
  input_tokens?: unknown
  output_tokens?: unknown
  cache_read_input_tokens?: unknown
  cache_creation_input_tokens?: unknown
}

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/** What one request cost: input, output, cache reads and cache writes (at the 1-hour rate); null without a price. */
export function requestUsd(
  usage: UsageLike | null | undefined,
  model: string | null | undefined,
  overrides?: PriceOverrides | null,
): number | null {
  const p = priceOf(model, overrides)
  if (!p || !usage || typeof usage !== 'object') return null
  return (
    (n(usage.input_tokens) * p.input +
      n(usage.output_tokens) * p.output +
      n(usage.cache_read_input_tokens) * p.cacheRead +
      n(usage.cache_creation_input_tokens) * p.cacheWrite1h) /
    1e6
  )
}

/** Keeps the well-formed rows of a "prices" config value: `{ family: [in, out, read, write1h] }` or the same as an object. */
export function sanitizePrices(raw: unknown): PriceOverrides | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: PriceOverrides = {}
  let any = false
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    const family = key.trim().toLowerCase()
    if (!family) continue
    const v = (raw as Record<string, unknown>)[key]
    let row: unknown[] | null = null
    if (Array.isArray(v)) row = v
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      row = [o.input, o.output, o.cacheRead, o.cacheWrite1h]
    }
    if (!row || row.length !== 4) continue
    if (!row.every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0)) continue
    out[family] = row as PriceRow
    any = true
  }
  return any ? out : null
}
