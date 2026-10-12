# Privacy policy

This policy covers the eight plugins in this repository: `loopkeeper` and the add-ons `lk-agent-map`, `lk-attention`,
`lk-handoff-guard`, `lk-token-budget`, `lk-where-am-i`, `lk-pr-watch` and `lk-secret-guard`. It was last updated on
2026-10-12.

## What we collect

Nothing. The plugins have no server, no account, no analytics and no telemetry. The maintainers receive no data from
you or from your sessions.

## What the plugins handle on your machine

The plugins run inside Claude Code on your machine, with your permissions. To do their work they read what Claude Code
shows a plugin (tool calls, prompts, the session's messages, subagents, usage figures) and files in your project.

- **Settings and state** stay on your machine: in Claude Code's own session state and plugin store, and in config
  files named after each command in `~/.claude/` and `<project>/.claude/`.
- **Files written**: the core writes a review log (`.claude/loopkeeper-review.jsonl`) and appends to your project's
  decision log; lk-handoff-guard writes its handoff notes to `<project>/.claude/brain/`. These are plain files in your
  project that you own, read and can delete.
- **Retention**: everything stays until you delete it. Uninstalling a plugin with `--keep-data` keeps its plugin store;
  without it, Claude Code removes the store.

## What leaves your machine

- **Model calls** run on your own Claude Code session and are billed to your account: the core's decision watch (off
  by default), one call per handoff in lk-handoff-guard, and lk-token-budget's keep-warm (a press, or the opt-in
  automatic keep-warm). These go to the model your Claude Code session already uses, under its terms.
- **GitHub**: the core's read-only `gh` queries and lk-pr-watch's `gh pr view` / `gh api graphql` reach GitHub through
  your own signed-in `gh` CLI. They send the repository, the branch and a pull-request number, nothing else.
- **Desktop notifications** from lk-attention stay on your machine; your desktop may keep them in its notification
  history. They can contain a clipped Bash command or question.
- Nothing else is sent anywhere. No plugin reads a credential to send it.

The per-plugin details (every process, file, model call and network use) are in [SECURITY.md](SECURITY.md) and in each
plugin's README, under Data handling and Footprint.

## Children

The plugins are developer tools and are not directed at people under 18.

## Changes and contact

Changes to this policy are made in this file and recorded in the repository's history. Questions: open an issue at
https://github.com/connectwithub/loopkeeper/issues. Security reports: use private vulnerability reporting at
https://github.com/connectwithub/loopkeeper/security/advisories/new.
