# Design Tokens Converter (Figma plugin starter)

Scans auto-layout frames on a page for raw, unbound spacing values
(`itemSpacing`, `paddingLeft/Right/Top/Bottom`, `counterAxisSpacing`) and
matches them against semantic spacing tokens published from a separate
library file, so you can bind them in bulk instead of one at a time.

## One-time setup

1. In the file that holds your semantic tokens, make sure the variable
   collection is **published as a library** (Assets panel → publish).
2. In the file(s) you want to clean up, enable that library:
   Assets panel → Libraries → toggle it on. This step can't be done from
   the Plugin API, so it has to happen once per file, manually.
3. Import this folder as a local plugin: Figma desktop app →
   **Plugins → Development → Import plugin from manifest…** → select
   `manifest.json` in this folder.

## Using it

1. Run the plugin from **Plugins → Development → Design Tokens Converter**.
2. **Pick a library** from the dropdown at the top — every team library
   currently enabled for this file is listed by name. Then, below it,
   check off which **spacing token collection(s)** in that library to
   match against. Collections are filtered to ones whose name suggests
   spacing (matching `/spac/i`, e.g. "Spacing"); if none match, all of
   that library's collections are shown instead so you're not stuck, with
   a note to that effect. Hit **Refresh** if you enable a library after
   opening the plugin. Then pick scope (whole page or current selection).

   **Design Tokens Converter currently only supports spacing tokens**
   (padding and gap) — color, radius, and other token types aren't
   handled. Even via the fallback above, only variables actually scoped
   for spacing (`GAP`) get used from whichever collection you pick.
3. Click **Scan**. Rows are grouped by **(field, value)**, not by node —
   a page with 65,000 raw spacing occurrences usually collapses into a
   few dozen groups, so review stays fast even on huge files.
   - Groups with exactly one matching token are pre-checked.
   - Groups with multiple candidate tokens (value collisions, e.g. two
     tokens both resolving to 8px) show a dropdown — pick the right one.
   - Groups with no match are shown but can't be applied; that value isn't
     covered by any published token yet.
   - "Select all matched" / "Select none" toggle every matchable group at
     once.
   - **Snap to nearest token within N px** — a toggle (with an editable px
     tolerance, default `2`) that appears whenever the scan turns up values
     with no exact match. When enabled, each unmatched value is matched to the
     closest published token whose value is within the tolerance — so
     `45.02px` snaps to a `44px` token, `42.82px` to `44px`, `31.88px` to
     `32px`. The row shows the transform (`45.02px → 44px`); if several tokens
     are within range they're listed nearest-first in the dropdown so you can
     override the pick. Applying binds the chosen token, which snaps the node's
     value to the token's value. Toggling and adjusting the tolerance are
     instant — no rescan needed — and per-row token picks are preserved.
4. Uncheck anything you don't want touched, then **Apply selected matches**.
   Each checked group is bound in bulk to every node it covers — a group
   affecting 20,000 nodes is one operation, not 20,000. A progress bar
   shows while it runs, and the plugin re-scans automatically afterward.

## Theming

The UI uses Figma's `themeColors: true` option and the `--figma-color-*`
CSS variables, so it follows the editor's light/dark theme automatically —
no manual switch needed.

## Performance notes

On large files (tens of thousands of nodes), two things matter most:

- **Results are grouped by (field, value), not listed per node.** The token
  match only depends on the field+value pair, so this is what keeps the
  review table small and the UI responsive even when the raw scan touches
  65,000+ properties.
- **Apply is bulk, not per-node.** Node references and resolved variables
  are cached from the scan pass, so applying a group re-uses that cache
  instead of re-fetching every node and re-resolving the same variable
  thousands of times. A progress bar reports node-level progress while a
  large apply runs.

If a scan still feels slow, narrowing scope to a specific frame or section
(rather than the whole page) is the most effective lever — it cuts down
the traversal itself, which grouping and caching can't help with.

## Known limitations / things to adapt

- **Modes**: token values are resolved using the semantic collection's
  *default* mode. If you have density or theme modes with different
  spacing values, `resolveNumericValue` in `code.js` needs to pick the
  mode that matches the current file's context instead of always using
  the default — worth customizing before running this at scale.
- **Scope filtering**: tokens are only considered if their Figma variable
  scope includes `GAP` or `ALL_SCOPES`. If your padding/gap tokens use a
  different scope convention, adjust the check in `loadSpacingTokens`.
- **Zero values are skipped** on purpose (too noisy / rarely tokenized).
  Remove that check in `getUnboundSpacingProps` if you do want 0px flagged.
- Only auto-layout spacing fields are covered. If raw spacing shows up as
  literal X/Y offsets in non-auto-layout frames, that's a different
  (much fuzzier) problem this doesn't attempt to solve.
- No undo batching beyond Figma's native undo stack — test on a
  duplicate page first.
