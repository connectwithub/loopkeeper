# lk-where-am-i

A loopkeeper add-on for Claude Code that keeps one line above the prompt saying which repo, branch and worktree the session is in, how dirty it is, and how the account's usage windows and prompt cache are doing. Made for running many repos and worktrees at once. A glance tells you which checkout this session will change before you ask it to change anything, and how close you are to a usage limit.

**Use it when**

- You run Claude Code in several repos or worktrees at once and want to see, before you type, which one this session is in.
- You are on a subscription and want the 5-hour and 7-day usage windows in view without opening another tool.
- You come back after a break and want to know whether the prompt cache is still warm and what is uncommitted or unpushed.

**Install:** `/plugin install lk-where-am-i@loopkeeper`, after `/plugin marketplace add connectwithub/loopkeeper` (more under [Install](#install)). Requires Claude Code 2.1.294 or later. Its usage-window chips need a Claude subscription.

**Data handling:** it keeps the settings you save with `/where` in its own plugin store (a JSON file under your Claude Code configuration folder) and the last git reading in session state. It reads `~/.claude/where-am-i.json`, runs read-only `git` in the session's folder and writes no file. It makes no model calls and sends nothing over the network. It collects no personal data; the saved settings stay until you delete them. Details under [What it runs](#what-it-runs).

**Commands:** `/where` and its options are listed under [Commands](#commands).

The band (the figures are examples):

```
acme-repo@main ⑂wt:feat-x  ● 5h 34%  ● 7d 12%  ● cache 41m          3 dirty · 2↑ · 14m since commit
```

- **Label**: the location in bold: the repo name (the main repo's folder, also from a linked worktree), the branch or `(sha)` when detached, and `⑂wt:<name>` in a linked worktree. Outside git it shows `<folder> (no git)`; before git is read, `where`.
- **Usage windows**: `5h` and `7d` percent used as chips, from `session.measure` (falling back to `$.session.usage()`). A chip is muted, in the warn tone from 80%, and in the danger tone from 95%; one toast per window at 90% (re-armed when the window resets). Windows past their reset time are hidden until a fresh reading.
- **Prompt cache**: a chip with the time left since the last main-loop model request against the TTL (default 60 minutes): muted, in the warn tone under 5 minutes, `cache cold` after expiry. Subagent requests don't move it.
- **Right side**: `N dirty` or `clean`, `N↑` unpushed or `no upstream`, and the time since the last commit, in quiet text; in the default text color while a window is at the danger level.
- Unknown parts are left out. The line stays one row: its label and right side truncate at the band's width. The bands of other plugins and Claude Code's own content stay under it. Colors are theme keys; nothing in the band is filled or drawn as Svg.

Needs Claude Code 2.1.294 or later.

## Install

lk-where-am-i is one plugin in the loopkeeper marketplace. Add the marketplace once, then install it, inside a Claude Code session:

```text
/plugin marketplace add connectwithub/loopkeeper
/plugin install lk-where-am-i@loopkeeper
```

Turn it off and on again with `/plugin disable lk-where-am-i@loopkeeper` and `/plugin enable lk-where-am-i@loopkeeper`. When the loopkeeper core is on, its hub links to the add-ons that are on.

To try a local checkout for one session:

```bash
claude --plugin-dir /path/to/loopkeeper/plugins/lk-where-am-i
```

Check it from its folder with `claude plugin validate --strict .` and `claude plugin test .`.

## Commands

| Command | What it does |
| :- | :- |
| `/where` | Opens the pane (below) |
| `/where text` | Prints the same details into the transcript |
| `/where refresh` | Checks git again now |
| `/where band on\|off` | Shows or hides the line (saved) |
| `/where cache <min>` | Sets the prompt-cache TTL in minutes (saved) |

## Pane

`/where` draws one pane with the loopkeeper kit (kit v3), the same in the terminal and the desktop app. At the top a **where you are** card: `repo@branch` (with `⑂wt:<name>` in a linked worktree) as the title, and the dirty count, unpushed commits and time since the last commit under it. Then four tiles: **Changed**, **Unpushed**, **Cache** (time left, warn tone under 5 minutes) and **Cost**. Then headers with counts: **Location** (repo, branch, worktree, cwd, top level, default branch, upstream, changes, last commit), **Usage** (a bar per window, warn tone at 80% and danger at 95%, the reset time on the right), **Prompt cache** (time left, the TTL and where it came from), and **Worktrees** (`●` and a `here` pill on this one, `locked` and `prunable` pills, the branch on the right). The pills are Svg on the desktop and `● here` chips in the terminal. Buttons: **r** Refresh, **c** Close.

## Configure

`~/.claude/where-am-i.json` (or `$CLAUDE_CONFIG_DIR/where-am-i.json`):

```json
{ "cacheTtlMin": 60, "band": true }
```

Settings saved with `/where` win over the file. Read at session start and after `/clear`, `/resume`, `/branch`.

## When it refreshes

Git is read on session start, after `/clear` / `/resume` / `/branch`, when the session's directory changes, after every main-loop turn, and every 60 seconds while no turn is running. Each refresh runs in the background (no turn waits on it), shares one run with any refresh already in flight, and caps every git call at 2 seconds. Status uses `--no-optional-locks` so polling never takes the index lock. A failed or missing git leaves the folder name.

## What it runs

`claude plugin validate --strict .` lists the footprint:

- **Hooks**: `session.start`, `classic.SessionStart` (`/clear`, `/resume`, `/branch`), `classic.CwdChanged`, `turn.start`, `turn.step`, `turn.complete`, `session.measure`, `session.end`, `command.run` (`/where`), and `ui.render` for the band and the pane. Every hook passes its event on unchanged.
- **Processes**: read-only `git` through `$.process.run`, in the session's directory, each capped at 2 seconds: `rev-parse`, `symbolic-ref`, `status --porcelain` (with `--no-optional-locks`), `rev-list --count`, `log -1` and `worktree list --porcelain`. Nothing that writes to the repository.
- **Files**: reads `~/.claude/where-am-i.json` (or the one under `CLAUDE_CONFIG_DIR`); `HOME` and `CLAUDE_CONFIG_DIR` are the only environment variables it reads. It writes no file.
- **Stored data**: the settings saved with `/where`, in the plugin's `$.store`; the last git reading and usage windows in `$.state`.
- **Model calls and network**: none.
- **Timers**: one 60-second `$.clock.every` tick.

## Notes for directory reviewers

The directory's validator listed these items for this plugin. Each bullet says what the code does and where.

- **Programs it runs** (policy holds `MOD_RUNS_PROCESS`, `MOD_PROCESS_COMMAND_COMPUTED`). Only `git`, from one helper, `git()` in `hooks/register.ts` (line 102): `$.process.run(['git', ...args], { cwd, timeoutMs: 2000 })`. The program is always `git` and the arguments are the fixed lists in `readLocation()` (lines 112–124): `rev-parse --absolute-git-dir --git-common-dir --show-toplevel`, `symbolic-ref --short -q HEAD`, `rev-parse --short HEAD`, `--no-optional-locks status --porcelain`, `rev-parse --abbrev-ref --symbolic-full-name @{upstream}`, `rev-list --count @{upstream}..HEAD`, `log -1 --format=%ct%x00%s`, `symbolic-ref --short refs/remotes/origin/HEAD` and `worktree list --porcelain`. Only `cwd` varies: it is the session's directory. Every call is local and read-only; none writes to the repository or contacts a remote. It is there to show the repo, branch, worktree and dirtiness in the band.
- **Local data and the conversation** (policy holds `MOD_LOCAL_DATA_LEAVES`, `MOD_SESSION_DATA_LEAVES`). Nothing is sent anywhere. Git's output is parsed into the band and the pane and kept in `$.state`. The only file it reads is its own config, `~/.claude/where-am-i.json` (or the one under `CLAUDE_CONFIG_DIR`), and nothing from it reaches a git argument. The `turn.step` hook (line 381) reads no message text: after the step it records the time, for the prompt-cache clock, and returns the step's result unchanged. The `session.measure` hook (line 408) reads only `rateLimits` and `cost`.
- **Fields in `plugin.json`** (warnings `UNKNOWN_KEY`). `documentationUrl` and `supportUrl` are listing fields the directory reads. `types` points at `types/index.d.ts`, the `$.state` contract that `claude plugin validate` checks. Claude Code ignores all three at load time.
- **Icon** (warning `ICON_MISSING`). Added at `.claude-plugin/icon.png` (512 × 512); its source is `docs/assets/icons/lk-where-am-i.svg` in the repo.
- **A call named in text** (note `MOD_CALL_NAMED_IN_TEXT`). `command.run` is named in the header comment of `hooks/register.ts` (line 11), which lists the hooks.
- **Its command** (note `MOD_REGISTERS_SURFACES`). It registers one slash command, `/where`, at session start (line 342). It registers no tools or agents.
- **Classic hooks** (note `MOD_HOOKS_POLICY_EVENT`). `classic.SessionStart` with source `clear`, `resume` or `fork` (line 355) loads the settings and refreshes git again, because those resets clear `$.state`. `classic.CwdChanged` (line 365) stores the new directory and refreshes git. Both return `next(e)` unchanged; neither alters settings, instructions or other hooks.
- **The `command.run` hook** (note `MOD_HOOKS_OPERATION`). The hook at line 430 has the matcher `{ command: 'where' }`, so it runs only for `/where`: it opens the pane, prints a text summary, refreshes git, shows or hides the band, or sets the cache TTL. It does not see or change any other command.

## Limitations

- Git is read through `$.process.run` (CLI only); on a surface without it the band shows only the usage and cache parts.
- `rateLimits` is empty off a subscription, so the usage chips are hidden there.
- The cache clock is an estimate from request times; it doesn't see server-side evictions or a TTL change mid-session.
- A bare repository or the inside of `.git` counts as "no git".

## Files

```
.claude-plugin/plugin.json   manifest
hooks/hooks.json             points at register.ts
hooks/register.ts            hooks, git refresh, the band and the pane
hooks/where.ts               pure helpers: git parsing, usage levels, the cache clock, the band's parts
hooks/pane.ts                the pane's view model (pure)
hooks/kit.ts                 the UI kit, kit v3 (identical to the core's hooks/lib/kit.ts; edit it there)
types/index.d.ts             $.state declarations and shared types
tests/where.test.ts          the pure helpers
tests/pane.test.ts           the pane and the band on both surfaces
tests/register.test.ts       hook tests with stubbed git
tests/kit.test.ts            the kit's tests
```

## Credits

The stale-window filter and the re-arming 90% toast follow `usage-meter` in hamzafer/claude-code-mods (MIT).

## License

MIT. See [LICENSE](LICENSE).
