# lk-handoff-guard

An add-on plugin of the loopkeeper set (its command stays `/handoff`). Never lose a session to the context limit. The plugin watches context fill and writes a session handoff into the project's handoff folder, `.claude/brain/` (see [The handoff folder](#the-handoff-folder)), before the limit is reached. It then clears the session and continues from that handoff.

- Below `warnAt` (70%): a quiet band, `handoff ● ctx 41%` in the ok colour.
- At `warnAt`: the chip turns to the Claude orange (the kit's accent tone, not the theme's warning colour), and one toast says "context 72%: run /handoff when you reach a stopping point".
- At `handoffAt` (85%), the chip turns red, the band's right side ("handoff due: /handoff clear") takes the default text colour instead of the quiet one, and the mode decides what happens:
  - **ask** (default): the mod asks "Context at 86%. Write the handoff and clear now?" with three options: **Handoff now**, **Later (ask at 92%)** and **Off this session**.
  - **auto**: it writes the handoff and clears without asking.
  - **off**: only the red band.
- Before compaction (`session.compact`, auto or manual): if no handoff has been written since the last clear or compaction, the mod writes one first. Compaction then goes ahead, because the mod never blocks it.
- Tool calls are never refused, with one exception: in auto mode past `denyAt` (95%), new tool calls get a reason telling Claude that the handoff is being written.

Context fill comes from `$.session.usage()` at three points:

- on `session.start`;
- after every main-loop `turn.complete`;
- before each main-loop request, in a `turn.step` generator hook.

The `turn.step` check also adds an estimate of tool output that has landed since the last response. That way a long, tool-heavy turn is caught mid-turn: the turn ends there, and the handoff runs. Subagent events (`e.agentId`) are ignored for measurement.

## Install

Needs Claude Code 2.1.294 or later. From the loopkeeper marketplace, inside a Claude Code session:

```text
/plugin marketplace add connectwithub/loopkeeper
/plugin install lk-handoff-guard@loopkeeper
```

Turn it off or on again with `/plugin disable lk-handoff-guard@loopkeeper` and
`/plugin enable lk-handoff-guard@loopkeeper`. To try it from a clone without installing it:
`claude --plugin-dir /path/to/loopkeeper/plugins/lk-handoff-guard`. Check and test it from its folder with
`claude plugin validate --strict .` and `claude plugin test .`.

## Commands

| Command | What it does |
| :- | :- |
| `/handoff` | Write the handoff now, without clearing |
| `/handoff clear` | Write the handoff, then `/clear` and resume from it |
| `/handoff status` | Context %, levels, mode, and the last handoff's time and path |
| `/handoff show` | Pane with the handoff state, the last 10 readings, the last brief, and a Write button (see [Pane](#pane)) |
| `/handoff mode ask\|auto\|off` | Set the mode |
| `/handoff at <0-1>` | Handoff level (`0.85`, `85` and `85%` all work) |
| `/handoff warn <0-1>` | Warning level |
| `/handoff band on\|off` | Show or hide the band. The band stacks other mods' band content under its own line. |

## Pane

`/handoff show` opens a pane drawn with the kit (`hooks/kit.ts`, a verbatim copy of the loopkeeper core's kit v3): bordered, unfilled cards on every surface, with `● text` badges in the terminal and fully rounded Svg pills in the Desktop app. At the top, a hero card (kicker HANDOFF GUARD) gives the handoff state in the band's words, such as "Context 72% · /handoff at a stopping point", "handoff due: /handoff clear" or "next handoff at 85%", with the tokens, the mode and the last handoff's time under it. Levels use theme colours: ok in green, warn in the accent orange, due in red (the hero, the Context tile, the bars and the level badges); the warn pill is orange in the Desktop app too. Tiles show **Context**, **Warn at** (orange), **Handoff at** (red) and **Mode**, and a bar shows the context fill. The **READINGS · n** section lists the last 10 readings, each with a level badge (ok, warn, due), its time, where it was taken and its own bar. The **LAST HANDOFF** section shows the brief's source as a badge (fork and complete in green, facts in orange), its path, any unverified figures (an orange badge), and the brief itself. The **Write handoff** (`w`) and **Close** (`c`) buttons sit at the bottom. The band above the prompt is one kit line: the bold label, the context chip in the level's colour, and the right side in the quiet colour, or in the default text colour once the handoff is due.

## Config

The layers are merged in this order, and later layers win:

1. the defaults;
2. `~/.claude/handoff-guard.json`;
3. `<cwd>/.claude/handoff-guard.json`;
4. what the `/handoff` commands saved in `$.store`.

```json
{ "warnAt": 0.70, "handoffAt": 0.85, "reaskAt": 0.92, "denyAt": 0.95,
  "mode": "ask", "model": "haiku", "maxBriefTokens": 2000, "band": true }
```

Levels are kept in order (warn ≤ handoff ≤ reask ≤ deny), and bad values are dropped.

## The handoff

1. **Facts, collected in code.** These are:
   - the working directory;
   - the git branch and the last 5 commits (`$.process.run git`);
   - files edited this turn and this session (from observing Edit, Write, MultiEdit and NotebookEdit calls, plus the transcript);
   - the last real user prompt and an excerpt of Claude's last answer (`$.session.messages()`);
   - open questions, meaning `AskUserQuestion` calls with no answer;
   - the context figures;
   - the loopkeeper core's current stage, when the core is on.

   Credential-shaped strings are redacted.
2. **Judgment sections from a cheap model.** The mod tries `$.model.fork` first, because it reuses the session's prompt cache. If that fails, it falls back to `$.model.complete` with `model` and `maxBriefTokens`, and a compact transcript. The template has six headings: Status, Next steps, Dead ends, Open questions, Decisions (pointers only), Log (one line). A reply is accepted only if it has all six headings. Otherwise only the facts are written. After that, `markUnverifiedFigures` appends `(unverified)` to any number in the model text that does not appear in the facts. It skips counts under 10, dates, times, versions and inline code.
3. **Written to the handoff folder.** The plugin writes the files directly through `$.fs`, so it needs no script, python or other tool, and anything else that reads the folder (a resume hook at session start, a sync at session end) keeps working unchanged.
   - `project.md`: rewrites only `## Status today`, `## Next` and `## Dead ends`. Dead ends is left alone when the model found none. The other sections are kept, the frontmatter `updated:` field is set to today, and a stamp records the time, context % and branch. If the file is missing, it is created from the template described under [The handoff folder](#the-handoff-folder).
   - `log.md`: one `- YYYY-MM-DD — text` line per session, under 300 characters. A second handoff in the same session replaces the session's own line while it is still the last line.
   - `decisions.md` and `questions.md`: dated lines are appended, and exact duplicates are skipped.
4. **A toast with the path.**
5. **Clear and resume (ask and auto flows, and `/handoff clear`).** A pending entry goes into `$.store`, and then `$.command.run({command:'clear'})` runs from a short `$.clock.after` timer. The timer is needed because a `command.run` hook may not run a command, and a `turn.step` hook holds the turn. On the next `classic.SessionStart` with `source=clear`, the mod deletes the entry and submits one line: "Resume from the handoff in .claude/brain/project.md (written <time>); read it first."

**Why `$.store`, not module variables (claude-auto-handoff's choice).** A hot reload of the module between the handoff and the clear would lose a module variable. `$.store` survives both a reload and the clear, and it is keyed by working directory. `$.state` holds only per-session state (readings, warned or asked flags, edited files). `/clear` resets it, which is the reset the mod wants. The entry is deleted before the prompt is submitted, so a session is never seeded twice, and entries older than 15 minutes are ignored.

## The handoff folder

The handoff lives in the project's `.claude/brain/` folder as four Markdown files, written for people and for any
tool that wants to pick a session up again:

- `project.md`: YAML frontmatter (`type`, `name`, `summary`, `tags`, `created`, `updated` and a few status fields),
  then the sections `## What it is`, `## Why`, `## Status today`, `## Next` and `## Dead ends`. The plugin rewrites
  only the last three and `updated:`; the first two are yours. A new file starts from a template whose own sections
  say "Not filled in yet".
- `log.md`: a `# Log` header, then one line per session, newest last:
  `- YYYY-MM-DD — what changed, what is next, what is blocked`, under 300 characters.
- `decisions.md`: a `# Decisions` header, then `- YYYY-MM-DD — decision and why` lines. Append only; to reverse a
  decision, add a new dated line.
- `questions.md`: a `# Questions` header, then `- YYYY-MM-DD — question` lines for questions only a person can
  answer. Remove a line once it is answered and record the answer as a decision.

After `/clear`, the resume prompt points at `project.md`.

## Footprint

What `claude plugin validate --strict .` reports for this plugin (Claude Code 2.1.294), and what that means:

| Area | What the plugin has |
| --- | --- |
| Hooks module | One: `./register.ts`, in `hooks/hooks.json`. |
| Hook events | `session.start`, `classic.SessionStart`, `prompt.submit`, `turn.start`, `turn.step`, `turn.complete`, `tool.call`, `session.compact`, `command.run` (`handoff`), `ui.render` (the band; the `handoff-guard` pane). |
| Refusals | `tool.call` refuses new tool calls only in auto mode past `denyAt` (95%); `turn.step` ends a turn to hand off. Compaction is never blocked. |
| Calls (`$.…`) | `clock` (`after`, `now`); `command` (`register`, `run`); `env.get`; `fs` (`exists`, `read`, `write`); `model` (`complete`, `fork`); `process.run`; `prompt.submit`; `session` (`cwd`, `id`, `messages`, `usage`); `state` (`get`, `set`); `store` (`delete`, `get`, `set`); `ui` (`ask`, `close`, `open`, `resolve`, `toast`). |
| State | 16 atoms under `lk-handoff-guard`; it also reads the loopkeeper core's `stageCurrent` when the core is on. |
| Store | The `/handoff` settings, the last brief and the pending resume entry, keyed by working directory. |
| Env | Reads `HOME`; writes nothing. |

What it runs:

- **Processes**: `git rev-parse --abbrev-ref HEAD` and `git log -5 --pretty=format:%h %s`, read-only.
- **Files**: reads `~/.claude/handoff-guard.json` and `<project>/.claude/handoff-guard.json`; reads and writes
  `project.md`, `log.md`, `decisions.md` and `questions.md` in `<project>/.claude/brain/`. Nothing else.
- **Model calls**: one per handoff: `$.model.fork` (which reuses the session's prompt cache), else `$.model.complete`
  with `model` (haiku) and `maxBriefTokens`. Both spend tokens on your account. If both fail, only the facts are
  written.
- **Prompts submitted**: after a handoff that cleared, one resume line (`$.prompt.submit`) in the fresh session.
- **Commands run**: `/clear`, after a handoff in the ask and auto flows and on `/handoff clear`.
- **Network**: none of its own.

## Credits

- [alexknowshtml/claude-auto-handoff](https://github.com/alexknowshtml/claude-auto-handoff) (Alex Hillman):
  - context checks on `turn.complete` and `turn.step`, with the "unmeasured" tool-output estimate;
  - ending a turn from `turn.step` by yielding a `stop` chunk;
  - extracting facts in code and leaving judgment to the model, with a facts-only fallback;
  - the heading check on the model's reply;
  - `markUnverifiedFigures`, widened from token figures to any number;
  - the meta-prompt prefixes;
  - clearing with `command.run` and seeding with `prompt.submit` on `classic.SessionStart`.

  Unlike auto-handoff, this mod lets compaction proceed and refuses tool calls only in auto mode past 95%.
- [hamzafer/claude-code-mods](https://github.com/hamzafer/claude-code-mods), session-saver (Hamza Zafar): showing a parked note on resume (here, "resumed from handoff <time>" in the band until you type), the typed-prompt test, and the resume-before-load race guard. On load, a fresh pending entry plus an empty transcript also seeds.

## Limits

- `$.ui.ask` from inside a `turn.step` hook (asking mid-turn) works in the test kit, but it has not been tried in a live session.
- The plugin does not limit the length of project.md: its body can grow past 300 words if the other sections are long.
- Decision and question lines come from the model: review them at the next session.
- `$.model.fork` answers `nothing-to-fork` before the first response, and `complete` is used instead. If both fail, only the facts are written.
- The tool-output estimate is about 4 characters per token, so a measurement taken mid-turn is approximate.
