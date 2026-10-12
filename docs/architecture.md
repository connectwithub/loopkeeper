# Architecture

The loopkeeper core is one Claude Code plugin with one hooks module. It lives in `plugins/loopkeeper/` of the repository, which is also the loopkeeper marketplace. The module wires six concerns, each in its own file. The concerns share state through atoms, and they share commands through a chain. This page describes how the pieces fit. The decisions behind them are in [docs/adr/](adr/README.md).

```
              Claude Code engine
  tool.check / tool.call / prompt.* / command.run / agent.spawn / ui.* / session.start / turn.*
                              │
                   hooks/register.ts  (the only hooks module, hooks/hooks.json)
                              │  wires, in this order (band order, /lk status order)
   ┌──────────┬──────────┬───────────┬──────────┬──────────┬───────────┐
   stage      gates      files       routing    review     decisions
   stage.ts   gates.ts   files.ts    routing.ts review.ts  decisions.ts
   │          │          │           │          │          │
   └──────────┴────── atoms (types/index.d.ts, one literal key each) ──┴──────────┘
                              │
                 hooks/lib/*.ts  pure rules, parsers, kit (no $)
```

Paths in the diagram are relative to `plugins/loopkeeper/`.

## The `plugins/` layout

Every plugin of the set has its own folder; the repository root holds no plugin and no tests:

```
.claude-plugin/marketplace.json   the marketplace "loopkeeper": one entry per folder below
plugins/loopkeeper/               the core: .claude-plugin/plugin.json, hooks/, tests/, types/, README, CHANGELOG, LICENSE
plugins/lk-<name>/                one add-on each: lk-agent-map, lk-attention, lk-handoff-guard, lk-pr-watch,
                                  lk-secret-guard, lk-token-budget, lk-where-am-i
docs/                             this page, the loop, the renderings, the ADRs
```

Each folder is validated and tested on its own (`claude plugin validate --strict` and `claude plugin test` walk every subfolder of the folder they are given). An add-on draws with a verbatim copy of the core's kit at `hooks/kit.ts`. The hub links to the add-ons that are installed and on, through their commands ([ADR 0010](adr/0010-ci-pinned-with-canary.md), [ADR 0014](adr/0014-hub-and-keys.md)).

## The hooks module

`plugins/loopkeeper/hooks/hooks.json` names one module, `./register.ts`. Claude Code 2.1.294 accepts one module per plugin ([ADR 0001](adr/0001-one-hooks-module-six-concerns.md)).

`register.ts` calls six wiring functions, in this order:

1. `wireStage`
2. `wireGates`
3. `wireFiles`
4. `wireRouting`
5. `wireReview`
6. `wireDecisions`

Hooks of one event run in registration order, the first outermost. That order is the band order, top to bottom, the order of the hub's rows, and the order of the lines `/lk status` prints. Reordering the calls changes the UI and the `/lk` chain.

## The six concerns

| File | Owns |
| --- | --- |
| `plugins/loopkeeper/hooks/stage.ts` | The stage machine: moves, sizing, approvals, the plan verdict, the growth guard, the `set_stage` tool, the `review_cycle` wrapper, the stage band and pane, the hub's frame and Stage row, continue after approval, the stage's `/lk` words (`/lk` alone, `/lk stage`, `/lk help` among them). |
| `plugins/loopkeeper/hooks/gates.ts` | The gates: plan gate, files per turn, protected paths, ship gate, merge gate, amend and add-all rules, the Bash write targets, the gates band and pane, `/lk gates`. Fails closed. |
| `plugins/loopkeeper/hooks/files.ts` | The Files pane and `/files`: what Claude read and edited, the project tree, git status, the Files band line. |
| `plugins/loopkeeper/hooks/routing.ts` | Subagent routing (`agent.spawn`), GSD mode and the loop, the loop rules block (`prompt.context`), the routing band and pane, `/lk routes`, `/lk route`, `/lk explain`. |
| `plugins/loopkeeper/hooks/review.ts` | The review loops: `review_cycle`, `review_item`, `review_status`, `/reviews`, the review band and pane, the review log. |
| `plugins/loopkeeper/hooks/decisions.ts` | The decision log: `record_decision`, `/decide`, `/decisions`, the decision watch, the decisions band and pane. |

Each concern also draws its own row of the hub and puts the nav row first in its pane.

`plugins/loopkeeper/hooks/lib/` holds pure helpers. They take plain values and return plain values, never `$`, so tests call them directly. Examples: `stageModel.ts` (stage list, presets, move rules, sizing, the growth guard text), `gateRules.ts` (globs, Bash targets, git and gh patterns, config layers), `config.ts` (the five sections and their defaults), `names.ts` (command and tool names, the disable variable), `classify.ts` and `routingConfig.ts` (roles, keywords, spawn decisions), `reviewModel.ts` (kinds, cycles, the log line), `decisionFormats.ts` (log formats and locations), `shell.ts` (shell reading, borrowed from another MIT mod), `kit.ts` (the UI kit, v3), `filesModel.ts` and `filesPane.ts`, `watch.ts` and `loopRules.ts`.

## Atoms and shared state

An atom is a value the engine keeps for the plugin. Every atom is declared with the literal key `{plugin: 'loopkeeper', key: '<name>'}`. Two files that declare the same literal key share one value ([ADR 0001](adr/0001-one-hooks-module-six-concerns.md)). Concerns therefore share state by redeclaring the key, with no import of `$` or of an atom object across files, which the validator refuses.

`plugins/loopkeeper/types/index.d.ts` lists every atom under its concern. In short:

- **stage**: the stage list and current stage, the stage history, the size, the plan verdict, the approved and verified gates, the approval mode, the hold, the file budget and its limits; for continuing after approval, the config switch (`stageContinueOnApprove`), whether a main turn runs (`stageTurnRunning`), the prompt held for that turn's end (`stageContinuePending`) and `session.start`'s `isInteractive` (`stageInteractive`; with no surface attached either, nothing continues); the other mods' commands the hub may link to (`stageHubCommands`); the `pipeline.nextHint` switch (`stageNextHint`); whether the focus hint has shown this session (`stageFocusHinted`, redeclared in all six concern files).
- **gates**: the merged config and its sources, the turn's files, the turn's extra allowances, the session's grants and files, the plan and ship approvals, the gates' log.
- **files**: the activity list, the touched files, the listing and git status, the pane's view settings.
- **routing**: the mode and loop switches, the role table, the last decisions, the spawn counts.
- **review**: the subjects, their cycles and items, the band switch.
- **decisions**: the entries and counts, the target log, the pending majors, the watch settings and its cap.

Writes that two concerns may race on use `update` (compare and set). The Bash write targets are an example: the gates and the Files pane both write `filesTouched` and `filesActivity` that way ([ADR 0001](adr/0001-one-hooks-module-six-concerns.md)).

Settings from the config files are read by each concern. Session overrides live in `$.store` under `loopkeeper:<concern>:<key>` ([ADR 0003](adr/0003-one-config-file-and-store-prefix.md)).

## The `/lk` chain

`/lk` and `/loopkeeper` are registered once, by the stage. Several concerns handle the same `command.run` event. Each concern does this:

- If the first word is one of its own, it answers and returns `{text}`.
- If the word is shared (`status`, `text`, `reload`, `band`, `on`, `off`, and `loop` where routing and the stage both act), it calls `next(e)`, does its part, and puts its line in front of the reply that comes back.
- Otherwise it calls `next(e)` and leaves the word to the next concern.

`decisions.ts` ends the chain and answers an unknown sub-command once ([ADR 0001](adr/0001-one-hooks-module-six-concerns.md)). `/lk on|off` shows the chain at work: the stage applies the `gsd` preset, the gates set the plan requirement, and routing turns the mode on, each through its own handler. Nothing sends a command to another concern ([ADR 0004](adr/0004-stage-machine-always-present.md)).

## The `review_cycle` wrapper

The stage wraps the `review_cycle` tool call as the outermost hook. It awaits the review concern's answer and then reads the `reviewSubjects` atom. When a plan review pass is done (a last cycle, no open p0 or p1 item, and a verdict that is neither `iterate` nor `stop`), the stage records a consistent plan verdict as `set_stage` would. The review concern does not write the stage's atoms ([ADR 0004](adr/0004-stage-machine-always-present.md)).

## The band stack

Each concern adds one `AbovePrompt` handler, and the bands draw in the order above. The stage band comes first and the decisions band last. A concern's band can be hidden with `/lk band <concern> off`. With the kill switch on, the Files band line is not drawn ([ADR 0009](adr/0009-kill-switch-and-fail-closed.md)).

Each pane has its own `Pane` handler keyed by `requestId`: `loopkeeper-stage`, `loopkeeper-gates`, `loopkeeper-routes`, `loopkeeper-review`, `loopkeeper-decisions`, and the Files pane. The hub, `loopkeeper-hub`, has one handler per concern (below). The text of every band and pane is in [renderings.md](renderings.md).

## The hub chain

`/lk` alone opens the hub ([ADR 0014](adr/0014-hub-and-keys.md)). It is drawn like the band: every concern registers a `ui.render` hook for the `Pane` with requestId `loopkeeper-hub`, and stacks its own row above what `next(e)` returns. The stage is wired first, so its hook is outermost. It draws the hero with the next-step sentence under it, the `Panels` header and the Stage row, puts the later concerns' rows below, and ends with the `Other mods` buttons and the actions (Approve, GSD on/off, Close). Each row hook catches its own failure and falls back to `next(e)`, and each handles a null from `next(e)`, which the last one (decisions) gets at the end of the chain.

The hub and the six panes, with their digits (`0 Hub` to `6 Decisions`), live in a table, `PANES`, with two helpers: `switchTo` closes the current pane and opens the next with the focus, and `navItems` builds the nav row the kit's `nav` draws first in every loopkeeper pane. `$` and atom objects never cross imports, so each concern file keeps its own copy of the table and both helpers; the stage's copy is the original.

The other mods' commands come from `$.command.list()`. The stage reads the list when the hub opens: in the `/lk` handler, in a `ui.open` hook for an open from another plugin's hook, and in a `ui.press` hook on a nav row's Hub item (an open made from a Button's press skips this plugin's own `ui.open` hooks). It stores the matches in `stageHubCommands`, and the hub's render only reads that atom, because a render may not write state. A command matches on its name and its plugin (the `lk-` add-on, or the older plugin of the same name).

A press on an other-mods button takes one of two paths, by the press's surface. Off the terminal (the desktop app), the stage closes the hub and runs the mod's command with `$.command.run({ command, args })`; the mod opens its own pane. On the terminal it fills an empty prompt box with the command (`$.prompt.fill`) and a toast says "Press Enter", or names the command to type when a draft is there. A run that is refused falls back to the terminal path. The terminal does not run the command because a pane opened by a queued plugin command is not one the person asked for, and on a narrow terminal it would wait undrawn.

`switchTo` toasts "ctrl+x tab to focus the panel" when the pane it opened did not get the focus. The toast shows once per session, through one atom, `stageFocusHinted`, that all six copies of `switchTo` share, and only when the press's surface is the terminal; with no press (the `/lk` path) it reads `$.session.surfaces()` and shows only when every surface is the terminal.

## Continue after approval

After a user approval that changed something, the stage submits one framed prompt with `$.prompt.submit` ([ADR 0012](adr/0012-continue-after-approval.md)). From `/lk approve` it is sent from a `$.clock.after` timer, because the host refuses a submit from inside a `command.run` hook. The stage tracks the main turn with a `turn.start` hook and a `turn.complete` hook (matcher `{}`): while a main turn runs, the prompt is kept in `stageContinuePending` and sent at that turn's end if the stage has not moved. A `turn.complete` that carries an `agentId` is a subagent's and changes nothing.

## The next-step line

`nextStep` in `hooks/lib/stageModel.ts` is one pure function from the stage machine's state (stages, current, approvals, verifiers, waiver, size, planned budget, approval mode, hold, the gates' ship-ok and ship-gate switches) to the next-step sentence. It tries seven cases in order, decided on the current stage ([loop.md](loop.md#the-next-step-after-every-answer)). Four places use it, through the stage's `nextSentence`: the notice line after an answer, the hub's hero, the Stage pane's hero and the `Next:` line of `/lk status`.

The line comes from the same `turn.complete` hook as continue after approval. After `next(e)` resolves, an answered main turn logs the line with `$.ui.log`: a notice line in the chat (dim; Claude does not read it), which the terminal and the desktop both draw. The desktop app does not draw text a `turn.complete` hook returns, so the line is not returned as the turn's text; the hook always returns `r` unchanged. It logs the line before it clears `stageTurnRunning` and submits a held continue prompt, so the line comes first. It logs nothing for a subagent's turn, an aborted turn, a refusal or an error, with the kill switch on, in a non-interactive session, with `pipeline.nextHint` off (`stageNextHint`), and while no task is in play (no size and the first stage). A failure logs nothing and leaves the answer as it was.

Interactive here is the stage's `live` check: `stageInteractive` (`session.start`'s `isInteractive`) or at least one surface in `$.session.surfaces()`. The desktop app may host Claude Code through the SDK, where `isInteractive` is false, so the surface check lets a desktop session have the line and continue after approval; a plain `-p` run has no surface and gets neither. The gates decide whether anyone can be asked the same way.

## The kit

`plugins/loopkeeper/hooks/lib/kit.ts` (kit v3, [ADR 0013](adr/0013-kit-v3-svg-and-theme-fills.md)) has no imports and takes the elements from `$.ui.resolve(e)` and the surface. v3 adds, over v2: `pill` (by default, `PILL` `'svg'`, a fully rounded Svg chip, 18 px high with 11 px bold white text; `PILL` `'fill'` keeps a theme-key fill under `inverseText` instead, the kit's only fill; the terminal draws `● text`), `header` (a section label with a right-hand count), `icon`, `typeBadge` and `progress` (Svg on surfaces that have `Svg`, text on the terminal), `nav` (the pane nav row), a `variant` on `buttons()` items, and the pure helpers `pillSvg`, `shortPath`, `extOf`, `TONE_HEX` and `CHIP_HEX`. Svg colours are fixed hexes, since Svg markup cannot read theme keys: `TONE_HEX` for icons and bars, the darker `CHIP_HEX` for pill fills under white text (each at least 4.5:1). Bands draw no Svg.

## The session start matcher

Each concern's `session.start` uses the matcher `{ isInteractive: [true, false] }`, so it runs in interactive and non-interactive sessions. Other repeated events (`prompt.context`, `turn.start`, `ui.open`) use an empty matcher `{}`; so does the stage's `turn.complete`. The six hub `ui.render` hooks share the matcher `{ component: 'Pane', requestId: 'loopkeeper-hub' }`. The engine refuses two hooks of one event with no matcher in one module, but the six `session.start` hooks, one per concern, share an identical matcher and validation accepts them. The smoke tests and the CI canary pin that behaviour ([ADR 0001](adr/0001-one-hooks-module-six-concerns.md)).

Hook order decides several things. The stage's `session.start` calls `next(e)` before it reads the saved GSD mode, so routing has loaded its stored switches by then.

## The Files seam

The gates see Bash commands that the other concerns do not. A Bash write that passes the gates is recorded into the `filesTouched` and `filesActivity` atoms, so the Files pane shows it. The Files pane is the only owner of the pane and its tree. Its tool tracking uses `tool.call` matchers written as patterns, such as `^(?:Edit|Write|MultiEdit|NotebookEdit)$`, because the typed matcher in 2.1.294 does not know some tool names. Searches run through Bash are not tracked.

## Old cross-mod calls

The five source mods called each other by name. In loopkeeper the calls are direct reads and writes of atoms with shared keys:

- change-control read `pipeline-stage`'s `planDone`, `shipOpen` and `current` from `$.state`, with a fallback for the case where pipeline-stage was missing. Gates now declare and read `stagePlanDone`, `stageShipOpen` and `stageCurrent` themselves. There is no fallback, because the stage machine is always present ([ADR 0004](adr/0004-stage-machine-always-present.md)).
- gsd-orchestrator sent `/pipeline preset gsd` and `/change-control plan required on` from a 250 ms timer. Each concern now handles `/lk on|off` itself, with no timer and no send.
- review-loop's context asked the model to call `set_stage` for a consistent plan verdict. The stage wrapper records it instead.

## Kill switch and failing closed

`CLAUDE_MODS_DISABLE` is read by the gates, the growth guard, routing and the Files pane. Each gating hook has its own `.catch`. The gates refuse a call when they fail, and the growth guard stops judging without blocking the edit; spawn routing lets the spawn through unchanged. See [ADR 0009](adr/0009-kill-switch-and-fail-closed.md).
