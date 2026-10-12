# 0013. Kit v3: Svg pictures and theme-key fills

- Status: accepted, amended (see the end)
- Date: 2026-10-11

## Context and Problem Statement

Kit v2 ([ADR 0008](0008-kit-v2-readable-ui.md)) made the panes readable in both themes by dropping every fill: state is a bold `● word` chip, and frames are round borders. A look at the desktop in the light theme found the Files and Gates panes reading as plain text. File types, outcomes and actions all looked alike, and there was no picture to scan for.

What Claude Code 2.1.294 offers:

- An `Svg` element (source up to 131072 characters, `alt`, optional `width` and `height`) on the desktop, mobile and vscode surfaces, but not on the terminal. The desktop paints it: kit v2's Svg doodle already draws there.
- Svg markup cannot read theme keys. A colour inside the markup is fixed whatever the theme.
- `Text` paints `backgroundColor` and `color` with theme keys, among them `inverseText`. The theme's `warning` colour is unreadable as a fill: it is yellow in the dark theme.

## Considered Options

1. Keep v2: text only on every surface.
2. Bring back v1's background fills across the panes.
3. Small Svg pictures (icons, file-type badges, progress bars) where the surface has `Svg`, a theme-key fill for pills only, and text on the terminal.
4. As 3, but pills drawn as rounded-rect Svg too.

## Decision Outcome

Chosen option: 3, with option 4 one switch away, because it brings the pictures back without the fills that made v1 unreadable, and the terminal keeps v2's text.

- Svg is drawn only when `surface !== 'terminal' && typeof ui.Svg === 'function'`. The terminal draws a glyph, a bold label or v2's bar instead.
- `pill(text, tone?)`: a `Text` with a theme-key `backgroundColor` under `color: 'inverseText'`, bold, padded by one space. It is the only fill in the kit. The fills are `suggestion` (info), `success` (ok), `claude` (warn and accent), `error` (danger), `inactive` (muted) and `permission` (violet). Warn uses `claude` because the `warning` fill is unreadable. `PILL = 'fill' | 'svg'` in `plugins/loopkeeper/hooks/lib/kit.ts` switches pills to a rounded-rect Svg (`pillSvg`). On the terminal a pill is v2's `● text` chip.
- `header(label, right?)`: a section label, upper-cased, bold and `inactive`, with a right-hand count.
- `icon(name, tone?)`: a 16×16 stroke icon (eye, pencil, plus, branch, search, folder, folder-open, file, shield, flag, check, dot, clock).
- `typeBadge(fileName)`: a file-type badge (`JS`, `PDF`, …); `null` for a name with no extension.
- `progress(ratio, { width?, tone? })`: a rounded bar. `width` is in CSS pixels; without it the bar takes the width of its slot.
- `buttons()` items accept `variant: 'primary' | 'secondary'`. `nav(items, currentKey)` draws a pane's nav bar ([ADR 0014](0014-hub-and-keys.md)).
- Pure helpers: `pillSvg`, `extOf`, and `shortPath(path, root, home)` (relative paths unchanged; home itself is `~`).
- Svg colours are fixed mid-tone hexes in one table, `TONE_HEX`, chosen to read on light and dark grounds: info `#3B82F6`, ok `#22A35A`, warn and accent `#D97757`, danger `#E5484D`, muted `#8A8F98`, violet `#8B5CF6`. Never a colour word. Pills fill from a second table, `CHIP_HEX`, darker so their white text keeps a contrast ratio of at least 4.5:1: info `#2563EB`, ok `#15803D`, warn and accent `#C2410C`, danger `#B91C1C`, muted `#5B6170`, violet `#7C3AED`. Each distinct drawing is built once and cached; the cache is cleared when it reaches 512 drawings.
- Additive: `KIT_VERSION` is `3.0.0` and every v2 export renders as before. `kit.ts` has no imports and names no plugin, so other plugins copy it verbatim.
- No Svg in any band. The band lines are unchanged and read the same on every surface.
- Users: the Files pane (a hero with an icon, the branch row, the search field's icon, file-type badges, pills, headers with counts, short folders), the Gates pane (a shield icon, headers with counts, pills for protected-path actions and decision outcomes, type badges for the turn's files, short paths), the Review pane (priority pills, a progress bar), the Stage pane (a progress bar), and every loopkeeper pane's nav bar.

### Consequences

- Good: on the desktop the panes show file types, outcomes and progress at a glance, in both themes.
- Good: the terminal output is unchanged in structure and has no Svg; tests mount both surfaces.
- Good: one switch (`PILL`) moves pills from theme fills to Svg if a host paints fills badly.
- Bad: Svg colours do not follow the theme. The mid-tone hexes are a compromise between light and dark grounds.
- Bad: the test harness checks the element tree, not how the desktop paints it. Svg surfaces are tested through their `alt` text.

## Amendment: Svg chips by default

- Date: 2026-10-11

A look at the desktop app found every pill (`Not committed`, `ask` and `deny`, `p0` to `p2`, `Reading`) drawn as a square filled box. The person asked for chips with rounded borders, and option 4 was one switch away.

- `PILL` is now `'svg'`. On a surface with `Svg`, `pill(text, tone?)` draws `pillSvg`: a fully rounded rect (`rx` is half the height), 18 px high, as wide as the text needs (about 6.5 px a character plus 7 px each side, at least 18), with the text in 11 px bold white on the tone's `CHIP_HEX` fill. The `Svg` element carries that width and height, and its `alt` is the pill's text.
- The two hex tables keep their jobs: `TONE_HEX` (mid-tones) for icons and bars, `CHIP_HEX` (darker) for chip fills. Against white text the `CHIP_HEX` ratios are info `#2563EB` 5.17, ok `#15803D` 5.02, warn and accent `#C2410C` 5.18, danger `#B91C1C` 6.47, muted `#5B6170` 6.20 and violet `#7C3AED` 5.70, all above the 4.5:1 of WCAG AA for small text.
- The theme-key fill stays behind the switch: `PILL = 'fill'`, or `makeKit`'s `pill` option for one kit, draws the `Text` pill described above.
- The terminal is unchanged: a pill is `● text` in its tone. Bands still draw no Svg.
- Every pane's pills follow (Files, Gates, Review); tests check the Svg chip through its `alt` text and its size.

### Consequences of the amendment

- Good: a pill reads as a chip on the desktop, mobile and VS Code, in both themes, with its text at 4.5:1 or more.
- Bad: chip colours do not follow the theme, like the other Svg colours.
- Bad: a chip's width comes from the character count, not a measured text width, so a label of wide letters runs close to its edges.

## Amendment: spacing (kit 3.1)

A look at the desktop app found blocks stacked with no gap touching border to border, and wrapped rows of buttons or tiles sitting line on line. Kit 3.1 adds space without changing what any helper draws on one line: every wrapping row (`buttons`, `tiles`, `nav`) gets `rowGap: 1`, buttons sit `columnGap: 2` apart, and two new columns space a pane out. `page(children)` is a pane's top-level column with one row between its blocks; `list(children)` is a column of repeated cards or blocks with one row between them. Rows inside one card or block stay tight, and `stack()` keeps its props. Bands are one row, so the new gaps on their buttons change nothing there. `KIT_VERSION` is `3.1.0`, and each add-on copies the kit byte for byte.
