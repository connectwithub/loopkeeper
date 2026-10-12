# Contributing

The plugins have no build step and no `package.json`. The hooks are TypeScript that Claude Code loads directly.

## Requirements

- Claude Code 2.1.294 or later.

## Layout

The repository is a marketplace. Each plugin has its own folder under `plugins/`: the core is `plugins/loopkeeper/`, and each add-on is `plugins/lk-<name>/`. The root holds `.claude-plugin/marketplace.json`, the set's README, LICENSE, SECURITY, CONTRIBUTING and CHANGELOG, the shared `docs/` and the CI. It holds no plugin and no tests.

Every plugin folder has the same shape: `.claude-plugin/plugin.json`, `hooks/` (with `hooks.json` pointing at one `register.ts`), `tests/`, `types/index.d.ts` (its state contract), and its own README, CHANGELOG and LICENSE.

In the core:

- `plugins/loopkeeper/hooks/register.ts` is the one hooks module. It calls six wiring functions, one per concern file (stage, gates, files, routing, review, decisions). The call order is the band order.
- `plugins/loopkeeper/hooks/lib/` holds pure helpers. They never see `$`.
- Concerns share state through atoms declared with the same literal `{plugin, key}` in each file.
- `plugins/loopkeeper/tests/world.ts` is the core's shared test world.
- `docs/adr/` holds the decision records.

A new plugin gets a folder under `plugins/` and an entry in `.claude-plugin/marketplace.json` whose `source` is `./plugins/<name>` (no `version` field). An add-on's name starts with `lk-`.

## Check your change

Validate the marketplace from the repository root:

```
claude plugin validate --strict .
```

Then validate and test each plugin you changed from its own folder. `claude plugin test` runs every `tests/*.test.ts` under the folder it starts in, so run it in the plugin's folder, not at the root:

```
cd plugins/loopkeeper        # or plugins/lk-<name>
claude plugin validate --strict .
claude plugin test .
```

`validate --strict` must pass with no warnings, and the suite must be green. CI runs the same commands for every folder under `plugins/`.

To try a plugin in a real session:

```
claude --plugin-dir /path/to/loopkeeper/plugins/<name>
```

## The UI kit

Every plugin draws its band and panes with one UI kit, kit v3. The core's `plugins/loopkeeper/hooks/lib/kit.ts` is the original. Each add-on carries a verbatim copy at `plugins/lk-<name>/hooks/kit.ts`, and its `tests/kit.test.ts` is the core's kit suite with the import path changed and the render snapshots left out. CI fails when a copy differs from the core's file.

To change the kit:

1. Edit `plugins/loopkeeper/hooks/lib/kit.ts` and its tests in `plugins/loopkeeper/tests/kit.test.ts`.
2. Copy the file to every add-on:

   ```
   for d in plugins/lk-*/; do cp plugins/loopkeeper/hooks/lib/kit.ts "$d/hooks/kit.ts"; done
   ```

3. Carry the same test changes into every add-on's `tests/kit.test.ts`, leaving out tests that need the core's text renderer.
4. Validate and test every plugin, not only the core: a kit change can move a pinned drawing in any add-on.

Never edit an add-on's `hooks/kit.ts` on its own.

## Rules

- UI goes through kit v3: colours are theme keys through the kit's tones; no `dimColor`; no `backgroundColor` except the kit's pill fill; never `yellow`, `gray`, `grey`, `white`, `black` or `subtle` as a colour.
- Svg only through the kit, with hex colours inside the markup, and never in a band.
- A band hook (`ui.render` on `AbovePrompt`) always calls `next(e)` and stacks its own line above what `next` returns, so the bands of other plugins stay.
- In one hooks module, two hooks of one event with no matcher are refused: `session.start` uses `{ isInteractive: [true, false] }`, other repeated events the empty matcher `{}`.
- `$` and atom objects never cross imports; pass `on` into functions in other files. Declare every atom in `types/index.d.ts`.
- In the core, never register `loop` or `review` as a command or match a `command.run` hook on them. They are built-ins.
- In the core, every gating hook gets a `.catch`, so the gates fail closed.
- A slow test passes `{ timeoutMs: 20_000 }`. The runner has no global timeout flag.
- A forced change, meaning one the engine or the host makes you do, gets an ADR in `docs/adr/`. Use the MADR format of the existing records and add a line to `docs/adr/README.md`.

## Public strings

Everything in this repository is public: code, comments, tests and docs. In all of them:

- No personal names.
- No paths from your own machine. Write `/path/to/…` in docs; tests use `/home/tester` as the home folder.
- No figures from your own sessions, such as costs, token counts or test totals. Examples in a README use clearly illustrative figures and say so.

The only exception is an upstream MIT notice, which names its author: the third-party notices in a LICENSE file, a source-file header that carries the MIT notice, and a README's Credits or "Borrowed from" section.

A quick check before a pull request, from the root:

```
git grep -nE '/(home|Users)/' -- . | grep -v '/home/tester'
```

## Pull requests

1. Fork the repository and branch from `main`.
2. Make the change, with tests, and run the checks above for every plugin it touches.
3. Add a line to that plugin's CHANGELOG.
4. Open a pull request that says what changed and why, and link the ADR if there is one.
5. CI must pass. The jobs on the latest Claude Code may fail; they flag drift in the latest release and do not block a merge.
