// kit.ts: the shared UI kit (kit v3).
//
// The module has no imports and touches no mods API: every helper takes the elements a hook got
// from `$.ui.resolve(e)` and the surface (`e.surface`) and returns an element tree.
//
//   const k = makeKit($.ui.resolve(e) as unknown as Elements, e.surface)
//   return k.stack([k.hero({ kicker: 'right now', title: 'Reading client.test.js' }), k.tiles([...])], 1)
//
// What v2 changed on purpose (v1 painted grey fills and dimmed grey text, unreadable on the desktop):
//   - colors are theme keys (suggestion, success, warning, error, claude, inactive) that the host
//     tunes for light and dark; PALETTE below swaps them for named colors in one line;
//   - no dimColor, no backgroundColor, no yellow, white, gray, black or subtle on content: secondary
//     text is `inactive`, state is a bold `● word` chip (glyph and word, so color is never the only cue);
//   - hero and card are one round frame (paddingX 1), tiles are single-border boxes with the label
//     over a bold value; terminal and desktop draw the same structure (the Svg doodle is desktop-only);
//   - kicker, section and tile labels keep the caller's case (v1 upper-cased kicker and section);
//   - additive: line(label, chips, right?) draws one band line.
//
// Calibration (claude plugin test, Claude Code 2.1.294): the test harness validates the tree a
// ui.render hook returns (a Text with a bogus prop makes `$.ui.mount` reject on both surfaces), but
// not how the desktop paints a theme key. A Button given `plain: false` throws when built (plain and
// autoFocus take only `true`), so the kit leaves false and undefined props out; a Box inside a Text
// is refused. doodle() draws its Svg on the desktop only (a pane holding only an Svg opens empty in
// the terminal).
//
// What v3 adds (strictly additive: every v2 export above renders as before). The desktop paints
// Svg, and its light theme made the v1 fills unreadable, so v3 draws small pictures as Svg wherever
// the element table has one (desktop, mobile, vscode) and as text on the terminal:
//   - pill(text, tone?): a fully rounded Svg chip (PILL 'svg', the default); PILL 'fill' draws a
//     theme-key backgroundColor under `inverseText` instead (the only fill in the kit); the v2
//     `● text` chip on the terminal;
//   - header(label, right?): an upper-cased `inactive` section label with a right-hand count;
//   - icon(name, tone?), typeBadge(fileName) and progress(ratio, opts?): Svg icons, file-type badges
//     and a rounded bar; a glyph, a bold label and the v2 bar on the terminal;
//   - buttons() items take an optional `variant` ('primary' | 'secondary');
//   - nav(items, currentKey): a pane's nav bar, the current item bold Text, the others plain Buttons;
//   - pure helpers: pillSvg, shortPath and extOf; TONE_HEX, the Svg colors of icons and bars, and
//     CHIP_HEX, the darker pill fills that keep white text at 4.5:1 or more.
// Svg markup cannot read theme keys, so it uses fixed mid-tone hexes that read on light and dark
// grounds (never a color word), and each distinct drawing is built once and cached.
//
// What v3.1 adds (spacing; additive): on the desktop, blocks stacked with no gap touch border to
// border and wrapped rows sit line on line. So every wrapping row (buttons, tiles, nav) gets rowGap 1,
// buttons get columnGap 2, and two new columns space a pane out:
//   - page(children): a pane's top-level column, one row between blocks;
//   - list(children): a column of repeated cards or blocks, one row between them.
// Rows inside one card or block stay tight (stack with no gap); stack() keeps its props. Bands that
// draw buttons() are one row, so the new gaps change nothing there. buttons() items also take
// `autoFocus` (passed only when true).

export const KIT_VERSION = '3.1.0'

/** How pill() draws on a surface with Svg: 'svg' (a fully rounded chip) or 'fill' (a theme-key
 *  background). makeKit's `pill` option overrides it for one kit. */
export const PILL: 'fill' | 'svg' = 'svg'

/** kit v3: makeKit's options. `pill` overrides PILL for this kit. */
export type KitOptions = { pill?: 'fill' | 'svg' }

/** 'theme': theme keys that follow the person's light or dark theme. 'named': named colors, for a
 *  host that does not paint theme keys (never yellow: warn is red plus its glyph). One-line switch. */
export const PALETTE: 'theme' | 'named' = 'theme'

export type Surface = 'terminal' | 'desktop' | (string & {})
export type Tone = 'info' | 'ok' | 'warn' | 'danger' | 'muted' | 'accent'
export type Role = 'main' | 'recon' | 'execute' | 'verify' | 'hard' | 'reviewer' | 'other'
export type DoodleState = 'running' | 'done' | 'failed' | 'waiting' | 'idle'
/** The tones of pill() and icon(): the six tones plus violet. */
export type PillTone = Tone | 'violet'
export type IconName =
  | 'eye'
  | 'pencil'
  | 'plus'
  | 'branch'
  | 'search'
  | 'folder'
  | 'folder-open'
  | 'file'
  | 'shield'
  | 'flag'
  | 'check'
  | 'dot'
  | 'clock'
/** What `$.ui.resolve(e)` returns, loosely typed so the kit compiles without the engine's types. */
export type Elements = Record<string, (props: Record<string, unknown>) => unknown>

export type Kit = {
  hero(p: { kicker?: string; title: string; sub?: string; icon?: string; tone?: Tone }): unknown
  card(p: { title?: string; right?: string; tone?: Tone; children: unknown[] }): unknown
  section(label: string, right?: string): unknown
  tiles(items: { label: string; value: string; tone?: Tone }[]): unknown
  badge(text: string, tone?: Tone): unknown
  legend(items: { tone: Tone; label: string }[]): unknown
  bar(ratio: number, opts?: { width?: number; tone?: Tone }): unknown
  /** One row, left side truncating, right side muted. `align: 'center'` (kit v3) centers a row holding a pill. */
  row(p: { left: unknown[] | string; right?: unknown[] | string; key?: string; align?: 'center' }): unknown
  kv(label: string, value: string, tone?: Tone): unknown
  buttons(
    items: {
      key: string
      label: string
      hotkey?: string
      onPress: (e?: unknown) => unknown
      plain?: boolean
      /** kit v3: the Button's variant, passed only when set. */
      variant?: 'primary' | 'secondary'
      /** kit 3.1: focus this Button when the pane opens; passed only when true. */
      autoFocus?: boolean
    }[],
  ): unknown
  doodle(role: Role, state?: DoodleState): unknown
  stack(children: unknown[], gap?: number): unknown
  /** kit 3.1: a pane's top-level column, one row between its blocks; null children are dropped. */
  page(children: unknown[]): unknown
  /** kit 3.1: a column of repeated cards or blocks, one row between them; null children are dropped. */
  list(children: unknown[]): unknown
  text(s: string, props?: Record<string, unknown>): unknown
  /**
   * One band line: `label  ● a  ● b      right · text`. A chip is `{ text, tone? }`, a string (a muted
   * chip) or an element such as badge(); at most four are drawn. `right` is a string or a list
   * joined with ` · `, drawn `inactive` and truncated. One row high.
   */
  line(label: string, chips: unknown[], right?: string | string[]): unknown
  /** kit v3: a rounded chip (Svg surfaces) or the v2 `● text` chip (terminal). */
  pill(text: string, tone?: Tone | 'violet'): unknown
  /** kit v3: one row, the label upper-cased, bold and `inactive`; `right` upper-cased, right-aligned. */
  header(label: string, right?: string): unknown
  /** kit v3: a 16×16 stroke icon (Svg surfaces) or one glyph in the tone (terminal). */
  icon(name: IconName, tone?: Tone | 'violet'): unknown
  /** kit v3: a file-type badge ('JS', 'PDF', …) for a file name; null when the name has no extension. */
  typeBadge(fileName: string): unknown
  /** kit v3: a rounded bar (Svg surfaces; `width` in CSS pixels, absent: the slot's width) or bar(). */
  progress(ratio: number, opts?: { width?: number; tone?: Tone }): unknown
  /**
   * kit v3: a pane's nav bar, one row keyed 'nav': the item whose key is `currentKey` as bold Text in the accent
   * tone (not pressable), the others plain Buttons with their hotkeys (`1: Stage`); one without onPress quiet Text.
   */
  nav(items: { key: string; label: string; hotkey?: string; onPress?: () => unknown }[], currentKey: string): unknown
  surface: Surface
}

/** The quiet color: secondary text, labels, units, timestamps, frame and tile borders. */
const QUIET = 'inactive'

const THEME_TONES: Record<Tone, string> = {
  info: 'suggestion',
  ok: 'success',
  warn: 'warning',
  danger: 'error',
  muted: QUIET,
  accent: 'claude',
}

const NAMED_TONES: Record<Tone, string> = {
  info: 'blue',
  ok: 'green',
  warn: 'red',
  danger: 'red',
  muted: QUIET,
  accent: 'magenta',
}

const TONE_COLORS = PALETTE === 'named' ? NAMED_TONES : THEME_TONES

/** fg: the color of the tone, a theme key (a named color when PALETTE is 'named'). bg equals fg: v2
 *  draws no fills; the field stays so v1 callers compile. */
export const TONES: Record<Tone, { fg: string; bg: string }> = {
  info: { fg: TONE_COLORS.info, bg: TONE_COLORS.info },
  ok: { fg: TONE_COLORS.ok, bg: TONE_COLORS.ok },
  warn: { fg: TONE_COLORS.warn, bg: TONE_COLORS.warn },
  danger: { fg: TONE_COLORS.danger, bg: TONE_COLORS.danger },
  muted: { fg: TONE_COLORS.muted, bg: TONE_COLORS.muted },
  accent: { fg: TONE_COLORS.accent, bg: TONE_COLORS.accent },
}

/**
 * kit v3: the Svg colors of icons and bars, a mid-tone hex per tone that reads on light and dark grounds
 * (Svg markup cannot read theme keys). warn and accent share the Claude orange: the theme's warning
 * color is unreadable as a fill. A pill fills with CHIP_HEX instead.
 *
 *   info #3B82F6   ok #22A35A   warn #D97757   danger #E5484D   accent #D97757   muted #8A8F98
 *   violet #8B5CF6
 */
export const TONE_HEX: Record<PillTone, string> = {
  info: '#3B82F6',
  ok: '#22A35A',
  warn: '#D97757',
  danger: '#E5484D',
  accent: '#D97757',
  muted: '#8A8F98',
  violet: '#8B5CF6',
}

/**
 * kit v3: a pill's fill per tone, darker than TONE_HEX so its white text has a contrast ratio of at
 * least 4.5:1 (WCAG AA for small text). The ratios against white:
 *
 *   info #2563EB 5.17   ok #15803D 5.02   warn #C2410C 5.18   danger #B91C1C 6.47   accent #C2410C 5.18
 *   muted #5B6170 6.20   violet #7C3AED 5.70
 */
export const CHIP_HEX: Record<PillTone, string> = {
  info: '#2563EB',
  ok: '#15803D',
  warn: '#C2410C',
  danger: '#B91C1C',
  accent: '#C2410C',
  muted: '#5B6170',
  violet: '#7C3AED',
}

/** kit v3: the theme key a pill fills with, per tone (warn is 'claude': a 'warning' fill is unreadable). */
const PILL_FILLS: Record<PillTone, string> = {
  info: 'suggestion',
  ok: 'success',
  warn: 'claude',
  danger: 'error',
  accent: 'claude',
  muted: QUIET,
  violet: 'permission',
}

/** kit v3: the stroke of an icon drawn without a tone. */
const ICON_STROKE = '#6B7280'
/** kit v3: the track of progress(): the muted hex at quarter opacity. */
const TRACK_HEX = '#8A8F98'
/** kit v3: the text on a light fill (the amber JS badge); light text everywhere else. */
const INK_DARK = '#1A1A1A'
const INK_LIGHT = '#FFFFFF'

/** kit v3: icon markup on a 16×16 grid, stroked with `currentColor`'s stand-in `S`. */
const ICONS: Record<IconName, string> = {
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  pencil: '<path d="M11 2.5 13.5 5 5.5 13H3v-2.5z"/><path d="M9.5 4 12 6.5"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  branch:
    '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5" r="1.5"/>' +
    '<path d="M4.5 5v6M11.5 6.5c0 2.5-2 3.5-4 3.8-1.6.2-3 .7-3 .7"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>',
  folder: '<path d="M1.75 3.25h4.5l1.5 1.75h6.5v7.75H1.75z"/>',
  'folder-open': '<path d="M1.75 12.75v-9.5h4.5l1.5 1.75h5v2"/><path d="M1.75 12.75 3.75 7h10.5l-2 5.75z"/>',
  file: '<path d="M9 1.75H3v12.5h10v-8.5z"/><path d="M9 1.75v4h4"/>',
  shield: '<path d="M8 1.75 13 3.75v4c0 3.2-2.2 5.4-5 6.5-2.8-1.1-5-3.3-5-6.5v-4z"/>',
  flag: '<path d="M3 14.5V2"/><path d="M3 2.5h8.5L9.75 5.5l1.75 3H3"/>',
  check: '<path d="M3 8.5 6 11.5 13 4.5"/>',
  dot: '<circle cx="8" cy="8" r="3" fill="S"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
}

/** kit v3: the terminal glyph of each icon. */
const ICON_GLYPHS: Record<IconName, string> = {
  eye: '◉',
  pencil: '✎',
  plus: '+',
  branch: '⎇',
  search: '⌕',
  folder: '▸',
  'folder-open': '▾',
  file: '·',
  shield: '⛨',
  flag: '⚑',
  check: '✓',
  dot: '●',
  clock: '◷',
}

/** kit v3: file-type badges by extension: the label, its Svg fill and its terminal tone. */
const FILE_TYPES: { exts: string[]; label: string; fill: string; tone: Tone }[] = [
  { exts: ['js', 'jsx', 'mjs', 'cjs'], label: 'JS', fill: '#F0C419', tone: 'accent' },
  { exts: ['ts', 'tsx'], label: 'TS', fill: '#3178C6', tone: 'info' },
  { exts: ['pdf'], label: 'PDF', fill: '#E5484D', tone: 'danger' },
  { exts: ['md', 'mdx'], label: 'MD', fill: '#4A7BD0', tone: 'info' },
  { exts: ['doc', 'docx'], label: 'DOC', fill: '#2B579A', tone: 'info' },
  { exts: ['csv'], label: 'CSV', fill: '#22A35A', tone: 'ok' },
  { exts: ['json'], label: 'JSON', fill: '#64748B', tone: 'muted' },
  { exts: ['yml', 'yaml'], label: 'YML', fill: '#64748B', tone: 'muted' },
  { exts: ['html'], label: 'HTML', fill: '#E8743B', tone: 'accent' },
  { exts: ['css'], label: 'CSS', fill: '#4A7BD0', tone: 'info' },
  { exts: ['py'], label: 'PY', fill: '#3776AB', tone: 'info' },
  { exts: ['sh'], label: 'SH', fill: '#64748B', tone: 'muted' },
  { exts: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'], label: 'IMG', fill: '#8B5CF6', tone: 'accent' },
  { exts: ['txt'], label: 'TXT', fill: '#64748B', tone: 'muted' },
]
const OTHER_FILL = '#64748B'

const GLYPHS: Record<Role, string> = {
  main: '◉',
  recon: '◈',
  execute: '▣',
  verify: '✓',
  hard: '◆',
  reviewer: '◎',
  other: '●',
}

const STATE_TONES: Record<DoodleState, Tone> = {
  running: 'info',
  done: 'ok',
  failed: 'danger',
  waiting: 'warn',
  idle: 'muted',
}

const STATE_COLORS: Record<DoodleState, string> = {
  running: TONES[STATE_TONES.running].fg,
  done: TONES[STATE_TONES.done].fg,
  failed: TONES[STATE_TONES.failed].fg,
  waiting: TONES[STATE_TONES.waiting].fg,
  idle: TONES[STATE_TONES.idle].fg,
}

// Desktop doodles (svg fills are not text colors, so they stay hex): 12×12 cells, 3 px each. B = body (by role), A = accent (by state), . = empty.
const BODY_FILL: Record<Role, string> = {
  main: '#6c63ff',
  recon: '#1f9eaa',
  execute: '#3b7ddd',
  verify: '#2f9e55',
  hard: '#b5523b',
  reviewer: '#c08a1e',
  other: '#7d8590',
}

const ACCENT_FILL: Record<DoodleState, string> = {
  running: '#22d3ee',
  done: '#4ade80',
  failed: '#f87171',
  waiting: '#facc15',
  idle: '#e5e7eb',
}

const SPRITES: Record<Role, string[]> = {
  // a crowned blob
  main: [
    '............',
    '..A..AA..A..',
    '..AAAAAAAA..',
    '..BBBBBBBB..',
    '.BBBBBBBBBB.',
    '.BBAABBAABB.',
    '.BBAABBAABB.',
    '.BBBBBBBBBB.',
    '.BBBAAAABBB.',
    '.BBBBBBBBBB.',
    '..BB....BB..',
    '..BB....BB..',
  ],
  // a one-eyed scout drone
  recon: [
    '....BBBB....',
    '..BBBBBBBB..',
    '.BBBBBBBBBB.',
    'BBBBAAAABBBB',
    'BBBAAAAAABBB',
    'BBBAA..AABBB',
    'BBBAAAAAABBB',
    'BBBBAAAABBBB',
    '.BBBBBBBBBB.',
    '..BBBBBBBB..',
    '...B.BB.B...',
    '..B..BB..B..',
  ],
  // a boxy robot with an antenna
  execute: [
    '.....AA.....',
    '.....BB.....',
    '.BBBBBBBBBB.',
    '.BBBBBBBBBB.',
    '.BBAABBAABB.',
    '.BBAABBAABB.',
    '.BBBBBBBBBB.',
    '.BBAAAAAABB.',
    '.BBBBBBBBBB.',
    '...BBBBBB...',
    '..BBB..BBB..',
    '..BB....BB..',
  ],
  // a shield with a check mark
  verify: [
    '.BBBBBBBBBB.',
    'BBBBBBBBBBBB',
    'BBBBBBBBBBBB',
    'BBBBBBBBBAAB',
    'BBBBBBBBAABB',
    'BAABBBBAABBB',
    'BBAABBAABBBB',
    '.BBAAAABBBB.',
    '.BBBAABBBBB.',
    '..BBBBBBBB..',
    '...BBBBBB...',
    '.....BB.....',
  ],
  // a gem golem
  hard: [
    '.....BB.....',
    '....BBBB....',
    '...BBBBBB...',
    '..BBBBBBBB..',
    '.BBAABBAABB.',
    'BBBAABBAABBB',
    'BBBBBBBBBBBB',
    '.BBBBAABBBB.',
    '..BBBBBBBB..',
    '...BBBBBB...',
    '....BBBB....',
    '.....BB.....',
  ],
  // a round face with glasses
  reviewer: [
    '...BBBBBB...',
    '..BBBBBBBB..',
    '.BBBBBBBBBB.',
    'BBBBBBBBBBBB',
    'BAAAABBAAAAB',
    'BA..AAAA..AB',
    'BAAAABBAAAAB',
    'BBBBBBBBBBBB',
    'BBBBAAAABBBB',
    '.BBBBBBBBBB.',
    '..BBBBBBBB..',
    '...BBBBBB...',
  ],
  // a ghost
  other: [
    '....BBBB....',
    '..BBBBBBBB..',
    '.BBBBBBBBBB.',
    '.BBBBBBBBBB.',
    'BBBAABBAABBB',
    'BBBAABBAABBB',
    'BBBBBBBBBBBB',
    'BBBBBBBBBBBB',
    'BBBBBBBBBBBB',
    'BBBBBBBBBBBB',
    'BBB.BBBB.BBB',
    'B....BB....B',
  ],
}

const CELL = 3
const GRID = 12

// ---------------------------------------------------------------- formatters

/** '≈$0.08', '≈$1.2', '≈$12'; '$0' for zero, '<$0.01' below a cent, '—' when unknown. */
export function money(usd: number | null | undefined): string {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return '—'
  const v = Math.max(0, usd)
  if (v === 0) return '$0'
  if (v < 0.005) return '<$0.01'
  const cents = Math.round(v * 100) / 100
  if (cents < 1) return '≈$' + cents.toFixed(2)
  const dimes = Math.round(v * 10) / 10
  if (dimes < 10) return '≈$' + dimes.toFixed(1)
  return '≈$' + String(Math.round(v))
}

/** '0', '950', '1.5k', '37k', '1.2M', '15M'. */
export function tokensShort(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  const k = n / 1000
  if (k < 10) {
    const r = Math.round(k * 10) / 10
    if (r < 10) return trimZero(r.toFixed(1)) + 'k'
  }
  if (Math.round(k) < 1000) return String(Math.round(k)) + 'k'
  const m = n / 1_000_000
  const r = Math.round(m * 10) / 10
  if (r < 10) return trimZero(r.toFixed(1)) + 'M'
  return String(Math.round(m)) + 'M'
}

/** '0:40', '10:05', '1:02:03'. */
export function clock(ms: number): string {
  const total = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`
  return `${m}:${pad2(s)}`
}

/** '4%', '100%'. Not capped at 100 (a budget can run over); negative and NaN read 0%. */
export function pct(ratio: number): string {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) return '0%'
  return String(Math.round(ratio * 100)) + '%'
}

/** '━━━━╌╌╌╌╌╌' for 0.4 at width 10; the ratio is clamped to 0..1. */
export function barText(ratio: number, width: number = 10): string {
  const w = typeof width === 'number' && Number.isFinite(width) && width >= 1 ? Math.floor(width) : 10
  const filled = Math.round(clamp01(ratio) * w)
  return '━'.repeat(filled) + '╌'.repeat(w - filled)
}

function clamp01(ratio: number): number {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return 0
  return Math.min(1, Math.max(0, ratio))
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

function toneOf(tone: unknown, fallback: Tone): Tone {
  return typeof tone === 'string' && Object.prototype.hasOwnProperty.call(TONES, tone) ? (tone as Tone) : fallback
}

function roleOf(role: unknown): Role {
  return typeof role === 'string' && Object.prototype.hasOwnProperty.call(GLYPHS, role) ? (role as Role) : 'other'
}

function stateOf(state: unknown): DoodleState {
  return typeof state === 'string' && Object.prototype.hasOwnProperty.call(STATE_COLORS, state)
    ? (state as DoodleState)
    : 'idle'
}

/** Drops undefined and false props: some props (Button plain, autoFocus) take only `true`. */
function clean(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(props)) {
    const v = props[k]
    if (v === undefined || v === false) continue
    out[k] = v
  }
  return out
}

function present(children: unknown[]): unknown[] {
  return children.filter(c => c !== null && c !== undefined && c !== false && c !== '')
}

/** The SVG document of one doodle: a 12×12 sprite at 3 px per cell, runs merged per row. */
export function doodleSvg(role: Role, state: DoodleState = 'idle'): string {
  const r = roleOf(role)
  const s = stateOf(state)
  const fills: Record<string, string> = { B: BODY_FILL[r], A: ACCENT_FILL[s] }
  const size = GRID * CELL
  let rects = ''
  SPRITES[r].forEach((line, y) => {
    let x = 0
    while (x < GRID) {
      const ch = line[x] ?? '.'
      let end = x + 1
      while (end < GRID && line[end] === ch) end++
      const fill = fills[ch]
      if (fill) {
        rects += `<rect x="${x * CELL}" y="${y * CELL}" width="${(end - x) * CELL}" height="${CELL}" fill="${fill}"/>`
      }
      x = end
    }
  })
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" ` +
    `shape-rendering="crispEdges">${rects}</svg>`
  )
}

/** The terminal glyph of a role, as doodle() draws it and as the desktop doodle's alt text. */
export function glyph(role: Role): string {
  return GLYPHS[roleOf(role)]
}

// ---------------------------------------------------------------- kit v3: pure helpers and Svg

/** 'ts' for 'src/a.test.TS', '' for 'Makefile', '.gitignore' or 'notes.'. Lower case, no dot. */
export function extOf(name: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * A path for display: inside `root` it is relative ('.' for the root itself), inside `home` it is
 * '~/' and the rest, anywhere else '…/' and its last two segments, so no absolute path from outside
 * the project is drawn. A relative path is already short and comes back as given. Trailing slashes
 * are dropped.
 */
export function shortPath(path: string, root: string, home: string): string {
  const p = trimSlash(path)
  const r = trimSlash(root)
  const h = trimSlash(home)
  if (!p.startsWith('/')) return p
  if (r && p === r) return '.'
  if (r && r !== '/' && p.startsWith(r + '/')) return p.slice(r.length + 1)
  if (h && p === h) return '~'
  if (h && h !== '/' && p.startsWith(h + '/')) return '~/' + p.slice(h.length + 1)
  return '…/' + p.split('/').filter(Boolean).slice(-2).join('/')
}

function trimSlash(s: string): string {
  const t = String(s ?? '')
  return t.length > 1 ? t.replace(/\/+$/, '') || '/' : t
}

const SVG_CACHE = new Map<string, string>()
const SVG_CACHE_MAX = 512

/** Builds each distinct drawing once; the cache is cleared when it grows past its bound. */
function cached(key: string, build: () => string): string {
  const hit = SVG_CACHE.get(key)
  if (hit !== undefined) return hit
  if (SVG_CACHE.size >= SVG_CACHE_MAX) SVG_CACHE.clear()
  const svg = build()
  SVG_CACHE.set(key, svg)
  return svg
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Dark text on a light fill (relative luminance above one half), light text otherwise. */
function inkOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const lin = (c: number) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  return l > 0.5 ? INK_DARK : INK_LIGHT
}

function pillToneOf(tone: unknown, fallback: PillTone): PillTone {
  return typeof tone === 'string' && Object.prototype.hasOwnProperty.call(TONE_HEX, tone) ? (tone as PillTone) : fallback
}

function iconOf(name: unknown): IconName {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(ICONS, name) ? (name as IconName) : 'dot'
}

const FONT = 'font-family="system-ui,-apple-system,Segoe UI,sans-serif"'

/** A label in a rounded rect: the shape of a pill (height 18) and of a type badge (height 16). */
function labelSvg(text: string, fill: string, width: number, height: number, rx: number, size: number, ink = inkOn(fill)): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" rx="${rx}" fill="${fill}"/>` +
    `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" dominant-baseline="central" ${FONT} ` +
    `font-size="${size}" font-weight="700" fill="${ink}">${xml(text)}</text></svg>`
  )
}

/** A pill's height in CSS pixels; its corners are fully rounded (rx = height / 2). */
const PILL_HEIGHT = 18

/** A pill's width in CSS pixels: about 6.5 per character of 11 px bold text plus 7 each side. */
function pillWidth(text: string): number {
  return Math.max(PILL_HEIGHT, Math.round(text.length * 6.5 + 14))
}

/** The Svg of a pill: a fully rounded rect in the tone's CHIP_HEX fill, white text. */
export function pillSvg(text: string, tone: Tone | 'violet' = 'muted'): string {
  const t = pillToneOf(tone, 'muted')
  const s = String(text)
  return cached(`pill|${t}|${s}`, () => labelSvg(s, CHIP_HEX[t], pillWidth(s), PILL_HEIGHT, PILL_HEIGHT / 2, 11, INK_LIGHT))
}

function iconSvg(name: IconName, hex: string): string {
  return cached(`icon|${name}|${hex}`, () =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" ` +
    `stroke="${hex}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">` +
    `${ICONS[name].replace(/"S"/g, `"${hex}"`)}</svg>`,
  )
}

function fileType(fileName: string): { label: string; fill: string; tone: Tone } | null {
  const ext = extOf(fileName)
  if (!ext) return null
  const known = FILE_TYPES.find(t => t.exts.includes(ext))
  return known ?? { label: ext.slice(0, 3).toUpperCase(), fill: OTHER_FILL, tone: 'muted' }
}

/** A type badge is 16 high and about 7 px per letter plus 8 wide. */
function badgeWidth(label: string): number {
  return Math.max(16, label.length * 7 + 8)
}

function badgeSvg(label: string, fill: string): string {
  return cached(`badge|${label}|${fill}`, () => labelSvg(label, fill, badgeWidth(label), 16, 3, 10))
}

/** A track and a fill, 6 high. Without a width the markup is 100% wide and stretches to the slot. */
function progressSvg(ratio: number, hex: string, width: number | undefined): string {
  const full = width ?? 100
  const fill = Math.round(clamp01(ratio) * full * 10) / 10
  return cached(`progress|${fill}|${hex}|${width ?? ''}`, () => {
    const size = width === undefined ? 'width="100%" height="6" preserveAspectRatio="none"' : `width="${width}" height="6"`
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} 6" ${size}>` +
      `<rect width="${full}" height="6" rx="3" fill="${TRACK_HEX}" opacity="0.25"/>` +
      (fill > 0 ? `<rect width="${fill}" height="6" rx="3" fill="${hex}"/>` : '') +
      `</svg>`
    )
  })
}

// ---------------------------------------------------------------- the kit

const MAX_CHIPS = 4

export function makeKit(ui: Elements, surface: Surface, opts: KitOptions = {}): Kit {
  const desktop = surface === 'desktop'
  const pillMode = opts.pill ?? PILL

  const el = (type: string, props: Record<string, unknown>, children?: unknown[]): unknown => {
    const make = ui[type]
    const p = clean(props)
    if (children !== undefined) p.children = present(children)
    return make(p)
  }
  const T = (s: string, props: Record<string, unknown> = {}): unknown => el('Text', props, [s])
  const color = (tone: Tone | undefined): string | undefined => (tone ? TONES[tone].fg : undefined)
  const pieces = (part: unknown[] | string, right: boolean): unknown[] =>
    (typeof part === 'string' ? [part] : part).map(c =>
      typeof c === 'string' || typeof c === 'number'
        ? T(String(c), { color: right ? QUIET : undefined, wrap: 'truncate' })
        : c,
    )
  const frame = (children: unknown[], tone: Tone | undefined): unknown =>
    el('Box', { flexDirection: 'column', borderStyle: 'round', borderColor: color(tone) ?? QUIET, paddingX: 1 }, children)
  const chip = (text: string, tone: Tone): unknown =>
    T('● ' + text, { color: TONES[tone].fg, bold: tone !== 'muted', wrap: 'truncate' })
  // kit v3: Svg wherever the table has it (desktop, mobile, vscode); the terminal draws text.
  const svgOk = surface !== 'terminal' && typeof ui.Svg === 'function'
  const svg = (source: string, alt: string, width?: number, height?: number): unknown =>
    el('Svg', { source, alt: alt || ' ', width, height })
  /** The theme key of a v3 tone on the terminal: the v2 tone's color, violet 'permission'. */
  const fg = (tone: PillTone): string => (tone === 'violet' ? PILL_FILLS.violet : TONES[tone].fg)

  const kit: Kit = {
    surface,

    hero(p) {
      const tone = p.tone ? toneOf(p.tone, 'info') : undefined
      const title = (p.icon ? p.icon + ' ' : '') + p.title
      return frame(
        [
          p.kicker ? T(p.kicker, { color: QUIET, wrap: 'truncate' }) : null,
          T(title, { bold: true, color: color(tone), wrap: 'truncate' }),
          p.sub ? T(p.sub, { color: QUIET, wrap: 'wrap' }) : null,
        ],
        tone,
      )
    },

    card(p) {
      const tone = p.tone ? toneOf(p.tone, 'info') : undefined
      const head =
        p.title || p.right
          ? el('Box', { flexDirection: 'row', justifyContent: 'space-between', columnGap: 1 }, [
              p.title ? T(p.title, { bold: true, wrap: 'truncate' }) : null,
              p.right ? T(p.right, { color: QUIET, wrap: 'truncate' }) : null,
            ])
          : null
      return frame([head, ...(Array.isArray(p.children) ? p.children : [])], tone)
    },

    section(label, right) {
      return el('Box', { flexDirection: 'row', justifyContent: 'space-between', columnGap: 1 }, [
        T(String(label), { bold: true, wrap: 'truncate' }),
        right ? T(right, { color: QUIET, wrap: 'truncate' }) : null,
      ])
    },

    tiles(items) {
      return el(
        'Box',
        { flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, rowGap: 1 },
        items.map(it => {
          const tone = it.tone ? toneOf(it.tone, 'info') : undefined
          return el(
            'Box',
            { flexDirection: 'column', flexGrow: 1, borderStyle: 'single', borderColor: QUIET, paddingX: 1 },
            [
              T(it.label, { color: QUIET, wrap: 'truncate' }),
              T(it.value, { bold: true, color: color(tone), wrap: 'truncate' }),
            ],
          )
        }),
      )
    },

    badge(text, tone) {
      return chip(text, toneOf(tone, 'muted'))
    },

    legend(items) {
      const parts: unknown[] = []
      items.forEach((it, i) => {
        if (i > 0) parts.push('  ')
        parts.push(T('●', { color: TONES[toneOf(it.tone, 'muted')].fg }))
        parts.push(' ' + it.label)
      })
      return el('Text', { wrap: 'wrap' }, parts)
    },

    bar(ratio, opts = {}) {
      const t = toneOf(opts.tone, 'info')
      return el('Text', { wrap: 'truncate' }, [
        T(barText(ratio, opts.width ?? 10), { color: TONES[t].fg }),
        T(' ' + pct(ratio), { color: QUIET }),
      ])
    },

    row(p) {
      const left = pieces(p.left, false)
      const right = p.right === undefined || p.right === '' ? [] : pieces(p.right, true)
      const alignItems = p.align === 'center' ? 'center' : undefined
      return el('Box', { key: p.key, flexDirection: 'row', justifyContent: 'space-between', alignItems, columnGap: 1 }, [
        el('Box', { flexDirection: 'row', flexShrink: 1, alignItems, columnGap: 1 }, left),
        right.length ? el('Box', { flexDirection: 'row', alignItems, columnGap: 1 }, right) : null,
      ])
    },

    kv(label, value, tone) {
      const t = tone ? toneOf(tone, 'info') : undefined
      return el('Text', { wrap: 'truncate' }, [
        T(label + ' ', { color: QUIET }),
        T(value, { bold: true, color: color(t) }),
      ])
    },

    buttons(items) {
      return el(
        'Box',
        { flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, rowGap: 1 },
        items.map(b =>
          el('Button', {
            key: b.key,
            label: b.label,
            hotkey: b.hotkey,
            onPress: b.onPress,
            plain: b.plain === true ? true : undefined,
            variant: b.variant === 'primary' || b.variant === 'secondary' ? b.variant : undefined,
            autoFocus: b.autoFocus === true ? true : undefined,
          }),
        ),
      )
    },

    doodle(role, state = 'idle') {
      const r = roleOf(role)
      const s = stateOf(state)
      if (desktop && typeof ui.Svg === 'function') {
        return el('Svg', { alt: GLYPHS[r], width: GRID * CELL, height: GRID * CELL, source: doodleSvg(r, s) })
      }
      return T(GLYPHS[r], { color: STATE_COLORS[s], bold: s === 'running' })
    },

    stack(children, gap = 0) {
      return el('Box', { flexDirection: 'column', rowGap: gap > 0 ? Math.floor(gap) : undefined }, children)
    },

    page(children) {
      return el('Box', { flexDirection: 'column', rowGap: 1 }, Array.isArray(children) ? children : [])
    },

    list(children) {
      return el('Box', { flexDirection: 'column', rowGap: 1 }, Array.isArray(children) ? children : [])
    },

    text(s, props = {}) {
      return el('Text', props, [String(s)])
    },

    line(label, chips, right) {
      const drawn = (Array.isArray(chips) ? chips : [])
        .filter(c => c !== null && c !== undefined && c !== false && c !== '')
        .slice(0, MAX_CHIPS)
        .map(c => {
          if (typeof c === 'string') return chip(c, 'muted')
          if (isChipSpec(c)) return chip(c.text, toneOf(c.tone, 'muted'))
          return c
        })
      const quiet = (Array.isArray(right) ? right.filter(Boolean).join(' · ') : right ?? '').trim()
      return el('Box', { flexDirection: 'row', justifyContent: 'space-between', columnGap: 2 }, [
        el('Box', { flexDirection: 'row', flexShrink: 1, columnGap: 2 }, [
          T(String(label), { bold: true, wrap: 'truncate' }),
          ...drawn,
        ]),
        quiet ? T(quiet, { color: QUIET, wrap: 'truncate' }) : null,
      ])
    },

    // ------------------------------------------------------------ kit v3

    pill(text, tone) {
      const t = pillToneOf(tone, 'muted')
      const s = String(text)
      if (!svgOk) return t === 'violet' ? T('● ' + s, { color: fg(t), bold: true, wrap: 'truncate' }) : chip(s, t)
      if (pillMode === 'svg') return svg(pillSvg(s, t), s, pillWidth(s), PILL_HEIGHT)
      return T(` ${s} `, { backgroundColor: PILL_FILLS[t], color: 'inverseText', bold: true, wrap: 'truncate' })
    },

    header(label, right) {
      return el('Box', { flexDirection: 'row', justifyContent: 'space-between', columnGap: 1 }, [
        T(String(label).toUpperCase(), { bold: true, color: QUIET, wrap: 'truncate' }),
        right ? T(String(right).toUpperCase(), { color: QUIET, wrap: 'truncate' }) : null,
      ])
    },

    icon(name, tone) {
      const n = iconOf(name)
      const t = tone === undefined ? undefined : pillToneOf(tone, 'muted')
      if (svgOk) return svg(iconSvg(n, t ? TONE_HEX[t] : ICON_STROKE), n, 16, 16)
      return T(ICON_GLYPHS[n], { color: t ? fg(t) : QUIET })
    },

    typeBadge(fileName) {
      const type = fileType(fileName)
      if (!type) return null
      if (svgOk) {
        return svg(badgeSvg(type.label, type.fill), type.label, badgeWidth(type.label), 16)
      }
      return T(type.label, { bold: true, color: TONES[type.tone].fg })
    },

    progress(ratio, opts = {}) {
      if (!svgOk) return kit.bar(ratio, opts)
      const t = toneOf(opts.tone, 'info')
      const width = typeof opts.width === 'number' && Number.isFinite(opts.width) && opts.width >= 1 ? Math.floor(opts.width) : undefined
      // Without a width the Svg gets no width prop and markup 100% wide: the user's look confirms the
      // desktop draws it the full width of its slot.
      return svg(progressSvg(ratio, TONE_HEX[t], width), pct(ratio), width, 6)
    },

    nav(items, currentKey) {
      return el(
        'Box',
        { key: 'nav', flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, rowGap: 1 },
        (Array.isArray(items) ? items : []).map(it => {
          if (it.key === currentKey) return T(String(it.label), { bold: true, color: TONES.accent.fg, wrap: 'truncate' })
          if (typeof it.onPress !== 'function') return T(String(it.label), { color: QUIET, wrap: 'truncate' })
          return el('Button', { key: it.key, label: String(it.label), hotkey: it.hotkey, onPress: it.onPress, plain: true })
        }),
      )
    },
  }
  return kit
}

function isChipSpec(c: unknown): c is { text: string; tone?: Tone } {
  return (
    typeof c === 'object' &&
    c !== null &&
    !('type' in c) &&
    typeof (c as { text?: unknown }).text === 'string'
  )
}
