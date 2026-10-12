# 0001. One hooks module, six concerns

- Status: accepted
- Date: 2026-10-10

## Context and Problem Statement

loopkeeper merges five mods: stage machine, gates, routing, review loops and a decision log. Claude Code 2.1.294 refuses a second entry in `hooks.json` `modules`, so a plugin has one hooks module. The concerns still need to share state, and the order in which their hooks run decides what the user sees.

Facts that shape the design:

- `$` and atom objects cannot cross an import. `validate` refuses it. Passing `on` into a function in another file works, and `validate` follows it.
- An atom declared in two files with the same literal `{plugin, key}` is one value.
- Hooks of one event run in registration order, the first being outermost.
- The engine refuses two hooks of one event with no matcher in one module ("registered twice without a matcher").

## Considered Options

1. One large `register.ts` of about 4,500 lines.
2. A single `loop.ts` holding stage, gates and routing, with review and decisions apart.
3. `plugins/loopkeeper/hooks/register.ts` calls six wiring functions, one per concern file.

## Decision Outcome

Chosen option: 3, because it keeps each file reviewable and the chaining held up in tests. `register.ts` calls wireStage, wireGates, wireFiles, wireRouting, wireReview and wireDecisions in that order. That order is the band order, top to bottom, and the order of the `/lk status` lines.

- Concerns share state by redeclaring the same literal key. Pure helpers live in `plugins/loopkeeper/hooks/lib/` and never see `$`.
- Each concern's `session.start` uses the matcher `{ isInteractive: [true, false] }`. Other repeated events (`prompt.context`, `turn.start`) use an empty matcher `{}`.
- `/lk` chains. An owning handler returns `{text}`. A shared word (status, reload, band, on, off) awaits `next(e)` and prepends its own line. `decisions.ts` ends the chain and answers an unknown sub-command once.
- `stage.ts` wraps the `review_cycle` tool call as the outermost hook, awaits review's answer, then reads the `reviewSubjects` atom.
- The Files pane tracks activity with `tool.call` matchers written as patterns (`^(?:Read|NotebookRead)$`, `^(?:Glob|Grep)$`, `^(?:Edit|Write|MultiEdit|NotebookEdit)$`). The typed matcher in 2.1.294 refuses tool names missing from its built-in list (Glob, Grep, NotebookRead, MultiEdit). Searches run through Bash are not tracked; Bash reads never were.
- Bash write targets reach the Files pane through the `filesTouched` and `filesActivity` atoms. Both are written with `update` (compare-and-set), so two concerns never overwrite each other.
- The stage's growth guard wraps the gates' edit check from outside. It judges first, inside its serialising chain: a file that would grow a small task is refused before the gates count it; any other new file is reserved and released if the gates or the permission rules refuse the edit.

### Consequences

- Good: six files of reviewable size; one module satisfies the engine.
- Good: the fallback (a single `loop.ts`) was not needed.
- Bad: the identical-matcher `session.start` registrations rely on the engine not enforcing "once per matcher" for an identical matcher. `validate`, the test kit and a real `claude -p` session accept them. The smoke tests and the CI canary pin that behaviour.
- Bad: when a small task's 4th file is also refused by the gates, the growth refusal wins and the task goes back to Plan.
- Bad: hook order is now load-bearing. Reordering the calls in `register.ts` changes the band order and the `/lk` chain.

## More Information

Build order was stage first, then gates, then routing, since everything reads the stage. Review, decisions and kit v2 were built alongside the stage in scratch copies because nothing reads them.
