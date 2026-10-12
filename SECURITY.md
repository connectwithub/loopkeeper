# Security

## Supported versions

The latest release of each plugin gets fixes.

| Plugin | Supported |
| --- | --- |
| `loopkeeper` | 0.1.x |
| `lk-agent-map` | 0.6.x |
| `lk-attention` | 0.3.x |
| `lk-handoff-guard` | 0.3.x |
| `lk-token-budget` | 0.4.x |
| `lk-where-am-i` | 0.3.x |
| `lk-pr-watch` | 0.3.x |
| `lk-secret-guard` | 0.3.x |

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting on the repository: https://github.com/connectwithub/loopkeeper/security/advisories/new. Do not open a public issue for a vulnerability. Name the plugin and its version.

## What each plugin does on your machine

This is drawn from what `claude plugin validate --strict` reports in each plugin's folder and from the code. Each plugin's README has the full footprint. A plugin that is off (`/plugin disable <name>`) loads no hooks and does none of this.

Common to all of them:

- Each reads a config file from `~/.claude/` and one from `<project>/.claude/`, named after its command (for example `~/.claude/pr-watch.json` for lk-pr-watch), and finds the first through `HOME`. lk-where-am-i reads only the user file, under `CLAUDE_CONFIG_DIR` when that is set.
- Each keeps session state in Claude Code's `$.state` and its saved settings in its own plugin store.
- Each draws with the same UI kit. On the desktop, mobile and VS Code the kit draws icons, pills, file-type badges and progress bars as Svg. The markup is generated locally from fixed templates with fixed colours; text placed in it, such as a file's extension, is escaped, and it loads no remote content. lk-agent-map and lk-handoff-guard add Svg of their own (agent avatars, pills) built the same way.
- None sends telemetry. No add-on registers tools for the model.

### loopkeeper (the core)

Its README lists the same in more detail under [Footprint](plugins/loopkeeper/README.md#footprint).

- **Processes**: read-only `git` queries (`git status --porcelain`, `git branch --show-current`, `git rev-parse --show-toplevel`, `git symbolic-ref --short refs/remotes/origin/HEAD`, `git merge-base --is-ancestor HEAD @{u}`) and read-only `gh` queries (`gh pr view [n] --json number,state`, `gh pr checks <n> --json name,bucket`). They feed the merge gate and the Files pane.
- **Files**: reads `~/.claude/loopkeeper.json` and `<project>/.claude/loopkeeper.json`. Writes only the review log, `.claude/loopkeeper-review.jsonl`, and the project's decision log, whose path stays inside the project.
- **Model calls**: only through the decision watch, which is off by default. When on, it calls `$.model.complete` with the configured model on your own Claude Code session.
- **Prompts submitted**: after you approve something that was waiting (`/lk approve`, or an Approve button in the band, the Stage pane or the hub), it submits one prompt, framed as a message from the plugin and not as yours, that tells the model to carry on. Never in a non-interactive session (no person at the prompt and no app surface attached) or with the kill switch on. Turn it off with `pipeline.continueOnApprove: false`.
- **Turns ended**: when an edit would go past the per-turn file budget and you choose Stop (or no one can answer), it refuses the edit and ends the running turn a moment later, so the model stops instead of trying another tool.
- **Other plugins' commands**: the hub's Other mods keys open an installed add-on. In the desktop app a press runs that add-on's command (for example `/agent-map cards`), which opens its pane. In the terminal it puts the command in an empty prompt box and you press Enter; it never replaces a draft.
- **Tools for the model**: it registers `set_stage`, `review_cycle`, `review_item`, `review_status` and `record_decision`. They change only the core's own state, the review log and the decision log.
- **Network**: none of its own. The `gh` queries reach GitHub through the `gh` CLI.

### lk-agent-map

- **Processes, model calls, network**: none. Writes no file.
- **Tool calls**: `TaskStop` for one agent, only when you press that agent's **Stop** twice (arm, then confirm). Your press is the consent. An agent `TaskStop` does not accept is muted instead: its next tool call is refused.
- **Refusals**: refuses a subagent spawn past a cap you set, or asks you first.

### lk-attention

Linux with GNOME only.

- **Processes**: `notify-send` for the desktop notification when `$.ui.notify` is missing, and `paplay` or `pw-play` for the sound. Notifications carry Bash commands and questions, clipped to one line, and your desktop's notification history keeps them.
- **Files**: checks that the sound files exist; writes no file.
- **Model calls, network**: none. It refuses nothing; its gating hooks only watch.

### lk-handoff-guard

- **Processes**: `git rev-parse --abbrev-ref HEAD` and `git log -5 --pretty=format:%h %s`, read-only.
- **Files**: reads and writes `project.md`, `log.md`, `decisions.md` and `questions.md` in `<project>/.claude/brain/`. Nothing else.
- **Model calls**: one per handoff: `$.model.fork`, or else `$.model.complete` with the configured model. Both spend tokens on your account. In the default ask mode it asks before a handoff at the handoff level; in auto mode it writes one without asking. In both, it also writes one before a compaction when none was written since the last clear or compaction.
- **Commands and prompts**: runs `/clear` after a handoff that clears, then submits one resume prompt in the fresh session.
- **Refusals**: in auto mode only, past `denyAt` (95%), it refuses new tool calls while the handoff is written, and it can end a turn to hand off.
- **Network**: none of its own.

### lk-token-budget

- **Processes, network**: none. Writes no file.
- **Model calls**: `$.model.fork` for Keep warm only, one small request per press of **Keep warm** or `/budget keepwarm`. The automatic keep-warm is off by default; after `/budget autowarm on` it sends up to `autoKeepWarmMax` such requests per idle stretch, in every session on the machine. **Each one spends tokens**: the context at the cache-read price, or the full cache write if the cache has already lapsed. Each is logged with its estimated cost.
- **Refusals**: once a budget is spent, depending on the action you chose, it refuses new subagents or tool calls.
- Its hooks fail open: if one throws, the call goes ahead.

### lk-where-am-i

- **Processes**: read-only `git` in the session's folder, each capped at 2 seconds: `rev-parse`, `symbolic-ref`, `status --porcelain` (with `--no-optional-locks`), `rev-list --count`, `log -1` and `worktree list --porcelain`.
- **Model calls, network**: none. Writes no file. It refuses nothing.

### lk-pr-watch

- **Processes**: `gh pr view` and `gh api graphql` in the session's folder, through your `gh` sign-in; they reach GitHub's API and count against its rate limit. `xdg-open`, then `open`, only when you press **Open in browser**. The plugin reads and stores no token.
- **Transcript**: when a check newly fails, it appends one user-role note naming the check and its run URL, which Claude reads on its next turn. It never submits a prompt or starts a turn.
- **Other**: the clipboard, when you press **Copy URL**.
- **Model calls**: none. Writes no file.

### lk-secret-guard

- **Processes, model calls, network**: none. Writes no file.
- **Refusals**: before a `Write`, `Edit`, `MultiEdit`, `NotebookEdit` or `Bash` call, it scans only the new text. A credential-shaped string is refused; a weaker match asks you (`Allow once` / `Block`). Values are always shown masked and never stored.
- It fails closed: if the guard errors on a call, the call is refused. `/secret-guard off` turns it off for the session.

## Failing closed and the kill switch

The core's gates fail closed: if a gate hook errors, the call is refused, not let through. To turn the core's enforcing hooks off, set `CLAUDE_MODS_DISABLE=loopkeeper` in the environment, or run `/lk gates off` for the gates alone.

The add-ons do not read that variable. Turn an add-on off with `/plugin disable <name>`.
