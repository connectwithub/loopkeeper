# 0012. Continue after approval

- Status: accepted
- Date: 2026-10-11
- Amended: 2026-10-11 (continue after approval also runs when the session draws on a surface, so desktop sessions hosted through the SDK get it)
- Amended: 2026-10-12 (`/lk approve` and every Approve button also open the next stage's gate from the stage before it, moving into it; that outcome changed something, so it submits)
- Amended: 2026-10-15 (a gate request's answer and the `/lk gates` commands carry on too; the text names the refused path, glob or command label)
- Amended: 2026-10-20 (a review loop's Allow more or Stop here carries on too, through `reviewAnswered` and the stage's review hooks, under the same guards)

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

## Amendment (2026-10-15)

A gate that needs the user's yes raises a request (`gateRequests`) instead of only refusing, and its buttons are the user's answer. A press on a request button goes through the stage's `ui.press` hook (`element: REQUEST_KEY`), which applies the answer and calls `continueAfter` before `next(e)`, so the gates' own press handlers do nothing. A press is not a command, so its prompt goes at once. `/lk approve` answers the newest pending request first, through the same routine. The person's `/lk gates allow`, `ship ok`, `merge ok`, `plan ok` and `max <n>` also carry on when they change something: the gates write the outcome to `gateAnswered`, and the stage's `/lk` handler, which awaits `next(e)`, reads it and calls `continueAfter(..., fromCommand = true)`, so the same timer applies. The text is `carryText`: fixed words for the outcome (for example "The user allowed all of docs/decisions/** for this session. Run the refused call again. Carry on with the task from where you stopped."), with the refused path, glob or command label, never the raw Bash command. A denial says "Do not retry it; ask the user how to proceed." instead. The guards are unchanged: one prompt per turn, `pipeline.continueOnApprove`, the kill switch, a live surface, and the person only; another plugin's `/lk gates` command is refused and carries on nothing. `$.prompt.submit` still has one call site, `submitContinue` in `hooks/stage.ts`. A request expires on a stage move and after three main turns, so a press on a request that no longer waits changes nothing.

## Amendment (2026-10-20)

A review loop at its limit waits for the person. Its card's **Allow <n> more** and **Stop here**, the Review pane's buttons, `/lk-reviews more` and `/lk-reviews stop` answer it. A `/lk-reviews max` that raises the limit is the person's too. The review concern writes the answer to `reviewAnswered` (`{ seq, text }`), and the stage carries on from it in two places: its `ui.press` hook for the review keys (`review-more:`, `review-stop:`, and the pane's `more:` and `stop:`), which runs after the press is applied, and its `command.run` hook for `reviews`, which runs after the command. Both call `continueAfter` with the same guards as above. The text is fixed and names the loop: "The user allowed 2 more passes for <name> (now 4). Run the next pass." for a grant, and "The user stopped the review loop for <name> at <n> passes. Do not run another pass; report the open items and carry on with the task." for a stop. A stop carries on only when the loop was at its limit. `$.prompt.submit` still has one call site, `submitContinue` in `hooks/stage.ts`.
