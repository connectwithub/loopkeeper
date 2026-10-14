# 0004. The stage machine is always present

- Status: accepted
- Date: 2026-10-10
- Amended: 2026-10-11 (`/lk` alone opens the hub; the Stage pane is `/lk stage`)
- Amended: 2026-10-12 (gates also read `stageStages`; paths and the config resolve against the session root)
- Amended: 2026-10-14 (gate questions only in the terminal; the Ship approval covers the next push or merge)

## Context and Problem Statement

As separate mods, change-control read `{plugin:'pipeline-stage', key:'planDone'|'shipOpen'|'current'}` and carried a branch for pipeline-stage being absent. In that branch the ship gate asked "commit or publish now?" per command. gsd-orchestrator sent `/pipeline preset gsd` and `/change-control plan required on` from a 250 ms timer, with a "not available" branch. review-loop's context asked the model to call `set_stage` for a consistent plan verdict. In one plugin the stage machine is always there, so these branches and sends are dead weight.

## Considered Options

1. Keep the fallbacks and the command sends for compatibility.
2. Remove them. Gates read stage state directly and effects are direct.

## Decision Outcome

Chosen option: 2, because the absent case cannot happen and the timer-and-send path was fragile.

- Gates declare and read `stagePlanDone`, `stageShipOpen`, `stageCurrent`, `stageBudget`, `stagePlanFiles` and `stageStages` directly; the stage list gives the deny texts and the `plan ok` reply their stage labels (whether a gated Validate plan or Ship exists, and the stage before it). Plan paths, protected globs and the config resolve against the session root (`$.session.root`), not the current directory, so a shell `cd` does not change them; the stage reads the same root. The ship fallback question is gone, so `git push origin main` asks once (the merge gate) instead of twice.
- `/lk on|off` is handled by each concern in the chain. Stage applies the preset gsd or default, only when the GSD loop setting is on and the mode changes. Gates set plan required on or off the same way. Routing turns GSD mode on or off. At session start stage and gates read the stored GSD mode and match it. There is no timer and no send.
- Stage wraps `review_cycle`. A plan pass that review-loop's own done rule calls done (a last cycle, no open p0/p1 item, last verdict not iterate or stop) records the consistent verdict as `set_stage` would. The context sentence asking the model to do it is removed.
- GSD mode, loop, band and overrides stay in `$.store`, shared by every session on the machine, as in gsd-orchestrator. There is no per-surface split.
- The routing pane's "Toggle loop" button fills the prompt with `/lk loop off`; one Enter runs it through every concern. The button no longer flips the store key itself, because the stage and the gates must react through their own `/lk` handlers. "Toggle mode" switches the stage and the gates as `/lk on` does. The hub (`/lk` alone, [ADR 0014](0014-hub-and-keys.md)) follows the same rule: its `o` key fills the prompt with `/lk on` or `/lk off`, and its Approve takes the band button's path. The Stage pane, which `/lk` alone used to open, is now `/lk stage`.

### Consequences

- Good: fewer code paths, one ask on push, no timing dependence.
- Bad: tests that stubbed pipeline-stage now seed the stage atoms after session start. The four "pipeline-stage absent" ship tests became stage-machine equivalents: defaults open shipping; the gsd preset holds at Plan until approved; non-interactive mode refuses held shipping without asking; `git push origin main` asks once.
- Bad: GSD mode is machine-wide, not per session.

## Amendment (2026-10-14)

Outside the terminal no gate opens a dialog from a permission check: the desktop app, mobile and VS Code draw the session, but a `$.ui.ask` from a `tool.check` hook is never answered there, so every push to the default branch and every edit of an `ask` protected path was refused. The gates now ask only when `$.session.surfaces()` includes `terminal`, and elsewhere refuse with the command that lets the call through. The user's Ship approval (`/lk approve` at Ship or into it, the Stage pane's Approve gate, the hub's `a`), `/lk gates ship ok` or `/lk gates merge ok` sets a one-shot merge credit (`gateMergeCredit`, declared by the stage and the gates) that the next push or merge to the default branch spends; `gh pr merge` still waits for green CI first, and the stage takes back an unused credit on a move to any stage other than Ship (a `merge ok` given at another stage included) or a reset. A protected `ask` path is allowed for the session with `/lk gates allow <path>`. Only the person can run these words, as with `/lk approve`. In the terminal the `Merge`/`Cancel` and `Allow` dialogs stay for calls the user has not approved ahead; the files-per-turn limit names `/lk gates max <n>` off the terminal.
