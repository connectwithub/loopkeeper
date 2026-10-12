# 0008. Kit v2, a readable UI

- Status: accepted
- Date: 2026-10-10

## Context and Problem Statement

The desktop light theme made kit v1 hard to read. Named yellow, gray and `dimColor` do not adapt to the theme, fills came out grey, and there were no borders.

## Considered Options

1. Keep v1 and patch the worst colours.
2. Kit v2: theme keys for every colour, frames instead of fills.

## Decision Outcome

Chosen option: 2, because only theme keys adapt to both themes.

- `Color = ThemeKey | string`. The keys success, error, warning, suggestion, inactive and claude each have separate light and dark values.
- Tone map: info to suggestion, ok to success, warn to warning, danger to error, accent to claude, muted to inactive.
- Rules: no `dimColor`, no `backgroundColor`, and no yellow, white, gray, black or subtle text. A band line is a bold label, up to four `● state` chips, and a quiet inactive right side. Hero and card sit in round frames with `paddingX` 1. Tiles are single-border boxes with the label over a bold value. Badges are `● text` on both surfaces. Labels keep their case.
- `PALETTE = 'theme' | 'named'` is a switch. `'named'` uses blue, green, red and magenta, never yellow.
- Signatures are unchanged. `line(label, chips, right?)` is additive. `KIT_VERSION` is 2.0.0.
- Every band except the stage band (a stepper) uses `line()`. The gates band moved from one muted line to chips: `gates  ● 0/10 files  ● plan needed  ● merge gate  ● ship held`, with the limit's source on the right (`budget 23`, `raised 30`, `max 3`).
- `plugins/loopkeeper/tests/render.ts` draws text renderings from `drawn()` for the docs.

### Consequences

- Good: readable in light and dark themes without per-theme code.
- Bad: the test harness checks props, not paint. One look in the desktop app confirms the colours.
- Bad: if a host does not paint theme keys, the `named` palette is the fallback.
