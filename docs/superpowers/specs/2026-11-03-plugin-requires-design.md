# Plugin requirements: a plugin can need other plugins

## Goal

A plugin's `mc-plugin.json` can say it needs other plugins. When you install or update it, Shikidan shows one dialog listing everything that will be installed, updated or turned on, gets one consent, and installs the needed plugins first. If any part fails, plugins installed fresh in that request are removed again. Removing or turning off a plugin that another installed plugin needs asks first.

First user: `fixstack` needs `clickup-board` 1.7.0 or newer.

## Manifest

```json
"requires": [{ "id": "clickup-board", "version": "1.7.0" }]
```

- `id`: required, must match `PLUGIN_ID_PATTERN`.
- `version`: optional minimum version, matching `/^\d+(\.\d+){0,2}$/`.
- `parseManifest` rejects these, one error each:
  - a bad id;
  - a bad version;
  - the plugin requiring itself;
  - the same id listed twice;
  - more than 10 entries.
- Add `requires?: PluginRequirement[]` to `PluginManifest` and to `InstalledPlugin`. `recordOf` copies it when present, so uninstall can find dependents.
- `requires` works with pluginApi 1 and 2. Older Shikidan builds drop unknown keys, so old builds ignore it. That is acceptable.

## Version compare

New `server/plugins/requirements.ts`.

`compareVersions(a, b)`:
- Compare numeric dotted parts; a missing part counts as 0.
- Cut anything from the first character that is not a digit or a dot. So `1.7.0-beta` compares as `1.7.0`.
- `1.10.0` is greater than `1.9.0`.

`satisfies(version, min?)`: true when `min` is undefined, or when version ≥ min.

## Resolution

`resolveRequirements(manifest, origin)` returns `RequirementStep[]`. `origin` is the parent's marketplace, if it has one.

A step is one of:
- `{ id, minVersion?, status: 'ok', installedVersion }`
- `{ id, minVersion?, status: 'enable', installedVersion, name }`: installed, version fine, turned off.
- `{ id, minVersion?, status: 'install' | 'update', installedVersion?, listing: { repo, ref, marketplace }, preview: { manifest: { id, name, version }, commit, permissions, runtime, contributes? } }`
- `{ id, minVersion?, status: 'unavailable', reason }`

Rules:
- **Installed, version fine, enabled:** `ok`.
- **Installed, version fine, turned off:** `enable`.
- **Installed but too old:** `update`. Look up the listing in `installed.source.marketplace` if it has one, otherwise as for "not installed". If the listing repo differs from `installed.source.repo`, the step is `unavailable` with reason "The marketplace copy of <id> comes from a different repo".
- **Not installed:** find the listing.
  - If origin has a marketplace, search only that marketplace.
  - Otherwise search all marketplaces in `catalog()` order and take the first match by id.
  - No match: `unavailable`, reason "<id> is not in your marketplaces. Add the marketplace that has it, or install it first."
- **For install and update steps, preview the listing** with the existing clone + manifest code at the listing ref:
  - If the preview's manifest id ≠ the required id: `unavailable`.
  - If its version doesn't satisfy min: `unavailable`, reason "The marketplace has <id> v<x>; this needs v<min> or newer".
  - If the clone or manifest fails: `unavailable`, with that error.
- **Transitive:** resolve the `requires` of each install or update preview's manifest too.
  - Use a visited set keyed by id; an already-visited id is skipped, so cycles stop.
  - Depth limit is 3. Deeper is `unavailable`, reason "Requirements nest too deep".
  - Output is deduped by id and ordered deepest first, so a plugin always comes after everything it needs.
- Make resolution injectable for tests the same way `marketplaceListing` is: through `InstallerDeps`, using the real catalog by default.

## API

**Preview.** `preview()` takes an optional `marketplace` and returns `requires: RequirementStep[]` (`[]` when there are none). The `/api/plugins/preview` route passes `marketplace` through, and so does `add-link` (with no marketplace).

**Install.** `InstallInput.requirements?: Array<{ id, action: 'install' | 'update' | 'enable', commit? }>` is the client sending back the steps it showed.

Inside `install()`, after the main manifest loads and its sha is checked:
1. Re-resolve server-side.
2. If any step is `unavailable`, return 409 `{ error: "<main name> needs <id>: <reason>", step: 'requirements' }`. Nothing is installed.
3. Every step that is not `ok` must appear in `body.requirements` with the same id and action, and the same commit for install and update steps. Otherwise return 409 `{ needsRequirements: true, requirements: steps }`. Nothing is installed.
4. Trust: if the main plugin or any install/update step needs trust (runtime `trusted`, or `contributes` present), `body.trust` must be true. One trust covers the whole set.
5. Execute the steps in order:
   - install calls the existing install path with `{ repo, ref, commit, trust, marketplace }`;
   - update calls `update(id, { ref, commit, accept: true, trust })`;
   - enable calls `setEnabled(id, true)`.

   Refactor `install()` so its core can be called per plugin without the requirement logic recursing. Each call takes its own plugin lock. Never nest a lock on the same id.
6. Then install the main plugin.
7. On any failure in step 5 or 6, roll back:
   - uninstall the plugins freshly installed in this request (`keepData: false`);
   - turn back off the plugins this request turned on;
   - leave updates in place.

   Return `{ ok: false, status, error, step: 'requirements' or the failing step, requirement?: id }`. The error names what was rolled back and any update kept, e.g. "ClickUp board was updated to v1.8.0; fixstack was not installed: <error>".
8. Add `'requirements'` to `InstallStep`.
9. The success result gains `installedRequirements: string[]`, the ids installed, updated or turned on.

**Update.** `UpdateInput.requirements?` works the same way, resolved against the new manifest. Run the steps after the consent and trust checks and before `prepareBuild`/replace. Roll back the same way if the replace fails.

**Uninstall and disable.**
- `dependentsOf(id)` returns the installed plugins (other than `id`) whose `requires` lists `id`.
- `uninstall(id, { force })` and `setEnabled(id, false, { force })` return 409 `{ error: "<names> need this plugin", dependents: [{ id, name }] }` when there are dependents and `force` is not true.
- The routes accept `force` in the body.

## Client (`client/plugins/marketplace.ts`)

- `Preview` gains `requires`. `previewListing` sends `marketplace`. The add-link draft also reads `requires`.
- **`installDialog`**, when any step is not `ok`:
  - Add an "It also needs" section, one row per step: the plugin name and version, plus a line:
    - "Will be installed";
    - "Will be updated from v<old>";
    - "Is turned off. It will be turned on";
    - or, for `unavailable`, the reason in `mk-fail` style.
  - Install and update rows list that plugin's permissions (reuse `permList`) and contribution lines.
  - The button reads "Install all (N)", where N = 1 + the install and update steps. It is disabled while any step is `unavailable`.
  - The trust switch shows when the main plugin or any step needs trust. Its label is "I trust these plugins" when more than one plugin needs it.
- **`confirmInstall`** sends `requirements` (the steps that are not `ok`, with commits) and `trust` when any part needs it.
  - On 409 `needsRequirements`, replace the draft's `requires` with the returned list and show "Something changed since you reviewed it. Check the list again."
  - Success toast: "Installed fixstack and ClickUp board". List all names, joined with "and" or commas.
- **Update area:** same section and payload when the update preview has steps that are not `ok`.
- **Remove and turn off:** on 409 with `dependents`, show inline (follow the existing Remove interaction in this file): "<names> need this plugin. Remove anyway?" or "Turn off anyway?", with a button that retries with `force: true`.

## Tests

Follow the existing fixtures in `test/plugin-installer.test.ts` and `test/support/plugin-fixtures`, using a local `file://` marketplace the way the existing marketplace tests do.

- **`test/plugin-manifest.test.ts`:** a valid `requires`, a bad id, a bad version, self, a duplicate, more than 10.
- **New `test/plugin-requirements.test.ts`:** `compareVersions` (`1.10.0` > `1.9.0`, `1.7` == `1.7.0`, `1.7.0-beta` == `1.7.0`) and `satisfies`.
- **`test/plugin-installer.test.ts`:**
  1. Preview lists a missing requirement as `install`, with its version and permissions.
  2. Preview statuses: installed and satisfied → `ok`; too old → `update`; turned off → `enable`; not in any marketplace → `unavailable`; marketplace version too old → `unavailable`.
  3. Install without `requirements` → 409 `needsRequirements`, and nothing is installed (`listInstalled()` is empty).
  4. Install with consent installs the requirement first, then the main plugin. Both are listed, and the requirement's `source.marketplace` is set.
  5. If the main plugin then fails at the build step, the freshly installed requirement is removed: its folder is gone and it is no longer listed.
  6. A wrong commit in `requirements` → 409 `needsRequirements`.
  7. A trusted requirement without `trust` is refused.
  8. Transitive: A needs B, B needs C. The install order is C, B, A.
  9. A cycle (A needs B, B needs A) ends and installs both.
  10. An update whose new version adds a requirement needs consent; with consent, it installs the requirement and then updates.
  11. Uninstalling a needed plugin → 409 with `dependents`; `force` removes it. Turning it off behaves the same.
- **`test/plugins-routes.test.ts`:** preview returns `requires`; install passes `requirements`; uninstall `force`.
- **`test/plugins-ui.test.ts` / `plugins-ui.dom.ts`:** the dialog shows "It also needs" and "Install all (2)"; an `unavailable` step disables Install; the Remove-with-dependents prompt appears.

Known failures that already exist, which you can ignore: `test/plugins-ui.test.ts` sidebar heading "TodayClear all", and the flaky split test in `test/workflow-runner-multi-repo.test.ts`. Report any others.

## Docs

Copy this file to `docs/superpowers/specs/2026-11-03-plugin-requires-design.md`.

## Known limits

- An `enable` step turns a plugin on without re-resolving that plugin's own requirements.
- A disabled plugin that requires another still counts as a dependent when removing or turning off.
- Resolution has no cache: every preview and install clones each listing again.
- Rollback never forces. A requirement that another plugin started needing in the meantime is kept, and the error says so.
- When one plugin is listed several times in the tree, the highest minimum version wins.
