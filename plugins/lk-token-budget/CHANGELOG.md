# Changelog

All notable changes to the lk-token-budget add-on are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.4.1] - 2026-10-11

### Changed

- Kit 3.1.0 (the loopkeeper core's kit, copied unchanged): wrapped rows of buttons and tiles keep one row between their lines, and buttons sit two columns apart.
- The `/budget` pane is a page of blocks one row apart: the tiles, one block per section (its header and its rows together, with no blank line between the rows) and the buttons.

## [0.4.0] - 2026-10-11

First release as `lk-token-budget`, an add-on plugin in the loopkeeper marketplace. It was `token-budget` 0.3.0; the minor version goes up because the plugin id is new.

### Changed

- New plugin id `lk-token-budget`. Its `$.state` key and atoms follow the new id; the `/budget` command, the pane id, the config files (`~/.claude/token-budget.json`, `<project>/.claude/token-budget.json`) and the store keys keep their names. The `stop` action's exemption for the plugin's own tools now matches `mcp__lk-token-budget__*`.
- Kit v3 (the loopkeeper core's kit, copied unchanged). The band is one kit line: the bold `budget` label, a budget chip (`● ▰▱▱▱ used / limit n%`) in the ok, warn or danger tone, a cache chip, and the quiet right side (main, agents, ctx, the resend cost), stacked above the bands that follow it. The right side turns to the default text color once the cache is cold or the budget is spent.
- The red filled "cache cold" badge is now a `● cache cold` chip in the danger tone. Nothing in the band or the pane is filled, dimmed or drawn in a named color.
- The Keep warm feature is unchanged: the manual button and `/budget keepwarm`, and the opt-in, capped automatic keep-warm.

### Notes

- Settings saved with `/budget` and the lifetime totals live in the plugin's store, which belongs to the plugin id, so they start fresh under `lk-token-budget`. The config files are read as before.
