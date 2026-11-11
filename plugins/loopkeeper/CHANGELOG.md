# Changelog

All notable changes to the loopkeeper core plugin are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- A held stage gate shows a card above the prompt, like the gates' request cards, with **Approve**, **Reject** and the command to type instead. It covers the Validate plan gate (while it waits for the user, or after a move past it was refused), the Ship gate (while it holds shipping and no ship request's card asks), any other gate stage, a verifier stage after a move out of it was refused, and the next stage's gate after a move jumped past it. Approve runs `/lk approve`'s path for that gate (`/lk waive`'s for a verifier); the card shows with the stage band off too.
- `/lk reject [note]`, which the card's Reject runs. Nothing moves and the gate stays closed. The Stage pane's history notes it as `rejected`, and Claude gets one carry-on prompt not to move past it. Rejecting the Validate plan gate also holds the plan, so only the user's approval opens it; `/lk status` then reads `Plan approval: held after your rejection`. Only the person can run it.

### Changed

- The band's `Approve plan · n files` button is now the Approve button of the Validate plan gate's card. The key and label are unchanged. A press approves the gate and no longer answers a pending gates request first; `/lk approve` typed still does.
- `/lk waive` is described as what it does: it marks the current stage's verifier as satisfied by the user.

### Fixed

- A small task's file limit counted a file whose edit was refused or failed, so the next file could push the task back to Plan. From Claude Code 2.1.312 the permission check runs inside the tool call: a refusal comes back as an errored result, not a `deny`, and the path is reserved during the call. The growth guard now looks the path up once the call settles and releases it on a `deny`, an errored result or a throw.

## [0.2.0] - 2026-10-15

### Added

- A gate that needs the user's yes raises a request off the terminal instead of only refusing. It shows as a card above the prompt on the desktop app (also with the gates band off), in the Gates pane on VS Code and mobile, and as the command to run under `-p`. A protected path offers **Allow this file**, **Allow all of `<glob>` for this session** and **Deny**. A push or merge to the default branch offers **Allow this push** (or **Allow this merge**), **Allow pushes for this session** (or **Allow merges for this session**) and **Deny**. Shipping offers **Allow this `<what>` once**, **Open shipping for this session** and **Deny**. Files past the limit offer **Raise to `<n>` files a turn for this session** and **Deny**.
- Claude carries on after a press on a request's button, and after a `/lk gates allow`, `ship ok`, `merge ok`, `plan ok` or `max` command the user runs that changes something. One prompt per turn, under the ADR 0012 guards. The prompt names the refused path, glob or command label, never the raw Bash command.
- `/lk-decisions` shows **Record** and **Skip** on each pending major decision, and **Record all** when there are two or more.
- The decision watch's hourly cap shows a card above the prompt, and a line in the pane: `Decision watch paused: <n> calls in the last hour`, with **Allow <n> more** and **Keep paused**. The card shows once per pause.
- A review loop that has used every pass and is not done shows a card above the prompt, with **Allow <n> more** (the kind's default) and **Stop here**. The Review pane has **Allow <n> more** beside Reopen and Close, and `/lk-reviews more <subject> [n]` allows `n` more. Each grant or stop sends Claude one carry-on prompt, under the ADR 0012 guards. A limit cannot go past 20 passes.

### Changed

- Every command except `/lk` takes the `lk-` prefix: `/lk-reviews`, `/lk-decide`, `/lk-decisions` and `/lk-files` (were `/reviews`, `/decide`, `/decisions` and `/files`). The hub runs the add-ons' new commands and matches only the `lk-` plugin ids. No aliases for the old names. lk-pr-watch's `/pr` became `/lk-prs` because Claude Code 2.1.306 ships `/pr`, which its validation refused. See [ADR 0016](../../docs/adr/0016-lk-command-prefix.md).
- `/lk approve` answers a waiting gate request first, with its first Allow, names the answer and carries on. A request raised in the latest main turn comes first, and the reply says what else still waits. With no request pending, the answers are as before.
- Requests are cleared by a stage move and expire after three main turns.
- `/lk gates plan ok`, `/lk gates max <n>` and the words that loosen a gate (`/lk gates off`, `ship gate off`, `plan required off`) are refused from another plugin ("Only the user can …"), as `allow`, `ship ok` and `merge ok` already were.
- A raise from a request card replaces a `/lk gates max` value when it is higher.
- The loop rules (GSD mode) add rule 8: at QA or Ship, a request that does not finish this ship (a commit, push, PR, merge, its deploy, or a fix that unblocks them) is new work, a question included; when unsure, it is new. Claude calls `set_stage` plan with a size before any work, and in a long session offers a handoff first.
- Refusal texts name only steps that work: `/lk approve`, the surface's card or Gates pane, or with `-p` the command. "run /lk approve at QA or Ship" is gone.
- The README's reviewer notes are refreshed: the carry-on prompt, the stage's `ui.press` hook, and the line numbers.
- A review loop's limit is raised only by the person: `/lk-reviews more`, a card's or a pane's **Allow <n> more**, and a `/lk-reviews max` that raises a loop's limit. A model's own call is refused ("Only the user can …"). Lowering `max` works from anyone. The past-limit refusal and the not-converging line now say to report what changed and to ask for more passes, instead of asking how to proceed.
- A backward move by Claude (`set_stage` to an earlier stage) drops the approvals of the gates after the target and the merge credit. Leaving QA or Ship backwards tells Claude that new work starts at Plan, and says when the Ship approval was dropped. `/lk back` keeps the approvals.
- The Ship approval is spent by the person's next message after a commit or push used it. Messages that start with `/`, plugin prompts and auto-continuations do not spend it. `/lk approve` at Ship re-approves it, and the flag is saved with the task.

### Fixed

- `git merge <ref>` on a feature branch was held as a merge to the default branch and spent the push credit. It counts only when the default branch is checked out. With an unknown current branch it is still held when the arguments name the default branch.
- The merge credit and a ship once-grant are spent only by a call every check allows. A call another rule refuses no longer uses them up.
- After a refusal, `/lk approve` at Execute, Plan or QA answered "has no gate to approve" and left the request pending. It now answers the request.
- "Ship has no gate to approve; ... allowed" granted the push credit with no carry-on. A new credit now carries on.
- A backward `set_stage` move kept the approvals of the gates after the target, Ship included. It drops them now (see Changed).

## [0.1.1] - 2026-10-14

### Added

- `/lk gates merge ok` lets the next push or merge to the default branch through, once.
- `/lk gates allow <path>` allows a protected path whose rule is `ask` for the rest of the session, as **Allow for session** does in the terminal; `allow` alone lists the paths allowed so far. A `deny` rule cannot be allowed this way.

### Changed

- The user's Ship approval is the yes for the next push or merge to the default branch: `/lk approve` at Ship (approving its gate, finding it already approved, or at a Ship stage with no gate) or into Ship from the stage before it, the Stage pane's `Approve gate` and the hub's `a`. `/lk gates ship ok` gives the same yes. The merge gate spends it on the next push or merge, with no question; `gh pr merge` still waits for green CI first. Leaving the Ship stage, `/lk reset` and a preset that drops the current stage take back an unused one. At a Ship stage with no gate, or with its gate already approved, `/lk approve` answers that the next push or merge is allowed and sends no continue prompt ([ADR 0004](../../docs/adr/0004-stage-machine-always-present.md)).
- `/lk gates ship ok`, `merge ok` and `allow` count only when the user runs them; from another plugin they are refused, as `/lk approve` already was.
- The changeControl rules block says how a protected `ask` path and a merge to the default branch get the user's yes.
- The README's reviewer note on `eval` describes the commands the regular expressions recognise in words, without a quoted shell snippet.

### Fixed

- On the desktop app, mobile and VS Code every push to the default branch and every edit of an `ask` protected path was refused, because a question put from a permission check is never answered there. The gates now ask only in the terminal. Elsewhere a merge or push is refused naming `/lk approve` and `/lk gates merge ok`, a protected `ask` path naming `/lk gates allow <path>`, and an edit past the files-per-turn limit naming `/lk gates max <n>`. In the terminal a dismissed question now says so, rather than that nobody could be asked.
- The growth guard released a reserved path only when the edit was refused: an edit whose call threw kept its path counted against a small task. It is now released too, and the reservation is dropped however the call ends.

## [0.1.0] - 2026-10-12

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
