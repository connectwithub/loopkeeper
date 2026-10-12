# Changelog

All notable changes to lk-handoff-guard are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.1] - 2026-10-11

### Changed

- Spacing (kit 3.1): the pane's top level is the kit's `page()`, one row between blocks; wrapped button rows keep one
  row between their lines and buttons sit two cells apart. The kit copy is the core's kit 3.1.0.

## [0.3.0] - 2026-10-11

First release as `lk-handoff-guard`, an add-on plugin of the loopkeeper set. It was handoff-guard 0.2.1; the minor
version is bumped because the plugin id is new.

### Changed

- The plugin id is `lk-handoff-guard`; its `$.state` atoms and their types follow the new id. The `/handoff` command,
  the band, the pane and the `handoff-guard.json` config files keep their names.
- Settings saved by `/handoff`, the last brief and a pending resume kept under the old id do not carry over; they
  start empty (the config files are read as before). The handoff files in `.claude/brain/` are untouched.
- The facts name the loopkeeper core's current stage (its `stageCurrent`) when the core is on, in place of the retired
  pipeline-stage mod's.
- `hooks/kit.ts` is the loopkeeper core's kit v3, copied verbatim. In the Desktop app the level and source pills are
  now fully rounded Svg chips instead of filled text; the terminal keeps its `● text` chips. `tests/kit.test.ts` is
  the core's kit suite without its render snapshots.
- The README describes the handoff folder's files and their format, and lists what the plugin runs.
- Needs Claude Code 2.1.294 or later. The manifest names the MIT license, the homepage and the repository.
