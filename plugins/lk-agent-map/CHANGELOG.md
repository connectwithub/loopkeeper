# Changelog

All notable changes to lk-agent-map are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.6.3] - 2026-10-14

### Changed

- The README's notes for directory reviewers explain the `caller` field read in `hooks/model.ts` (warning
  `MOD_REFLECTION`): a plain field of the plugin's own `PendingCall` record, the id of the agent that made the call,
  not `Function.prototype.caller`. No code change.

## [0.6.2] - 2026-10-11

### Added

- The caps in the plugin's settings (`/config`, the `lk-agent-map` rows): `maxConcurrent` (4), `maxPerTurn` (8),
  `maxPerSession` (40), `warnAtPercent` (75, read as `warnAt` 0.75) and `maxReturnedTokens` (150000); 0 means no cap.
  They are read live from `$.config.list()` (the `register` options when the rows can't be read) and merged after the
  defaults and before `~/.claude/agent-map.json`, `<cwd>/.claude/agent-map.json` and what `/agent-map cap` saved. A
  value out of range is ignored. A `config.set` hook refuses an out-of-range value with a reason and loads the caps
  again once a value is written; `classic.ConfigChange` loads them again too.
- The pane's **Caps** block, under the body: each cap with its value (`no cap` for 0) and its source (`default`,
  `settings`, `user file`, `project file`, `saved (/agent-map cap)`), and how to change them.
- `/agent-map cap reset [kind]` clears the saved override for one kind, or for all of them.

### Fixed

- `/agent-map cap` no longer takes an inherited object property (such as `toString`) as a cap kind.

## [0.6.1] - 2026-10-11

### Changed

- Spacing (kit 3.1): the pane spaces its blocks one row apart: the header block (tiles, the view buttons and, in the
  cards view, the main loop's line, one row apart), the body, the log and the footer buttons. Cards sit one row apart;
  the tree and log rows stay tight, with no blank-line spacers. The kit copy is the core's kit 3.1.0.
- The team view is a list of its top-level lanes (team of main, teammates, unattached), one row apart; the rows inside
  a lane, nested lanes included, stay tight, and the main loop's line leads the first lane.

## [0.6.0] - 2026-10-11

First release as `lk-agent-map`, an add-on plugin of the loopkeeper set. It was agent-map 0.5.0; the minor version is
bumped because the plugin id is new.

### Changed

- The plugin id is `lk-agent-map`; its `$.state` atoms and their types follow the new id. The `/agent-map` command, the
  band, the pane and the `agent-map.json` config files keep their names.
- Settings saved under the old id do not carry over: the `stuckAfterMs` value from the config menu, and the band switch,
  caps and chosen view kept in `$.store`, start from their defaults. Set them again from the config menu and
  `/agent-map`.
- `hooks/kit.ts` is the loopkeeper core's kit v3, copied verbatim; `tests/kit.test.ts` is the core's kit suite without
  its render snapshots.
- Needs Claude Code 2.1.294 or later. The manifest names the MIT license, the homepage and the repository.

## Earlier, as agent-map

- 0.5.0: cards readable in both themes. Kit v3; no fills, dimmed text, yellow or grey, only theme keys. Each card has a
  pixel critter avatar (Desktop) or the role glyph (terminal), the effort word in its color, a step line and a progress
  bar. The active view button is the primary button. The band is one line of `●` chips with the cap state last. The
  chosen view moved to the store key `view2`, so the pane opened on the cards once after that update.
