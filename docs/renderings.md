# Renderings

Text renderings of the bands, the hub and every pane, drawn by the test kit over `drawn()` with an 80-column body and laid out by `plugins/loopkeeper/tests/render.ts` at width 80. The renderer is an approximation of the host's layout; it shows the text and its order, not the paint. Colours are theme keys and do not show in plain text; the desktop app paints them in the light and dark themes.

How to read them:

- **Svg as alt text.** On the desktop (and mobile and VS Code) the kit draws icons, file-type badges and progress bars as Svg; the renderer prints each Svg as its alt text. So the desktop blocks read `clock`, `branch`, `folder` and `shield` where the terminal has `◷`, `⎇`, `▸` and `⛨`, `TS` and `MD` are type badges, and a progress bar reads as its percentage (`33%`) on its own line. The terminal draws all of these as text.
- **Pills.** On the terminal a pill is `● word` in its tone. On the desktop it is a fully rounded Svg chip (white text on the tone's `CHIP_HEX` fill), so it reads as its alt text, `word`, without the dot.
- **Buttons.** A plain Button reads as the host draws it: `2: Gates` with a hotkey, the label alone without one. Any other Button reads `[ label ]`.
- **Spacing.** A blank line is the kit's one-row gap (kit 3.1): between a pane's blocks (`page`) and between repeated cards or entries (`list`). Rows inside one block have none. The renderer leaves out the gap the host draws between the lines of a wrapped button or tile row.
- **Cut lines.** A line wider than 80 columns is cut with `…`, as the host truncates it. The host's own drawing beneath the hooks is left out.

The state behind the renderings: GSD mode on and the loop on; a large plan of 13 files, checked by a reviewer subagent and approved (budget 23), now at Execute; this turn edited `src/cache.ts` and `src/cache.test.ts`, so the gates read `2/23`; the review subject `landing-page.png` at cycle 2 of 4 with one open item; two decisions recorded this session; and the seven add-ons' commands listed (lk-agent-map, lk-token-budget, lk-handoff-guard, lk-attention, lk-where-am-i, lk-pr-watch and lk-secret-guard), so the hub shows all of them. The renderings were drawn by a scratch test in a copy of `plugins/loopkeeper`; the test is not part of the repository.

The bands are one `AbovePrompt` drawing, one line per concern. After the stage's stepper, every line follows the kit's band grammar: a bold label in the default colour, up to four `● word` chips in their tone, and a quiet right side in `inactive`. At 80 columns the stepper keeps only the current stage's label.

`/lk` opens the hub: a hero with the stage and the next-step sentence under it, then one row per panel (a digit and the panel's band words, quiet), the other mods' Buttons, and the actions. Every loopkeeper pane starts with the nav row `0 Hub 1 Stage 2 Gates 3 Files 4 Routes 5 Reviews 6 Decisions`; the current pane is bold text in the accent tone, with no hotkey, and a digit switches to the pane it names.

## Terminal

### Bands (AbovePrompt, all six concerns)

```text
stage ✓ ─ ✓ ⚑ ⇄ ─ ● Execute ─ ○ ⇄ ─ ○ ─ ○ ⚑ · in Execute <1m · budget 23
gates  ● 2/23 files  ● plan ok  ● merge gate  ● ship held              budget 23
files  ● 2 touched
routing  ● on  ● loop  recon→haiku · exec→sonnet · verify→sonnet · hard→opus · …
review  ● landing-page.png cycle 2/4  ● 1 open                         8.0 → 9.0
decisions  ● 2 this session
```

### Hub (`/lk`)

```text
╭──────────────────────────────────────────────────────────────────────────────╮
│ LOOPKEEPER                                                                   │
│ ⚑ Execute · 3 of 6                                                           │
│ preset gsd · approval auto · GSD on                                          │
╰──────────────────────────────────────────────────────────────────────────────╯
Next: Validate. Claude moves on when it starts that work, or /lk next.

PANELS
1: Stage ✓ Plan ─ ✓ Validate plan ⚑ ⇄ ─ ● Execute ─ ○ Validate ⇄ ─ ○ QA ─ ○ Shi…
2: Gates on · 2/23 files · plan ok · merge gate · ship held · budget 23
3: Files 2 touched · last: edited cache.test.ts
4: Routes GSD on · routed 0
5: Reviews 1 active of 1 subjects
6: Decisions 2 this session · watch off

OTHER MODS
m: Agents  u: Budget  h: Handoff  t: Attention  w: Where  p: PRs  s: Secrets

o: GSD off  c: Close
```

### Stage pane

```text
0: Hub  Stage  2: Gates  3: Files  4: Routes  5: Reviews  6: Decisions

╭──────────────────────────────────────────────────────────────────────────────╮
│ stage                                                                        │
│ Execute                                                                      │
│ preset gsd · auto on · build it                                              │
╰──────────────────────────────────────────────────────────────────────────────╯
Next: Validate. Claude moves on when it starts that work, or /lk next.

✓ Plan ─ ✓ Validate plan ⚑ ⇄ ─ ● Execute ─ ○ Validate ⇄ ─ ○ QA ─ ○ Ship ⚑
━━━━━━━╌╌╌╌╌╌╌╌╌╌╌╌╌ 33%                                      in Execute for <1m

┌────────────┐ ┌───────────┐ ┌──────────────┐ ┌─────────────┐ ┌────────────────┐
│ Stage      │ │ Size      │ │ Approval     │ │ Verdict     │ │ File budget    │
│ 3 of 6     │ │ large     │ │ auto         │ │ ok          │ │ 23 a turn      │
└────────────┘ └───────────┘ └──────────────┘ └─────────────┘ └────────────────┘

Gates                                                                1 of 2 open
⚑ Validate plan                                                           ● open
⇄ Validate plan verifier                     reviewer: Check the plan ● verified
⇄ Validate verifier                                                     ● needed
⚑ Ship                                                                 ● waiting

History · 5
14:30 ● moved Execute · tool · build it
14:30 ● gate open Validate plan · auto · plan validated by reviewer: Check the …
14:30 ● verified Validate plan · auto · verified by reviewer: Check the plan
14:30 ● moved Validate plan · tool
14:30 ● moved Plan · auto · session start

b: Back  n: Next  a: Approve gate  r: Reset  c: Close
```

### Gates pane

```text
0: Hub  1: Stage  Gates  3: Files  4: Routes  5: Reviews  6: Decisions

╭──────────────────────────────────────────────────────────────────────────────╮
│ ⛨ GATES                                                                      │
│   On · 2/23 files this turn                                                  │
│   the approved plan's budget: 13 planned + 10                                │
╰──────────────────────────────────────────────────────────────────────────────╯

┌────────────────────┐ ┌──────────────┐ ┌────────────────────┐ ┌───────────────┐
│ Files per turn     │ │ Plan         │ │ Ship               │ │ Merge gate    │
│ 23                 │ │ approved     │ │ held at execute    │ │ on            │
└────────────────────┘ └──────────────┘ └────────────────────┘ └───────────────┘

╭──────────────────────────────────────────────────────────────────────────────╮
│ RULES                                                                 SOURCE │
│ maxFilesPerTurn: 10                                                  default │
│ planSlack: 10                                                        default │
│ autoBudgetMax: 40                                                    default │
│ planPaths:                                                           default │
│ .claude/plans/**                                                             │
│ docs/plans/**                                                                │
│ **/*.plan.md                                                                 │
│ **/*.plan.html                                                               │
│ + scratchpad                                                                 │
│ requirePlan: on                                                      session │
│ mergeGate: on                                                        default │
│ requireGreenCi: on                                                   default │
│ blockAmend: on                                                       default │
│ blockAddAll: off                                                     default │
│ countSubagents: off                                                  default │
│ shipGate: on                                                         default │
│ Config files: none (defaults)                                                │
╰──────────────────────────────────────────────────────────────────────────────╯

╭──────────────────────────────────────────────────────────────────────────────╮
│ PROTECTED PATHS                                                            3 │
│ docs/decisions/**                                              ● ask default │
│ .env*                                                         ● deny default │
│ **/migrations/**                                               ● ask default │
╰──────────────────────────────────────────────────────────────────────────────╯

╭──────────────────────────────────────────────────────────────────────────────╮
│ THIS TURN                                                            2 FILES │
│ TS cache.ts  src                                                             │
│ TS cache.test.ts  src                                                        │
╰──────────────────────────────────────────────────────────────────────────────╯

╭──────────────────────────────────────────────────────────────────────────────╮
│ DECISIONS                                                                    │
│ none yet                                                                     │
╰──────────────────────────────────────────────────────────────────────────────╯

r: Reset turn  c: Close
```

### Files pane

```text
0: Hub  1: Stage  2: Gates  Files  4: Routes  5: Reviews  6: Decisions

╭──────────────────────────────────────────────────────────────────────────────╮
│ ◷ RIGHT NOW                                                                  │
│   Claude is idle                                                             │
│   last: edited cache.test.ts                                                 │
│ ──────────────────────────────────────────────────────────────────────────── │
│ ⎇ feature                                                          2 changed │
│ ● Claude read  ● Claude edited  ● Not committed                              │
╰──────────────────────────────────────────────────────────────────────────────╯

⌕

[ Refresh ]  [ Collapse all ]  [ Show sizes ]  [ Up a folder ]
[ Back to project ]  [ Show hidden files ]

╭──────────────────────────────────────────────────────────────────────────────╮
│ CLAUDE TOUCHED                                                       2 FILES │
│ TS cache.test.ts src                                                ● Edited │
│ TS cache.ts src                                                     ● Edited │
╰──────────────────────────────────────────────────────────────────────────────╯

ALL FILES                                                                PROJECT
▸ docs
▸ src
MD README.md                                                              11 Oct
```

### Routing pane

```text
0: Hub  1: Stage  2: Gates  3: Files  Routes  5: Reviews  6: Decisions

╭──────────────────────────────────────────────────────────────────────────────╮
│ GSD                                                                          │
│ ● Orchestrator on                                                            │
│ Plan approval: auto (/lk approval auto|ask) · band on                        │
╰──────────────────────────────────────────────────────────────────────────────╯

┌────────────────────────┐ ┌───────────────────────┐ ┌─────────────────────────┐
│ Routes                 │ │ Spawns                │ │ Approval                │
│ 5                      │ │ 0                     │ │ auto                    │
└────────────────────────┘ └───────────────────────┘ └─────────────────────────┘

Routes                                                     override explicit: no
● recon → haiku                                                          default
● execute → sonnet                                                       default
● verify → sonnet                                                        default
● hard → opus                                                            default
● default → sonnet                                                       default

Recent spawns · 0                                            routed 0 · none yet
none yet

Loop
● Loop on size → plan → validate plan → execute → verify → QA → ship gate
mode on:  stage preset gsd · gates plan required on
mode off: stage preset default · gates plan required off
Toggle mode and Toggle loop put /lk on|off or /lk loop on|off in the prompt box…

t: Toggle mode  l: Toggle loop  c: Close
```

### Review pane

```text
0: Hub  1: Stage  2: Gates  3: Files  4: Routes  Reviews  6: Decisions

╭──────────────────────────────────────────────────────────────────────────────╮
│ review loop                                                                  │
│ landing-page.png · critic                                                    │
│ cycle 2/4 · target 9.0                                                       │
╰──────────────────────────────────────────────────────────────────────────────╯

━━━━━━━━━━━━━━━━╌╌╌╌ 80% 8.0                                          target 9.0

● ① ● ② ● ③ ● ④

7.0 → 8.0                                                                     ▁▃

┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐ ┌──────────────────┐
│ Cycle           │ │ Score           │ │ Target          │ │ Verdict          │
│ 2/4             │ │ 8.0             │ │ 9.0             │ │ –                │
└─────────────────┘ └─────────────────┘ └─────────────────┘ └──────────────────┘

Items · 2                                                                 1 open
● p1 ○ raise the button contrast
● p1 ✓ tighten the hero copy                                          (no proof)

Mark shipped  Reopen  Close

defaults: target by kind · max by kind                             c: Close pane
```

### Decisions pane

```text
0: Hub  1: Stage  2: Gates  3: Files  4: Routes  5: Reviews  Decisions

╭──────────────────────────────────────────────────────────────────────────────╮
│ decisions                                                                    │
│ 2 decisions today                                                            │
│ Last: Key the cache by project path                                          │
╰──────────────────────────────────────────────────────────────────────────────╯

┌────────────────┐ ┌───────────────┐ ┌───────────────────────┐ ┌───────────────┐
│ Total          │ │ Today         │ │ Major pending         │ │ Watch         │
│ 2              │ │ 2             │ │ 0                     │ │ off           │
└────────────────┘ └───────────────┘ └───────────────────────┘ └───────────────┘

.claude/decisions.jsonl · jsonl
r: Refresh  c: Close  w: Turn watch on

Recent decisions                                                               2
● major 2026-10-11 Key the cache by project path
sessions share it
  #cache

● major 2026-10-11 Cache in SQLite
one file, no server
  #storage

Learned preferences                                                            0
None yet. The decision watch learns them from your turns.
```

## Limit question

The four options the files question offers past the budget of 23 (13 planned files plus 10). The raise is computed once, so the label and the effect match:

```text
1. Allow 1 more
2. Allow rest of turn
3. Raise to 33 for this session
4. Stop
```

## Approve button

A large plan of 13 files at Validate plan with `approval: ask` and a consistent verdict: the gate waits for the user. The band shows the button, the Stage pane shows the gate's `press a to approve` hint, and the hub shows the `a` action; both say `Waiting for you: /lk approve (or a in /lk).` under the hero. On the desktop the band and the hub read the same, and the Stage pane differs only in its progress bar (`17%`).

### Band

```text
stage ✓ ─ ● Validate plan ⚑ ⇄ ─ ○ ─ ○ ⇄ ─ ○ ─ ○ ⚑ · in Validate plan <1m
Approve plan · 13 files
gates  ● 0/10 files  ● plan needed  ● merge gate  ● ship held
routing  ● on  ● loop  recon→haiku · exec→sonnet · verify→sonnet · hard→opus · …
```

### Stage pane

```text
0: Hub  Stage  2: Gates  3: Files  4: Routes  5: Reviews  6: Decisions

╭──────────────────────────────────────────────────────────────────────────────╮
│ stage                                                                        │
│ Validate plan                                                                │
│ preset gsd · auto on · verified by reviewer: Check the plan                  │
╰──────────────────────────────────────────────────────────────────────────────╯
Waiting for you: /lk approve (or a in /lk).

✓ Plan ─ ● Validate plan ⚑ ⇄ ─ ○ Execute ─ ○ Validate ⇄ ─ ○ QA ─ ○ Ship ⚑
━━━╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ 17%                                in Validate plan for <1m

┌────────────┐ ┌───────────┐ ┌──────────────┐ ┌─────────────┐ ┌────────────────┐
│ Stage      │ │ Size      │ │ Approval     │ │ Verdict     │ │ File budget    │
│ 2 of 6     │ │ large     │ │ ask          │ │ ok          │ │ 13 planned     │
└────────────┘ └───────────┘ └──────────────┘ └─────────────┘ └────────────────┘

Gates                                                                0 of 2 open
⚑ Validate plan                                     press a to approve ● waiting
⇄ Validate plan verifier                     reviewer: Check the plan ● verified
⇄ Validate verifier                                                     ● needed
⚑ Ship                                                                 ● waiting

History · 3
14:30 ● verified Validate plan · auto · verified by reviewer: Check the plan
14:30 ● moved Validate plan · tool
14:30 ● moved Plan · auto · session start

b: Back  n: Next  a: Approve gate  r: Reset  c: Close
```

### Hub

```text
╭──────────────────────────────────────────────────────────────────────────────╮
│ LOOPKEEPER                                                                   │
│ ⚑ Validate plan · 2 of 6                                                     │
│ preset gsd · approval ask · GSD on                                           │
╰──────────────────────────────────────────────────────────────────────────────╯
Waiting for you: /lk approve (or a in /lk).

PANELS
1: Stage ✓ Plan ─ ● Validate plan ⚑ ⇄ ─ ○ Execute ─ ○ Validate ⇄ ─ ○ QA ─ ○ Shi…
2: Gates on · 0/10 files · plan needed · merge gate · ship held
3: Files 0 touched
4: Routes GSD on · routed 0
5: Reviews 0 active of 0 subjects
6: Decisions 0 this session · watch off

OTHER MODS
m: Agents  u: Budget  h: Handoff  t: Attention  w: Where  p: PRs  s: Secrets

a: Approve plan · 13 files  o: GSD off  c: Close
```

### Continue after approval

After `/lk approve` in that state, the command answers with the outcome, and a moment later loopkeeper submits one prompt framed as the plugin's message (not as the user's), so the model carries on:

```text
The user ran /lk approve. Approved the Validate plan gate; the pipeline may now move past it. File budget: 23 files a turn (13 planned + 10). Carry on with the task from where you stopped.
```

## Next-step line

A notice line in the chat after each answer (dim; Claude does not read it): `turn.complete` logs it with `$.ui.log` after an answered main turn and leaves the answer as it is. Shown in the state behind the renderings above: GSD loop, Execute, Validate next. The text is the same on every surface; the terminal and the desktop draw it dim, as a notice of its own.

### Next-step line (terminal)

```text
loopkeeper · Execute (3 of 6) · Next: Validate. Claude moves on when it starts that work, or /lk next.
```

### Next-step line (desktop)

```text
loopkeeper · Execute (3 of 6) · Next: Validate. Claude moves on when it starts that work, or /lk next.
```

The lines of a whole task, turn by turn, are in the worked example in [docs/loop.md](loop.md#worked-example-a-large-task-from-sizing-to-ship).

## Desktop

The same surfaces mounted with the desktop surface. The text matches the terminal blocks except where the kit draws Svg (icons, type badges, progress bars and pills).

### Bands (AbovePrompt, all six concerns) (desktop)

```text
stage ✓ ─ ✓ ⚑ ⇄ ─ ● Execute ─ ○ ⇄ ─ ○ ─ ○ ⚑ · in Execute <1m · budget 23
gates  ● 2/23 files  ● plan ok  ● merge gate  ● ship held              budget 23
files  ● 2 touched
routing  ● on  ● loop  recon→haiku · exec→sonnet · verify→sonnet · hard→opus · …
review  ● landing-page.png cycle 2/4  ● 1 open                         8.0 → 9.0
decisions  ● 2 this session
```

### Hub (`/lk`) (desktop)

```text
╭──────────────────────────────────────────────────────────────────────────────╮
│ LOOPKEEPER                                                                   │
│ ⚑ Execute · 3 of 6                                                           │
│ preset gsd · approval auto · GSD on                                          │
╰──────────────────────────────────────────────────────────────────────────────╯
Next: Validate. Claude moves on when it starts that work, or /lk next.

PANELS
1: Stage ✓ Plan ─ ✓ Validate plan ⚑ ⇄ ─ ● Execute ─ ○ Validate ⇄ ─ ○ QA ─ ○ Shi…
2: Gates on · 2/23 files · plan ok · merge gate · ship held · budget 23
3: Files 2 touched · last: edited cache.test.ts
4: Routes GSD on · routed 0
5: Reviews 1 active of 1 subjects
6: Decisions 2 this session · watch off

OTHER MODS
m: Agents  u: Budget  h: Handoff  t: Attention  w: Where  p: PRs  s: Secrets

o: GSD off  c: Close
```

### Stage pane (desktop)

```text
0: Hub  Stage  2: Gates  3: Files  4: Routes  5: Reviews  6: Decisions

╭──────────────────────────────────────────────────────────────────────────────╮
│ stage                                                                        │
│ Execute                                                                      │
│ preset gsd · auto on · build it                                              │
╰──────────────────────────────────────────────────────────────────────────────╯
Next: Validate. Claude moves on when it starts that work, or /lk next.

✓ Plan ─ ✓ Validate plan ⚑ ⇄ ─ ● Execute ─ ○ Validate ⇄ ─ ○ QA ─ ○ Ship ⚑
33%
                                                              in Execute for <1m

┌────────────┐ ┌───────────┐ ┌──────────────┐ ┌─────────────┐ ┌────────────────┐
│ Stage      │ │ Size      │ │ Approval     │ │ Verdict     │ │ File budget    │
│ 3 of 6     │ │ large     │ │ auto         │ │ ok          │ │ 23 a turn      │
└────────────┘ └───────────┘ └──────────────┘ └─────────────┘ └────────────────┘

Gates                                                                1 of 2 open
⚑ Validate plan                                                           ● open
⇄ Validate plan verifier                     reviewer: Check the plan ● verified
⇄ Validate verifier                                                     ● needed
⚑ Ship                                                                 ● waiting

History · 5
14:30 ● moved Execute · tool · build it
14:30 ● gate open Validate plan · auto · plan validated by reviewer: Check the …
14:30 ● verified Validate plan · auto · verified by reviewer: Check the plan
14:30 ● moved Validate plan · tool
14:30 ● moved Plan · auto · session start

b: Back  n: Next  a: Approve gate  r: Reset  c: Close
```

### Gates pane (desktop)

```text
0: Hub  1: Stage  Gates  3: Files  4: Routes  5: Reviews  6: Decisions

╭──────────────────────────────────────────────────────────────────────────────╮
│ shield GATES                                                                 │
│        On · 2/23 files this turn                                             │
│        the approved plan's budget: 13 planned + 10                           │
╰──────────────────────────────────────────────────────────────────────────────╯

┌────────────────────┐ ┌──────────────┐ ┌────────────────────┐ ┌───────────────┐
│ Files per turn     │ │ Plan         │ │ Ship               │ │ Merge gate    │
│ 23                 │ │ approved     │ │ held at execute    │ │ on            │
└────────────────────┘ └──────────────┘ └────────────────────┘ └───────────────┘

╭──────────────────────────────────────────────────────────────────────────────╮
│ RULES                                                                 SOURCE │
│ maxFilesPerTurn: 10                                                  default │
│ planSlack: 10                                                        default │
│ autoBudgetMax: 40                                                    default │
│ planPaths:                                                           default │
│ .claude/plans/**                                                             │
│ docs/plans/**                                                                │
│ **/*.plan.md                                                                 │
│ **/*.plan.html                                                               │
│ + scratchpad                                                                 │
│ requirePlan: on                                                      session │
│ mergeGate: on                                                        default │
│ requireGreenCi: on                                                   default │
│ blockAmend: on                                                       default │
│ blockAddAll: off                                                     default │
│ countSubagents: off                                                  default │
│ shipGate: on                                                         default │
│ Config files: none (defaults)                                                │
╰──────────────────────────────────────────────────────────────────────────────╯

╭──────────────────────────────────────────────────────────────────────────────╮
│ PROTECTED PATHS                                                            3 │
│ docs/decisions/**                                                ask default │
│ .env*                                                           deny default │
│ **/migrations/**                                                 ask default │
╰──────────────────────────────────────────────────────────────────────────────╯

╭──────────────────────────────────────────────────────────────────────────────╮
│ THIS TURN                                                            2 FILES │
│ TS cache.ts  src                                                             │
│ TS cache.test.ts  src                                                        │
╰──────────────────────────────────────────────────────────────────────────────╯

╭──────────────────────────────────────────────────────────────────────────────╮
│ DECISIONS                                                                    │
│ none yet                                                                     │
╰──────────────────────────────────────────────────────────────────────────────╯

r: Reset turn  c: Close
```

### Files pane (desktop)

```text
0: Hub  1: Stage  2: Gates  Files  4: Routes  5: Reviews  6: Decisions

╭──────────────────────────────────────────────────────────────────────────────╮
│ clock RIGHT NOW                                                              │
│       Claude is idle                                                         │
│       last: edited cache.test.ts                                             │
│ ──────────────────────────────────────────────────────────────────────────── │
│ branch feature                                                     2 changed │
│ ● Claude read  ● Claude edited  ● Not committed                              │
╰──────────────────────────────────────────────────────────────────────────────╯

search

[ Refresh ]  [ Collapse all ]  [ Show sizes ]  [ Up a folder ]
[ Back to project ]  [ Show hidden files ]

╭──────────────────────────────────────────────────────────────────────────────╮
│ CLAUDE TOUCHED                                                       2 FILES │
│ TS cache.test.ts src                                                  Edited │
│ TS cache.ts src                                                       Edited │
╰──────────────────────────────────────────────────────────────────────────────╯

ALL FILES                                                                PROJECT
folder docs
folder src
MD README.md                                                              11 Oct
```

### Routing pane (desktop)

```text
0: Hub  1: Stage  2: Gates  3: Files  Routes  5: Reviews  6: Decisions

╭──────────────────────────────────────────────────────────────────────────────╮
│ GSD                                                                          │
│ ● Orchestrator on                                                            │
│ Plan approval: auto (/lk approval auto|ask) · band on                        │
╰──────────────────────────────────────────────────────────────────────────────╯

┌────────────────────────┐ ┌───────────────────────┐ ┌─────────────────────────┐
│ Routes                 │ │ Spawns                │ │ Approval                │
│ 5                      │ │ 0                     │ │ auto                    │
└────────────────────────┘ └───────────────────────┘ └─────────────────────────┘

Routes                                                     override explicit: no
● recon → haiku                                                          default
● execute → sonnet                                                       default
● verify → sonnet                                                        default
● hard → opus                                                            default
● default → sonnet                                                       default

Recent spawns · 0                                            routed 0 · none yet
none yet

Loop
● Loop on size → plan → validate plan → execute → verify → QA → ship gate
mode on:  stage preset gsd · gates plan required on
mode off: stage preset default · gates plan required off
Toggle mode and Toggle loop put /lk on|off or /lk loop on|off in the prompt box…

t: Toggle mode  l: Toggle loop  c: Close
```

### Review pane (desktop)

```text
0: Hub  1: Stage  2: Gates  3: Files  4: Routes  Reviews  6: Decisions

╭──────────────────────────────────────────────────────────────────────────────╮
│ review loop                                                                  │
│ landing-page.png · critic                                                    │
│ cycle 2/4 · target 9.0                                                       │
╰──────────────────────────────────────────────────────────────────────────────╯

80%
8.0                                                                   target 9.0

● ① ● ② ● ③ ● ④

7.0 → 8.0                                                                     ▁▃

┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐ ┌──────────────────┐
│ Cycle           │ │ Score           │ │ Target          │ │ Verdict          │
│ 2/4             │ │ 8.0             │ │ 9.0             │ │ –                │
└─────────────────┘ └─────────────────┘ └─────────────────┘ └──────────────────┘

Items · 2                                                                 1 open
p1 ○ raise the button contrast
p1 ✓ tighten the hero copy                                            (no proof)

Mark shipped  Reopen  Close

defaults: target by kind · max by kind                             c: Close pane
```

### Decisions pane (desktop)

```text
0: Hub  1: Stage  2: Gates  3: Files  4: Routes  5: Reviews  Decisions

╭──────────────────────────────────────────────────────────────────────────────╮
│ decisions                                                                    │
│ 2 decisions today                                                            │
│ Last: Key the cache by project path                                          │
╰──────────────────────────────────────────────────────────────────────────────╯

┌────────────────┐ ┌───────────────┐ ┌───────────────────────┐ ┌───────────────┐
│ Total          │ │ Today         │ │ Major pending         │ │ Watch         │
│ 2              │ │ 2             │ │ 0                     │ │ off           │
└────────────────┘ └───────────────┘ └───────────────────────┘ └───────────────┘

.claude/decisions.jsonl · jsonl
r: Refresh  c: Close  w: Turn watch on

Recent decisions                                                               2
● major 2026-10-11 Key the cache by project path
sessions share it
  #cache

● major 2026-10-11 Cache in SQLite
one file, no server
  #storage

Learned preferences                                                            0
None yet. The decision watch learns them from your turns.
```
