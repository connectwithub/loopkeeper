# 0010. CI pinned with a canary

- Status: accepted
- Date: 2026-10-10

## Context and Problem Statement

The mods API is young and the plugin depends on its behaviour. CI should test against the version the plugin targets, and warn early when a newer release changes the API.

## Considered Options

1. Test only against the latest release.
2. Test only against the pinned version.
3. A required job on the pinned version and an allowed-to-fail canary on the latest.

## Decision Outcome

Chosen option: 3, because the pinned job keeps the build stable and the canary flags drift without blocking.

- With an empty `HOME` and `CLAUDE_CONFIG_DIR`, `claude plugin validate --strict .` and `claude plugin test .` pass with no login and no network.
- The `test` job installs `@anthropic-ai/claude-code@2.1.294` and is required.
- The `canary` job installs `@anthropic-ai/claude-code@latest` and has `continue-on-error: true`. It is the only unpinned install.
- No secrets and no login are used.

### Consequences

- Good: stable required checks, early notice of API drift.
- Bad: a red canary needs a human to look; it does not fail the build.
- Bad: moving the pin to a newer version is a manual change.

## Amendment: one folder per plugin

- Date: 2026-10-11

The repository became a marketplace: the core moved to `plugins/loopkeeper/` and each add-on is its own plugin in `plugins/lk-<name>/`. The root holds `.claude-plugin/marketplace.json` and no plugin. The workflow now has three jobs: `layout` checks that every marketplace source folder exists and lists every `plugins/*` folder, and that each add-on's `hooks/kit.ts` equals the core's `hooks/lib/kit.ts`; `marketplace` validates the root; `plugin` runs a matrix of every `plugins/*` folder by Claude Code version, 2.1.294 required and `latest` allowed to fail (the canary), with `fail-fast: false`. The commands run per folder:

- At the root, `claude plugin validate --strict .` checks the marketplace manifest.
- In each `plugins/<name>/` folder, `claude plugin validate --strict .` checks that plugin's manifest, hooks and types, and `claude plugin test .` runs its `tests/*.test.ts`. The test runner walks every subfolder of the folder it is given, so the root holds no tests and each plugin's suite runs from its own folder.

The pin, the canary, the empty `HOME` and `CLAUDE_CONFIG_DIR` and the no-login rule stay as above.
