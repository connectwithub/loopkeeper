# Changelog

All notable changes to the loopkeeper core plugin are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - Unreleased

First release. loopkeeper is one plugin that replaces five separate mods (pipeline-stage, change-control, gsd-orchestrator, review-loop and decision-pad). Nothing is migrated from the old mods: no config files, store keys or review logs are read. A fresh install starts from defaults.

### Added

- One plugin with a stage machine and approval gates, change-control gates, model routing by role, bounded review loops and a decision log.
- A file budget that follows the approved plan (see ADR 0011).
- Kit v2, a UI that uses theme keys and frames and reads in light and dark themes (see ADR 0008).
- Kit v3, additive over v2: pills drawn as fully rounded Svg chips (white text on a `CHIP_HEX` fill with a contrast ratio of 4.5:1 or more; the theme-key fill stays behind the kit's `PILL` switch), section headers with counts, and Svg icons, file-type badges and progress bars on the desktop, mobile and VS Code; the terminal keeps text, and bands never draw Svg. The Files and Gates panes use its headers, icons, type badges and pills; the Stage and Review panes draw their progress bars with it, and Review its pills ([ADR 0013](../../docs/adr/0013-kit-v3-svg-and-theme-fills.md)).
- Kit 3.1, spacing: wrapped rows (buttons, tiles, the nav bar) keep one row between their lines and buttons sit two cells apart; `page()` spaces a pane's blocks one row apart and `list()` does the same for repeated cards or blocks, while rows inside one block stay tight; `buttons()` items take `autoFocus`. The hub draws its sections one row apart (hero and next step, Panels, Other mods, actions) and opens 22 rows high; the Review pane's other subjects and the Decisions pane's entries are spaced lists, and every core pane's top level is a `page()` ([ADR 0013](../../docs/adr/0013-kit-v3-svg-and-theme-fills.md)).
- Continue after approval: after a user approval that changes something (`/lk approve`, the band's Approve buttons, the Stage pane's `Approve gate`, the hub's `a`), loopkeeper submits one prompt, framed as the plugin's message, so the model carries on. Config `pipeline.continueOnApprove` (default `true`); `/lk status` shows `Continue after approval: on|off` ([ADR 0012](../../docs/adr/0012-continue-after-approval.md)).
- The hold phrase holds only for prompts the person sends (typed, through the bridge, or from the SDK host) and needs a first-person form ("let me approve the plan", "review the plan first"); a mention such as "once I approve the plan" does not hold.
- In a preset with no plan gate (the default preset), leaving Plan through `set_stage` or an automatic move approves a waiting file budget in auto approval, up to `autoBudgetMax`; `ExitPlanMode` still does not ([ADR 0011](../../docs/adr/0011-plan-scoped-file-budget.md)).
- The loopkeeper hub: `/lk` opens it, with one row per panel and its live status, buttons for the other mods that are installed, and Approve, GSD on/off and Close. `/lk stage` opens the Stage pane and `/lk help` lists the keys ([ADR 0014](../../docs/adr/0014-hub-and-keys.md)).
- Keys: every loopkeeper pane starts with a nav row, `0` Hub to `6` Decisions, and a digit switches panes; in the hub, `1` to `6` open the panels, `m`, `u`, `h`, `t`, `w`, `p`, `s` open an add-on, `a` approves, `o` puts `/lk on` or `/lk off` in the prompt box and `c` closes.
- The hub's add-on keys open the mod directly on the desktop: the press closes the hub and runs the mod's command (`$.command.run`), which opens the mod's own pane. On the terminal, or when the run is refused, they fill an empty prompt box with the command instead ([ADR 0014](../../docs/adr/0014-hub-and-keys.md)).
- Secrets (`s`, `/secret-guard`, from lk-secret-guard) joins the hub's add-ons.
- Next step after every answer: after each answered main turn, a notice line in the chat (dim; Claude does not read it; `$.ui.log`), `loopkeeper · <Stage> (<n> of <m>) · <next step>`, from one function over the stage machine's state with seven cases (a button waits, the plan validator's verdict, a gate waits, a verifier must finish, Ship waits for `/lk approve`, the last stage, or the next stage, naming `/lk approve` when it can open the next stage's gate). Not after a subagent's turn, a refusal, an interrupt or an error, and not before a task is sized or moved. Config `pipeline.nextHint` (default `true`). The hub and the Stage pane show the same sentence under their title, and `/lk status` on its `Next:` line.
- `/lk approve` from the stage before a gate opens that gate and moves into it: at gsd Plan the Validate plan gate (its verifier vouched for and the planned file budget approved), at QA the Ship gate. It never opens a gate two stages ahead, and a waiting file budget still comes first. The band button, the Stage pane's `Approve gate` and the hub's `a` do the same.
- Plan material, protected paths and the config resolve against the project root (`$.session.root`), so a shell `cd` into a subfolder does not change which files are plan material or protected.
- `/lk` (long form `/loopkeeper`) and `/reviews`, with `/decide`, `/decisions` and `/files`.
- Tools `set_stage`, `review_cycle`, `review_item`, `review_status` and `record_decision`.
- CI with a required job pinned to Claude Code 2.1.294 and a canary job on the latest release.

### Changed

Changes against the behaviour of the old mods:

- One hooks module wires six concern files; shared state goes through atoms with the same literal keys ([ADR 0001](../../docs/adr/0001-one-hooks-module-six-concerns.md)).
- Commands are `/lk` and `/reviews`, because the built-ins own `/loop` and `/code-review`; the pipeline, GSD and change-control grammars fold under `/lk` ([ADR 0002](../../docs/adr/0002-command-names.md)).
- One config file, `~/.claude/loopkeeper.json` then `<project>/.claude/loopkeeper.json`, with five sections and the store prefix `loopkeeper:` ([ADR 0003](../../docs/adr/0003-one-config-file-and-store-prefix.md)).
- The stage machine is always present: absent-pipeline fallbacks and timer-driven command sends are removed, and a plan review verdict reaches the stage. `git push origin main` now asks once, not twice ([ADR 0004](../../docs/adr/0004-stage-machine-always-present.md)).
- One approval mode and one plan-material list ([ADR 0005](../../docs/adr/0005-one-approval-mode-and-plan-list.md)).
- The decision watch is off by default; the `brain-md` format is now `markdown`, with the old name kept as an alias ([ADR 0006](../../docs/adr/0006-decision-watch-off-and-format-names.md)).
- The minimum Claude Code version, 2.1.294, is recorded in `plugin.json` and checked at session start ([ADR 0007](../../docs/adr/0007-minimum-claude-code-version.md)).
- The UI uses theme keys and frames; the only fills are kit v3's pills, Svg chips in `CHIP_HEX` on the desktop ([ADR 0008](../../docs/adr/0008-kit-v2-readable-ui.md), [ADR 0013](../../docs/adr/0013-kit-v3-svg-and-theme-fills.md)).
- `CLAUDE_MODS_DISABLE=loopkeeper` turns off every enforcing hook, not only the gates; the gates fail closed on error ([ADR 0009](../../docs/adr/0009-kill-switch-and-fail-closed.md)).
- The base limit of files per turn is 10 (was 6); the approved plan's file count plus 10 applies once the plan is approved ([ADR 0011](../../docs/adr/0011-plan-scoped-file-budget.md)).
- CI pins Claude Code 2.1.294 with a canary on the latest release ([ADR 0010](../../docs/adr/0010-ci-pinned-with-canary.md)).
- The core lives in `plugins/loopkeeper/` of the loopkeeper repository, which is a marketplace; each add-on is its own plugin in `plugins/lk-<name>/`. Validate and test from each plugin folder.
- `/lk approve` and the hub's `a` at a gate other than Validate plan approve a planned file budget that still waits first; the next approval opens the gate. At Validate plan the budget is approved with the plan.
- The "ctrl+x tab to focus the panel" toast shows at most once per session, and only on the terminal.
