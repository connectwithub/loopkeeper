# 0007. Minimum Claude Code version

- Status: accepted
- Date: 2026-10-10

## Context and Problem Statement

The plugin uses mods API behaviour that exists in Claude Code 2.1.294. `plugin.json` has no engines-like field, so the manifest cannot enforce a minimum version.

## Considered Options

1. Say nothing and let it fail on older versions.
2. A custom field in `plugin.json`, a runtime check, and a line in the README.

## Decision Outcome

Chosen option: 2, because it costs one field and one comparison.

- `plugin.json` carries `metadata.minimumClaudeCode: "2.1.294"`. It is for readers; `claude plugin validate --strict` accepts it.
- At session start the stage calls `$.session.version()`. When the base version is older than 2.1.294, the stage band says so.
- Unknown or unparseable versions and dev builds give no warning.
- The README states the minimum.

### Consequences

- Good: users on older versions see why things misbehave.
- Bad: the check is advisory; nothing stops the plugin loading on an older version.
- Bad: the field is not a standard one, so tools other than people ignore it.
