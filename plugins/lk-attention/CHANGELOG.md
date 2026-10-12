# Changelog

All notable changes to lk-attention are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.1] - 2026-10-11

### Changed

- Spacing (kit 3.1): the pane's top level is the kit's `page()`, one row between blocks; wrapped button rows keep one
  row between their lines and buttons sit two cells apart. The kit copy is the core's kit 3.1.0.

## [0.3.0] - 2026-10-11

First release as `lk-attention`, an add-on plugin of the loopkeeper set. It was attention 0.2.1; the minor version is
bumped because the plugin id is new.

### Changed

- The plugin id is `lk-attention`; its `$.state` atoms and their types follow the new id. The `/attention` command,
  the band, the pane and the `attention.json` config files keep their names.
- Settings saved by `/attention` under the old id do not carry over; they start from their defaults (the config files
  are read as before).
- `hooks/kit.ts` is the loopkeeper core's kit v3, copied verbatim. In the Desktop app the settings and kind pills are
  now fully rounded Svg chips instead of filled text; the terminal keeps its `● text` chips. `tests/kit.test.ts` is
  the core's kit suite without its render snapshots.
- Needs Claude Code 2.1.294 or later. The manifest names the MIT license, the homepage and the repository.
- The README documents where `assets/ding.wav` comes from: a tone generated for this plugin.
