# lk-token-budget

A loopkeeper add-on for Claude Code that puts a token budget on the session, so an orchestrated multi-agent run can't quietly use up the plan.

It counts the tokens in every model request, from the main loop and from each subagent. It shows the running total in a one-line band above the prompt. At a threshold you set, it warns you. Once the budget is spent, it warns, refuses new subagents, or stops tool calls, depending on the action you choose. Each subagent also has its own limit.

It also times the main conversation's prompt cache: how long until it goes cold, what a cold resend would cost, a toast before that happens, a note when you send a prompt into a cold cache, a **Keep warm** button, and an opt-in [automatic keep-warm](#auto-keep-warm) for long idle waits (off by default). See [Prompt cache](#prompt-cache).

The band (all figures in this README are examples):

```
budget  ● ▰▰▰▰▱▱▱▱ 1.2M / 2.0M 60%  ● cache warm 54:30 left   main 0.9M · agents 0.3M · ctx 40% · cold resend ≈ $1.60   w: Keep warm
```

The bold label, then two chips. The budget chip is in the ok tone under the warn level, the warn tone from the warn level, and the danger tone once the budget is spent. The cache chip has its own tones (below). The right side is quiet text, drawn in the default text color once the cache is cold or the budget is spent. The band is a kit line: colors are theme keys, nothing is filled, and the bands of other plugins stay below it.

Needs Claude Code 2.1.294 or later.

## Install

lk-token-budget is one plugin in the loopkeeper marketplace. Add the marketplace once, then install it, inside a Claude Code session:

```text
/plugin marketplace add connectwithub/loopkeeper
/plugin install lk-token-budget@loopkeeper
```

Turn it off and on again with `/plugin disable lk-token-budget@loopkeeper` and `/plugin enable lk-token-budget@loopkeeper`. When the loopkeeper core is on, its hub links to the add-ons that are on.

To try a local checkout for one session:

```bash
claude --plugin-dir /path/to/loopkeeper/plugins/lk-token-budget
```

Check it from its folder:

```bash
claude plugin validate --strict .
claude plugin test .
```

## Commands

| Command | What it does |
| :- | :- |
| `/budget` | Opens the **Token budget** pane: tiles for **Context** (tokens and fill), **Cache** (warm with time left, cold, or no request yet), **Cold resend** (≈ cost) and **Session cost** (what Claude Code reports); then the budget and action, used and remaining with a bar, the prompt-cache settings and last request, tokens by model, the top 10 subagents, the average per turn and projected turns left, and the lifetime total for this project. **Keep warm** (`w`), **Reset** (`r`) and **Close** (`c`) buttons. |
| `/budget set <n>` | Sets the session budget. Accepts `500k`, `2m`, `1.5m`, or `1500000`. `0` removes the session limit. |
| `/budget agent <n>` | Sets the per-subagent budget. `0` turns the per-agent limit off. |
| `/budget action warn\|deny-agents\|stop` | Sets what happens once the session budget is spent |
| `/budget warn <0-1>` | Sets the warn level as a fraction of the budget, such as `0.8` (or `80%`) |
| `/budget reset` | Sets this session's counts back to zero. The lifetime total stays. |
| `/budget off` / `/budget on` | `off` keeps counting and drawing but never refuses anything or shows the over-budget reminders |
| `/budget band on\|off` | Shows or hides the band above the prompt |
| `/budget keepwarm` | Sends one tiny request to refresh the prompt cache (see [Keep warm](#keep-warm)) |
| `/budget autowarm on\|off` | Turns the [automatic keep-warm](#auto-keep-warm) on or off for every session on this machine. `/budget autowarm` alone prints its state. Off by default. |
| `/budget pings on\|off` | Turns the cache toasts on or off. The band keeps showing the cache either way. |
| `/budget text` | Prints a plain-text summary in the transcript, which Claude also reads, with the cache state on its first line |

`/budget` is registered as `immediate`, so you can raise the budget or change the action while Claude is working, including while `stop` is refusing tool calls.

## Actions

When counted tokens reach `warnAt × session`, the band's budget chip turns to the warn tone and one toast appears. When they reach the session budget, the chip turns to the danger tone and the action applies:

| Action | Once the budget is spent |
| :- | :- |
| `warn` (default) | A toast at the end of each turn, the main loop's and each subagent's. Nothing is refused. |
| `deny-agents` | New subagents are refused (`agent.spawn` returns `deny`), so Claude finishes with what it has. Tool calls still run. |
| `stop` | Every tool call is refused, and Claude is told to stop and report. Exempt: the plugin's own tools (`mcp__lk-token-budget__*`; it registers none today) and calls raised by your own press in the interface. Slash commands such as `/budget` are commands, not tool calls, so they always run. |

The per-agent limit applies whatever the action is. Once a subagent's counted tokens reach `perAgent`, its further tool calls are refused with a message telling it to wrap up and return its result. Other subagents and the main loop aren't affected. `/budget off` and `perAgent: 0` both turn it off.

## Configuration

Settings merge in this order, later wins:

1. Defaults: `{ "session": 2000000, "perAgent": 400000, "warnAt": 0.8, "action": "warn", "countCacheReads": false, "cacheTtlMinutes": 60, "cacheWarnMinutes": [15, 5, 1], "cachePings": true, "autoKeepWarm": false, "autoKeepWarmMinutes": 3, "autoKeepWarmMax": 6 }`
2. `~/.claude/token-budget.json`, the same fields for every project (the natural home for `prices` and the cache settings)
3. What you saved with `/budget` commands, kept in the plugin's `$.store` and shared by every session on the machine
4. `<project>/.claude/token-budget.json`, a project override:

```json
{
  "session": "1.5m",
  "perAgent": "300k",
  "warnAt": 0.75,
  "action": "deny-agents",
  "countCacheReads": false
}
```

Token fields take a number or the same `500k` / `2m` strings the commands take. `prices` merges by model family across the files rather than replacing the whole table. Malformed fields are ignored. Because the project file wins, a `/budget set` in a project that has the file says so and shows the value in force.

The one exception is auto keep-warm, which spends money on its own: a project file can turn it off (`"autoKeepWarm": false`) but not on, and its `autoKeepWarmMinutes` and `autoKeepWarmMax` are ignored, so a repository you clone can't start background requests. Set those keys in `~/.claude/token-budget.json` or with `/budget autowarm`.

## Prompt cache

The Claude API caches the start of each request, so the next request in the conversation reads it at a tenth of the input price instead of paying for it again. The cache entry lapses some time after its last use. Once it has, the next prompt re-writes the whole context at the cache-write price, which on a long conversation is the most expensive request of the session.

**The lifetime is an assumption.** Claude Code doesn't report when the API drops the main conversation's cache entry. The plugin assumes 60 minutes after the main loop's last request (the 1-hour cache TTL), and `cacheTtlMinutes` changes it. If your setup uses the 5-minute TTL, set `"cacheTtlMinutes": 5` and thresholds under it, such as `[3, 1]`.

How it works:

- **Last request**: every answered request of the main loop (`turn.step` with no `agentId`) stamps the time and the model. Subagents' requests have caches of their own and don't count.
- **Context size**: read from `$.session.usage().context.tokens` after each main turn, which is what a cold resend re-writes.
- **Cold**: decided from the plugin's own clock: `now − last request ≥ cacheTtlMinutes`. After a compaction there is nothing to re-warm, because the next request starts a new cache, so the band shows `● cache compacted` and the plugin stays quiet until that request.
- **Timer**: `$.clock.every(30 s)`, started in `session.start` and again after `/clear`, `/resume` and `/branch`.

What you see:

| Where | When | What it says |
| :- | :- | :- |
| Band | warm | the chip `● cache warm 54:30 left` in the ok tone, the warn tone under 5 minutes, and `cold resend ≈ $1.60` on the quiet right side. The countdown moves in 30-second steps. |
| Band | cold | the chip `● cache cold` in the danger tone (a chip, never a fill), and `resend ≈ $1.60` on the right side in the default text color |
| Band | before the first request, or after a compaction | a muted chip, `● cache: no request yet` or `● cache compacted` with `next request starts fresh` on the right |
| Toast | at each of `cacheWarnMinutes` (15, 5 and 1 by default), once per warm window | `Prompt cache goes cold in 5 min; a resend after that costs ≈ $1.60 (200k tokens at $8/MTok). Keep warm: /budget keepwarm, or w on the band.` |
| Toast | once, when the timer sees it go cold | `Prompt cache went cold. The next send re-writes the context, ≈ $1.60 (200k tokens at $8/MTok).` |
| Transcript line and toast | you send a prompt while it's cold | `Cache cold: this prompt re-writes 200k tokens of context at the cache-write price, ≈ $1.60.` The prompt is never held back. Slash commands don't count. |
| Transcript line (dim) | each automatic keep-warm, when it's on | `auto keep-warm 1/6: cache refreshed for 60 min · read 200k · wrote 30 · ≈ $0.04` |

A toast lasts 4 seconds, so the band carries the same state for as long as it holds. `/budget pings off` turns the toasts off. While auto keep-warm is on and can still act in the current window, the pings are skipped, because it will refresh the cache itself; they come back when it can't (see below).

### Keep warm

**Keep warm** on the band (focus it and press `w`), on the pane (`w`), or `/budget keepwarm` sends one `$.model.fork` of the conversation with the prompt `Reply with the single word ok.`; the fork takes only a prompt, so the short prompt is what keeps the reply tiny. The fork repeats the main conversation's last request, so the API reads the cached prefix and its lifetime starts over. It costs one tiny request: the prefix at the cache-read price plus a few tokens, logged as a dim transcript line such as `keep-warm: cache refreshed for 60 min · read 200k · wrote 30 · ≈ $0.04`.

Unless you turn on [auto keep-warm](#auto-keep-warm), the plugin sends nothing on a timer. A keep-warm pressed after the cache has already gone cold pays the full cold write itself (the logged cost shows it). If the fork has nothing to fork yet, fails, or is refused, a toast says `keep-warm got no reply` with the reason, and the timer is left alone.

### Auto keep-warm

Off by default. `/budget autowarm on` (or `"autoKeepWarm": true` in `~/.claude/token-budget.json`) lets the 30-second cache timer send the same keep-warm fork on its own when `autoKeepWarmMinutes` (3) are left, so the cache stays warm while you're away. Each refresh starts a new warm window, so with the 60-minute lifetime it fires every 57 minutes.

**Caps.** At most `autoKeepWarmMax` (6) automatic refreshes per idle stretch. An idle stretch runs from the start of one turn to the start of the next, so an abandoned session stops refreshing: with the defaults, 6 refreshes keep the cache warm for about 6.7 hours after your last turn (6 × 57 minutes, plus the last 60), then it goes cold as usual. Your next turn starts a new stretch with a fresh count. A manual Keep warm doesn't reset the count. With a 5-minute lifetime, `autoKeepWarmMinutes` must be under it (such as `1`, which refreshes every 4 minutes); raise `autoKeepWarmMax` to cover a longer wait.

**Cost.** One refresh is one tiny request: the context at the cache-read price plus a few tokens, such as 200k tokens on `opus-5-5` at $0.20/MTok ≈ $0.04. Six refreshes cost ≈ $0.24, against ≈ $1.60 for one cold resend of the same context. Each refresh logs a dim transcript line with what it read, wrote and cost, and the 6th says the cap is reached. `/budget autowarm on` prints the estimate per refresh at your current context. These requests go through `$.model.fork`, not the main loop, so they aren't counted against the token budget; the logged costs are the record.

**Worst case.** The lifetime is only assumed. If the real cache lapsed sooner, or `/model` changed the model, an automatic fork pays the full cache write, the same as a cold resend. When a fork writes more than it reads, the plugin logs and toasts `auto keep-warm 1/6: the fork re-wrote the cache instead of reading it (…); auto keep-warm stops until the next turn.` So it pays at most one such write per idle stretch.

**When it doesn't fire:**

- while a turn is running, from `turn.start` until its `turn.complete`. A turn waiting on a long tool call or a permission prompt counts as running, so the cache can go cold during that wait.
- after a compaction, until the next request, because there is nothing to re-warm
- once the cache is already cold, because that would pay the full write
- once enforcement is on and the session budget is spent (`/budget` shows `paused: session budget spent`)
- after an automatic fork that got no reply or failed. It toasts and logs `auto keep-warm got no reply (…); no retry before the cache goes cold` (or `auto keep-warm failed: …`) and tries once per warm window.
- while a keep-warm fork is still running. A fork that is still running when a turn starts counts toward the stretch that ended, not the new one, and its line reads like a manual `keep-warm:` line.
- when `autoKeepWarmMinutes` isn't under `cacheTtlMinutes`. `/budget autowarm` says so.

When it can't act in the current window (any of the cases above, or the cap reached), the 15/5/1-minute pings come back, so you still hear before the cache goes cold.

**Machine-wide.** `/budget autowarm on` is saved in the plugin's `$.store`, so every idle session on this machine refreshes, each up to its own cap. The pane's **Prompt cache** section shows `auto keep-warm on|off` and a line like `on · at 3 min left · 1 of 6 this idle stretch`. `/budget text` and `/budget autowarm` print the same line.

### Prices

Costs come from a dated table in `hooks/prices.ts`: USD per million tokens for input, output, cache read and the 1-hour cache write, matched by the first model family the model id contains, longest family first (`claude-opus-5-5` is `opus-5-5`, not `opus-5`):

| Family | Input | Output | Cache read | Cache write (1 h) |
| :- | -: | -: | -: | -: |
| fable-5-1 | 10 | 50 | 1.00 | 20 |
| opus-5-5 | 4 | 20 | 0.20 | 8 |
| opus-5 | 5 | 25 | 0.50 | 10 |
| opus-4 | 5 | 25 | 0.50 | 10 |
| sonnet-5-5 | 2 | 10 | 0.20 | 4 |
| sonnet-5 | 2 | 10 | 0.20 | 4 |
| sonnet | 3 | 15 | 0.30 | 6 |
| haiku-5-5 | 1 | 5 | 0.10 | 2 |
| haiku | 1 | 5 | 0.10 | 2 |

These are list prices as of 2026-10 and only partly confirmed. A cold resend is priced as context tokens × the cache-write rate. Override or add families with `prices`, as `[input, output, cacheRead, cacheWrite1h]` or an object with those names:

```json
{ "prices": { "opus-5-5": [4, 20, 0.2, 8], "my-gateway-model": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite1h": 6 } } }
```

A model that matches no family has no price: the band and toasts leave the cost out instead of guessing. **Session cost** on the pane is Claude Code's own figure (`$.session.usage().cost`), not this table.

### Resumed sessions

On `/resume` and `/branch`, the `SessionStart` payload can carry `seconds_since_last_response`, `prompt_cache_likely_expired`, `context_tokens` and `model`. These fields are in Claude Code's generated types but not in its documentation, so the plugin reads each one defensively to seed the timer: the last request is placed that many seconds ago, and a payload that says the cache likely expired is shown cold even if the 60-minute assumption says otherwise. When the fields are absent, the cache state stays unknown (`● cache: no request yet` on the band) until the first request.

## How counting works

- **Where**: only in `turn.step`, which fires once for each request to the model. Its result's `usage` holds `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and `model`. `e.agentId` is set for a subagent's request. `turn.complete`'s `e.usage` repeats the same responses' totals, so it isn't added; counting both would double the count.
- **What counts**: `input_tokens + output_tokens + cache_creation_input_tokens`, plus `cache_read_input_tokens` only when `countCacheReads` is `true`. Cache reads are tracked and shown either way.
- **Breakdowns**: by model (from `usage.model`, falling back to the request's model) and by agent (`agentId`, or `main`). Requests are counted, and so are main-loop turns. A main-loop turn's tokens go into a history of the last 50 turns, which gives the average per turn and the projected turns left.
- **Context**: `ctx` in the band is the context window fill from `$.session.usage()`, read after each main-loop turn. It's left out when Claude Code doesn't report it.
- **Lifetime**: counted tokens are also added to a lifetime total for each project directory, kept in `$.store` under `lifetime:<cwd>`. It's shown for information only, never enforced, and `/budget reset` leaves it alone.
- **Where counts live**: in `$.state`, so they survive a hot reload of the plugin. A new session (a different session id at `session.start`) starts from zero, and so do `/clear`, `/resume`, and `/branch`, because Claude Code resets `$.state` for those.

## Limits

- **Usage arrives after the request.** A request is counted when its response finishes, so the spend that crosses the budget is never refused itself. A long final request, or several subagents running at once, can overshoot by a request each.
- **A request without usage isn't counted.** If a response reports no `usage`, for example because the request was interrupted or failed before any response arrived, the plugin counts nothing for it.
- **Subagents finishing one request.** The per-agent limit refuses a subagent's tool calls, which stops its work, but the subagent still makes the request in which it writes its final answer.
- **`stop` refuses tool calls, not text.** Claude can still answer in text, which is the point: it reports back to you.
- **`/clear`, `/resume`, and `/branch` start the count again**, because Claude Code resets `$.state` for them. The lifetime total isn't affected.
- **Hooks fail open.** If a hook throws, Claude Code skips it and the call goes ahead, so a bug in the plugin never blocks your session. `claude plugin validate` lists the gating hooks as having no `.catch`; that's deliberate.
- **Shared store.** Settings and lifetime totals are shared by every session on the machine. Two sessions that write at the same moment can lose one lifetime increment.
- **Budgets are in tokens, not dollars.** The dollar figures are for the prompt cache only, from a dated price table you can override; they are estimates, not a bill.
- **The cache lifetime is assumed, not reported.** The plugin can't see the API's cache; if the real TTL differs from `cacheTtlMinutes`, its countdown is wrong by the difference. A request the plugin doesn't see (another client on the same conversation) doesn't move its clock.
- **Auto keep-warm needs the session open.** It runs on the session's own timer, so a closed or suspended Claude Code sends nothing, and a machine that slept past the window wakes to a cold cache (no fork is sent once cold). Its requests aren't counted against the token budget.

## What it runs

`claude plugin validate --strict .` lists the footprint:

- **Hooks**: `session.start`, `classic.SessionStart` (`/clear`, `/resume`, `/branch`), `session.compact`, `prompt.submit`, `session.end`, `turn.step`, `turn.start`, `turn.complete`, `agent.spawn`, `tool.call`, `command.run` (`/budget`), and `ui.render` for the band and the pane.
- **Processes**: none. It runs no shell command and starts no program.
- **Files**: reads `~/.claude/token-budget.json` (found through `HOME`, the only environment variable it reads) and `<project>/.claude/token-budget.json`. It writes no file.
- **Stored data**: settings saved with `/budget` and the lifetime totals per project, in the plugin's `$.store`; the session's counts in `$.state`.
- **Model calls**: `$.model.fork` for Keep warm only: one tiny request per press of Keep warm or `/budget keepwarm`, and, only after `/budget autowarm on`, up to `autoKeepWarmMax` automatic ones per idle stretch. **Each one spends tokens** (the context at the cache-read price, or the full cache write if the cache already lapsed) and is logged with its cost. Nothing else is sent anywhere.
- **Timers**: one 30-second `$.clock.every` for the cache countdown.

## Files

```
.claude-plugin/plugin.json   manifest
hooks/hooks.json             points at register.ts
hooks/register.ts            hooks and the helpers that call the mods API
hooks/budget.ts              pure helpers: parsing, config, counting, formatting
hooks/cache.ts               pure helpers: cache time left, cold, pings, band chip and toast texts
hooks/prices.ts              the dated price table, family matching, cost math
hooks/kit.ts                 the UI kit, kit v3 (identical to the core's hooks/lib/kit.ts; edit it there)
types/index.d.ts             $.state declarations and shared types
tests/budget.test.ts         unit tests for the pure helpers
tests/cache.test.ts          cache math, prices, timer pings, keep-warm and auto keep-warm, band and pane on both surfaces
tests/kit.test.ts            the kit's tests
tests/register.test.ts       hook tests with stubbed turn.step streams
```

## License

MIT. See [LICENSE](LICENSE).
