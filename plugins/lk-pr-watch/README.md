# lk-pr-watch

A loopkeeper add-on for Claude Code that shows the pull request and CI state for the current branch above the prompt, and gives Claude a one-line note when a check fails. You see a red check or a change request while you are still in the session, and Claude learns which check failed and where its run is without you copying it over.

**Use it when**

- You push from the session and wait on CI before you can merge.
- You work on something else while a PR is in review and want a toast when the review decision changes, instead of reloading GitHub.
- You follow several PRs at once: paste their URLs as a prompt and they are all watched in one pane.

**Install:** `/plugin install lk-pr-watch@loopkeeper`, after `/plugin marketplace add connectwithub/loopkeeper`; it needs `gh` signed in (more under [Requirements](#requirements) and [Install](#install)). Requires Claude Code 2.1.294 or later.

**Data handling:** it keeps one setting (the band on or off) in its own plugin store and the watched PRs in session state; it reads `~/.claude/pr-watch.json` and `<project>/.claude/pr-watch.json` and writes no file. Its only network traffic is `gh pr view` and `gh api graphql`, which reach GitHub's API through your own `gh` sign-in; it reads and stores no token. It makes no model calls; a newly failed check adds one note to the transcript. It collects no personal data; the saved setting stays until you delete it. Details under [What it runs and touches](#what-it-runs-and-touches).

**Commands:** `/pr` and its options are listed under [Commands](#commands).

lk-pr-watch adds:

- **A band above the prompt**, one kit line, only while a PR is watched:
  `PR #42  ● checks 3/5 ✓ 1 ✗ 1 …  ● changes requested  ● mergeable      +1 more`
  The PR number in bold, then three chips, each in its own theme tone: the checks (ok when all passed, warning while one runs, error when one failed, quiet with none), the review decision (ok approved, error changes requested, warning review required, quiet with none) and mergeability (ok mergeable or merged, warning behind, error conflicts or closed, quiet for a draft or unknown). The right side holds `+N more` when several PRs are watched and `refresh failed` after a failed poll; it is quiet, and drawn in the default text color when the PR needs you (a failed check, changes requested, a conflict, a closed PR, or `gh` failing). Other bands stay below it.
- **A `/pr` pane**: the branch's PR as a hero, tiles over every watched PR, and one card per PR with its state, a checks bar, the review decision, every check with a link to its run, and buttons (see [Pane](#pane)).
- **Toasts** on transitions: a check failed, all checks green, the review decision changed, the PR merged.
- **A note to Claude** when a check newly fails, through `$.session.append`: a user-role row Claude reads on its next turn, naming the check and its run URL. It never submits a prompt or starts a turn by itself.

Needs Claude Code 2.1.294 or later.

## Requirements

`gh` on the `PATH`, signed in: run `gh auth status` once. The add-on calls `gh pr view` and `gh api graphql` in the session's working directory. No token is read or stored by the add-on.

## Install

From the loopkeeper marketplace, inside a Claude Code session:

```text
/plugin marketplace add connectwithub/loopkeeper
/plugin install lk-pr-watch@loopkeeper
```

Turn it off and on again with `/plugin disable lk-pr-watch@loopkeeper` and `/plugin enable lk-pr-watch@loopkeeper`. It works with or without the loopkeeper core; with the core on, its hub links here.

To try a checkout without installing: `claude --plugin-dir /path/to/loopkeeper/plugins/lk-pr-watch`.

## How PRs get watched

- **The current branch's PR**: found with `gh pr view --json number,url,title,state,isDraft,mergeable,reviewDecision,headRefName,baseRefName` when the session starts, after `/clear`, `/resume` or `/branch`, and after any Bash call Claude makes whose command contains `gh pr create`, `git push` or `gh pr merge`. A new branch PR replaces the old one; a branch with no PR drops it.
- **A bare PR URL as a prompt**: paste `https://github.com/owner/repo/pull/7` (one or more URLs and nothing else) and it is consumed, no model turn runs, and the PR is watched. A prompt with a URL among other words goes to Claude unchanged.
- **`/pr add <url|number>`**: a number is looked up in the current repo with `gh pr view <number>`.

## Polling

One `gh api graphql` call per watched PR, in the background; no turn waits on it.

- Every `pollSec` seconds (default 120).
- Every `hotPollSec` seconds (default 30) while a check is pending inside the 20 minute hot window that a `git push` or `gh pr create` opens.

Each poll is diffed against the previous one. The first poll of a PR reports nothing, so a check that was already red when you started watching does not toast or note.

## Pane

`/pr` opens a pane drawn with the kit (`hooks/kit.ts`, a copy of the loopkeeper core's UI kit): bordered, unfilled cards on every surface, with `● text` chips in the terminal and rounded pill chips in the Desktop app. At the top, a hero card (kicker `pull requests`) names the branch's PR, else the first one watched, with its number and title, over its state, repo and whether it is this branch's or added; its border and title take the PR's level (the theme's ok, warning or error color). Tiles count over every watched PR: **Open**, **Checks passing** (passed of all checks), **Failing** checks and PRs **Awaiting review**. Under **Watched · n**, each PR gets a card: a state pill (open in the info color, merged ok, closed and draft quiet, failing in the error color when a check failed) beside its number and title, with the repo on the right; a bar of passed checks with `k/n checks` and how many are failing or running; the review decision as a pill (approved ok, changes requested error, review required warning) with mergeability and merge state in the quiet color and the age of the last poll (`polled 2m ago`) on the right; every check (latest run per name) with its icon in its tone, a link to its run, its status and duration; the PR's URL; and **Open in browser** (`xdg-open`, then `open`), **Copy URL** and **Stop watching**. **r: Refresh now** and **c: Close** sit at the bottom. Colors are theme keys, so the pane follows the light or dark theme.

## Commands

| Command | What it does |
| :- | :- |
| `/pr` | Opens the pane |
| `/pr add <url\|number>` | Watches a PR |
| `/pr rm <number\|owner/repo#n\|url>` | Stops watching it |
| `/pr refresh` | Looks for the branch's PR again and polls every watched PR now |
| `/pr band on\|off` | Shows or hides the band; saved for every project |
| `/pr text` | Prints the state as text in the transcript |

The command is registered with `immediate: true`, so it runs while Claude is working.

## Configure

`~/.claude/pr-watch.json`, then `<cwd>/.claude/pr-watch.json` (the project file wins field by field):

```json
{
  "pollSec": 120,
  "hotPollSec": 30,
  "notifyOn": ["failed", "green", "review", "merged"],
  "appendNoteOnFailure": true
}
```

- `pollSec` is held to 15 to 3600, `hotPollSec` to 10 to 3600. The timer ticks every 10 seconds, so cadences round up to the next tick.
- `notifyOn` picks which transitions toast. Unknown names are dropped; `[]` silences toasts.
- `appendNoteOnFailure: false` stops the note to Claude. It is independent of `notifyOn`.

Files are read at session start and after `/clear`, `/resume` or `/branch`.

## Files

| File | What it holds |
| :- | :- |
| `hooks/register.ts` | The hooks: session start, Bash calls, prompt submit, `/pr`, band and pane |
| `hooks/pr.ts` | Pure parts: the GraphQL query, parsers for `gh pr view` and the GraphQL response, the diff, the band's parts and text, cadence, config and command parsing |
| `hooks/kit.ts` | The UI kit the band and pane are drawn with: a verbatim copy of the loopkeeper core's `hooks/lib/kit.ts` (CI checks that the copies match) |
| `types/index.d.ts` | The `$.state` contract |
| `tests/pr.test.ts`, `tests/register.test.ts`, `tests/pane.test.ts`, `tests/kit.test.ts`, `tests/fixtures.ts` | Tests and fixture JSON; run `claude plugin test .` in this folder |

## What it runs and touches

From `claude plugin validate --strict .` and the code:

- **Processes**: `gh pr view` and `gh api graphql` (GitHub's API, through your `gh` sign-in), in the session's working directory, in the background with a timeout; `xdg-open`, then `open`, when you press **Open in browser**.
- **Files**: reads `~/.claude/pr-watch.json` and `<cwd>/.claude/pr-watch.json`; writes none.
- **Stored data**: one key, `band` (the `/pr band on|off` choice), in the plugin's store.
- **Environment**: reads `HOME`.
- **Model calls**: none. A failed check adds one user-role note to the transcript; Claude reads it on its next turn.
- **Other**: toasts, the clipboard (**Copy URL**), a 10 second timer.

## Notes for directory reviewers

The directory's validator listed these items for this plugin. Each bullet says what the code does and where.

- **Programs it runs** (policy holds `MOD_RUNS_PROCESS`, `MOD_PROCESS_COMMAND_COMPUTED`). Every program starts from one helper, `run()` in `hooks/register.ts` (line 102): `$.process.run(argv, { cwd, timeoutMs: 30000 })`, in the session's directory. The commands are:
  - `gh pr view --json number,url,title,state,isDraft,mergeable,reviewDecision,headRefName,baseRefName`, to find the current branch's PR (`discover()`), and `gh pr view <number> --json …` the same, for `/pr add <number>`;
  - `gh api graphql -f query=<QUERY> -f o=<owner> -f r=<repo> -F n=<number>`, to poll one PR (`graphqlArgv()` in `hooks/pr.ts`, line 222; `QUERY` is the fixed query at line 18 of that file);
  - `xdg-open <url>`, then `open <url>` if that fails, only when the user presses **Open in browser** (`openUrl()`). The URL is always `https://github.com/<owner>/<repo>/pull/<number>`, built by `refOf()` in `hooks/pr.ts`.

  The program names and flags are fixed text. Only the owner, repo, PR number and URL vary; they come from `gh`'s own answer or from a GitHub PR URL the user pasted.
- **Network use.** The plugin has no network code of its own. It reaches GitHub only through the user's installed `gh`, signed in with the user's own `gh auth login`; it never reads, stores or passes on that sign-in. By default it polls every 120 seconds (`pollSec`), and every 30 seconds (`hotPollSec`) while a check is pending in the 20 minutes after a `git push` or `gh pr create` (see [Polling](#polling)).
- **Local data and the conversation** (policy holds `MOD_LOCAL_DATA_LEAVES`, `MOD_SESSION_DATA_LEAVES`). What reaches GitHub is the owner, repo and PR number, with the fixed query. The files it reads are its own config, `~/.claude/pr-watch.json` and `<cwd>/.claude/pr-watch.json` (poll intervals, which changes to announce, whether to add the failure note); nothing from them goes into a command. The `prompt.submit` hook (line 423) checks only whether a prompt is nothing but GitHub PR URLs (`bareUrls()` in `hooks/pr.ts`, line 84). If it is, the plugin watches those PRs and answers `{ drop: 'pr-watch: watching …' }`, so that prompt does not go to the model; every other prompt is passed on unchanged with `next(e)`. When a watched check fails, `announce()` (line 213) appends one user-role message to the transcript, `[pr-watch: automated notice, not typed by the user] Check "<name>" failed on PR #<number> (<owner>/<repo>): <link>`, built from GitHub's answer; `appendNoteOnFailure: false` turns it off.
- **Fields in `plugin.json`** (warnings `UNKNOWN_KEY`). `documentationUrl` and `supportUrl` are listing fields the directory reads. `types` points at `types/index.d.ts`, the `$.state` contract that `claude plugin validate` checks. Claude Code ignores all three at load time.
- **Icon** (warning `ICON_MISSING`). Added at `.claude-plugin/icon.png` (512 × 512); its source is `docs/assets/icons/lk-pr-watch.svg` in the repo.
- **Calls named in text** (note `MOD_CALL_NAMED_IN_TEXT`). `tool.call`, `prompt.submit` and `command.run` are named in the header comment of `hooks/register.ts` (lines 6–9), which lists the hooks. The `tool.call` hook (line 406) watches `Bash` calls: it returns what `next(e)` gave back, unchanged, and after a call that was not refused and that ran `gh pr create`, `gh pr merge` or `git push`, it looks up the branch's PR again.
- **Its command** (note `MOD_REGISTERS_SURFACES`). It registers one slash command, `/pr`, at session start (line 383). It registers no tools or agents.
- **Classic hook** (note `MOD_HOOKS_POLICY_EVENT`). `classic.SessionStart` with source `clear`, `resume` or `fork` (line 396) loads the config and the band setting again, because those resets clear `$.state`, and looks up the branch's PR. It returns `next(e)` unchanged and alters nothing that passes through it.
- **Hooks on events that are also calls** (note `MOD_HOOKS_OPERATION`). `prompt.submit` (line 423) is described above. `command.run` (line 445) has the matcher `{ command: 'pr' }`, so it runs only for `/pr`. Neither makes the call it hooks.

## Borrowed from

[cc-pr-tracker](https://github.com/sezaakgun/cc-pr-tracker) by Seza Akgün, MIT licence, Copyright (c) 2026 Seza Akgün:

- the single `gh api graphql` query per PR (merge state, review decision, the head commit's check rollup), here with `completedAt` added and `isRequired` left out
- `toCheck`'s buckets, the lineage key and `latestPerName` (latest run per check name), `clean()` and `linkable()`
- diffing each poll against the previous one, the bare-URL prompt answered with `{ drop }`, the `$.session.append` note, and the `attempt()` wrapper for calls newer than a build

The MIT notice applies to those parts. The rest is written for this add-on.

## Limits

- Counts every check, required or not: the query does not ask for `isRequired`, so an optional failing check turns the checks chip to the error color.
- Checks beyond the first 100 contexts on the head commit are not seen.
- One GraphQL call per PR per poll counts against your GitHub API rate limit; with many PRs watched, raise `pollSec`.
- The watch list lives in `$.state`: it survives a hot reload but not a new session, and `/clear` starts it again from the branch's PR.
- Discovery after Bash matches on the command text, so `git push` inside a script file Claude runs is not seen. Use `/pr refresh`.
- The pane shows durations of running checks against the local clock. The branch name is not kept, so the hero says "this branch" rather than naming it.
- `gh pr view` for the branch needs the branch pushed with an upstream; a fork's PR may need `gh pr view` to resolve the head repo.
