# 0011. A plan-scoped file budget

- Status: accepted
- Date: 2026-10-10
- Amended: 2026-10-11 (leaving Plan in a preset without a plan gate approves a waiting budget)

## Context and Problem Statement

change-control capped the files changed per turn at a fixed 6. That asked too often on planned work. The request: a base of about 10, the plan's file count approved with the plan plus about 10, and a one-click raise in the limit question.

## Considered Options

1. Raise the fixed number.
2. A budget that follows the approved plan, with a base and a raise option.

## Decision Outcome

Chosen option: 2, because a plan that says it touches 23 files should not be asked about each one.

- Base `changeControl.maxFilesPerTurn` is 10 (was 6).
- `set_stage {stage:'plan', size:'large', files:n}` records the planned count. Approving the plan approves `n + planSlack` (`planSlack` is 10). Approval can come from the validator's consistent verdict in auto mode, a plan review pass, `/lk approve`, or the band button `Approve plan · n files`. In a preset with no plan gate (the default preset has none), leaving Plan forward through `set_stage` or an auto move, in approval mode `auto` with no hold, approves a waiting budget as a validator's verdict would, up to `autoBudgetMax` planned files. A move made by `ExitPlanMode` is an auto move too, but it is excluded by tool name.
- Auto approval covers budgets up to `autoBudgetMax` (40) planned files. A bigger one leaves the plan gate open and waits for `Approve budget · n files` or `/lk approve`, which also works later, from Execute.
- Limit per turn is the `/lk gates max` override if set, else the maximum of the base, the approved budget and the session raise. `turn.start` resets the count; a subagent's turn does not. Subagent edits count only with `countSubagents`.
- The limit question offers: Allow 1 more, Allow rest of turn, Raise to `<limit + planSlack>` for this session, Stop. With no plan the raise reads "Raise to 20". The value is computed once, so label and effect match. Stop, dismissal or no one to ask denies and aborts the turn 250 ms later. Raise under a max override raises the override too.
- The budget clears with plan approval, going back to Plan, re-sizing, `/lk reset`, or a small task. Re-planning before approval takes the new count. The raise lasts the session. A larger value wins.
- The rules block asks for `files` in `set_stage`, names the budget (planned plus `planSlack`), and tells the model that `/lk approve` works at the plan gate and at Ship. A plan review pass with no open p0/p1 item records the verdict. The rest of the block is word for word gsd-orchestrator's text, pinned by a test.
- `files` must be a whole number from 1 to 10000. The text "13" is read as 13; "12 files", 2.5, 0 and negatives are refused.

### Consequences

- Good: planned work is not interrupted; unplanned work still hits a limit of 10.
- Good: the band reads `<count>/<limit> files` and the gates pane reads `Files per turn: 23 (the approved plan's budget: 13 planned + 10)`.
- Bad: approving a plan through Claude Code's plan mode (`ExitPlanMode`) moves the stage on and satisfies the gates' plan check, but does not approve the planned budget. This holds in every preset, the gate-less ones included. The budget waits for `Approve budget · N files` or `/lk approve`, and the base of 10 applies until then.
- Bad: the model can forget `files` or under-count. The base of 10 still applies and the raise is one click.
