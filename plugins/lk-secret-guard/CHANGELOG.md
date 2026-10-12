# Changelog

All notable changes to lk-secret-guard are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.1] - 2026-10-11

### Changed

- Kit 3.1.0 (the loopkeeper core's kit, copied unchanged): wrapped rows of buttons and tiles keep one row between their lines, and buttons sit two columns apart.
- The `/secret-guard` pane's top level is the kit's `page` (one row between the hero, the tiles, the status, each section and the buttons; the rows inside a section stay together). It looks the same as before.

## [0.3.0] - 2026-10-11

First release as `lk-secret-guard`, an add-on plugin in the loopkeeper marketplace. It was `secret-guard` 0.2.0; the minor version is bumped because the plugin id is new.

### Changed

- Renamed the plugin to `lk-secret-guard`. Its `$.state` keys follow the new name. The `/secret-guard` command, the pane id, the config files (`~/.claude/secret-guard.json`, `<project>/.claude/secret-guard.json`) and the store key `band` keep their names; the store is per plugin id, so a `/secret-guard band off` saved under the old id is not carried over.
- Kit v3, a verbatim copy of the loopkeeper core's kit. Colors are theme keys, so the band and pane follow the light or dark theme.
- The band is one kit line: `secret-guard` in bold, then `● n blocked` (error color once nonzero) and `● n allowed` (ok color once nonzero). With the guard off it shows an `● off for this session` chip in the error color and `/secret-guard on to resume` in the default text color. It used to be one line of text in a single color.
- The pane's outcome, source and `ignored` badges are kit pills: rounded chips in the Desktop app, `● text` chips in the terminal. Secondary text uses the theme's quiet color. There are no filled badges.

### Added

- `LICENSE` in the plugin folder.
