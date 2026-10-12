# loopkeeper

loopkeeper is a set of Claude Code plugins in one repository, which is also their marketplace. The core plugin, `loopkeeper`, runs a task loop (plan, validate the plan, execute, verify, QA, ship) and enforces its rules with hooks that share state: approval gates, a file budget per turn tied to the approved plan, protected paths, a ship gate, merge and amend guards, model routing by role, bounded review loops and a decision log. The seven add-on plugins are optional; turn each one on or off on its own.

Requires Claude Code 2.1.294 or later, for the core and every add-on.

## The core

| Plugin | Command | What it does |
| --- | --- | --- |
| [`loopkeeper`](plugins/loopkeeper/README.md) | `/lk` | The stage machine and its gates, the file budget, model routing, review loops and the decision log. `/lk` opens its hub. |

The core's README covers the loop, the gates, every command, the config, the footprint and the kill switch.

## Add-ons

Each add-on is a plugin of its own, named `lk-<name>`. It works with or without the core, and its slash command is the one it always had. Every add-on draws with the core's UI kit, so its band and pane look like the core's.

| Plugin | Command | What it does | Band and pane | What it runs | Limits |
| --- | --- | --- | --- | --- | --- |
| [`lk-agent-map`](plugins/lk-agent-map/README.md) | `/agent-map` | An agent deck for the session's subagents: cards with cost, tokens, context, model, effort and progress; tree and team views; spawn caps; permission waits; idle alerts; a Stop button per agent. | Band; `/agent-map` pane | No processes, model calls or network. **Stop** calls `TaskStop` after two presses. | None |
| [`lk-attention`](plugins/lk-attention/README.md) | `/attention` | Tells you when Claude needs you or finished something long: a desktop notification, a sound, a toast and an inbox. | Band; `/attention` inbox pane | `notify-send` (when `$.ui.notify` is missing), `paplay` or `pw-play`. No model calls or network. | Linux with GNOME |
| [`lk-handoff-guard`](plugins/lk-handoff-guard/README.md) | `/handoff` | Watches context fill, writes a session handoff into the project's `.claude/brain/` before the limit, then clears and resumes from it. | Band; pane (`/handoff show`) | Read-only `git rev-parse` and `git log`. One model call per handoff, which spends tokens. Runs `/clear` and submits one resume prompt after a handoff that clears. | None |
| [`lk-token-budget`](plugins/lk-token-budget/README.md) | `/budget` | A token budget for the session and each subagent, and a prompt-cache timer with a manual Keep warm and an opt-in, capped auto keep-warm. | Band; `/budget` pane | No processes. Keep warm sends one small model request, which spends tokens; auto keep-warm is off by default. | None |
| [`lk-where-am-i`](plugins/lk-where-am-i/README.md) | `/where` | One line with the repo, branch and worktree, how dirty it is, and the account's usage windows and prompt cache. | Band; `/where` pane | Read-only `git`, each run capped at 2 seconds. No model calls or network. | Usage chips need a subscription |
| [`lk-pr-watch`](plugins/lk-pr-watch/README.md) | `/pr` | The pull request and CI state of the current branch, toasts on transitions, and a note to Claude when a check fails. | Band while a PR is watched; `/pr` pane | `gh pr view` and `gh api graphql` (GitHub, through your `gh` sign-in); `xdg-open` or `open` when you press **Open in browser**. No model calls. | Needs `gh`, signed in |
| [`lk-secret-guard`](plugins/lk-secret-guard/README.md) | `/secret-guard` | Stops credential-shaped strings and a private deny-list of words from being written into files or shell commands. | Band after the first block or warning; `/secret-guard` pane | No processes, model calls or network. Refuses or asks before a write. | Pattern-based |

[SECURITY.md](SECURITY.md) lists what each plugin reads, writes, runs and calls.

### The hub's Other mods row

With the core on, `/lk` opens its hub. Its **Other mods** row has one key for each add-on that is installed and on: `m` Agents, `u` Budget, `h` Handoff, `t` Attention, `w` Where, `p` PRs, `s` Secrets. In the desktop app a press runs the add-on's command, which opens its pane. In the terminal it puts the command in an empty prompt box for you to send with Enter, and never replaces a draft. An add-on that is off has no key.

## Install

Inside a Claude Code session, add the marketplace once, then install the core and any add-ons you want (lk-attention here):

```text
/plugin marketplace add connectwithub/loopkeeper
/plugin install loopkeeper@loopkeeper
/plugin install lk-attention@loopkeeper
```

Turn a plugin off or on again with `/plugin disable <name>@loopkeeper` and `/plugin enable <name>@loopkeeper`, for example `/plugin disable lk-attention@loopkeeper`. `/plugin` alone lists what is installed. From a shell, `claude plugin` takes the same words: `claude plugin install lk-attention@loopkeeper`.

To try a plugin from a clone without installing it, point Claude Code at its folder:

```sh
claude --plugin-dir /path/to/loopkeeper/plugins/loopkeeper
claude --plugin-dir /path/to/loopkeeper/plugins/lk-where-am-i
```

## Layout

```
.claude-plugin/marketplace.json   the marketplace: one entry per plugin
plugins/loopkeeper/               the core plugin (hooks, tests, types, README, CHANGELOG, LICENSE)
plugins/lk-<name>/                one add-on plugin each, laid out the same way
docs/                             architecture, the loop, renderings, decision records
.github/workflows/ci.yml          validation and tests for every plugin
```

[ADR 0015](docs/adr/0015-core-and-add-ons.md) explains why the set is laid out this way.

## Links

- The plugins: [loopkeeper](plugins/loopkeeper/README.md), [lk-agent-map](plugins/lk-agent-map/README.md), [lk-attention](plugins/lk-attention/README.md), [lk-handoff-guard](plugins/lk-handoff-guard/README.md), [lk-token-budget](plugins/lk-token-budget/README.md), [lk-where-am-i](plugins/lk-where-am-i/README.md), [lk-pr-watch](plugins/lk-pr-watch/README.md), [lk-secret-guard](plugins/lk-secret-guard/README.md).
- [docs/](docs/architecture.md): [architecture](docs/architecture.md), [the loop](docs/loop.md), [renderings](docs/renderings.md) and the [decision records](docs/adr/README.md).
- [CHANGELOG.md](CHANGELOG.md): where each plugin's changelog is.
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [LICENSE](LICENSE).

## License

MIT. See [LICENSE](LICENSE). Each plugin folder carries its own copy with the third-party notices that apply to it; the credits are in each plugin's README.
