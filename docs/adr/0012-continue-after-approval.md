# 0012. Continue after approval

- Status: accepted
- Date: 2026-10-11
- Amended: 2026-10-11 (continue after approval also runs when the session draws on a surface, so desktop sessions hosted through the SDK get it)
- Amended: 2026-10-12 (`/lk approve` and every Approve button also open the next stage's gate from the stage before it, moving into it; that outcome changed something, so it submits)

## Context and Problem Statement

A slash command starts no model turn. After `/lk approve`, or a press of the band's Approve button, the state changed and a line was printed, but the model stayed idle until the user typed a second prompt. The approval already is the user's go-ahead, so the second prompt adds a step and nothing else.

Claude Code 2.1.294 has `$.prompt.submit`. It submits a prompt as a turn of its own once the session is idle, framed as a message the plugin sent unless `asUser` is set. Two limits shape its use:

- The host refuses a submit from inside a `command.run` hook: the submit would wait on the turn the hook holds.
- The engine queues a plugin's prompt until the session is idle. A submit made while a main turn runs therefore always runs after that turn, even when the model has already moved past the gate by itself.

A second fault surfaced in the same pass: the plan hold fired on a prompt that only mentioned approving the plan ("once I approve the plan"), and it could fire on prompts the person did not send.

## Considered Options

1. Do nothing. The user types the next prompt.
2. Fill the prompt box with "continue" and let the user press Enter.
3. Submit one prompt framed as the plugin's message.
4. Submit one prompt as the user (`asUser`).

## Decision Outcome

Chosen option: 3, because the approval is the user's decision and needs no second keystroke, and a framed prompt keeps the transcript honest about who sent it. Option 2 still needs the keystroke. Option 4 puts words in the user's mouth.

- Sources: `/lk approve`, the stage band's button (`Approve plan · n files`, `Approve budget · n files`), the Stage pane's `Approve gate`, and the hub's Approve (`a`, [ADR 0014](0014-hub-and-keys.md)), which takes the band button's path. All of them go through the same approval, so each also opens the next stage's gate from the stage before it (at gsd Plan the Validate plan gate, at QA the Ship gate) and moves into it. Approvals made on the model's side never submit: a validator's verdict through `set_stage`, a plan review pass, `ExitPlanMode`, auto moves, and leaving Plan in a preset without a plan gate ([ADR 0011](0011-plan-scoped-file-budget.md)). `/lk gates plan ok` and `/lk gates ship ok` do not submit either.
- Only an approval that changed something submits: a gate newly approved, a waiting budget newly approved, or a move into the next stage's gate from the stage before it, approved now or earlier (`changed` on the outcome; "Approved the Validate plan gate and moved to Validate plan; Claude may start Execute.", "Approved the Ship gate and moved to Ship: Claude may commit, push or open a PR.", "Moved to <stage>; its gate was already approved."). "The <stage> gate is already approved.", "has no gate to approve" and "No current stage" submit nothing.
- The text: `The user ran /lk approve. <outcome> Carry on with the task from where you stopped.`, or `The user pressed <button label>. <outcome> Carry on with the task from where you stopped.` The command's own reply is unchanged.
- `/lk approve` submits from a timer (`$.clock.after`, 100 ms), just after the command has answered, because of the `command.run` refusal. A refused submit is tried again after 100 ms, 500 ms and 2 s, each time only while the conditions below still hold and no main turn has started. After that it is given up silently: the approval stands.
- Turn tracking: the stage adds `turn.start` and `turn.complete` hooks. `turn.start` sets `stageTurnRunning`; a subagent's run raises no `turn.start`. A `turn.complete` without an `agentId` clears it, for any reason, `aborted` included. A subagent's `turn.complete` changes nothing.
- While a main turn runs, the approval is not submitted. It is kept as `{ stage, text }` in `stageContinuePending`. At that turn's end it is submitted once if the current stage is still the one the approval left, and dropped otherwise. A later approval replaces the kept one. A budget-only approval made during a turn is never kept, so a model that is still working is not prompted again. This is why the engine's own queueing is not enough.
- Never submitted when `pipeline.continueOnApprove` is `false` (default `true`; user file, then project file, project wins), in a non-interactive session (`session.start`'s `isInteractive` false, kept in `stageInteractive`, and no surface in `$.session.surfaces()`), or with the kill switch on. A failing submit is swallowed.
- `/lk status` prints `Continue after approval: on` or `off` after the `Plan approval` line.
- Matchers: the stage's `turn.start` and `turn.complete` use the empty matcher `{}`, each with `.catch(($, e, next) => next(e))`. The gates' `turn.start` has the same `{}` matcher, and the decisions concern keeps its unmatched `turn.start` and `turn.complete`. The two identical `{}` registrations of `turn.start` rely on the same engine behaviour as the six `session.start` hooks in [ADR 0001](0001-one-hooks-module-six-concerns.md).
- At Ship, the user's `/lk approve` is the asking. The model carrying on into the commit or push is intended. A push to the default branch still goes through the merge gate.
- The hold: only a prompt the person sends can set it. That is `origin.kind` `composer`, `bridge` or `sdk`, or no origin. A plugin's prompt (this one included), a peer's message, a task notification, a scheduled trigger or a channel message never does. The pattern needs a first-person form: "let me approve the plan", "I want to review the plan", "review the plan first". A mention such as "once I approve the plan" does not hold (`HOLD_PATTERN` in `plugins/loopkeeper/hooks/lib/stageModel.ts`).

### Consequences

- Good: one action approves and resumes. The prompt tells the model what was approved and the new file budget.
- Good: no prompt in `-p` sessions or with the kill switch on, and one config key turns it off.
- Good: a stale approval does not wake the model after it has moved on by itself.
- Bad: the plugin starts a model turn the user did not type. The transcript shows it as the plugin's message, and SECURITY.md says so.
- Bad: the delayed submit depends on the host accepting it a moment after the command answers. If every retry is refused, the user types the next prompt, as before.
- Bad: the gates' and the stage's `turn.start` hooks share an identical matcher and rely on the engine not enforcing one hook per matcher. `plugins/loopkeeper/tests/stage-continue.test.ts` pins the text, the conditions and the turn tracking.
