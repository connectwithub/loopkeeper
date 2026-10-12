# 0006. Decision watch off by default; public format names

- Status: accepted
- Date: 2026-10-10

## Context and Problem Statement

The decision watch reads qualifying turns and asks a model whether a decision was made. That is a model call the user did not type. It should not run unless the user asks for it. Separately, the markdown decision log format carried a name from a personal tool.

## Considered Options

1. Watch on by default, with a way to turn it off.
2. Watch off by default; the user turns it on.
3. Remove the watch.

## Decision Outcome

Chosen option: 2, because a plugin should not make model calls on the user's session until asked.

- `decisions.watch` is false by default. `/decide watch on`, or `"watch": true` in either config file, turns it on.
- Its caps stay: an hourly cap across sessions (20), at most five pending majors, an 8 s timeout and a minimum turn length.
- The markdown decision log format is named `markdown`. `brain-md` is still accepted as an alias. Public strings never name personal tools.

### Consequences

- Good: a fresh install makes no model calls.
- Good: the format name is neutral, and old configs that say `brain-md` keep working.
- Bad: users who want automatic capture must opt in, and may not know the watch exists. `/decide` shows its state.
