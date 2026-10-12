# lk-attention

A Claude Code plugin, an add-on of the loopkeeper set (its command stays `/attention`), that tells you when Claude needs you or has finished something long, so you can look away while it works. It is built for Linux with GNOME, and it keeps an inbox of those moments.

It raises an event when:

| Kind | When |
| :- | :- |
| `long-turn-done` | A main-loop turn ends normally after at least `longTurnMs` (20 s) |
| `permission-waiting` | A main-loop tool call is waiting for your OK: a permission dialog is shown (`classic.PermissionRequest`). With `permissionSignal: "grace"`, a `tool.check` verdict of `ask` still unanswered after `permissionGraceMs` (4 s) also counts. Raised once per tool call, cleared when the call settles or the turn ends. Subagent asks are ignored unless `includeSubagents` is on. |
| `question-waiting` | Claude opens an AskUserQuestion dialog (first draw per tool call). Cleared when you answer or the turn ends. |
| `subagent-done` | A subagent, foreground or background, finishes after running at least `subagentMs` (60 s). The title names it by its Agent call's description. |
| `failed` | A main-loop turn ends on an API error. An interrupt (Esc) is kept in the inbox as history but does not notify, because you were the one who pressed it. |

Each event goes out through three channels:

1. **Toast**: `$.ui.toast(title)`, always.
2. **Native notification**: `$.ui.notify({ title, body })` on Claude Code 2.1.295 and later; on older builds `notify-send -a "Claude Code" -i dialog-information <title> <body>`, which GNOME shows as a banner and keeps in its notification list.
3. **Sound**: your `soundFile`, else `/usr/share/sounds/freedesktop/stereo/complete.oga`, played with `paplay` and then `pw-play`. When neither file plays, the bundled `assets/ding.wav` (a 0.3 s chime) goes through `$.audio.play`, then `paplay` and `pw-play`.

While unseen events exist, a line above the prompt says what is waiting:

```
attention  ● 2 waiting                              permission (Bash), question
```

The chip is drawn in the theme's accent orange, and red when a failure is among them. The kinds sit on the right: in the default text colour while an ask waits or a turn failed, in the quiet colour otherwise. When you submit a prompt yourself, everything is marked seen. A task notification or a message from another session doesn't count as you coming back.

Needs Claude Code 2.1.294 or later. Notifications are built for Linux with GNOME (see [Linux notes](#linux-notes)).

## Install

From the loopkeeper marketplace, inside a Claude Code session:

```text
/plugin marketplace add connectwithub/loopkeeper
/plugin install lk-attention@loopkeeper
```

Turn it off or on again with `/plugin disable lk-attention@loopkeeper` and `/plugin enable lk-attention@loopkeeper`. To
try it from a clone without installing it: `claude --plugin-dir /path/to/loopkeeper/plugins/lk-attention`. Check and
test it from its folder with `claude plugin validate --strict .` and `claude plugin test .`.

Then run `/attention test` in a session to check that the banner and the sound reach you.

## Commands

| Command | What it does |
| :- | :- |
| `/attention` | Opens the inbox pane (see [Pane](#pane)), with **Mark all seen** (`m`) and **Close** (`c`) |
| `/attention text` | Prints the settings and the inbox |
| `/attention on` / `off` | Turns the whole mod on or off |
| `/attention sound on` / `off` | Turns the sound on or off |
| `/attention native on` / `off` | Turns the desktop notification on or off |
| `/attention band on` / `off` | Shows or hides the line above the prompt |
| `/attention subagents on` / `off` | Includes or ignores permission asks from subagents (default off) |
| `/attention signal dialog` / `grace` | What raises a permission wait: only a shown dialog (default), or an ask left unanswered past the grace |
| `/attention grace <ms>` | In grace mode, sets how long an ask must stay unanswered before it notifies: `4000`, `4s` |
| `/attention long <ms>` | Sets how long a turn must run before it notifies: `20000`, `20s`, `2m` |
| `/attention test` | Sends a test event through every channel, skipping the rate limit and quiet period, and reports which method worked for each |

Settings changed with these commands are kept in the mod's `$.store`, so they carry over to every session.

## Pane

`/attention` opens the inbox pane, drawn with the kit (`hooks/kit.ts`, a verbatim copy of the loopkeeper core's kit v3): bordered, unfilled cards on every surface, with `● text` badges in the terminal and fully rounded Svg pills in the Desktop app. At the top, a hero card (kicker ATTENTION) shows the newest unseen event: its title, then its kind, its age and its one-line body, colored by kind. With nothing unseen it says **Nothing waiting** in green. Below it, tiles count **Unseen** (orange, red with an unseen failure), **Asks** (permission and question waits, orange while one is unseen), **Done** (long turns and subagents, green) and, once there is one, **Failed** (red). A row shows the switches (an on/off badge in green or red, then native, sound, band and the long-turn threshold in the quiet colour). The **INBOX · n** section lists every event, newest first: a ● in the kind's colour while unseen or a quiet ○ once seen, a kind badge (asks in the accent orange, failures red, finished work green, a test in the info colour), the title (bold while unseen, quiet once seen), the body in the quiet colour, and the clock time and age on the right. The **Mark all seen** and **Close** buttons sit at the bottom. The band above the prompt is the one kit line described above.

## Configuration

Two optional JSON files, merged in this order (later wins, field by field):

1. Defaults
2. `~/.claude/attention.json`
3. `<project>/.claude/attention.json`
4. Settings you changed with `/attention`

```json
{
  "longTurnMs": 20000,
  "subagentMs": 60000,
  "sound": true,
  "native": true,
  "soundFile": "",
  "quietAfterPromptMs": 0,
  "permissionSignal": "dialog",
  "permissionGraceMs": 4000,
  "includeSubagents": false
}
```

| Field | Default | Meaning |
| :- | :- | :- |
| `longTurnMs` | `20000` | A main-loop turn at least this long notifies when it ends |
| `subagentMs` | `60000` | A subagent that ran at least this long notifies when it ends |
| `sound` | `true` | Play a sound with each notification |
| `native` | `true` | Send a desktop notification |
| `soundFile` | `""` | A file to play instead of the freedesktop sound, such as `/usr/share/sounds/freedesktop/stereo/bell.oga` |
| `permissionSignal` | `"dialog"` | `"dialog"`: only a shown permission dialog notifies. `"grace"`: an unanswered ask notifies after the grace. |
| `permissionGraceMs` | `4000` | In grace mode, how long a `tool.check` ask must stay unanswered before it notifies |
| `includeSubagents` | `false` | Also notify for permission asks from subagents |
| `quietAfterPromptMs` | `0` | For this long after you submit a prompt, events only toast: no banner, no sound. Use it if you sit and watch short turns. |

The files also accept `enabled` and `band` (booleans). Fields of the wrong type are ignored.

Native notifications and sounds are rate-limited to one per kind every 10 seconds. Toasts and the inbox are never limited.

## Auto mode and the permission signal

A `tool.check` verdict of `ask` doesn't mean you will be asked. It means "let the permission mode decide". In auto permission mode the classifier answers most asks itself, often while a long command is already running. So by default (`permissionSignal: "dialog"`) a permission wait is raised only by `classic.PermissionRequest`, which fires when a dialog is really on screen. That event has no `tool_use_id`, so it is matched to the newest call in flight with the same tool, and that call settling clears the wait. A bare `ask` raises and schedules nothing in this mode. Subagent asks are ignored unless `includeSubagents` is on, because auto mode decides them and you can't approve them.

`permissionSignal: "grace"` is the 0.1.2 behaviour, for builds where `classic.PermissionRequest` never fires. An `ask` is held for `permissionGraceMs` (4 s), and dropped if its call runs (the terminal's `ToolProgress` pill) or settles, or the turn ends or is interrupted. Only an ask still open after that notifies. Once a dialog event has fired in the session, it alone decides for the main loop. `classic.PreToolUse` can't be the "approved" signal, because it fires before `tool.check`.

## Linux notes

- `notify-send` comes with `libnotify-bin` on Ubuntu and Debian, and `libnotify` on Fedora and Arch. GNOME shows its banners and keeps them in the message tray. In Do Not Disturb mode GNOME keeps them in the tray without a banner.
- `paplay` comes with `pulseaudio-utils`, and works on PipeWire through `pipewire-pulse`. `pw-play` comes with PipeWire itself. Either one is enough.
- The freedesktop sound theme (`sound-theme-freedesktop`) supplies `complete.oga`. Without it, the bundled `assets/ding.wav` plays.
- `$.audio.play` names only the macOS player in its typings, so on Linux the mod runs `paplay` or `pw-play` itself first.
- `/attention test` prints which method worked for each channel, such as `native via notify-send; sound via paplay /usr/share/sounds/freedesktop/stereo/complete.oga`.

## Credits

- From charlie947's done-ping (no license, so these are ideas re-implemented, with no code copied): the long-turn test on `turn.complete` (main loop, not interrupted, over a threshold) and the permission test on `tool.check`, where the verdict after `next(e)` is `ask` only when a real dialog will show.
- From zycck's plan-progress (MIT): a short bundled clip through `$.audio.play({ asset })`, with a player of our own as the fallback.
- From hamzafer's review-watch (MIT): claiming an event in one `update()` callback, so a repeat (a second `tool.check`, a re-drawn dialog) can never raise it twice.
- From community mods: `paplay`/`pw-play` for Linux sound, and a map from `tool_use_id` to the loop it runs in, because `tool.check` carries no `agentId` while `tool.call` does.
- House style shared with the loopkeeper set: `$.state` atoms, config in `$.store` plus JSON files, a one-line band that keeps what other plugins draw under it, and the test layout.

## Footprint

What `claude plugin validate --strict .` reports for this plugin (Claude Code 2.1.294), and what that means:

| Area | What the plugin has |
| --- | --- |
| Hooks module | One: `./register.ts`, in `hooks/hooks.json`. |
| Hook events | `session.start`, `classic.SessionStart` (clear, resume, fork), `prompt.submit`, `agent.spawn`, `tool.call`, `tool.check`, `classic.PermissionRequest`, `turn.complete`, `command.run` (`attention`), `ui.render` (the `AskUserQuestion` dialog, `ToolProgress`, the band, the `attention` pane). |
| Refusals | None. Its gating hooks only watch and pass every event on. |
| Calls (`$.…`) | `audio.play`; `clock` (`after`, `now`); `command.register`; `env.get`; `fs` (`exists`, `read`); `process.run`; `session.cwd`; `state` (`get`, `set`); `store` (`get`, `set`); `ui` (`close`, `notify`, `open`, `resolve`, `toast`). |
| State | 6 atoms under `lk-attention`. |
| Store | The settings saved by `/attention`. |
| Env | Reads `HOME`; writes nothing. |

What it runs:

- **Processes**: `notify-send` (when `$.ui.notify` is missing) and `paplay` or `pw-play` for the sound. Linux only.
- **Files**: reads `~/.claude/attention.json` and `<project>/.claude/attention.json`; checks that the sound files
  exist; writes nothing.
- **Model calls**: none.
- **Network**: none.

## Limits

- `$.ui.notify` arrives in Claude Code 2.1.295. The validator refuses reading a mods API method as a value, so the mod detects it by calling it and falling back to `notify-send` when the call throws. The 2.1.294 test kit can't stub `ui.notify`, so only the `notify-send` path is tested.
- In grace mode, an approved call is recognised as running only from the terminal's `ToolProgress` pill. On the desktop app, an approved call that runs past the grace can still notify once, so dialog mode is the default.
- A permission wait is cleared when its tool call settles: approved and run, or refused. Between your approval and the end of a long-running tool, the inbox can still list it as waiting, though the band stops counting it once you submit a prompt or the turn ends.
- The question event is raised from a zero-delay timer, because a `ui.render` hook can't write state. It comes a moment after the dialog appears.
- Whether you are "clearly active" is judged only from your own prompts and interrupts. The mod can't see whether the terminal window has focus, so a long turn you watched to the end still notifies, unless you set `quietAfterPromptMs`.
- Subagent labels come from `agent.spawn`, or from the Agent call's description. A subagent whose spawn happened before a reload of the mod is named by the start of its id.
- The inbox lives in `$.state`: it keeps its last 50 events through a mod reload but not into a new session.
- Bash commands and questions appear in the notification body, clipped to one line. Your desktop's notification history keeps them.

## Files

```
.claude-plugin/plugin.json   manifest
hooks/hooks.json             points at register.ts
hooks/register.ts            the hooks: events, delivery, band, pane, commands
hooks/attention.ts           pure helpers: config merge, band text, argv builders
hooks/kit.ts                 the UI kit v3, a verbatim copy of the loopkeeper core's kit (don't edit here)
types/index.d.ts             Config, AttentionEvent and the $.state declarations
assets/ding.wav              0.3 s chime, 13 KB, see Assets below
tests/attention.test.ts      helper unit tests
tests/register.test.ts       event, delivery, band, pane and command tests
tests/pane.test.ts           the pane and the band on both surfaces
tests/kit.test.ts            the core's kit suite, without its render snapshots
```

## Assets

`assets/ding.wav` is a tone generated for this plugin, not a recording: 0.3 s of mono 16-bit audio at 22,050 Hz, an
880 Hz sine with a quieter sine a fifth above (1,320 Hz). It is covered by the plugin's MIT license.
