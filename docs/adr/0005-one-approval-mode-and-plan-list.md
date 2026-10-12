# 0005. One approval mode and one plan-material list

- Status: accepted
- Date: 2026-10-10

## Context and Problem Statement

pipeline-stage and gsd-orchestrator each kept an approval mode; gsd only forwarded its mode to the pipeline. pipeline-stage and change-control each kept a list of plan material, the files that may be written during planning. Two settings for one idea can disagree.

## Considered Options

1. Keep both settings and sync them.
2. One approval mode and one plan-material list.

## Decision Outcome

Chosen option: 2, because synced duplicates only add a way to be wrong.

- The approval mode is one setting, `/lk approval auto|ask`, set per project. Its default is `pipeline.approval`.
- The plan-material list is `changeControl.planPaths`. The plan gate and the growth guard both read it. The scratchpad is always plan material.

### Consequences

- Good: one place to say who approves plans and what counts as plan material.
- Good: the plan gate and the growth guard cannot disagree about a file.
- Bad: a project that had different lists in the two old mods must merge them by hand into `changeControl.planPaths`.
