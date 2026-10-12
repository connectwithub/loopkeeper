# loopkeeper

loopkeeper is a Claude Code plugin, the core of the [loopkeeper set](../../README.md), that runs a task loop (plan, validate the plan, execute, verify, QA, ship) and enforces its rules. It adds approval gates, a file budget per turn tied to the approved plan, protected paths, a ship gate, merge and amend guards, model routing by role, bounded review loops and a decision log. The rules are hooks with shared state, not instructions the model may ignore: a call the rules refuse does not run. You agree on a plan once; with the gates on, Claude cannot edit before that plan is approved, change more files than it allows, or commit and push before you say so, and after `/lk approve` it carries on by itself.

**Use it when**

- A large change should follow a plan you approved, with Claude held at the gate instead of asked to wait.
- Parts of the repo are off limits or need your OK first, such as `docs/decisions/`, migrations or `.env` files.
- You want commits, pushes and merges held until you approve them, and merges to the default branch held until CI is green.

**Install:** `/plugin install loopkeeper@loopkeeper`, after `/plugin marketplace add connectwithub/loopkeeper` (the add-ons are listed in the [set's README](../../README.md)).

**Data handling:** it keeps its saved settings (such as the preset, the approval mode and the routes) in its own plugin store, and the loop's state in session state. It reads `~/.claude/loopkeeper.json` and `<project>/.claude/loopkeeper.json`, and writes only the review log, `.claude/loopkeeper-review.jsonl`, and the project's decision log. It runs read-only `git` and `gh` queries for the merge gate and the Files pane; the `gh` ones reach GitHub through your own `gh` sign-in. It has no network of its own and makes no model calls, except the decision watch, which is off by default and, when on, makes model calls on your own Claude Code session. It collects no personal data; what it saves stays until you delete it. Details under [Footprint](#footprint).

**Commands:** `/lk` (also `/loopkeeper`), `/files`, `/reviews`, `/decide` and `/decisions` are listed under [Commands](#commands), and the five tools it gives the model under [Tools](#tools).

Requires Claude Code 2.1.294 or later.

## Try it

```sh
claude --plugin-dir /path/to/loopkeeper/plugins/loopkeeper
```

Then run `/lk` for the hub, or `/lk status`. To install it from the loopkeeper marketplace (https://github.com/connectwithub/loopkeeper), see [Install](../../README.md#install) in the set's README.

loopkeeper uses its own command names. The built-ins own `/loop` and `/code-review`, so the old names are gone (see [ADR 0002](../../docs/adr/0002-command-names.md)).

| Before | After | Notes |
| --- | --- | --- |
| `/pipeline` | `/lk stage` | Opens the Stage pane. `/lk` alone opens the loopkeeper hub, which links every pane. `/loopkeeper` is the long form. |
| `/pipeline <stage>`, `next`, `back` | `/lk <stage>`, `/lk next`, `/lk back` | Sub-command words win over stage ids. |
| `/pipeline approve`, `waive`, `status` | `/lk approve`, `/lk waive`, `/lk status` | |
| `/pipeline preset <name>`, `size`, `small-max`, `auto` | `/lk preset <name>`, `/lk size`, `/lk small-max`, `/lk auto` | |
| `/pipeline reset` | `/lk reset` | Resets the stage machine. |
| `/pipeline approval auto\|ask`, `/gsd approval auto\|ask` | `/lk approval auto\|ask` | One mode for the whole plugin ([ADR 0005](../../docs/adr/0005-one-approval-mode-and-plan-list.md)). |
| `/gsd` | `/lk routes` | Opens the routing pane. |
| `/gsd on\|off`, `/gsd loop on\|off` | `/lk on\|off`, `/lk loop on\|off` | GSD mode and the loop. |
| `/gsd route <role> <model>`, `/gsd explain <text>` | `/lk route <role> <model>`, `/lk explain <text>` | |
| `/gsd reset` | `/lk route reset` | `/lk reset` is the stage reset. |
| `/gsd text` | `/lk text` | Plain-text status. |
| `/change-control` | `/lk gates` | Opens the gates pane. |
| `/change-control text`, `files` | `/lk gates text`, `/lk gates files` | `/files` still opens the Files pane. |
| `/change-control on\|off` | `/lk gates on\|off` | Session switch for every gate. Not the same as `/lk on\|off`. |
| `/change-control max <n>` | `/lk gates max <n>` | |
| `/change-control plan ok`, `plan required on\|off`, `plan paths` | `/lk gates plan ok`, `/lk gates plan required on\|off`, `/lk gates plan paths` | |
| `/change-control ship ok`, `ship gate on\|off` | `/lk gates ship ok`, `/lk gates ship gate on\|off` | |
| `/change-control band on\|off` | `/lk band [stage\|gates\|files\|routing\|review\|decisions] on\|off` | No concern named means all of them. |
| `/review` | `/reviews` | Same words: `text`, `status`, `clear`, `kinds`, `kind`, `target`, `max`, `ship`, `reopen`, `stop`, `band`, `context`. |
| `/decide`, `/decisions`, `/files` | unchanged | |
| tools `set_stage`, `review_cycle`, `review_item`, `review_status`, `record_decision` | `mcp__loopkeeper__<name>` | Same names and inputs. |

## Commands

Everything is under `/lk` (or `/loopkeeper`), except `/reviews`, `/decide`, `/decisions` and `/files`. Each word is answered by the concern that owns it; shared words (`status`, `text`, `reload`, `band`, `on`, `off`) are answered by every concern and joined in one reply.

### `/lk`

| Form | What it does |
| --- | --- |
| `/lk` | Opens the loopkeeper hub: the stage, one row per panel with its live status, the other mods and the actions. |
| `/lk stage` | Opens the Stage pane. |
| `/lk help` | Lists the keys (below). |
| `/lk status`, `/lk text` | Status: stage, routing and gates. `text` is plain text. `/lk status` also says `Continue after approval: on` or `off`. |
| `/lk <stage>`, `/lk next`, `/lk back` | Moves the stage. `<stage>` is an id of the current stages. `stage` and `help` are read as the words above, so a custom stage with one of those ids is reached with `next`, `back` or `set_stage`. |
| `/lk approve` | Approves the current stage's gate or, from the stage before a gate, the next one, then asks the model to carry on (see Continue after approval). From the stage before (no gate of its own waiting, no budget waiting) it opens the next stage's gate and moves into it: at Plan in the gsd preset the Validate plan gate ("Approved the Validate plan gate and moved to Validate plan; Claude may start Execute."), at QA the Ship gate. The approval also vouches for the verifier of the stage it leaves and of the gate's stage. It never opens a gate two stages ahead; a gate already approved (after `/lk back`) is moved into without approving it again. At Validate plan, or opening it from Plan, it approves the planned file budget with the plan. At any other gate a planned budget that still waits comes first: this `/lk approve` approves the budget, the next one the gate. With the gate already open, or no gate, it approves a waiting budget. |
| `/lk waive` | Waives the gate for the current task. |
| `/lk size small\|large` | Sizes the task. |
| `/lk small-max <n>` | The small-task limit for this session, 1 to 20. |
| `/lk preset <name>` | Sets the stage preset for the project. |
| `/lk approval auto\|ask` | Plan approval mode for the project. |
| `/lk auto on\|off` | Automatic stage moves. |
| `/lk reset` | Clears size, verdict, hold, waiver, files and the approved budget. |
| `/lk on\|off` | GSD mode. |
| `/lk loop on\|off` | The loop: the `gsd` preset and the plan gate with it. |
| `/lk reload` | Re-reads `loopkeeper.json` for every concern. |
| `/lk band [stage\|gates\|files\|routing\|review\|decisions] on\|off` | Shows or hides a band. With no concern named, all of them. |
| `/lk routes` | Opens the routing pane. |
| `/lk route <recon\|execute\|verify\|hard\|default> <haiku\|sonnet\|opus\|model-id>` | Overrides a role's model. Saved in the plugin store for every session on this machine until `/lk route reset`. |
| `/lk route reset` | Drops every `/lk route` override. |
| `/lk explain <text>` | Says which role and model a subagent with this description would get. |
| `/lk gates …` | The gates, below. |

### Keys

`/lk` is the way in. Claude Code 2.1.294 lets a plugin bind keys only inside its own panes and band, so there is no global shortcut. The keys work while a loopkeeper pane has the focus; a pane opened from the hub or the nav row takes the focus when it can ([ADR 0014](../../docs/adr/0014-hub-and-keys.md)).

| Where | Key | What it does |
| --- | --- | --- |
| Stage, Gates, Files, Routes, Reviews and Decisions panes | `0` to `6` | The nav row on the first line: `0` Hub, `1` Stage, `2` Gates, `3` Files, `4` Routes, `5` Reviews, `6` Decisions. Closes this pane and opens that one. |
| Hub | `1` to `6` | Opens that panel, as above. |
| Hub | `m`, `u`, `h`, `t`, `w`, `p`, `s` | The add-ons: Agents (`/agent-map cards`, lk-agent-map), Budget (`/budget`, lk-token-budget), Handoff (`/handoff`, lk-handoff-guard), Attention (`/attention`, lk-attention), Where (`/where`, lk-where-am-i), PRs (`/pr`, lk-pr-watch), Secrets (`/secret-guard`, lk-secret-guard). Each shows only when that add-on's command is listed. On the desktop a press closes the hub and runs the command, which opens the mod's own pane. On the terminal, or if the run is refused, it fills an empty prompt box with the command and says "Press Enter"; with a draft it keeps the draft and names the command to type. |
| Hub | `a` | Approves what waits, the way `/lk approve` does (a planned budget before a gate other than Validate plan); shown only while something waits, or, while a task is in play, when `/lk approve` can open the next stage's gate. Then the model carries on. |
| Hub | `o` | Puts `/lk on` or `/lk off` in the prompt box. |
| Hub | `c` | Closes the hub. |
| Prompt box | ctrl+x tab | Focuses the band, or a pane that opened without the focus. On the terminal a toast says so, once per session; the desktop shows no such toast. |

A pane's own buttons keep their letter keys where they have one (`b: Back`, `n: Next` and so on); no digit is used by them. The Files pane's name filter takes every key while it has the focus, so digits switch panes there only once the focus leaves it.

Status chips in the panes (`Not committed`, `Reading`, `ask`, `deny`, `asked`, `p0` to `p2` and the like) are rounded Svg pills on the desktop app, VS Code and mobile: white text on a fill dark enough for a contrast ratio of 4.5:1 or more (the kit's `CHIP_HEX`). The terminal draws a chip as `● text` in the tone's colour ([ADR 0013](../../docs/adr/0013-kit-v3-svg-and-theme-fills.md)).

### `/lk gates`

From the gates' own usage line: `pane`, `text`, `files`, `max <n>`, `plan ok`, `plan required on|off`, `plan paths`, `ship ok`, `ship gate on|off`, `on`, `off`, `reload`, `band on|off`.

- `/lk gates on|off` is the session switch for every gate. `/lk on|off` is GSD mode. The two are different.
- `/lk gates max <n>` sets a per-turn limit for the session. `/lk gates reload` is the same as `/lk reload`.
- `/lk gates plan ok` allows edits for the session. While the pipeline's plan gate (gsd: Validate plan) is still pending, the reply says that gate is separate: moving past it still needs `/lk approve` (in auto approval a plan validator's consistent verdict also opens it).
- The config is read from the project root, and the plan and protected-path checks resolve paths against it, so a shell `cd` does not move them.

### `/reviews`

```
/reviews [text | status [subject] | clear <subject> | kinds | kind <subject> <kind> | target <n> [subject] |
          max <n> [subject] | ship <subject> | reopen <subject> | stop <subject> |
          band on|off | context on|off]
```

With no words it opens the review pane. `kind` is one of `critic`, `review`, `plan`, `qa`, `copy`, `design`.

### `/decide`, `/decisions`, `/files`

- `/decide <decision> -- <why> #tag #tag` records a decision. `/decide prefs [clear]` lists or clears the learned preferences. `/decide watch on|off|status` and `/decide watch model <haiku|sonnet|model id>` control the decision watch (off by default).
- `/decisions` opens the decision pane. `/decisions text`, `/decisions reload`, and `/decisions band on|off` do the rest.
- `/files` opens the Files pane: what Claude read and edited this session, and the project tree. It still opens when loopkeeper is off.

## Tools

Claude calls these tools; they are named `mcp__loopkeeper__<name>`.

| Tool | Inputs | What it does |
| --- | --- | --- |
| `set_stage` | `stage` (required), `note`, `size` (`small` or `large`), `files` (a number, for the plan's budget), `verdict` (`consistent` or `issues`) | Moves the stage, sizes the task, records the file count or a plan verdict. |
| `review_cycle` | `subject` (required), `kind`, `doneBy` (`score` or `items`), `score`, `target`, `maxCycles`, `cycle`, `verdict` (`ship`, `iterate` or `stop`), `items` (`text`, `priority` `p0`/`p1`/`p2`, `done`) | Records one pass of a review loop. It is wrapped by the stage, which records a plan pass as the plan verdict when the review is done. |
| `review_item` | `subject`, `text` (required), `done`, `proof`, `priority` | Adds an open item, or closes one with a proof (a path, output or commit). |
| `review_status` | `subject` (optional) | Shows one subject's loop state, or all of them. |
| `record_decision` | `decision` (required), `why`, `tags` | Appends a decision to the project's log. |

## The loop

The loop is a list of stages. Each stage is a move in `set_stage` or `/lk <stage>`. The GSD preset is the full loop; the default preset is four plain stages.

| Stage id | Label | Gate | What it needs |
| --- | --- | --- | --- |
| `plan` | Plan | | Claude writes Goal, Steps, Done-when and the files it touches. Given as `set_stage {stage:'plan', size:'large', files:n}`. |
| `validate-plan` | Validate plan | ⚑ gate, ⇄ verifier | A subagent whose type or description matches `valid\|review\|verif\|critic\|audit\|plan` must finish. Then `set_stage {stage:'validate-plan', verdict:'consistent'\|'issues'}`. Consistent opens the gate in auto approval; in ask approval the user approves it. |
| `execute` | Execute | | The work, through subagents. Routing picks their models. |
| `validate` | Validate | ⇄ verifier | A subagent matching `verif\|valid\|review\|critic\|audit\|test\|qa` must finish during this visit. |
| `qa` | QA | | Tests and the build run. |
| `ship` | Ship | ⚑ gate | Shipping commands are held until the stage opens shipping (`/lk approve`). |

⚑ means the stage is a gate and waits for approval. ⇄ means a verifier subagent is required before the stage can move on. A verifier counts once per visit to the stage, except that a small task's waiver counts the first time.

- **Presets.** `default` is `plan, build, qa, ship`, with no gates and no verifier. `gsd` is the full loop above. `/lk preset <name>` sets one for the project; a project can define its own presets in the `pipeline` section.
- **GSD mode.** `/lk on` and `/lk off` switch GSD mode. `/lk loop on` runs the loop: with GSD mode and the loop both on, the stage uses the `gsd` preset and the gates require a plan. A change of mode moves the preset only while the loop is on, and `/lk loop off` goes back to the default preset. A session that starts with both on begins in `gsd`.
- **Sizing.** Every task is sized first, with `set_stage {stage:'plan', size:'small'|'large'}` or `/lk size small|large`. A small task is one clear change in at most `pipeline.smallMaxFiles` files (default 3). It waives the plan gate and the verifier. If a fourth file is about to be touched, the growth guard refuses it, the task goes back to Plan, and its size is cleared. A large task runs the full loop.
- **Approval.** `/lk approval auto` (the default) lets a validator's consistent verdict open the plan gate. `/lk approval ask` keeps the gate closed until the user approves it: `/lk approve`, the band's `Approve plan · n files` button, the Stage pane's `Approve gate` button or the hub's `a`. `/lk approve` works from Plan too: it opens the Validate plan gate and moves there (see `/lk approve` in Commands). The mode is kept per project.
- **Continue after approval.** When a user approval changes something (a gate or a waiting budget newly approved, or a move into the next stage's gate from the stage before it), loopkeeper submits one prompt so the model carries on: "The user ran /lk approve. <outcome> Carry on with the task from where you stopped." (or "The user pressed <button label>."). The prompt is framed as the plugin's message, not as the user's. From `/lk approve` it is sent just after the command answers. During a running turn it waits for that turn's end and is dropped if the stage has moved on by then; a budget-only approval during a turn sends nothing. It is never sent in a non-interactive session, with the kill switch on, or with `pipeline.continueOnApprove: false`. Non-interactive here means no person at the prompt and no app surface attached, as in a plain `-p` run; a desktop session counts as interactive even when the desktop app hosts Claude Code through the SDK. Model-side approvals (a validator's verdict, a plan review pass, `ExitPlanMode`) and `/lk gates plan ok` send nothing. At Ship, the user's `/lk approve` is the asking, so the model goes on into the commit or push ([ADR 0012](../../docs/adr/0012-continue-after-approval.md)).
- **Next step after every answer.** After each answered main turn, a notice line in the chat (dim; Claude does not read it) says where the task stands and what moves it on: `loopkeeper · <Stage> (<n> of <m>) · <next step>`, for example `loopkeeper · QA (5 of 6) · Next: Ship. Claude moves on when it starts that work, or /lk approve opens Ship now.` The next step is decided on the current stage, and the first case that applies wins:
  1. The band shows an Approve button (the plan gate waits for the user in ask approval or under a hold, or a planned file budget waits): "Waiting for you: /lk approve (or a in /lk)."
  2. Validate plan's gate is not approved, approval is auto and nothing holds it: "A plan validator's consistent verdict opens the gate, or /lk approve."
  3. Any other stage's gate is not approved (custom presets can gate any stage), except Ship and the last stage: "Waiting for you: /lk approve."
  4. A verifier subagent must finish before the move: "A verifier subagent checks the work first."
  5. Ship, with the ship gate on and shipping not open (no `/lk approve` at Ship, no `/lk gates ship ok`): "/lk approve when you want Claude to commit, push or open a PR."
  6. The last stage, whatever its id: "Last stage: ask Claude to commit, push or open a PR; /lk reset starts the next task."
  7. Otherwise: "Next: <next stage>. Claude moves on when it starts that work, or /lk next." When the next stage has a gate not yet approved, the sentence ends "or /lk approve opens <next stage> now." instead, except for a Ship gate with the ship gate off or `/lk gates ship ok` on.

  A small task in a preset with a plan gate adds "Small task: the Validate plan gate is waived." The line shows only in an interactive session (see Continue after approval), with the kill switch off and `pipeline.nextHint` on, and only while a task is in play (sized, or the stage past the first). It does not show after a subagent's turn, a refusal, an interrupted turn or an API error. It is logged with `$.ui.log`, once per answered main turn and before any continue prompt: the terminal and the desktop draw it as a dim notice, the answer's text is left as it is, and the line is not sent to the model. The same sentence sits under the title of the hub and the Stage pane, and on the `Next:` line of `/lk status`.
- **Hold phrase.** A prompt the person sends (typed, through the bridge, or from the SDK host) that asks to wait holds the gate even when the verdict is consistent: phrases such as "wait for approval", "ask me first", "check with me", "let me approve the plan", "I want to review the plan", "review the plan first", "plan only" or "just the plan". A mention such as "once I approve the plan" does not hold. A prompt from anywhere else (a plugin, a peer session, a task notification, a channel) never holds. `/lk approve` clears the hold.
- **Plan material.** Files in the scratchpad (`/tmp/claude-*`), `.claude/plans/**`, `docs/plans/**`, `**/*.plan.md` and `**/*.plan.html` are plan material. They are exempt from the plan gate and never count toward the file budget. The list is `changeControl.planPaths`. Paths resolve against the project root (where the session started, or where `/cd` or a worktree move took it), so a shell `cd` into a subfolder does not change what counts. Protected rules still apply to a plan file if its path matches one; the defaults match none.

## The file budget

Claude Code's turn is the unit. loopkeeper counts the distinct files a turn edits (Edit, Write, MultiEdit, NotebookEdit and Bash writes it can see), and refuses the edit that would pass the limit unless someone allows it.

- **Base.** `changeControl.maxFilesPerTurn` is 10 ([ADR 0011](../../docs/adr/0011-plan-scoped-file-budget.md)).
- **Plan budget.** `set_stage {stage:'plan', size:'large', files:n}` records the planned count. Approving the plan approves `n + planSlack` files (`planSlack` is 10). The text "13" is read as 13; "12 files", 2.5, 0 and negatives are refused. Approval comes from a validator's consistent verdict in auto approval, a plan review pass with no open p0 or p1 item, leaving Plan in a preset with no plan gate (below), `/lk approve`, the band's `Approve plan · n files` button, the Stage pane's `Approve gate` button, or the hub's `a`.
- **No plan gate.** In a preset whose plan stage has no gate (the default preset), leaving Plan forward through `set_stage` or an automatic move, in auto approval with no hold, approves a waiting budget the way a validator's verdict would, up to `autoBudgetMax`. A move through `ExitPlanMode` does not (see Plan mode).
- **Auto approval limit.** Auto approval covers budgets up to `autoBudgetMax` (40) planned files. A larger budget leaves the plan gate open and waits for `Approve budget · n files` or `/lk approve`. This also works later, from Execute.
- **Plan mode.** Approving a plan through Claude Code's plan mode (`ExitPlanMode`) moves the stage on and satisfies the gates' plan check. It does not approve the planned file budget. The budget then waits for the band's `Approve budget · n files` button or `/lk approve`, and until then the base limit applies.
- **Limit in force.** The limit is the `/lk gates max <n>` override if one is set. Otherwise it is the largest of the base, the approved budget and the session raise.
- **The limit question.** Past the limit, the user is asked with four options: `Allow 1 more`, `Allow rest of turn`, `Raise to <limit + planSlack> for this session`, and `Stop`. With no plan, the raise reads `Raise to 20`. The figure is computed once, so the label and the effect match. `Stop`, a dismissal, or no one to ask (a non-interactive session) denies the edit and ends the turn 250 ms later. A raise under a `max` override raises the override too.
- **Lifetimes.** `turn.start` resets the turn's count. A subagent's turn does not reset it, and a subagent's edits count only when `changeControl.countSubagents` is on. The approved budget clears when the plan is approved again, when the stage goes back to Plan, when the task is re-sized, on `/lk reset`, and for a small task. Re-planning before approval replaces the count. A session raise lasts the session. When several values apply, the larger one wins.
- **Band.** The band reads `gates  ● <count>/<limit> files  ● plan ok  ● merge gate  ● ship held`, with where the limit comes from on the right (`budget 23`, `raised 33`, `max 3`). The gates pane reads, for example, `Files per turn: 23 (the approved plan's budget: 13 planned + 10)`.

## The gates

Each gate decides one kind of call. The `/lk gates` commands and the config keys in [Config](#config) change them. `CLAUDE_MODS_DISABLE` turns them all off (see [Kill switch](#kill-switch-and-failing-closed)).

### Plan gate

| | |
| --- | --- |
| Trigger | Edits to work files before a plan is approved |
| What happens | Refused with a message. With a plan gate it asks for `/lk approve`, which opens the gate from that stage or the stage before it (gsd: Plan or Validate plan), or `/lk gates plan ok`; without one, it says to move the pipeline past Plan or ask for `/lk gates plan ok`. Stage names come from the preset's labels. |
| Setting (default) | `requirePlan` (off; the GSD loop turns it on) |
| How to get past it | `/lk approve` (at Validate plan or the stage before it), `/lk gates plan ok`, `/lk gates plan required off` |

### Files per turn

| | |
| --- | --- |
| Trigger | An edit that passes the limit (see [the file budget](#the-file-budget)) |
| What happens | Asks with four options; without a yes, denies and ends the turn |
| Setting (default) | `maxFilesPerTurn` (10), `planSlack` (10), `autoBudgetMax` (40), `countSubagents` (off) |
| How to get past it | The options; `/lk gates max <n>` |

### Protected paths

| | |
| --- | --- |
| Trigger | An edit to a path matching a glob (relative to the project root, as for plan material) |
| What happens | Asks `Allow once`, `Allow for session` or `Deny`; a `deny` rule refuses outright |
| Setting (default) | `protected`: `docs/decisions/**` ask, `.env*` deny, `**/migrations/**` ask |
| How to get past it | The answer; `{"glob", "action":"off"}` removes a rule |

### Ship gate

| | |
| --- | --- |
| Trigger | `git commit`, `git push`, `gh pr create`, `gh pr merge`, `gh release create`, `npm`, `pnpm`, `yarn` (and `yarn npm`) `publish`, `cargo publish`, `pip upload`, `twine upload` |
| What happens | Refused until the stage has opened shipping |
| Setting (default) | `shipGate` (on) |
| How to get past it | `/lk approve` at Ship or the stage before it (a waiting file budget comes first), `/lk gates ship ok`, `/lk gates ship gate off` |

### Merge gate

| | |
| --- | --- |
| Trigger | `gh pr merge`; `git merge` into the default branch; `git push` that updates the default branch |
| What happens | With `requireGreenCi`, a PR merge is held while its checks fail or run (`gh pr checks`). Otherwise asks `Merge now?` with `Merge` or `Cancel` |
| Setting (default) | `mergeGate` (on), `requireGreenCi` (on) |
| How to get past it | Choose `Merge`; `mergeGate: false` |

### Amend

| | |
| --- | --- |
| Trigger | `git commit --amend` on the default branch or on a pushed HEAD |
| What happens | Refused: make a new commit |
| Setting (default) | `blockAmend` (on) |
| How to get past it | `blockAmend: false` |

### Add-all

| | |
| --- | --- |
| Trigger | `git add -A`, `--all`, `.` and similar, when files outside the session are untouched |
| What happens | Refused: stage the files by name |
| Setting (default) | `blockAddAll` (off) |
| How to get past it | `blockAddAll: true` turns it on |

### Growth guard

| | |
| --- | --- |
| Trigger | A small task's fourth file |
| What happens | Refused before the other gates see it; the task returns to Plan and its size clears |
| Setting (default) | `pipeline.smallMaxFiles` (3); `/lk small-max <n>` (1 to 20) |
| How to get past it | `/lk size large` |

### Spawn routing

| | |
| --- | --- |
| Trigger | A subagent starts while GSD mode and routing are on |
| What happens | Its model is set by role. A routing error lets the spawn through unchanged |
| Setting (default) | `routing` (see [Config](#config)) |
| How to get past it | `/lk route <role> <model>`, `/lk route reset`, `/lk loop off` |

Notes:

- Protected rules are checked on every edit, including plan files.
- A gate that fails on an error refuses the call and says so. See [Kill switch and failing closed](#kill-switch-and-failing-closed).
- The ship gate and the merge gate read the commands in the Bash call. A command assembled in a script is not seen.

## Config

Settings come from two JSON files, read in this order. Later layers win:

1. Built-in defaults.
2. `~/.claude/loopkeeper.json` (the user file).
3. `<project>/.claude/loopkeeper.json` (the project file).

Session overrides kept in the plugin store (set by `/lk`, for example `/lk preset`, `/lk gates max`, `/lk route`) apply after the files. A broken file is skipped with a problem note; the other layers still apply. An unknown key or a wrong type is reported and the default stays.

The file has five sections: `pipeline`, `changeControl`, `routing`, `review` and `decisions`.

### `pipeline`

| Key | Default | Meaning |
| --- | --- | --- |
| `stages` | `plan`, `build`, `qa`, `ship` (no gates) | The stage list. Each item is `{ "id", "label", "gate"?, "requiresAgent"? }`. `requiresAgent` is a regex a subagent's type or description must match. |
| `auto` | `true` | Automatic stage moves. |
| `presets` | `{}` | Named stage lists, merged by name over the built-in `default` and `gsd`. |
| `approval` | `"auto"` | `"auto"` or `"ask"`. A saved `/lk approval` for the project wins. |
| `smallMaxFiles` | `3` | Files a small task may touch (1 to 20). |
| `continueOnApprove` | `true` | After a user approval that changed something, submit one prompt so the model carries on (see Continue after approval). `false` turns it off. |
| `nextHint` | `true` | Show the next-step line, a notice line in the chat after each answer (dim; Claude does not read it); see Next step after every answer. `false` turns it off; the hub, the Stage pane and `/lk status` still show the sentence. |

### `changeControl`

| Key | Default | Meaning |
| --- | --- | --- |
| `maxFilesPerTurn` | `10` | The base per-turn file limit (was 6 in the old mods). |
| `planSlack` | `10` | Added to the approved plan's file count. |
| `autoBudgetMax` | `40` | Largest planned count that auto approval covers. |
| `protected` | `docs/decisions/**` ask, `.env*` deny, `**/migrations/**` ask | Rules `{ "glob", "action": "ask" \| "deny" \| "off" }`. `"off"` removes a glob from the layer below. |
| `requirePlan` | `false` | Plan gate on or off. The GSD loop sets it. |
| `mergeGate` | `true` | Merge gate. |
| `requireGreenCi` | `true` | Hold a PR merge while its checks are not green. |
| `blockAmend` | `true` | Refuse `git commit --amend` on a shared commit. |
| `blockAddAll` | `false` | Refuse `git add -A` and similar when it would stage untouched files. |
| `countSubagents` | `false` | Count subagent edits toward the turn's limit. |
| `shipGate` | `true` | Ship gate. |
| `planPaths` | `.claude/plans/**`, `docs/plans/**`, `**/*.plan.md`, `**/*.plan.html` | Plan material. The scratchpad is always plan material too. |

### `routing`

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `null` | `true` or `false` sets whether routing is on at start. `null` is off, unless the stored `/lk on` or `/lk off` says otherwise. |
| `override` | `false` | When `true`, routing replaces a subagent's explicit `model`. When `false`, an explicit model stays. An inline `[role:x]` or `[model:x]` tag always wins. |
| `models` | `{ "haiku": "haiku", "sonnet": "sonnet", "opus": "opus" }` | Alias to model. Pin a full model id here to keep one model. |
| `roles` | `{}` (built-in table) | Role to `"alias-or-id"` or `{ "model", "keywords" }`. Roles are `recon`, `execute`, `verify`, `hard` and `default`. Built-in: recon → haiku, execute → sonnet, verify → sonnet, hard → opus, default → sonnet. Keyword lists are in `hooks/lib/routingConfig.ts`. |

### `review`

| Key | Default | Meaning |
| --- | --- | --- |
| `kinds` | `{}` (built-in table) | Per kind: `{ "target"?, "maxCycles"? }`. A missing value uses the kind's preset. |

Built-in presets, from `hooks/lib/reviewModel.ts`:

| Kind | Done by | Target | Max cycles |
| --- | --- | --- | --- |
| `critic` | score | 9.0 | 4 |
| `review` | items | | 3 |
| `plan` | items | | 2 |
| `qa` | items | | 3 |
| `copy` | score | 8.5 | 3 |
| `design` | score | 9.0 | 4 |

### `decisions`

| Key | Default | Meaning |
| --- | --- | --- |
| `watch` | `false` | The decision watch. It calls a model on qualifying turns; see [Footprint](#footprint). |
| `watchModel` | `"haiku"` | Model for the watch. |
| `watchMaxPerHour` | `20` | Hourly cap across sessions. |
| `watchMinChars` | `200` | Shortest turn the watch reads. |
| `file` | `""` | Log path relative to the project (inside it). `""` finds a log. Set from the project file only. |
| `format` | `"jsonl"` | `jsonl`, `markdown`, `brain-md` (an alias of `markdown`) or `journal-md`. Set from the project file only. |

The log is looked up in this order when `file` is empty: `docs/decisions/decisions.jsonl`, `.claude/brain/decisions.md`, `brain/decisions.md`, `DECISION_JOURNAL.md`. If none exists and `docs/decisions/` does, a `decisions.jsonl` is started there; otherwise the default is `.claude/decisions.jsonl`.

### Example

`<project>/.claude/loopkeeper.json`:

```json
{
  "pipeline": { "approval": "ask", "smallMaxFiles": 2 },
  "changeControl": {
    "maxFilesPerTurn": 12,
    "protected": [
      { "glob": "config/prod/**", "action": "deny" },
      { "glob": "**/migrations/**", "action": "off" }
    ],
    "blockAddAll": true
  },
  "routing": { "roles": { "hard": { "model": "opus" } } },
  "decisions": { "file": "docs/decisions/decisions.jsonl", "format": "jsonl" }
}
```

### Store keys and old settings

Session state is kept in the plugin store under `loopkeeper:<concern>:<key>`, for example the saved preset for a project (`loopkeeper:stage:preset:<project path>`) or the approval mode (`loopkeeper:stage:approval:<project path>`).

Nothing is migrated from the old mods. loopkeeper does not read `.claude/pipeline.json`, `change-control.json`, `gsd-orchestrator.json`, `decision-pad.json`, or their store keys, and it does not read the old review log. A fresh install starts from defaults. To carry settings over, copy the values by hand into `loopkeeper.json`: `pipeline.json` into `pipeline`, `change-control.json` into `changeControl`, `gsd-orchestrator.json` into `routing`, and `decision-pad.json` into `decisions`. Review kept its per-kind values in the store only, so there is nothing to copy for it.

## Footprint

The plugin's footprint, as `claude plugin validate --strict plugins/loopkeeper` reports it from the repository root (Claude Code 2.1.294). The validator cuts long lines at about 1,000 characters, so the full lists come from the source; the table gives them whole.

| Area | What the plugin has |
| --- | --- |
| Hooks module | One: `./register.ts`, in `hooks/hooks.json`. |
| Hook events | `session.start` (interactive and not), `classic.SessionStart` (clear, resume, fork), `turn.start`, `turn.complete`, `prompt.submit`, `prompt.context`, `prompt.mention`, `tool.call` (`set_stage`, `review_cycle`, `review_item`, `review_status`, `record_decision`, `ExitPlanMode`, Read and NotebookRead, Glob and Grep, Edit, Write, MultiEdit and NotebookEdit, and one with no tool named), `tool.check` (Edit, Write, MultiEdit, NotebookEdit and Bash), `command.run` (`lk`, `loopkeeper`, `reviews`, `decide`, `decisions`, `files`), `agent.spawn`, `ui.open`, `ui.press` (the Hub item of a nav row; the hub's Files row and the Files nav item), `ui.render` (`AbovePrompt`, and the panes `loopkeeper-hub`, `loopkeeper-stage`, `loopkeeper-gates`, `loopkeeper-routes`, `loopkeeper-review`, `loopkeeper-decisions`, and `files`). |
| Gating hooks | 38. 36 have a `.catch`: a gate that errors refuses the call. The other two are the `ui.open` hooks that preload the Files pane and read the other mods' commands before the hub opens; each catches its own errors and passes the open on. |
| Calls (`$.…`) | `clock` (`after`, `every`, `now`); `command` (`list`, `register`, `run`: the hub runs another mod's command on the desktop); `env.get`; `fs` (`exists`, `list`, `read`, `stat`, `write`); `model.complete`; `process.run`; `prompt` (`fill`, `read`, `submit`); `session` (`cwd`, `id`, `messages`, `root`, `surfaces`, `version`); `store` (`get`, `set`, `delete`, `keys`); `tool.register`; `turn.abort`; `ui` (`ask`, `close`, `invalidate`, `log`, `open`, `panes`, `resolve`, `toast`). The validator cuts this list short. The code also reads `$.plugin.root`, a property, for the rules block. |
| State | 87 atoms under `loopkeeper`, read and written by the concerns. Shared atoms are declared by the same literal key in each file that reads them. |
| Store | Keys under `loopkeeper:`. |
| Env reads | `CLAUDE_MODS_DISABLE`, `HOME`. |
| Env writes | None. |
| Processes | `git status --porcelain`; `git branch --show-current`; `git symbolic-ref --short refs/remotes/origin/HEAD`; `git merge-base --is-ancestor HEAD @{u}`; `git rev-parse --show-toplevel`; `gh pr view [n] --json number,state`; `gh pr checks <n> --json name,bucket`. Read-only. |
| Files read | `~/.claude/loopkeeper.json`; `<project>/.claude/loopkeeper.json`; the decision log (one of the candidates above, or the set `decisions.file`); `.claude/loopkeeper-review.jsonl` before an append; folder listings and file stats in the project for the Files pane; a listing of `docs/decisions/` when looking for the decision log; existence checks on paths that tool calls name. |
| Files written | `.claude/loopkeeper-review.jsonl` (one line per review cycle); the decision log (new entries; the file is rewritten with the new text appended). Nothing else. |
| Model calls | `$.model.complete` from the decision watch only. The watch is off by default. When on, it uses `decisions.watchModel` (haiku) on the user's own session. |
| Prompts submitted | One framed prompt (`$.prompt.submit`, as the plugin's message, not the user's) after each user approval that changed something, so the model carries on. Off with `pipeline.continueOnApprove: false`; never in a non-interactive session (no person at the prompt and no app surface attached) or with the kill switch on. |
| Network | None of its own. The `gh` queries reach GitHub through the `gh` CLI. |

The validator's own output, with the absolute path made relative to the repository root:

<details>
<summary><code>claude plugin validate --strict plugins/loopkeeper</code></summary>

```
Validating plugin manifest: plugins/loopkeeper/.claude-plugin/plugin.json

  ❯ types ./types/index.d.ts declares on $: nothing (no EngineInterface member)
  ❯ types ./types/index.d.ts declares state: loopkeeper.stageStages, loopkeeper.stageCurrent, loopkeeper.stageApproved, loopkeeper.stageVerified, loopkeeper.stageHistory, loopkeeper.stageAuto, loopkeeper.stageBand, loopkeeper.stageNow, loopkeeper.stageCwd, loopkeeper.stageSource, loopkeeper.stagePreset, loopkeeper.stagePlanDone, loopkeeper.stageShipOpen, loopkeeper.stageSize, loopkeeper.stageVerdict, loopkeeper.stageApproval, loopkeeper.stageHoldPlan, loopkeeper.stageHoldBound, loopkeeper.stageCarry, loopkeeper.stageCarryBy, loopkeeper.stageWaived, loopkeeper.stageFilesTouched, loopkeeper.stageSmallMax, loopkeeper.stagePlanPaths, loopkeeper.stagePlanFiles, loopkeeper.stageBudget, loopkeeper.stageLimits, loopkeeper.stageVersionNote, loopkeeper.stageDisabled, loopkeeper.stageContinueOnApprove, loopkeeper.stageTurnRunning, loopkeeper.stageContinuePending, loopkeeper.stageContinueSent, loopkeeper.stageInteractive, loopkeeper.stageHubCommands, loopkeeper.stageNextHint, loopkeeper.stageFocusHint… [+15 chars]

Validating hooks: plugins/loopkeeper/hooks/hooks.json

  ❯ ./register.ts hooks: session.start{isInteractive=true|false}, classic.SessionStart{source=clear|resume|fork}, tool.call{tool=mcp__loopkeeper__set_stage}, tool.call{tool=mcp__loopkeeper__review_cycle}, tool.call, prompt.submit, turn.start{}, turn.complete{}, tool.check{tool=Edit|Write|MultiEdit|NotebookEdit}, command.run{command=lk}, command.run{command=loopkeeper}, ui.render{component=AbovePrompt}, ui.render{component=Pane, requestId=loopkeeper-stage}, ui.open{}, ui.press{plugin=?, element=hub}, ui.render{component=Pane, requestId=?}, session.start{isInteractive=true|false}, classic.SessionStart{source=clear|resume|fork}, turn.start{}, tool.call{tool=ExitPlanMode}, tool.check{tool=Edit|Write|MultiEdit|NotebookEdit}, tool.check{tool=Bash}, prompt.context{}, command.run{command=lk}, command.run{command=loopkeeper}, ui.render{component=AbovePrompt}, ui.render{component=Pane, requestId=?}, ui.render{component=Pane, requestId=loopkeeper-gates}, session.start{isInteractive=true|false}, class… [+1535 chars]
  ❯ ./register.ts answers its own command: command.run{command=reviews}
  ❯ ./register.ts answers its own command: command.run{command=decide}
  ❯ ./register.ts answers its own command: command.run{command=decisions}
  ❯ ./register.ts gating hook with .catch: classic.SessionStart{source=clear|resume|fork}
  ❯ ./register.ts gating hook with .catch: tool.call{tool=mcp__loopkeeper__set_stage}
  ❯ ./register.ts gating hook with .catch: tool.call{tool=mcp__loopkeeper__review_cycle}
  ❯ ./register.ts gating hook with .catch: tool.call
  ❯ ./register.ts gating hook with .catch: prompt.submit
  ❯ ./register.ts gating hook with .catch: tool.check{tool=Edit|Write|MultiEdit|NotebookEdit}
  ❯ ./register.ts gating hook with .catch: command.run{command=lk}
  ❯ ./register.ts gating hook with .catch: command.run{command=loopkeeper}
  ❯ ./register.ts gating hook without .catch: ui.open{}
  ❯ ./register.ts gating hook with .catch: classic.SessionStart{source=clear|resume|fork}
  ❯ ./register.ts gating hook with .catch: tool.call{tool=ExitPlanMode}
  ❯ ./register.ts gating hook with .catch: tool.check{tool=Edit|Write|MultiEdit|NotebookEdit}
  ❯ ./register.ts gating hook with .catch: tool.check{tool=Bash}
  ❯ ./register.ts gating hook with .catch: command.run{command=lk}
  ❯ ./register.ts gating hook with .catch: command.run{command=loopkeeper}
  ❯ ./register.ts gating hook with .catch: classic.SessionStart{source=clear|resume|fork}
  ❯ ./register.ts gating hook with .catch: tool.call{tool=/"^(?:Read|NotebookRead)$"/}
  ❯ ./register.ts gating hook with .catch: tool.call{tool=/"^(?:Glob|Grep)$"/}
  ❯ ./register.ts gating hook with .catch: tool.call{tool=/"^(?:Edit|Write|MultiEdit|NotebookEdit)$"/}
  ❯ ./register.ts gating hook with .catch: prompt.mention
  ❯ ./register.ts gating hook with .catch: command.run{command=files}
  ❯ ./register.ts gating hook with .catch: command.run{command=lk}
  ❯ ./register.ts gating hook with .catch: command.run{command=loopkeeper}
  ❯ ./register.ts gating hook without .catch: ui.open{}
  ❯ ./register.ts gating hook with .catch: classic.SessionStart{source=clear|resume|fork}
  ❯ ./register.ts gating hook with .catch: agent.spawn{}
  ❯ ./register.ts gating hook with .catch: command.run{command=lk}
  ❯ ./register.ts gating hook with .catch: command.run{command=loopkeeper}
  ❯ ./register.ts gating hook with .catch: classic.SessionStart{source=clear|resume|fork}
  ❯ ./register.ts gating hook with .catch: tool.call{tool=?}
  ❯ ./register.ts gating hook with .catch: tool.call{tool=?}
  ❯ ./register.ts gating hook with .catch: tool.call{tool=?}
  ❯ ./register.ts gating hook with .catch: command.run{command=lk}
  ❯ ./register.ts gating hook with .catch: command.run{command=loopkeeper}
  ❯ ./register.ts gating hook with .catch: classic.SessionStart{source=clear|resume|fork}
  ❯ ./register.ts gating hook with .catch: command.run{command=lk}
  ❯ ./register.ts gating hook with .catch: command.run{command=loopkeeper}
  ❯ ./register.ts gating hook with .catch: tool.call{tool=?}
  ❯ ./register.ts calls: $.clock.after (via continueAfter, scheduleAbort, submitContinue), $.clock.every, $.clock.now (via nowMs, nowOf, safeNow, tick), $.command.list (via readHubCommands), $.command.register, $.command.run (via openMod), $.env.get, $.fs.exists (via appendLog, existsSafe, fileExists, loadConfig, readConfig, recordBashWrites, textOf), $.fs.list (via findTarget, listFolder), $.fs.read (via allEntries, appendLog, findTarget, loadConfig, loadEntries, readConfig, record, textOf), $.fs.stat (via listFolder), $.fs.write (via appendLog, record), $.model.complete (via proposeFromTurn), $.process.run (via gitBranches, gitGate, gitRoot, headIsPushed, openPr, refreshGit, repoTop), $.prompt.fill (via offer, offerGsd, offerMod), $.prompt.read (via offerGsd, offerMod), $.prompt.submit (via submitContinue), $.session.cwd (via cwdOf, detect, init, load, loadAll, projectRoot, readConfig, recordBashWrites, runDir, sessionCwd), $.session.id (via appendLog, sessionIdOf, sessionKey), $.session… [+604 chars]
  ❯ ./register.ts env writes: nothing
  ❯ ./register.ts env reads: CLAUDE_MODS_DISABLE, HOME
  ❯ ./register.ts state writes: loopkeeper.decisionBand, loopkeeper.decisionCount, loopkeeper.decisionCwd, loopkeeper.decisionEntries, loopkeeper.decisionKinds, loopkeeper.decisionLogged, loopkeeper.decisionPending, loopkeeper.decisionPrefs, loopkeeper.decisionStats, loopkeeper.decisionTarget, loopkeeper.decisionTurnPrompt, loopkeeper.decisionTurnRecorded, loopkeeper.decisionWatch, loopkeeper.filesActivity, loopkeeper.filesGit, loopkeeper.filesListing, loopkeeper.filesTouched, loopkeeper.filesView, loopkeeper.gateBand, loopkeeper.gateConfig, loopkeeper.gateConfigErrors, loopkeeper.gateConfigFiles, loopkeeper.gateDisabled, loopkeeper.gateEnabled, loopkeeper.gateGrants, loopkeeper.gateLog, loopkeeper.gatePlanBy, loopkeeper.gatePlanOk, loopkeeper.gateSessionFiles, loopkeeper.gateSessionRaise, loopkeeper.gateShipOk, loopkeeper.gateSources, loopkeeper.gateTurnExtra, loopkeeper.gateTurnFiles, loopkeeper.gateTurnFired, loopkeeper.gateTurnId, loopkeeper.gateTurnUnlimited, loopkeeper.reviewBand, lo… [+1252 chars]
  ❯ ./register.ts state reads: loopkeeper.decisionBand, loopkeeper.decisionCount, loopkeeper.decisionCwd, loopkeeper.decisionEntries, loopkeeper.decisionKinds, loopkeeper.decisionLogged, loopkeeper.decisionPending, loopkeeper.decisionPrefs, loopkeeper.decisionStats, loopkeeper.decisionTarget, loopkeeper.decisionTurnPrompt, loopkeeper.decisionTurnRecorded, loopkeeper.decisionWatch, loopkeeper.filesActivity, loopkeeper.filesGit, loopkeeper.filesListing, loopkeeper.filesTouched, loopkeeper.filesView, loopkeeper.gateBand, loopkeeper.gateConfig, loopkeeper.gateConfigErrors, loopkeeper.gateConfigFiles, loopkeeper.gateDisabled, loopkeeper.gateEnabled, loopkeeper.gateGrants, loopkeeper.gateLog, loopkeeper.gatePlanBy, loopkeeper.gatePlanOk, loopkeeper.gateSessionFiles, loopkeeper.gateSessionRaise, loopkeeper.gateShipOk, loopkeeper.gateSources, loopkeeper.gateTurnExtra, loopkeeper.gateTurnFiles, loopkeeper.gateTurnFired, loopkeeper.gateTurnId, loopkeeper.gateTurnUnlimited, loopkeeper.reviewBand, loo… [+1251 chars]

✔ Validation passed
```

</details>

## Kill switch and failing closed

- `CLAUDE_MODS_DISABLE=loopkeeper` (or `all`, or a comma list containing either) turns off the enforcing hooks: the gates, the growth guard, spawn routing, and the Files pane's tracking and band line. The bands say so. The commands still register, so `/lk` can explain the state, and `/files` still opens.
- `/lk gates off` turns off the gates for the session only.
- The gates fail closed. If a gate hook errors, the call is refused with this message: "loopkeeper: the gates failed (<kind>: <msg>) and refused this call rather than let it through unchecked. Tell the user; they can run /lk gates off, or set CLAUDE_MODS_DISABLE=loopkeeper." Spawn routing fails open instead: if it errors, the subagent starts with the model it was given.
- `ExitPlanMode` still approves the plan (not the planned file budget; see [The file budget](#the-file-budget)).

## Troubleshooting

- **No loopkeeper lines above the prompt.** The band above the prompt is one chain shared by every plugin, in load order. A plugin whose band hook returns its own line without calling `next(e)` hides every band after it. Run `/lk status` to see the same lines as text, and switch the other plugin off for the project (`enabledPlugins` in `.claude/settings.json`) to check.
- **A plugin change did not take effect.** `/reload-plugins` picks up a newly enabled plugin, but a plugin that is already running may stay loaded until the next session.

## Tests

From this folder, `plugins/loopkeeper/`:

```sh
claude plugin validate --strict .   # manifest, hooks and types; warnings are errors
claude plugin test .                # every tests/*.test.ts
```

At the repository root, `claude plugin validate --strict .` checks the marketplace manifest.

All of these run with an empty `HOME` and `CLAUDE_CONFIG_DIR`, with no login and no network. CI ([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)) runs them on Node 22:

- The `test` job is required and installs `@anthropic-ai/claude-code@2.1.294` ([ADR 0010](../../docs/adr/0010-ci-pinned-with-canary.md)).
- The `canary` job installs the latest release and may fail. It flags API drift.

## Docs

- [docs/architecture.md](../../docs/architecture.md): the hooks module, the six concerns, shared state, the `/lk` chain.
- [docs/loop.md](../../docs/loop.md): the loop, presets, sizing, gates, the verifier, approval and the file budget, with a worked large task.
- [docs/renderings.md](../../docs/renderings.md): text renderings of the bands, the hub, every pane and the next-step line, in the terminal and on the desktop, drawn by the test kit.
- [docs/adr/](../../docs/adr/README.md): the architecture decision records.
- [CHANGELOG.md](CHANGELOG.md), [CONTRIBUTING.md](../../CONTRIBUTING.md), [SECURITY.md](../../SECURITY.md), [LICENSE](LICENSE).

## Credits

loopkeeper borrows code from two MIT plugins. Full notices are in [LICENSE](LICENSE).

- The shell reader (`hooks/lib/shell.ts`) is taken from the merge-gate mod of [hamzafer/claude-code-mods](https://github.com/hamzafer/claude-code-mods) (MIT, Hamza Zafar), unchanged.
- The Bash write-target parser and per-turn file set, the ask-or-deny with turn abort, and the kill switch and fail-closed pattern come from the scope-guard mod of [yash-gadodia/claude-mods](https://github.com/yash-gadodia/claude-mods) (MIT, Yash Gadodia).

The five mods that loopkeeper replaces were the author's own.

## Related work

Other Claude Code plugins cover parts of this ground. Plan review: gemini-plan-review and exam-gate. Review loops: oakoss review-cycle and verify-loop. Model routing: jev-model-router, effort-router and team-orchestrator. Budgets: budget-governor and budget-guard. Decision and handoff records: ruflo-adr, ctx-handoff and compact-handoff. Agent dashboards: claude-deck, agentpane and flightdeck. Commit guards and status lines: gsd-status-mod and similar plugins. The markdown frameworks, get-shit-done and superpowers, describe a similar loop in prompts. loopkeeper enforces its rules in hooks that share state, so a plan gate, a file budget or a ship gate does not depend on the model reading an instruction.

## License

MIT. See [LICENSE](LICENSE).
