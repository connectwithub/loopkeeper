# The loop

This page covers the stages, the presets, sizing, the gates, the verifier, approval, continuing after approval and the file budget. The full tables of gates, commands and config keys are in the core's [README](../plugins/loopkeeper/README.md). The text the bands and panes show is in [renderings.md](renderings.md).

## Stages

The loop is a list of stages. Each stage has an id, a label, and optionally a gate (⚑) and a verifier requirement (⇄).

| Stage id | Label | Gate | Verifier | What it needs |
| --- | --- | --- | --- | --- |
| `plan` | Plan | | | A written plan: Goal, Steps, Done-when, the files touched. Given with `set_stage {stage:'plan', size, files}`. |
| `validate-plan` | Validate plan | ⚑ | ⇄ | A subagent whose type or description matches `valid\|review\|verif\|critic\|audit\|plan` has finished. Then `set_stage {stage:'validate-plan', verdict}`. |
| `execute` | Execute | | | The work, through subagents. Routing chooses their models. |
| `validate` | Validate | | ⇄ | A subagent matching `verif\|valid\|review\|critic\|audit\|test\|qa` has finished during this visit. |
| `qa` | QA | | | Tests and the build run. |
| `ship` | Ship | ⚑ | | Shipping commands wait until the stage opens shipping. |

Presets choose the list:

- `default`: `plan`, `build`, `qa`, `ship`. No gates, no verifier.
- `gsd`: the table above.
- Any preset the project defines in `pipeline.presets`.

`/lk preset <name>` saves the choice for the project.

## Sizing

Every task is sized first:

- `small`: one clear change in at most `pipeline.smallMaxFiles` files (default 3). The plan gate and the verifier are waived. The task moves to Execute. If the task grows past the limit, the growth guard refuses the next new file, the task goes back to Plan, and its size is cleared. `/lk small-max <n>` changes the limit for the session.
- `large`: the full loop: plan, validate the plan, execute, validate, QA, ship.

When in doubt, size the task large. `/lk size small|large` sizes it from the prompt box.

## Approval

The plan gate opens in one of two ways, set by `/lk approval`:

- `auto` (the default): a validator's consistent verdict opens the gate.
- `ask`: the verdict is recorded, but the gate stays closed until the user runs `/lk approve`, presses the band's `Approve plan · n files` button, or presses Approve (`a`) in the hub.

`/lk approve` also works one stage early. At Plan it opens the Validate plan gate and moves there, vouching for the plan's validator and approving the planned budget, so a plan left at Plan (for example after validator passes that did not converge) needs no other command. It never opens a gate two stages ahead, and a planned budget that waits still comes first.

A prompt the person sends holds the gate when it asks to wait or to approve the plan themselves: phrases such as "wait for approval", "ask me first", "check with me", "plan only", "just the plan", "don't start until ...", "let me approve the plan", "I want to review the plan" or "review the plan first". A prompt that only mentions approving, such as "once I approve the plan", does not hold. Neither does a message from a plugin, a peer, a task or a channel: only a prompt typed in the composer, sent through the bridge or by the SDK host counts. `/lk approve` clears the hold.

`/lk approve` at Ship (or the Stage pane's `Approve gate`, or the hub's `a`) opens shipping; at the stage before Ship (QA) it opens the Ship gate and moves there. The same approval is the user's yes for the next push or merge to the default branch, once: the merge gate lets that one through without a question. At Ship with no gate (the default preset), or with its gate already approved, `/lk approve` gives that yes alone (`Ship has no gate to approve; the next push or merge to the default branch is allowed.`) and sends no continue prompt. `/lk gates ship ok` gives it too, and `/lk gates merge ok` gives only it. A move to any stage other than Ship (this includes a `/lk gates merge ok` given at another stage), `/lk reset`, or a preset that drops the current stage takes back an unused one. Without it the terminal asks about each merge with `Merge` and `Cancel`; the desktop app, mobile and VS Code cannot answer a question from a permission check, so there the merge is refused with `/lk approve` and `/lk gates merge ok` named.

## Continue after approval

A slash command starts no model turn. So after a user approval that changed something, loopkeeper submits one prompt, framed as the plugin's message, and Claude carries on. The approvals that count are `/lk approve`, the band's `Approve plan · n files` and `Approve budget · n files`, the Stage pane's `Approve gate`, and the hub's Approve. The prompt reads:

```
The user ran /lk approve. <what was approved> Carry on with the task from where you stopped.
```

A button press reads `The user pressed <label>.` at the start instead. Opening the next stage's gate from the stage before it moves the pipeline, so it counts too, even when that gate was approved earlier. An approval that changed nothing ("The <stage> gate is already approved.", "has no gate to approve") sends no prompt, and neither does one made on the model's side (a verdict, `ExitPlanMode`, an auto move).

If a main turn is running, the prompt waits for that turn to end and is dropped if the stage has moved on by then. A budget-only approval made during a turn sends nothing. No prompt is sent in a non-interactive session, with the kill switch on, or with `pipeline.continueOnApprove: false` (default `true`). Non-interactive means no person at the prompt and no app surface attached, as in a plain `-p` run; a desktop session counts as interactive even when the desktop app hosts Claude Code through the SDK (`session.start` then says `isInteractive: false`, but `$.session.surfaces()` lists the desktop). `/lk status` shows `Continue after approval: on` or `off`. At Ship, the user's `/lk approve` is the asking, so Claude carrying on into the commit or push is intended. See [ADR 0012](adr/0012-continue-after-approval.md).

## The next step after every answer

An answer that only reports progress can read as if the task were done. So after each answered main turn a notice line in the chat (dim; Claude does not read it) says where the task stands, what comes next and what moves it there:

```
loopkeeper · <Stage> (<n> of <m>) · <next step>
```

The next step comes from one function over the stage machine's state (`nextStep` in `hooks/lib/stageModel.ts`), decided on the current stage, because a gate holds the move out of its own stage and `/lk approve` approves the current stage's gate or, from the stage before a gate, opens the next one. The first case that applies wins:

| # | When | Next step |
| --- | --- | --- |
| 1 | The band shows an Approve button: the plan gate waits for the user (ask approval, or a hold), or a planned budget waits | `Waiting for you: /lk approve (or a in /lk).` |
| 2 | Validate plan's gate is not approved, approval is auto, no hold | `A plan validator's consistent verdict opens the gate, or /lk approve.` |
| 3 | Any other stage's gate is not approved, except Ship and the last stage | `Waiting for you: /lk approve.` |
| 4 | A verifier subagent must finish before the move | `A verifier subagent checks the work first.` |
| 5 | Ship, with the ship gate on and shipping not open (no `/lk approve` at Ship, no `/lk gates ship ok`) | `/lk approve when you want Claude to commit, push or open a PR.` |
| 6 | The last stage, whatever its id | `Last stage: ask Claude to commit, push or open a PR; /lk reset starts the next task.` |
| 7 | Otherwise | `Next: <next stage>. Claude moves on when it starts that work, or /lk next.` When the next stage has a gate not yet approved (not a Ship gate with the ship gate off or `ship ok` on), it ends `or /lk approve opens <next stage> now.` |

A small task in a preset with a plan gate adds `Small task: the Validate plan gate is waived.`

The line shows only while a task is in play (sized, or the stage past the first), in an interactive session (as defined under continue after approval), with the kill switch off and `pipeline.nextHint` on (default `true`). A subagent's turn, a refusal, an interrupted turn and an API error get no line. The line is logged with `$.ui.log`, once per answered main turn and before any continue prompt goes: the terminal and the desktop draw it as a dim notice of its own, the answer's text is left as it is, and the model does not read the line. The hub and the Stage pane show the same sentence under their title, and `/lk status` shows it on its `Next:` line.

## The verifier

Two stages require a verifier subagent. A verifier counts once per visit to its stage: entering the stage again needs a new one. A small task's waiver is the exception: it counts the first time. The check is made by matching the subagent's type or description against the stage's `requiresAgent` pattern, and the subagent must have finished.

A validator that finished during Plan is kept (the stage calls it a carry), so a consistent verdict given later can still open the gate.

## Gates

| Gate | Stops |
| --- | --- |
| Plan gate | Edits to work files before the plan is approved (when `requirePlan` is on; the GSD loop turns it on). |
| Files per turn | The edit that would pass the turn's file limit. In the terminal the user is asked; elsewhere the edit is refused and the refusal names `/lk gates max <n>`. |
| Protected paths | Edits to matching globs. The default rules ask for `docs/decisions/**` and `**/migrations/**` and deny `.env*`. An ask rule asks in the terminal; elsewhere the edit is refused until the user runs `/lk gates allow <path>`, which allows that path for the session. |
| Ship gate | Shipping commands (commit, push, PR create or merge, release, publish, upload) until the stage opens shipping. |
| Merge gate | Merges into the default branch. A PR merge is held while its checks are not green. Then the user's Ship approval or `/lk gates merge ok` lets the next one through; without it the terminal asks, and elsewhere the merge is refused. |
| Amend and add-all | `git commit --amend` on a shared commit; `git add -A` that would stage untouched files (when `blockAddAll` is on). |
| Growth guard | A small task's file past its limit. |

Plan material (the scratchpad, `.claude/plans/**`, `docs/plans/**`, `**/*.plan.md`, `**/*.plan.html`) is exempt from the plan gate and does not count toward the file budget. Paths resolve against the project root (where the session started, or where `/cd` or a worktree move took it), so a shell `cd` into a subfolder does not change what is plan material or which protected globs match.

## The file budget

The budget is a count of distinct files one turn may edit.

1. The base is `changeControl.maxFilesPerTurn`, 10.
2. `set_stage {stage:'plan', size:'large', files:n}` records the planned count.
3. Approving the plan approves `n + planSlack` files (`planSlack` is 10). Auto approval covers a planned count up to `autoBudgetMax` (40). A bigger plan waits for `Approve budget · n files`, or `/lk approve`. At a gate other than Validate plan, a budget that still waits comes first: that `/lk approve` (or the hub's `a`) approves the budget, and the next one the gate.
4. In a preset with no plan gate (`default`), leaving Plan forward through `set_stage` or an auto move, in approval mode `auto` with no hold, approves a waiting budget as a validator's verdict would, up to `autoBudgetMax` planned files.
5. In any preset, approving a plan through Claude Code's plan mode (`ExitPlanMode`) moves the stage on and satisfies the gates' plan check, but it does not approve the planned budget. The budget waits for `Approve budget · n files` or `/lk approve`, and the base limit applies until then.
6. Past the limit, the user chooses: `Allow 1 more`, `Allow rest of turn`, `Raise to <limit + planSlack> for this session`, or `Stop`.

The budget clears when the plan is approved again, when the stage goes back to Plan, when the task is re-sized, on `/lk reset`, and for a small task. A raise lasts the session. Subagent edits count only with `countSubagents` on.

## Worked example: a large task from sizing to Ship

The task: add a cache layer to a small service. The plan touches 13 files. The project uses `approval: ask`.

**1. Turn GSD mode and the loop on.**

```
/lk on
/lk loop on
```

The stage moves to the `gsd` preset and the gates require a plan. The stage band reads `stage ● Plan ─ ○ Validate plan ⚑ ⇄ ─ …`.

**2. Plan the task.** Claude writes the Goal, Steps, Done-when and the files, then sizes it:

```
set_stage { stage: "plan", size: "large", files: 13, note: "add the cache layer" }
```

The stage band shows the planned count, and the budget is not granted until the plan is approved. After Claude's answer, the next-step line shows as a notice in the chat:

```
loopkeeper · Plan (1 of 6) · Next: Validate plan. Claude moves on when it starts that work, or /lk approve opens Validate plan now.
```

**3. Validate the plan.** Claude starts a validator subagent, then records its verdict:

```
set_stage { stage: "validate-plan", verdict: "consistent", note: "plan checked" }
```

The verdict is consistent, but `approval: ask` keeps the gate closed. The band shows the button:

```
stage ✓ Plan ─ ● Validate plan ⚑ ⇄ ─ ○ Execu… ─ ○ Valid… ⇄ ─ ○ QA ─ ○ Ship ⚑ · in Validate plan <1m
[ Approve plan · 13 files ]
```

The answer's line says the same:

```
loopkeeper · Validate plan (2 of 6) · Waiting for you: /lk approve (or a in /lk).
```

The user runs `/lk approve`. The budget becomes 23 (13 planned plus 10). The gate opens and the stage moves on. Just after the command answers, loopkeeper submits one prompt, so Claude carries on without a second message from the user:

```
The user ran /lk approve. Approved the Validate plan gate; the pipeline may now move past it. File budget: 23 files a turn (13 planned + 10). Carry on with the task from where you stopped.
```

**4. Execute.** Claude moves to the next stage and works through subagents:

```
set_stage { stage: "execute", note: "build it" }
```

The notice line after each answer now reads:

```
loopkeeper · Execute (3 of 6) · Next: Validate. Claude moves on when it starts that work, or /lk next.
```

The gates count the distinct files each turn touches. The gates band reads `gates  ● 2/23 files  ● plan ok  ● merge gate  ● ship held   budget 23`: a bold label, up to four `● word` chips in their tone (the files chip turns to the warning tone near the limit and to the error tone once a rule fired this turn), and a quiet right side that names where the limit comes from when it is not the base (`budget 23`, `raised 33`, `max 3`).

**5. Validate.** Claude starts a verifier subagent and moves on:

```
set_stage { stage: "validate", note: "verify the cache" }
```

If no matching verifier has finished, `set_stage` refuses the move and says which agent it needs. A turn that ends in Validate before the verifier has finished says so:

```
loopkeeper · Validate (4 of 6) · A verifier subagent checks the work first.
```

**6. QA.** Claude runs the tests and the build, then moves on:

```
set_stage { stage: "qa", note: "tests and build" }
```

```
loopkeeper · QA (5 of 6) · Next: Ship. Claude moves on when it starts that work, or /lk approve opens Ship now.
```

**7. Ship.** Claude tries to commit. A commit never moves the stage into a gated Ship, so the pipeline stays at QA and the gate refuses it:

```
loopkeeper: shipping is gated (git commit). The pipeline is at QA. Ask the user to review the work and run /lk approve at QA or Ship (it opens the Ship gate; a waiting file budget comes first), or /lk gates ship ok.
```

Had Claude moved to Ship first, the answer's line there would name what the user does next:

```
loopkeeper · Ship (6 of 6) · /lk approve when you want Claude to commit, push or open a PR.
```

The user reviews the work and runs:

```
/lk approve
```

From QA it opens the Ship gate and moves the pipeline to Ship. Shipping opens, and loopkeeper's prompt (`The user ran /lk approve. Approved the Ship gate and moved to Ship: Claude may commit, push or open a PR. Carry on with the task from where you stopped.`) has Claude run the commit. At Ship itself the reply reads `Approved the Ship gate; the pipeline may now move past it.` The approval also covers the next `git push origin main`, so it runs without a question; one after that asks once, through the merge gate, with `Merge` and `Cancel`, in the terminal (elsewhere it is refused until `/lk approve` at Ship or `/lk gates merge ok`). The stage pane's history lists each move with its cause (`tool`, `command` or `auto`). From here every answer ends with:

```
loopkeeper · Ship (6 of 6) · Last stage: ask Claude to commit, push or open a PR; /lk reset starts the next task.
```

## Turning the loop off

`/lk loop off` goes back to the `default` preset and turns the plan gate off. `/lk off` turns GSD mode off as well. `/lk reset` clears the size, the verdict, the hold, the waiver, the files and the approved budget for the task in progress.
