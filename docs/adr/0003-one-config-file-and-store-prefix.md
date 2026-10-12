# 0003. One config file and one store prefix

- Status: accepted
- Date: 2026-10-10

## Context and Problem Statement

The five mods each had their own config file and their own store keys. review-loop and decision-pad both used a bare `band` key, which would collide in one plugin. Pipeline had only a project file.

## Considered Options

1. Keep five config files and migrate the old ones at first run.
2. One config file with five sections, read from a user level and a project level, and no migration.

## Decision Outcome

Chosen option: 2, because a migration would read files from five other mods and guess at their state, and the plugin is new.

- Config is `~/.claude/loopkeeper.json`, then `<project>/.claude/loopkeeper.json`, with sections `pipeline`, `changeControl`, `routing`, `review` and `decisions`. Session overrides live in `$.store`. Pipeline gains a user-level file.
- Store keys are `loopkeeper:<concern>:<key>`.
- Nothing is read from the old files (`.claude/pipeline.json`, `change-control.json`, `gsd-orchestrator.json`, `decision-pad.json`) or from old store keys. A fresh plugin starts from defaults. The README says how to copy settings by hand.
- The review log is `.claude/loopkeeper-review.jsonl`. Only review-loop read the old log.
- For decisions, the `file` and `format` overrides come from the project file only, and the path must stay inside the project. Watch settings come from either file.
- The gates merge the `changeControl` section with change-control's own layer merge: protected paths merge by glob, with `[source]` labels.

### Consequences

- Good: one place to configure, no key collisions.
- Good: no code that reads another tool's state.
- Bad: existing users start from defaults and must copy settings by hand.
- Bad: the old review log is not picked up.
