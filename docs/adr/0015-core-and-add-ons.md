# 0015. One marketplace: the core plus add-on plugins

- Status: accepted
- Date: 2026-10-11

## Context and Problem Statement

loopkeeper merged five mods into one plugin, the core. Seven other mods (agent-map, attention, handoff-guard, token-budget, where-am-i, pr-watch, secret-guard) lived as standalone plugins in another repository, each with its own copy of an older UI kit, while the core's hub linked to them by name. That left two homes for the set, kits drifting apart, and add-ons that no CI here checked. Each add-on must stay optional: someone who wants the gates should not have to run attention's sound player or pr-watch's `gh` polling. How should the core and the add-ons be packaged so that there is one copy of each, each can be turned on or off, and all are checked the same way?

## Considered Options

1. One merged plugin with a config toggle per add-on.
2. Separate repositories, one per add-on, each its own marketplace.
3. One repository that is also the marketplace, with every plugin in its own folder, `plugins/<name>`.

## Decision Outcome

Chosen option: 3, because it keeps one copy of each plugin and one CI over all of them, while `/plugin enable` and `/plugin disable` turn each add-on on or off with none of its hooks loaded while off.

- The repository root holds only `.claude-plugin/marketplace.json` (one entry per plugin, `source` `./plugins/<name>`, no `version`), the set's README, LICENSE, SECURITY, CONTRIBUTING and CHANGELOG, `docs/` and the CI. The core is `plugins/loopkeeper/`.
- The core gets a folder too, not the root, because of test discovery: `claude plugin test` runs every test file under the folder it starts in. With the core at the root, its run would pick up every add-on's tests as well. So the root holds no plugin and no tests, and each plugin is validated and tested from its own folder (CI runs a matrix over `plugins/*`).
- Add-ons are named `lk-<name>`. The prefix marks them as part of the set and keeps them apart from the standalone plugins of the same names while both may be installed during the switch. Only the plugin's own identity changes: the `plugin.json` name, the `plugin` literal of its state atoms and its `types/index.d.ts` key, and the hub's table. Slash commands, pane ids, band labels, config file names and store keys keep their names. The hub lists each add-on under both names, so it links to whichever is installed.
- Each add-on carries a verbatim copy of the core's kit v3 at `hooks/kit.ts`. CI fails when a copy differs.
- Each plugin folder carries a copy of LICENSE, so a plugin installed on its own still has the MIT text and the third-party notices that apply to it.
- Stored data is not carried over. A plugin's store belongs to its plugin id, so settings saved under the old names (band switches, agent-map's caps, view and config-menu value, token-budget's lifetime totals, handoff-guard's last brief and pending resume) start from their defaults under the `lk-` names. Config files keep their names and are read as before. As in [0003](0003-one-config-file-and-store-prefix.md), there is no migration. Each add-on's CHANGELOG says what starts fresh.
- The old copies, the five mods the core replaced and the seven standalone add-ons, are archived in their old repository and dropped from its marketplace listing once the set is installed in their place. Nothing is deleted.

### Consequences

- Good: one copy of each plugin, one place to install from, and one CI that validates and tests all of them on the pinned and the latest Claude Code.
- Good: each add-on works without the core; with the core on, the hub's Other mods row links to the ones that are on.
- Good: SECURITY can list each plugin's footprint separately, and a person turns off exactly what they do not want.
- Bad: eight copies of the kit to keep identical. A kit change is one change across every plugin folder; CI catches a copy left behind.
- Bad: settings saved under the old names are lost once, and people set them again.
- Bad: the root is no longer a plugin, so `--plugin-dir` and local checks name `plugins/<name>`.

### Why not the others

- Option 1 loads every add-on's hooks for everyone. A toggle inside the plugin can stop an add-on acting, but its hooks still load and its footprint (processes, model calls) stays in the one validate listing, so a person cannot tell or choose what runs. It also makes one plugin of eight unrelated concerns.
- Option 2 means eight repositories, marketplaces and CI setups. Nothing would check that the kit copies match, and the hub's links would depend on names kept in step across repositories.
