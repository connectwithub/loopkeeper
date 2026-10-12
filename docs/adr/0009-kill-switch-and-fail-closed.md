# 0009. Kill switch and fail closed

- Status: accepted
- Date: 2026-10-10

## Context and Problem Statement

`CLAUDE_MODS_DISABLE` was read only by the gates. In one plugin the stage's growth guard and spawn routing also enforce, and the Files pane tracks activity. The user needs one switch that turns enforcement off, and the gates must not let a call through when they fail.

## Considered Options

1. Keep the switch for the gates only.
2. One switch for every enforcing hook; gates deny on error and name the switch.

## Decision Outcome

Chosen option: 2, because a half-working switch is worse than none.

- `CLAUDE_MODS_DISABLE` (a comma list) containing `loopkeeper` or `all` turns off the enforcing hooks: the gates, the stage's growth guard and spawn routing. It also stops the Files pane's tracking and band line, as change-control did. The bands say so; the gates band reads "OFF for this session". Commands still register, so `/lk` can explain, and `/files` still opens.
- The gates fail closed on a hook error. The refusal reads: "loopkeeper: the gates failed (<kind>: <msg>) and refused this call rather than let it through unchecked. Tell the user; they can run /lk gates off, or set CLAUDE_MODS_DISABLE=loopkeeper."
- Found in the build: the stage's growth guard wraps the edit check from outside, and its catch would have turned a gates failure into "ask". The gates' edit hook now also catches inside its own body, so it denies.
- ExitPlanMode still approves the plan. It does not approve the planned file budget ([ADR 0011](0011-plan-scoped-file-budget.md)).

### Consequences

- Good: one documented way out, and a failure is a refusal, not a silent pass.
- Bad: a bug in a gate blocks work until the user turns it off.
- Bad: every gating hook needs its own `.catch`; this is a contributor rule.
