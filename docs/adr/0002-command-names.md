# 0002. Command names

- Status: accepted
- Date: 2026-10-10
- Amended: 2026-10-11 (`/lk` alone opens the hub; the Stage pane is `/lk stage`)

## Context and Problem Statement

The merged plugin needs short command names. The old mods used `/pipeline`, `/change-control` and `/gsd`; review-loop and the pipeline also wanted `loop` and `review`. In 2.1.294 two of those names are taken by built-ins.

- `$.command.register('loop')` throws: "/loop" is refused because it is the built-in `/loop`.
- `review` is refused as an alias of the built-in `/code-review`.
- A `command.run` hook matched on `loop` also fires for the built-in `/loop`.

## Considered Options

1. Register `loop` and `review` anyway and handle the refusal.
2. Use a prefixed set of names for everything.
3. `/lk` (long form `/loopkeeper`) for the pipeline, GSD and gates grammars, `/reviews` for review loops, and keep `/decide`, `/decisions`, `/files`.

## Decision Outcome

Chosen option: 3, because it avoids every refused name and keeps the commands that did not clash.

- `/lk` and `/loopkeeper` carry the stage machine. `/lk` alone opens the loopkeeper hub (requestId `loopkeeper-hub`), `/lk stage` opens the Stage pane, and `/lk help` lists the keys ([ADR 0014](0014-hub-and-keys.md)). Both words are read before a stage id, so a custom stage with the id `stage` or `help` is reached with `/lk next`, `/lk back` or `set_stage` instead of `/lk <stage-id>`. change-control's words move under `/lk gates ...`. gsd's `/gsd reset` becomes `/lk route reset`; `/lk reset` stays the stage reset. `/lk text` is the plain-text status.
- `/reviews` keeps review-loop's grammar.
- `/decide`, `/decisions` and `/files` are unchanged.
- `/lk on|off` (GSD mode) is distinct from `/lk gates on|off` (the gates' session switch).
- The plugin never registers `loop` or `review`, and never matches a `command.run` hook on them.
- Every registration is wrapped in try/catch, so a refused name leaves the rest working.
- `/lk routes` opens the routing pane (requestId `loopkeeper-routes`). The routing band reads `routing  ● on  ● loop   recon→haiku · exec→sonnet · verify→sonnet · hard→opus · routed 1`, or `routing  ● off`.

### Consequences

- Good: no clash with built-ins, no accidental firing on `/loop`.
- Good: one entry point to learn. Since 2026-10-11 it opens the hub, which links every pane.
- Bad: users of the old mods must learn the new words. Nothing is aliased from the old names.
- Bad: `/lk on` and `/lk gates on` look alike and do different things; the help text states the difference.
