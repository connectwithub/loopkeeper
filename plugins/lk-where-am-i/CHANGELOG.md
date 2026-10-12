# Changelog

All notable changes to the lk-where-am-i add-on are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.1] - 2026-10-11

### Changed

- Kit 3.1.0 (the loopkeeper core's kit, copied unchanged): wrapped rows of buttons and tiles keep one row between their lines, and buttons sit two columns apart.
- The `/where` pane's top level is the kit's `page` (one row between the hero, the tiles, each section and the buttons; the rows inside a section stay together). It looks the same as before.

## [0.3.0] - 2026-10-11

First release as `lk-where-am-i`, an add-on plugin in the loopkeeper marketplace. It was `where-am-i` 0.2.0; the minor version goes up because the plugin id is new.

### Changed

- New plugin id `lk-where-am-i`. Its `$.state` key and atoms follow the new id; the `/where` command, the pane id, the band's key and the config file (`~/.claude/where-am-i.json`) keep their names.
- Kit v3 (the loopkeeper core's kit, copied unchanged). The band is one kit line: the location as the bold label, the usage windows and the prompt cache as `●` chips (muted, warn from 80%, danger from 95%, warn under 5 cache minutes), and dirty, unpushed and since-commit as the quiet right side, in the default text color while a window is at danger. It stacks above the bands that follow it and truncates instead of being cut by hand.
- The view model carries kit tones instead of color names: `Level` is `ok | warn | danger`, and band parts and pane rows have a `tone`.
- The pane draws kit v3 headers with counts, and the worktree marks (`here`, `locked`, `prunable`) as pills: Svg on the desktop, `●` chips in the terminal. Nothing is filled, dimmed or drawn in a named color.

### Removed

- `fitSegments` and `widthOf`: the kit line does the truncation.

### Notes

- Settings saved with `/where` live in the plugin's store, which belongs to the plugin id, so they start fresh under `lk-where-am-i`. The config file is read as before.
