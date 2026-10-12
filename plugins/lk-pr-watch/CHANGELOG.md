# Changelog

All notable changes to lk-pr-watch are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.1] - 2026-10-11

### Changed

- Kit 3.1.0 (the loopkeeper core's kit, copied unchanged): wrapped rows of buttons and tiles keep one row between their lines, and buttons sit two columns apart (the buttons on each PR card too).
- The `/pr` pane's top level is the kit's `page` and the PR cards are a kit `list`, one row apart. The `Watched · n` header and its cards are one block of the page, so the header sits right above the first card.

## [0.3.0] - 2026-10-11

First release as `lk-pr-watch`, an add-on plugin in the loopkeeper marketplace. It was `pr-watch` 0.2.0; the minor version is bumped because the plugin id is new.

### Changed

- Renamed the plugin to `lk-pr-watch`. Its `$.state` keys follow the new name. The `/pr` command, the pane id, the config files (`~/.claude/pr-watch.json`, `<cwd>/.claude/pr-watch.json`) and the store key `band` keep their names; the store is per plugin id, so a `/pr band off` saved under the old id is not carried over.
- Kit v3, a verbatim copy of the loopkeeper core's kit. Colors are theme keys, so the band and pane follow the light or dark theme.
- The band is one kit line: `PR #42` in bold, then the checks, review and merge chips, each in its own tone, and `+N more` or `refresh failed` on the right side, in the default text color when the PR needs you, else quiet. It used to be one line of text colored by the PR's level.
- The pane's state and review badges are kit pills: rounded chips in the Desktop app, `● text` chips in the terminal. Secondary text uses the theme's quiet color. There are no filled badges.
- The PR's level and the check icons are named by kit tone (`ok`, `warn`, `danger`, `muted`) instead of color names.

### Added

- `LICENSE` in the plugin folder, with the notice for the parts borrowed from cc-pr-tracker.
