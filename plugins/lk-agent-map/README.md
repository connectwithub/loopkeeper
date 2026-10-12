# lk-agent-map

An add-on plugin of the loopkeeper set (its command stays `/agent-map`). An agent deck for the session's subagents. It caps how many agents a session may spawn, warns before their results eat the main context, and shows each agent as a card with its cost, tokens, context fill, model, effort and task progress, a tree row, or a member of its team's lane. It also shows who spawned whom, what each one is doing right now, how long it has run, the messages between agents, and which ones wait on you. Each running agent has a Stop button. When a run fans out, you see at a glance which agents are working, which are stuck or waiting on you and what each costs, and a runaway spawn loop stops at a cap you set.

**Use it when**

- You run orchestrated work that spawns many subagents and want to see what each one is doing and what it costs.
- You want a ceiling on how many agents run at once, per turn or per session, so a spawn loop can't run away.
- Subagent results fill the main context and you want a warning while there is still room to `/compact` or hand off.

**Install:** `/plugin install lk-agent-map@loopkeeper`, after `/plugin marketplace add connectwithub/loopkeeper` (more under [Install](#install)). Requires Claude Code 2.1.294 or later.

**Data handling:** it keeps the band setting, the caps you save with `/agent-map cap` and the chosen view in its own plugin store, and the agents' state in session state; the cap rows set in `/config` live in Claude Code's own settings. It reads `~/.claude/agent-map.json` and `<project>/.claude/agent-map.json` and writes no file. It runs no process, makes no model calls and sends nothing over the network; the only tool it calls is `TaskStop`, for one agent, after you press that agent's **Stop** twice. It collects no personal data; the saved settings stay until you delete them. Details under [Footprint](#footprint).

**Commands:** `/agent-map` and its options are listed under [Commands](#commands).

The pane opens on the **Agents** cards, drawn with the kit (`hooks/kit.ts`, a verbatim copy of the loopkeeper core's kit v3): round, unfilled cards whose colors are theme keys, so they read in light and dark themes. In the Desktop app each card has a pixel critter avatar and a progress bar drawn as Svg; in the terminal the avatar is the role glyph and the bar is text. An example (the figures are illustrative):

```
┌──────────────────────┐ ┌──────────────────────┐ ┌────────────────────┐
│ Cost                 │ │ Tokens               │ │ Time               │
│ ≈$0.10               │ │ 60k                  │ │ 1:10               │
└──────────────────────┘ └──────────────────────┘ └────────────────────┘

[ Collapse ]  [ Cards ]  [ Tree ]  [ Team ]

◉ main (orchestrator) · 100k tok · 14 tools

AGENTS · 2                                                     1 RUNNING
╭──────────────────────────────────────────────────────────────────────╮
│ ◆ ▸ build the signup form                                    ●  Stop │
│   careful Opus 5.5 · high                                            │
│   4/5 · Signup                             ctx 20% · 40k ≈$0.10 0:40 │
│   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╌╌╌╌╌╌╌╌╌╌╌╌ 80%  │
╰──────────────────────────────────────────────────────────────────────╯

╭──────────────────────────────────────────────────────────────────────╮
│ ◈ ▸ survey the repo                                                ✓ │
│   medium Haiku 4.5 · medium                                          │
│   0 tools                                  ctx 10% · 20k ≈$0.05 0:30 │
│   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ 75%  │
╰──────────────────────────────────────────────────────────────────────╯

PLANNED · 1
◎ review the plan                  reviewer · Opus · asked 0:05 ago

[ Clear finished ]  [ Log ]  [ Close ]
```

The tree view (`/agent-map tree`), with illustrative figures too:

```
main (orchestrator) · 1.0M tok · 14 tools
├─ ● survey-projects  general-purpose  sonnet  00:57  12 tools  80k tok  ⏸ waiting: Bash   Stop
│   ⋯ Bash: rm -rf build
│   ├─ ✓ explore  Explore  haiku  00:20  4 tools  10k tok
│   └─ ● ⑂ side look  general-purpose  opus  06:10  2 tools  10k tok  ⚠ idle 5m   Stop
├─ ● ◇ reviewer  teammate  sonnet  01:12  5 tools  20k tok   Stop
│   ⋯ Read: /src/index.ts
├─ ■ research-docs  claude-code-guide  opus  02:50  12 tools  90k tok  by you (agent map)
└─ ✗ build-x  general-purpose  opus  01:10  3 tools  40k tok
```

● running · ✓ done · ✗ failed (API error, refusal, or a failed hook) · ○ aborted (interrupted) · ■ stopped (with who stopped it)

⑂ a fork of its parent · ◇ a teammate · ⏸ a tool call waiting on your permission answer · ⚠ idle past the alert threshold · ⊘ muted

## Commands

| Command | What it does |
| :- | :- |
| `/agent-map` | Open the pane and focus it (Esc closes it) |
| `/agent-map clear` | Remove finished agents (done, failed, aborted). Running agents stay. |
| `/agent-map band on` / `off` | Show or hide the band. The setting is saved in `$.store` and kept between sessions. |
| `/agent-map text` | Print the chosen view (tree, cards or team) as plain text in the transcript; the tree when none was chosen. Use it on the mobile app or anywhere panes don't draw. |
| `/agent-map cards` / `tree` / `team` | Switch the pane's view and open it. Saved between sessions. `/agent-map view cards\|tree\|team` does the same. |
| `/agent-map log` | Print the last 40 lifecycle events |
| `/agent-map cap` | Show the caps and where each stands |
| `/agent-map cap concurrent <n>` / `turn <n>` / `session <n>` | Set a spawn cap; `0` turns it off |
| `/agent-map cap returned <k>` | Set the returned-tokens budget in thousands (`200` or `200k`) |
| `/agent-map cap warn <0.1-1>` / `grace <ms>` | Set `warnAt`, or the waiting grace (`0` marks at once) |
| `/agent-map cap reset [kind]` | Clear what `/agent-map cap` saved for that kind (`concurrent`, `turn`, `session`, `returned`, `warn`, `grace`), or for every kind; the value from the files, the settings or the defaults comes back |

## What it shows

- **Pane** (`Agent map`): the cards above, or the tree or team view. The first spawn of the session opens it without taking focus, and a toast points to `/agent-map` when the terminal is too narrow for an unasked pane. Each agent's title (a card's first line, a tree row) is a button. Press it to show its full description, the first 200 characters of its prompt, tool counts by name, its last activity, tokens by kind (input, output, cache read, cache write), status, timing, request count, parent and flags (fork, teammate, background, muted, stopped by). Header: the session tiles and the **Collapse**/**Expand**, **Cards**, **Tree** and **Team** buttons (the shown view's is marked as the primary button). Under the body, the **Caps** block: each cap with its value (`no cap` for 0) and where it came from (see [Configuration](#configuration)). Footer buttons: **Clear finished**, **Log** and **Close**. The header, the body, the caps, the log and the footer sit one row apart, and so do the cards; the rows of a tree stay tight. Running agents count up once a second, and the timer stops when nothing runs.
- **Stop**: every running row ends with a **Stop** button. The first press arms it (the label turns to **Confirm stop**) and it disarms by itself after 5 seconds. A second press within those 5 seconds calls Claude Code's own `TaskStop` for that agent, with your press as the consent, and the row turns to `■ stopped` with `by you (agent map)`. A `TaskStop` the model makes is recorded the same way, with `by main` or the calling agent.
- **Mute** (the fallback): when `TaskStop` refuses (a foreground subagent, or an id it doesn't know), you get a toast and the agent is muted instead: each further tool call it makes is refused with a reason that asks it to stop calling tools and return its result now. The row shows `⊘ muted`.
- **Last activity**: under each running agent, a dim `⋯ Bash: npm test` line with its last tool and the first 40 characters of that call's input. For an agent no tool call was seen from (one that started before a reload, or one only the engine's list names), the line comes from the tail of its own transcript (`$.session.messages({ agentId })`).
- **Waiting on you**: when Claude Code's permission check answers `ask` for an agent's tool call and the ask is still open after `waitGraceMs` (4 s by default), that agent's row shows `⏸ waiting: Bash` in the 'claude' color (its card ◷) until the call runs or is refused. An ask that auto mode's classifier approves within the grace never shows, so the mark doesn't flicker. When a permission dialog actually opens (`classic.PermissionRequest`), the mark shows at once, and from then on in the session the dialog is the only signal. A pending mark is dropped when the call runs or the agent's turn ends. For the main loop it shows on the header line.
- **Idle alert**: a running agent with no tool call and no model request for `stuckAfterMs` (5 minutes by default) gets `⚠ idle 5m` in red on its row and one toast per stall. Any activity clears it. An agent waiting on you isn't counted as idle.
- **Forks and teammates**: `⑂` marks a fork (`agent.spawn`'s `fork`), `◇` a teammate. The model column shows what the agent actually runs on: the model of its latest request (`turn.step`), else the spawn's.
- **Agents the spawn hook missed**: on each one-second tick while anything runs, on `/agent-map`, and when a loop no spawn announced makes a request, the map merges `$.agent.list()`: new ids (forks, teammates, workflow agents, agents from before a reload) appear under their `parentId`, and agents the list reports finished end. A parent that would close a loop is left at main.
- **Band** (one line above the prompt): `agents  ● 3/4 running  ✓ 5 done  ✗ 1  ● ok` with `400k tok · results 100k → main` (example figures) on the right in a quiet color, and `○ n aborted` / `■ n stopped` in front of the tokens when there are any. The `/4` is the concurrency cap; `results … → main` appears once subagent results passed 1k tokens. A count is colored only when it is not zero (running in the suggestion color, done in success, failed in error). The last chip is the cap state: `● ok` (success), `● near cap` ('claude': a cap at `warnAt` of its limit, or the returned-tokens warning) or `● at cap` (error: a cap reached, or a spawn denied this turn). No chip is filled. The band stays hidden until the first subagent of the session spawns; other mods' band content is kept below it.
- **Message edges**: a dim `→ msg to <label>` line under the sender, for SendMessage traffic between main and a subagent or between subagents.
- **main**: the orchestrator's own tokens and tool calls are on the header line, so you can compare its share with the agents'.

Tokens are input + output + cache read + cache write, summed from each model request (`turn.step`). The band total counts subagents only.

## The Agents cards

- **Header tiles** over the session's subagents: **Cost** (the sum of the agents' cost estimates), **Tokens** (their sum) and **Time**: wall-clock time during which at least one subagent ran, the union of each agent's span from its first start to its end (now while it runs), so agents running side by side count once. Tiles are single-border boxes, label over a bold value, with no fill. **Collapse** folds each card to its first three lines (no bar or notes); **Expand** unfolds them. Then **Cards**, **Tree** and **Team**: the shown view's button is the primary one.
- **One card per agent**, running first, then waiting on you, then finished, in a round frame (the suggestion color while it runs, quiet otherwise). On the left the avatar; on the right four lines:
  1. `▸`, which opens the card's details, the title in bold (the spawn's description, with ⑂ or ◇ in front), and at the far right the status (● running and ✓ done in success, ◷ waiting on you in 'claude', ✗ failed in error, ■ stopped and ○ aborted quiet) and Stop while it runs.
  2. The effort word in its color, then the model it actually ran on and the effort as seen: `careful Opus 5.5 · high`. low → light (success), medium → medium (suggestion), high → careful and xhigh → thorough ('claude'), max → max (error); no effort, no word. The effort is its latest request's (`turn.step`'s `e.effort`), else the spawn's when the event carries one.
  3. Progress from the agent's own `TodoWrite` calls, `4/5 · Signup` (completed over all items, and the in-progress item's `activeForm`, else its `content`), or `12 tools` without a list; on the right `ctx 5% · 40k ≈$0.10 0:40` (example figures): context fill, tokens, cost and elapsed time.
  4. A full-width bar in the effort's color: the TodoWrite share done, else the agent's elapsed time over the longest card's. Waits, idle and mute notes and `by you (agent map)` follow on a line of their own.

  `▸` adds `tools 12 · last: Bash npm test`, `→ 40k to main` once its result came back, and the agent's full record (description, prompt excerpt, tools, tokens, status, model). The avatar: in the Desktop app a 12×12 pixel critter (about 44 px) with a hat in the effort's color, a pennant while it runs, X eyes when it failed and faded once finished; the main loop wears a violet crown. Its alt text names the role and state (`hard running`). In the terminal, the role glyph in the status color. The role comes from a `[role:x]` tag in the prompt or description, then the type and description words (recon, explore or search → recon; verif or valid → verify; review, critic or audit → reviewer), then an Opus model → hard, else execute.
- **Planned · n**: Agent calls whose subagent hasn't started yet (waiting on a permission answer or the cap override ask), with type, model and how long ago they were asked. A call the cap gate or the engine refused leaves the list.

**Context %** is an approximation: the agent's latest request's input + cache read + cache write tokens over the session's context window, read once from `$.session.usage().context.window` at session start (200k when it can't be read). A subagent's own window isn't exposed, so an agent on a model with a different window reads off by that ratio.

**Cost** is an estimate from list prices: each request's input × the input price + output × output + cache read × cache read + cache write × the 1-hour cache-write price, per million tokens, using the model that answered it. A model the table doesn't know adds nothing and shows `—` while it has tokens and no known cost. Prices as of 2026-10 (partly confirmed), USD per million tokens, matched by the first family the model id contains, longest names first:

| Family | Input | Output | Cache read | Cache write (1 h) |
| :- | -: | -: | -: | -: |
| `fable-5-1` | 10 | 50 | 1.00 | 20 |
| `opus-5-5` | 4 | 20 | 0.20 | 8 |
| `opus-5` | 5 | 25 | 0.50 | 10 |
| `opus-4` | 5 | 25 | 0.50 | 10 |
| `sonnet-5-5` | 2 | 10 | 0.20 | 4 |
| `sonnet-5` | 2 | 10 | 0.20 | 4 |
| `sonnet` | 3 | 15 | 0.30 | 6 |
| `haiku-5-5` | 1 | 5 | 0.10 | 2 |
| `haiku` | 1 | 5 | 0.10 | 2 |

Override or add rows with a `prices` object in `~/.claude/agent-map.json` or `<cwd>/.claude/agent-map.json` (the files the caps come from; the project file wins), by family, as `[input, output, cacheRead, cacheWrite]` or an object with those four keys:

```json
{ "prices": { "opus-5-5": [4, 20, 0.2, 8], "my-gateway-model": { "input": 1, "output": 5, "cacheRead": 0.1, "cacheWrite": 2 } } }
```

## Spawn caps

Every `agent.spawn` passes a gate first. It counts running agents (plus spawns already admitted and not yet started), spawns in this main-loop turn and spawns in the session:

| Cap | Default | Counts |
| :- | :- | :- |
| `maxConcurrent` | 4 | running subagents, forks and teammates included |
| `maxPerTurn` | 8 | spawns since the last main-loop `turn.start`; forks and teammates don't count |
| `maxPerSession` | 40 | every spawn this session |

Change them in `/config` (the `lk-agent-map` rows), in the files, or with `/agent-map cap`; [Configuration](#configuration) has the order.

- **Near a cap**: once a spawn brings any cap to `warnAt` (0.75), the band's state chip turns to `● near cap` and one toast goes out per turn, such as `agents 3/4 running, near the concurrency cap`.
- **At a cap**: the spawn is refused, and the model reads: `agent-map: concurrency cap reached (4/4). Wait for running subagents to return, or batch the work into fewer agents. The user can raise it with /agent-map cap concurrent <n>.` The band turns red for the rest of the turn.
- **Override**: a spawn whose description or prompt carries `[cap-override: <reason>]` asks you instead: `agent-map: <reason>. Allow one more agent beyond the cap?` with **Allow this one**, **Allow the rest of the turn** and **Deny**. When no one can be asked (`-p`, a dismissed dialog), it's refused. The marker is removed from the description and prompt the agent gets.
- Every decision (spawned with its counts, denied with the cap, override answers) goes to the lifecycle log.

## Context cost of results

The text each Agent tool call returns to its caller is measured (characters / 4) and stored on the agent as `returnedTokens`: rows and cards show `→ 40k to main`. Results that reach the main loop add up to a session total; past `warnAt × maxReturnedTokens` (112.5k of 150k by default) the band shows `results 120k → main` on its quiet right side, the cap chip turns `● near cap`, and one toast suggests `/compact` or a handoff. A background agent's result arrives later as a task notification, which is counted the same way when it names the agent. The subagent's own tokens (`80k tok`) are shown as before.

## Views and the log

- **Cards** (`/agent-map cards`, the pane's default): the Agents cards above. As text (`/agent-map text` once cards were chosen), each card is four lines in a rounded border: label, type, model and status glyph; `spawned 10:31 → running 00:57 → ⏸ waiting (Bash) → done 10:38`; `12 tools · last Bash: npm test · 80k tok · → 40k to main`; the parent and `[Stop]`.
- **Tree** (`/agent-map tree`): the map above.
- **Team** (`/agent-map team`): lanes by parent. `team of main: 3 running · 2 done` first, then each agent's children in a lane indented under it, and teammates (◇) in a `teammates` lane of their own.
- The choice is saved in `$.store`. The header's **Cards**, **Tree** and **Team** buttons switch, and **Log** shows the last 12 lifecycle events at the bottom. Until you choose, the pane draws the cards and `/agent-map text` prints the tree.
- **Lifecycle log**: spawned (with cap counts), denied (with the cap), override answers, first tool, waiting, resumed, idle, stopped or muted, returned (result tokens), and done, failed or aborted with duration and tokens. `/agent-map log` prints the last 40.

## Configuration

| Option | Default | What it does |
| :- | :- | :- |
| `stuckAfterMs` | `300000` | How long a running agent may go without a tool call or model request before it gets `⚠ idle` and a toast. `0` turns the alert off. |
| `maxConcurrent` | `4` | Max subagents running at once (see [Spawn caps](#spawn-caps)). A whole number; `0` means no cap. |
| `maxPerTurn` | `8` | Max subagents per main-loop turn. A whole number; `0` means no cap. |
| `maxPerSession` | `40` | Max subagents per session. A whole number; `0` means no cap. |
| `warnAtPercent` | `75` | Warn at this share of a cap, from 1 to 100 (`warnAt` = the value / 100). |
| `maxReturnedTokens` | `150000` | Max tokens subagent results add to the main context per session (see [Context cost of results](#context-cost-of-results)); it warns, it never refuses a spawn. A whole number; `0` means no cap. |

Set them in `/config` (the `lk-agent-map` rows) or the Desktop app's plugin settings; they are kept under `pluginConfigs` in settings. The caps follow a change at once: `/config` changes go through a `config.set` hook that refuses a value out of range (a negative or fractional count, a percent outside 1-100), and a settings file changed by other means loads them again (`classic.ConfigChange`). `stuckAfterMs` takes effect when the plugin loads. A value the settings file holds out of range is ignored, and the default stands.

The caps are merged in this order, a later layer winning: the defaults, then the settings (a value equal to the default counts as the default), then `~/.claude/agent-map.json`, then `<cwd>/.claude/agent-map.json`, then what `/agent-map cap <kind> <n>` saved in `$.store` (kept between sessions until `/agent-map cap reset [kind]` clears it). The pane's **Caps** block shows each value with its source: `default`, `settings`, `user file`, `project file` or `saved (/agent-map cap)`. The files also take `waitGraceMs`, and the `prices` object described under [The Agents cards](#the-agents-cards):

```json
{ "maxConcurrent": 4, "maxPerTurn": 8, "maxPerSession": 40, "warnAt": 0.75, "maxReturnedTokens": 150000, "waitGraceMs": 4000 }
```

## Install

Needs Claude Code 2.1.294 or later. From the loopkeeper marketplace, inside a Claude Code session:

```text
/plugin marketplace add connectwithub/loopkeeper
/plugin install lk-agent-map@loopkeeper
```

Turn it off or on again with `/plugin disable lk-agent-map@loopkeeper` and `/plugin enable lk-agent-map@loopkeeper`. To
try it from a clone without installing it: `claude --plugin-dir /path/to/loopkeeper/plugins/lk-agent-map`. Check and
test it from its folder with `claude plugin validate --strict .` and `claude plugin test .`.

## Footprint

What `claude plugin validate --strict .` reports for this plugin (Claude Code 2.1.294), and what that means:

| Area | What the plugin has |
| --- | --- |
| Hooks module | One: `./register.ts`, in `hooks/hooks.json`. |
| Hook events | `session.start`, `classic.SessionStart` (clear, resume, fork), `config.set` (this plugin's cap rows), `classic.ConfigChange`, `tool.call`, `tool.check`, `agent.spawn`, `classic.PermissionRequest`, `classic.PreToolUse`, `turn.start`, `turn.step`, `turn.complete`, `session.send`, `session.receive`, `command.run` (`agent-map`), `ui.render` (the band; the `agent-map` pane). |
| Refusals | `agent.spawn` refuses a spawn past a cap (or asks, with an override marker); `tool.call` refuses a muted agent's calls; `config.set` refuses an out-of-range cap setting. |
| Calls (`$.…`) | `agent.list`; `clock` (`after`, `every`, `now`); `command.register`; `config.list`; `env.get`; `fs.read`; `session` (`messages`, `usage`); `state` (`get`, `set`); `store` (`get`, `set`); `tool` (`call`, `check`); `ui` (`ask`, `close`, `open`, `resolve`, `toast`). |
| State | 17 atoms under `lk-agent-map`. |
| Store | `band`, `caps`, `view2`. |
| Env | Reads `HOME`; writes nothing. |

What it runs:

- **Processes**: none.
- **Files**: reads `~/.claude/agent-map.json` and `<project>/.claude/agent-map.json`; writes nothing.
- **Model calls**: none.
- **Tool calls**: `TaskStop`, only when you press a row's **Stop** twice (arm, then confirm), with your press as the consent.
- **Network**: none.

## Notes for directory reviewers

The directory's validator listed these items for this plugin. Each bullet says what the code does and where (`hooks/register.ts` unless named).

- **The one tool it calls** (policy holds `MOD_CALLS_TOOLS`, `MOD_CAN_FETCH_AND_RUN`). `stopAgent()` (line 689) calls Claude Code's own `TaskStop` tool, `$.tool.call({ tool: 'TaskStop', task_id, consent })`, and no other tool. It runs only when the user presses a running agent's **Stop** in the pane twice (the first press arms it, the second confirms). `TaskStop` stops that agent by its id; it fetches nothing and runs no command. The `consent` is a sentence built in the code, `The user pressed "Stop" on the "<agent type>" agent <id> in the agent map pane`. When `TaskStop` cannot stop the agent, the plugin mutes it instead: the `tool.call` hook refuses that agent's further tool calls with a message that asks it to return its result now. The plugin starts no programs and has no network code.
- **Local data and the conversation** (policy holds `MOD_LOCAL_DATA_LEAVES`, `MOD_SESSION_DATA_LEAVES`). Nothing is sent anywhere: the `TaskStop` call above carries only the agent's id and that sentence. The files it reads are its own config, `~/.claude/agent-map.json` and `<cwd>/.claude/agent-map.json` (the caps). It reads a running subagent's transcript (`$.session.messages({ agentId })` in `peekActivity()`) only to show that agent's last activity on its card, and it estimates how many tokens an agent's result adds to the main conversation; both stay in `$.state`, for the pane and the band.
- **The spawn caps and the permission hooks.** The `agent.spawn` hook (line 961) refuses a new subagent only past a cap the user set (running at once, per turn, per session), with `{ deny: … }` and the reason. When the spawn's description or prompt carries `[cap-override: <reason>]`, it first asks the user (**Allow this one**, **Allow the rest of the turn**, **Deny**) and lets the spawn through only on an Allow; it removes that marker from the description and prompt before it passes the spawn on, and changes nothing else (never the agent's permission mode or tools). The `tool.check` hook (line 931) decides nothing: it asks Claude Code what the user's rules would answer (`$.tool.check({ tool, input })`, which runs no tool and opens no dialog), marks the agent's row "waiting" when the answer is `ask`, and returns `next(e)` unchanged. The `config.set` hook (line 848) sees only this plugin's own cap settings (`lk-agent-map.maxConcurrent` and the like) and refuses a value out of range with the reason; any other value passes on unchanged. The `tool.call` hook (line 864) refuses only a muted agent's calls; every other call passes on unchanged, after the map notes its tool, a short activity label and any TodoWrite progress.
- **Fields in `plugin.json`** (warnings `UNKNOWN_KEY`). `documentationUrl` and `supportUrl` are listing fields the directory reads. `types` points at `types/index.d.ts`, the `$.state` contract that `claude plugin validate` checks. Claude Code ignores all three at load time.
- **Icon** (warning `ICON_MISSING`). Added at `.claude-plugin/icon.png` (512 × 512); its source is `docs/assets/icons/lk-agent-map.svg` in the repo.
- **Its command.** It registers one slash command, `/agent-map`, at session start (line 812). It registers no tools or agents.
- **Classic hooks.** `classic.SessionStart` with source `clear`, `resume` or `fork` (line 825) loads the band switch, the caps and the view again, because those resets clear `$.state`. `classic.ConfigChange` (line 858) loads the caps again after a settings file changed. `classic.PermissionRequest` (line 1003) marks the matching pending ask "waiting" at once. `classic.PreToolUse` (line 1023) clears a "waiting" mark, because the call is about to run. Each passes its event on and returns what `next(e)` gave back, unchanged.
- **Other hooks on events that are also calls.** `session.send` (line 1093) and `session.receive` (line 1103) record which agent messaged which and how large a background agent's result was; `turn.step` and `turn.complete` count tokens and record when a loop ends. All of them pass their events on unchanged. `command.run` (line 1129) has the matcher `{ command: 'agent-map' }`, so it runs only for `/agent-map`.

## Layout

- `hooks/register.ts`: the hooks, the `$.state` atoms, the drawings and the command
- `hooks/model.ts`: pure functions that update agent records from events (tokens, cost, effort, context size, TodoWrite progress), the cap checks and the returned-token estimate
- `hooks/format.ts`: pure layout for the tree rows, the text cards, team lanes, the log, `/agent-map text`, the band's chips, the effort words and the critter avatar's Svg
- `hooks/pane.ts`: the Agents cards, the session tiles and the Caps block, built with the kit
- `hooks/prices.ts`: the price table, `priceOf`, `costUsd` and the `prices` override
- `hooks/kit.ts`: the UI kit v3, a verbatim copy of the loopkeeper core's `plugins/loopkeeper/hooks/lib/kit.ts`; adapt the callers, not this file
- `types/index.d.ts`: the record types and the `$.state` declaration
- `tests/`: `claude plugin test` suites and the stubs they share (`agent-map-v2.test.ts` covers Stop, mute, reconcile, waits, the idle alert and markers; `agent-map-v3.test.ts` covers caps, the override ask, returned tokens, text cards, team lanes, the log, `/agent-map cap` and the waiting grace; `cards.test.ts` covers prices and cost, effort, TodoWrite progress, ctx %, the session tiles, the cards on both surfaces with Collapse, Planned, the view buttons and the band badge; `caps.test.ts` covers the cap settings, their order against the files and `/agent-map cap`, `cap reset`, the `config.set` guard and the Caps block; `kit.test.ts` is the core's kit suite without its render snapshots)

## Limits

- **Parent links** come from `agent.spawn`'s `parentAgentId`, or else from the `agentId` of the Agent `tool.call` that came before the spawn. The two are matched by `tool_use_id`, then by description.
- **Received messages** have no sender id in `session.receive`, so an incoming message draws an edge only when the event carries a known agent id or name. Messages this session sends (`session.send`) always draw when one side is a subagent.
- **Engine-internal loops** (compaction, memory forks) raise `turn.step` with agent ids that no spawn announced. They're counted but never drawn.
- **Resets**: `$.state` is reset by `/clear`, `/resume` and `/branch`, so the map starts over then. The band switch is reloaded from the store.
- **Width**: labels are cut to 24 characters, or fewer when needed, so a row fits `bodyColumns`. Detail lines wrap.
- **Elapsed** is wall-clock time per run. An agent that a message resumes adds its new run to its earlier time.
- **Stop** works on what `TaskStop` accepts: background agents, teammates and named background agents. A foreground subagent falls back to the mute, which only takes effect at the agent's next tool call; an agent thinking through a long answer finishes that answer first.
- **Permission waits** are matched to an agent through the `tool.call` that wraps the check (`tool.check` carries no agent id), by `tool_use_id`. A check raised outside a call (a plugin's query) isn't drawn.
- **Reconcile** depends on `$.agent.list()`. Agents a workflow files under its run, and the engine's own forks (compaction, memory), aren't listed, so they stay counted but undrawn. An agent the spawn hook recorded under a fallback id (`tool:<id>`) and the list names by its real id can show twice.
- **Caps** count what this mod sees. A spawn that bypasses `agent.spawn` (an engine-internal fork) isn't gated; a turn is a main-loop `turn.start` without an `agentId`. The override ask waits inside the `agent.spawn` hook, so a very slow answer can run into the hook's time limit, which lets the spawn through.
- **Returned tokens** are an estimate (characters / 4) of the result text, not a tokenizer count. A background agent's Agent call returns only its launch notice; its real result counts only when the task notification names the agent.
- **Waiting grace**: there's no event for "the ask was approved". Until a permission dialog has been seen in the session, a long command that auto mode approved can show `⏸ waiting` once the grace passes and until it finishes. A `classic.PreToolUse` hook clears a pending or shown mark by `tool_use_id`, but the typings place PreToolUse before `tool.check`, so in practice it rarely helps; the test kit can't fire it, so it is untested.
- **Card times** (`spawned 10:31`) use the runtime's local time zone.
- **Cost** is a list-price estimate, not a bill: cache writes are priced at the 1-hour rate (the 5-minute rate is lower), batch and other discounts aren't applied, and a request whose model the table lacks adds nothing. Prices are dated 2026-10; check them and override with `prices` when they change.
- **Context %** divides by the main session's window; see above.
- **Progress** reads only `TodoWrite` calls made in the agent's own loop. An agent that tracks its work another way shows its tool count and last call.
- **Effort** shows what each request carried as this mod's `turn.step` hook received it. A model without an effort setting shows `—`.
- **The idle toast** goes out once per stall. It doesn't call any other mod; if you use an attention mod, it sees the toast like any other.

## Credits

MIT-licensed community mods this version takes ideas and code shapes from:

- [xuanji86/claude-agentpane](https://github.com/xuanji86/claude-agentpane): the per-agent Stop button, its arm-then-confirm press, and the `TaskStop` call with the press as `consent`.
- [hamzafer/claude-code-mods](https://github.com/hamzafer/claude-code-mods), `agent-radar`: merging `$.agent.list()` with `parentId`, an agent's last activity from `$.session.messages({ agentId })`, the one-second tick only while something runs. `mission-control`: the try/finally that records a spawn as failed when it throws.
- [scasella/claude-flightdeck](https://github.com/scasella/claude-flightdeck): permission verdicts from `tool.check`, matched to the agent by the wrapping `tool.call`'s `tool_use_id` and settled when that call runs.
- [nvr0x5/claude-deck](https://github.com/nvr0x5/claude-deck) (MIT): the idea of per-agent strips with the current tool, model and elapsed time, and a collapsed one-line summary, re-implemented here as cards and the band. No code copied.
- [MichaelP17/claude-mods](https://github.com/MichaelP17/claude-mods), `concurrency-guard` (MIT): capping parallel subagents with a stated reason and the person's approval past the cap, reserving admitted spawns by `tool_use_id` so parallel spawns can't all pass, and serializing the check. Re-implemented here with the `[cap-override: …]` marker and three answers. No code copied.
- [helenkwok/gsd-status-mod](https://github.com/helenkwok/gsd-status-mod): the agent tree from `parentId` with a cycle guard, and fork detection from `agent.spawn`'s `fork`.
