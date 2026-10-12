# 0014. The hub and keys

- Status: accepted, amended (see the end)
- Date: 2026-10-11

## Context and Problem Statement

Each concern opened its own pane from its own command: `/lk` (the Stage pane), `/lk gates`, `/files`, `/lk routes`, `/reviews`, `/decisions`. Nothing linked one pane to another, and nothing linked loopkeeper to the other mods. The request: one central panel that opens the others, links between all of them, and keyboard shortcuts.

What Claude Code 2.1.294 allows:

- A Button `hotkey` is one digit or one lowercase letter. It presses the Button while the plugin's site holds the focus: its pane (opened with `focus`, or clicked) or its band (after ctrl+x tab or a click). It never fires from the composer, except that a bare digit in an empty composer presses a band Button.
- A Button `action` binds the chord of an existing engine keybinding action, on the terminal only. A plugin cannot define a global chord of its own.
- A focus request is a request, not a grant. It is refused while the person holds a band or pane element, has text in the composer, or has a dialog or a survey up; the pane then opens without the keyboard.
- `$.command.list()` lists the session's slash commands with the plugin that registered each.

## Considered Options

1. One large pane that holds every panel's content.
2. Tabs only: a nav row on every pane, no hub.
3. A hub pane, a nav row on every pane, and links in each band line's label.

## Decision Outcome

Chosen option: 3 without the band links, because a hub gives one place to start and see status, and the nav row makes every pane one key from every other. The band links were dropped: the band lines stay exactly as they read, and the hub and the nav row already link every pane. One large pane would mix six concerns' controls and hotkeys in one place.

- `/lk` alone (and `/loopkeeper`) opens the hub: requestId `loopkeeper-hub`, title `loopkeeper`, 16 rows high. `/lk stage` opens the Stage pane. `/lk help` prints the keys. Both words are read before a stage id ([ADR 0002](0002-command-names.md)).
- The hub is a `ui.render` chain, like the band. Each concern registers a `Pane` hook for `loopkeeper-hub` and stacks its row above what `next(e)` returns. The stage is wired first, so its hook is outermost and draws the frame: a hero (flag icon, eyebrow `LOOPKEEPER`, title `<stage> · <n> of <m>`, sub `preset <p> · approval <a> · GSD on|off`), the `Panels` header, the Stage row, the later concerns' rows, then `Other mods` and the actions.
- Panel rows, in wiring order: `1 Stage`, `2 Gates`, `3 Files`, `4 Routes`, `5 Reviews`, `6 Decisions`. Each is a plain Button with its digit hotkey, followed by the concern's status in `inactive`, in the words of its band line. Every row hook wraps its work in try/catch, falls back to `next(e)`, and handles a null `next(e)`. The rows show with the band off or the kill switch on; the hero's sub carries the disabled note.
- Other mods: `m` Agents (`/agent-map cards`), `u` Budget (`/budget`), `h` Handoff (`/handoff`), `t` Attention (`/attention`), `w` Where (`/where`), `p` PRs (`/pr`). A Button appears only for a command `$.command.list()` reports, matched on name and plugin (`name@marketplace` counts). The list is read when the hub opens (in the `/lk` handler, a `ui.open` hook and a `ui.press` hook on a nav row's Hub item) into the atom `stageHubCommands`; the render only reads it, since state writes are refused during a render.
- An other-mods press with an empty composer closes the hub, fills the prompt with the command and toasts "Press Enter to open <name>". With a draft in the composer, the draft is kept and the toast says "Type <command> to open <name>".
- Actions: `a` Approve, shown only while a gate or a budget waits. It takes the band button's path, so a changed approval continues the task ([ADR 0012](0012-continue-after-approval.md)). `o` fills the prompt with `/lk on` or `/lk off`, as the routing pane's Toggle mode does ([ADR 0004](0004-stage-machine-always-present.md)). `c` closes the hub.
- The nav row: every loopkeeper pane (Stage, Gates, Files, Routes, Reviews, Decisions) starts with `0 Hub  1 Stage  2 Gates  3 Files  4 Routes  5 Reviews  6 Decisions`, drawn by the kit's `nav(items, currentKey)` ([ADR 0013](0013-kit-v3-svg-and-theme-fills.md)). The current item is bold Text in the accent tone and cannot be pressed, because a Button has no bold or colour prop and `plain` overrides `variant`. The others are plain Buttons with digit hotkeys. Digits never clash with the panes' letter hotkeys.
- The focus model: a row or nav press switches panes. It closes the current pane first, because a focus request is refused while the person holds a pane, then opens the next with `focus: true` and `closeOnEscape: true`. It then reads `$.ui.panes()`. If the new pane did not get the focus (the composer held a draft), a toast says "ctrl+x tab to focus the panel". The Files pane's name filter takes every key while it has the focus, so there digits switch panes only once the focus leaves it.
- No global chord: `action` only borrows an engine action's chord, on the terminal, and no plugin-defined global shortcut exists in 2.1.294. `/lk` is the way in; inside panes, the hotkeys. No band Button has a digit hotkey, since a bare digit in an empty composer would press it.
- Other mods are opened by filling the prompt, not by running their command. The person stays one Enter from the command, a draft they are typing is kept, and loopkeeper starts nothing in another plugin on its own. The routing pane's Toggle buttons already work this way.
- `$` and atom objects never cross imports, so each concern file keeps its own copy of the pane table (`PANES`), `switchTo` and `navItems`. The stage's copy is the original.

### Consequences

- Good: one command reaches every pane, and every pane reaches every other with one digit.
- Good: the other installed mods are one key and one Enter away; mods that are not installed are not shown.
- Good: the band lines are unchanged.
- Bad: no key opens the hub from the prompt; `/lk` must be typed.
- Bad: `/lk` no longer opens the Stage pane directly; it is `/lk stage` or `1` in the hub.
- Bad: six copies of the pane table. Adding a pane means editing each one; `plugins/loopkeeper/tests/hub.test.ts` checks the six rows in order.
- Bad: a draft in the composer keeps the focus, so the user needs ctrl+x tab after a switch.

## Amendment: mods open directly on the desktop

- Date: 2026-10-11

On the desktop app the other-mods buttons did not open the mod: they only said which command to type, and the "ctrl+x tab to focus the panel" toast showed on every switch, where the chord means nothing. What 2.1.294 allows: a pane opened by the hook of a Button the person pressed is one the person asked for, and `$.command.run({ command, args })` from that press is allowed (it runs once the session is idle).

- On the desktop (the press's surface is not the terminal), an other-mods press closes the hub and runs the mod's command with `$.command.run`; the mod opens its own pane, and no toast shows. If the run is refused, the press falls back to the terminal's path.
- On the terminal the press fills an empty composer with the command and toasts "Press Enter to open <name>", or keeps a draft and toasts "Type <command> to open <name>", as before. The terminal does not run the command: a pane that a queued plugin command opens is not one the person asked for, and on a narrow terminal it would wait undrawn.
- The add-ons are now plugins of this repository, named `lk-<name>`. A command matches on its name and on the `lk-` plugin or the older plugin of the same name. `s` Secrets (`/secret-guard`, lk-secret-guard) joins the six: `m` Agents, `u` Budget, `h` Handoff, `t` Attention, `w` Where, `p` PRs.
- The focus hint shows at most once per session, through one atom, `stageFocusHinted`, shared by the six copies of `switchTo`, and only when the press's surface is the terminal. With no press (the `/lk` path) it shows only when `$.session.surfaces()` lists nothing but the terminal.
- The hub's hero carries the next-step sentence under its title, the same sentence as the notice line in the chat after each answer ([loop.md](../loop.md#the-next-step-after-every-answer)).

This replaces the decision that other mods open only by filling the prompt. loopkeeper still starts another plugin's command only from the person's own press.

### Consequences of the amendment

- Good: on the desktop an add-on is one press away, with no Enter.
- Good: no toast about a chord the desktop does not use; on the terminal the hint shows once.
- Bad: the two surfaces behave differently for the same press, so the tests cover both paths.
