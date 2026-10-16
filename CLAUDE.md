# skepsis

Local diff review UI: a CLI starts an HTTP server that serves a web app for
reviewing a GitHub PR or jj/git diff in the browser (per-file viewed state,
keyboard navigation, private Pi Durable line conversations, and editable
review drafts explicitly published to GitHub). The normal UI never writes
comments into source files.

After changes, run `npm run ci` unless narrowing is clearly justified. That
runs the build, type-check, oxlint, oxfmt check, and tests. Use `npm run fmt`
to apply formatting — not prettier/eslint. To try the app against a real repo,
run `node cli.ts --dev` in that repo (`--host 127.0.0.1` suppresses
auto-opening a browser).

## npm package build

The npm package is a bin-only package named `@oxide/skepsis`. `npm run build`
removes `dist/`, builds the frontend into `dist/web`, then bundles the CLI and
server into `dist/cli.js` with tsdown. Runtime dependencies are bundled into
the CLI output, so the published package has no production dependencies and
`npx @oxide/skepsis` does not run a build step.

`dist/` is ignored build output. Do not edit it by hand or include it in
reviews; regenerate it with `npm run build` when checking package behavior.

## Code map

```
cli.ts                CLI entry (commander). Detects jj/git, builds DiffArgs
                      (incl. commentsEnabled: diff must end at @/working copy),
                      starts the API server, spawns Vite in --dev mode.
server/
  main.ts             Hono server. GET /api/diff; POST/DELETE /api/viewed;
                      POST/DELETE /api/comment; GET/POST /api/theme;
                      GET /api/theme.js (pre-first-paint theme boot script
                      loaded by index.html); serves dist/web statics.
  settings.ts         Global (not per-repo) UI settings — currently just the
                      theme — in ~/.local/share/skepsis/settings.json.
  diff.ts             Runs `jj diff --git`/`git diff`, extracts per-file blob
                      hashes from index lines.
  viewed.ts           Viewed state, content-addressed by git blob ID — files
                      auto-unview when content changes; no invalidation logic.
                      TSV per repo in ~/.local/share/skepsis/.
  comment.ts          Inserts/removes <review>…</review> comment lines into
                      real working-copy files (this is how review comments
                      exist in the diff at all).
  commentSyntax.ts    Comment syntax (prefix/suffix) by file extension.
shared/
  types.ts            API request/response types + zod schemas.
  reviewComments.ts   <review> open/close tag constants and regexes shared by
                      server insertion and client detection.
src/
  App.tsx             Entire frontend (single file). Renders the diff with
                      @pierre/diffs CodeView (virtualized, shadow-DOM items);
                      react-query for API state.
  styles.css          All styling. OKLCH color tokens with a documented
                      elevation ramp at the top — extend it, don't add ad hoc
                      colors.
```

The normal flow uses `shared/review.ts`, `server/reviewApi.ts`,
`server/reviewContext.ts` (read-only bounded tools and revision anchors),
`server/reviewStore.ts` (Pi Durable SQLite), `server/reviewAgent.ts`
(model/auth), `server/github.ts` (PR checkout/publication), and
`src/ReviewPanel.tsx`. `server/reviewCodemode.ts` adds the bounded QuickJS worker
sandbox, and `server/reviewClassifier.ts` loads explicit System One endpoint
configuration (`--classifier-config` / `SKEPSIS_CLASSIFIER_CONFIG`). Classifier
credentials remain in server-side closures; never put them in model catalog
metadata. Use a localhost HTTP stub for classifier tests, never the user's real
endpoint. The build ships `codemodeWorker.js` and `quickjs.wasm` alongside the CLI;
exercise both outside `node_modules` when changing packaging.

The original source-backed comment and external queue
modules remain legacy only. Never use a real GitHub publication as a test.
Use the faux provider and temp repositories for agent tests; never spend model
tokens or mutate user repositories just to test chat. Publication is an explicit
human action; private conversation is never included in its payload.

Pi Durable's experimental dependencies are pinned together. Node >=22.19 is
required. Model work is paused with --no-agent. PR reviews must be on loopback;
the browser gets a per-server token for mutating review endpoints. The published
package still has no production dependencies: smoke-test bundled provider/OAuth
imports when changing the build.
