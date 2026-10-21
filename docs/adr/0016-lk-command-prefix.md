# 0016. One `lk-` prefix for every command except `/lk`

- Status: accepted
- Date: 2026-10-21

## Context and Problem Statement

The set's commands were short names chosen against the built-ins: `/lk` and `/reviews`, with `/decide`, `/decisions` and `/files` kept by [ADR 0002](0002-command-names.md). Two things changed. Claude Code 2.1.306 ships `/pr`, so lk-pr-watch's `/pr` is refused by `$.command.register` and `claude plugin validate --strict` fails. And the other add-ons' names (`/agent-map`, `/budget`, `/where`, `/attention`, `/handoff`, `/secret-guard`) are generic words that a future built-in or another plugin could take as well. Typing `/lk-` should also list the whole set, as context-mode's `ctx-` commands do. How should the set's command names be chosen so that they do not clash with built-ins and are found together?

## Considered Options

1. Keep the names and rename only `/pr`.
2. `/lk` subcommands for everything, so every command is a word after `/lk` (`/lk reviews`, `/lk agents`, ...).
3. A `lk-` prefix on every command except `/lk`.

## Decision Outcome

Chosen option: 3, because it keeps one short command per concern, puts the whole set under one prefix that completion shows at once, and leaves `/lk` as the hub and the grammar for the pipeline, the gates and the routes.

| Plugin | Old | New |
|:-|:-|:-|
| loopkeeper (core) | `/reviews` | `/lk-reviews` |
| loopkeeper (core) | `/decide` | `/lk-decide` |
| loopkeeper (core) | `/decisions` | `/lk-decisions` |
| loopkeeper (core) | `/files` | `/lk-files` |
| lk-pr-watch | `/pr` | `/lk-prs` |
| lk-agent-map | `/agent-map` | `/lk-agents` |
| lk-token-budget | `/budget` | `/lk-budget` |
| lk-where-am-i | `/where` | `/lk-where` |
| lk-attention | `/attention` | `/lk-attention` |
| lk-handoff-guard | `/handoff` | `/lk-handoff` |
| lk-secret-guard | `/secret-guard` | `/lk-secrets` |

`/lk` and `/loopkeeper` do not change, and neither do the words after `/lk`. Subcommands and arguments keep their words (`/lk-reviews more <subject>`, `/lk-agents cards`, `/lk-handoff show`, `/lk-prs add 7`).

What does not change:

- Config file names (`pr-watch.json`, `agent-map.json`, `secret-guard.json`, `loopkeeper.json`, ...), `docs/decisions` and the other paths.
- Plugin ids. The add-ons stay `lk-<name>` ([ADR 0015](0015-core-and-add-ons.md)).
- Pane ids, store keys, `$.state` atoms, band labels and tool names (`set_stage`, `review_cycle`, ...).
- The `/lk` words, and the hub's keys and labels.

The hub runs the add-ons' new commands (`/lk-agents cards`, `/lk-budget`, `/lk-handoff show`, `/lk-attention`, `/lk-where`, `/lk-prs`, `/lk-secrets`) and matches only the `lk-` plugin ids. The old unprefixed ids are no longer matched, because their commands are gone.

This ADR supersedes the part of [ADR 0002](0002-command-names.md) that kept `/reviews`, `/decide`, `/decisions` and `/files`.

### Consequences

- Good: typing `/lk-` lists the whole set, and no name clashes with a built-in. lk-pr-watch validates again.
- Good: each concern keeps a short command of its own, and the words after it keep their grammar, so existing habits carry over with a prefix.
- Good: the hub and the docs name one form per command.
- Bad: the old names are gone with no alias, so a saved habit or note that says `/pr` or `/agent-map` stops working until it is retyped.
- Bad: `/lk` is a prefix of every other name in completion, so typing `/lk` and Enter still runs `/lk`, while `/lk-` with a hyphen is needed to list the set.
- Bad: settings and stored data are not changed, so the prefix is only in the names people type, not in what is saved.
