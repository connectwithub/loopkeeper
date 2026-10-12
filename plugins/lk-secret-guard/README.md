# lk-secret-guard

A loopkeeper add-on for Claude Code: a seatbelt that stops credential-shaped strings, and a private deny-list of words, from being written into files or shell commands, by Claude or by any subagent.

Needs Claude Code 2.1.294 or later.

## What it does

Before a `Write`, `Edit`, `MultiEdit`, `NotebookEdit` or `Bash` call runs, the guard scans **only the new text** the call would write:

| Tool | Text scanned |
| :- | :- |
| `Write` | `content` |
| `Edit` | `new_string` (never `old_string`, so removing a secret is always allowed) |
| `MultiEdit` | each edit's `new_string` |
| `NotebookEdit` | `new_source` |
| `Bash` | the whole command, which covers heredocs and `echo … >> file` |

Each finding has a confidence:

- **block**: the call is refused, and Claude reads why (`secret-guard: AWS access key detected in src/x.ts (AKIA…456). Secrets must not be written here. …`).
- **warn**: you are asked `Allow once` or `Block`. If the session is non-interactive (`claude -p`, the SDK), there is no one to ask, so a warn is **allowed with a toast** and logged as `allowed`. If you dismiss the question in an interactive session, the call is refused.

Built-in patterns (the id in brackets is what `disabledKinds` takes):

| Kind | Action |
| :- | :- |
| AWS access key `AKIA…` [`aws-access-key`] | block |
| Anthropic key `sk-ant-…` [`anthropic-key`] | block |
| OpenAI key `sk-…`, `sk-proj-…` [`openai-key`] | block |
| GitHub token `ghp_/gho_/ghu_/ghs_/ghr_…`, `github_pat_…` [`github-token`] | block |
| Slack token `xoxb-/xoxa-/xoxp-/xoxr-/xoxs-…` [`slack-token`] | block |
| Google API key `AIza…` [`google-api-key`] | block |
| Stripe live key `sk_live_…`, `rk_live_…` [`stripe-key`] | block |
| Private key block `-----BEGIN … PRIVATE KEY-----` [`private-key`] | block |
| Twilio key `SK` + 32 hex [`twilio-key`] | warn |
| JWT `eyJ….eyJ….…` [`jwt`] | warn |
| `password/passwd/secret/api_key/token = <8+ chars>` [`generic-secret`] | warn |

The generic rule ignores obvious placeholders: values containing `xxx`, `your_`, `<`, `${`, `example`, `changeme`, `placeholder`, `redacted`, `process.env`, `os.environ` or `getenv`, and values made of one repeated character.

Values are always shown masked: the first 4 and last 3 characters (`AKIA…456`). Shorter values reveal less (`ab…z`, `a…`). The raw value is never stored or printed.

## Install

From the loopkeeper marketplace, inside a Claude Code session:

```text
/plugin marketplace add connectwithub/loopkeeper
/plugin install lk-secret-guard@loopkeeper
```

Turn it off and on again with `/plugin disable lk-secret-guard@loopkeeper` and `/plugin enable lk-secret-guard@loopkeeper`; `/secret-guard off` pauses it for one session only. It works with or without the loopkeeper core; with the core on, its hub links here.

To try a checkout without installing: `claude --plugin-dir /path/to/loopkeeper/plugins/lk-secret-guard`.

## Config file

The guard never creates a config file. Without one, only the built-in patterns run. To add your own words, create either or both of:

1. `~/.claude/secret-guard.json` (global)
2. `<project>/.claude/secret-guard.json` (project)

They are merged in that order. A later file **replaces** `publicPaths`, `allowPaths` and `disabledKinds` when it sets them. `deny` and `warn` are **unioned**, so a project file can add words but never silently drops the private words in your global file.

```json
{
  "deny": ["Project Placeholder", "CLIENT_NAME_HERE"],
  "warn": ["internal-codename"],
  "publicPaths": ["public/", "README", "docs/", "site/"],
  "allowPaths": [".env", ".env.*", "**/*.secret", "node_modules/**", "~/.claude/**", "tests/fixtures/**"],
  "disabledKinds": ["jwt"]
}
```

- **deny / warn**: words or phrases, matched case-insensitively as whole words (`Placeholder` does not match `Placeholders`; spaces in a phrase match any run of whitespace). Deny blocks; warn asks.
- **publicPaths**: when set, the word lists apply only to writes whose path matches one of these, and to Bash commands that mention one. When absent, the word lists apply everywhere. Credential patterns always apply everywhere.
- **allowPaths**: files exempt from **all** checks, credential patterns included. `.env` files are where secrets legitimately live.
- **disabledKinds**: pattern ids to turn off.

Path entries are kept simple. An entry with `*` or `?` is a glob (`**` crosses folders; without a `/` it is matched against the file name). Any other entry matches, case-insensitively, wherever a path segment starts with it: `README` matches `docs/README.md`, `public/` matches `site/public/index.html`, `.env` matches `.env.local`. `~/` stands for your home directory.

A file that is not valid JSON is ignored, with a toast and a line in the error color in the pane. The message never quotes the file.

## Commands

| Command | What it does |
| :- | :- |
| `/secret-guard` | Opens the **Secret guard** pane (see [Pane](#pane)): the last block, blocked and allowed counts, on/off, the last 20 decisions (masked), the rules (never the words), the config files found, and a Close button |
| `/secret-guard off` / `on` | Turns the guard off or on for this session only. While off, an urgent band sits above the prompt. |
| `/secret-guard reload` | Re-reads both config files |
| `/secret-guard test <text>` | Runs the matcher on the text and prints what would be blocked or asked, masked. The word lists are applied as if the path were public. |
| `/secret-guard band on\|off` | Shows or hides the one-line band above the prompt. Saved across sessions. |

The band is one kit line that appears only after the first block or warning in a session: `secret-guard  ● 2 blocked  ● 1 allowed`, the label in bold, the blocked count in the error color and the allowed count in the ok color once they are nonzero (quiet at zero). While the guard is off it reads `secret-guard  ● off for this session      /secret-guard on to resume`: the chip in the error color and the hint in the default text color, whatever the band setting.

## Pane

`/secret-guard` draws one pane with the kit (`hooks/kit.ts`, a copy of the loopkeeper core's UI kit): bordered, unfilled cards on every surface, with `● text` chips in the terminal and rounded pill chips in the Desktop app. Colors are theme keys, so it follows the light or dark theme. At the top a card (kicker `secret guard`) with the last block (`Blocked AWS access key in src/x.ts`, then the time, the masked value and the agent, if any), or `Nothing blocked yet`. Then three tiles: **Blocked**, **Allowed** and **Rules** (the rules in force), and the on/off status with the band setting. Then sections with counts: **Recent** (the last 20 decisions, newest first: time, an outcome pill `blocked` (error), `allowed` (ok) or `asked → allowed` (warning), the kind, and where with the masked value), **Rules** (each built-in kind with a `built-in` pill and block, warn or off; the deny and warn lists as counts with a `config` pill, never the words), and **Config** (the files loaded, any ignored file, the allowPaths count and where the word lists apply). Button: **c** Close.

## Limits

- **Pattern-based.** It catches credential *shapes*, not every secret. A password with no `password=` around it, a key split across two writes, or a value that is base64-encoded or built at run time in a Bash command (`echo $VAR`, `printf '%s' …`) is not seen.
- **Bash is never path-exempt.** `allowPaths` exempts files written by the file tools. A `Bash` command that writes a key into `.env` is still blocked; write it with the Write tool instead, or turn the guard off for the session.
- **False positives.** The generic rule can flag test fixtures, sample configs and type annotations such as `token: SomeLongTypeName`; `sk-` followed by 20 letters (for example a CSS class or slug) looks like an OpenAI key; the JWT rule flags any real-looking JWT, including harmless test tokens; plain path entries like `README` match any segment that starts with them. Use `allowPaths`, `disabledKinds`, or **Allow once**.
- **Fail closed.** If the guard itself crashes or times out on a call, the call is refused with `secret-guard failed (…)`. Run `/secret-guard off` if the guard is broken.
- **Order.** Settings `PreToolUse` hooks from managed settings run before every plugin's hooks module; other `PreToolUse` hooks run after the guard lets a call through. Another plugin loaded ahead of this one can answer a call before the guard sees it.
- **State.** The log, counts and on/off switch live in `$.state` and last for the session; `/clear`, `/resume` and `/branch` reset them. Only the band setting is saved in the plugin's store.
- It does not inspect what tools *read*, what MCP tools send, or what Claude says in chat.

## Files

| File | What it holds |
| :- | :- |
| `hooks/register.ts` | The hooks: session start, the guarded tool calls, `/secret-guard`, band and pane |
| `hooks/patterns.ts` | Pure parts: the pattern table, matching, masking, config merging, the messages and the band's parts |
| `hooks/pane.ts` | The pane's view model: outcomes, rule rows, counts |
| `hooks/kit.ts` | The UI kit the band and pane are drawn with: a verbatim copy of the loopkeeper core's `hooks/lib/kit.ts` (CI checks that the copies match) |
| `types/index.d.ts` | The `$.state` contract |
| `tests/*.test.ts`, `tests/world.ts` | Tests and shared stubs; every fake credential is assembled at run time. Run `claude plugin test .` in this folder |

## What it runs and touches

From `claude plugin validate --strict .` and the code:

- **Processes**: none. **Network**: none. **Model calls**: none.
- **Files**: reads `~/.claude/secret-guard.json` and `<project>/.claude/secret-guard.json`; writes none.
- **Stored data**: one key, `band` (the `/secret-guard band on|off` choice), in the plugin's store. The log and counts stay in session state, masked.
- **Environment**: reads `HOME`.
- **Other**: a question (`Allow once` / `Block`) on a warn, toasts, the pane.
