# skepsis

Local diff review UI: a CLI starts an HTTP server that serves a web app for
reviewing a jj/git diff in the browser, GitHub-PR-style (per-file viewed
state, keyboard navigation, source-backed review comments and Ask agent threads
written into the working copy as comment lines, with raw storage markers hidden
in the rendered frontend).

Skepsis owns its embedded Pi/H2O runtime. There is no external worker CLI or
codemode skill in the user-facing flow. Ask agent only gets a read-only repo
`read_file` tool; durable per-thread JSONL state lives under
`~/.local/share/skepsis/<cwd-digest>.agents`; restart recovery only resumes
locally registered requests.

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
                      starts the API server, spawns Vite in --dev mode, and
                      bounds child shutdown on SIGINT/SIGTERM without spawning
                      late children after shutdown begins.
cli/access.ts         Shared helper for score CLI server discovery/auth.
cli/score.ts          `skepsis score` and `skepsis score cancel`; both talk to
                      an already running Skepsis server discovered from cwd.
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
                      real working-copy files (this is how review comments and
                      Ask agent threads exist in the diff at all).
  commentSyntax.ts    Comment syntax (prefix/suffix) by file extension.
  embeddedRuntime.ts  Embedded pi-durable runtime. Stores per-thread JSONL in
                      ~/.local/share/skepsis/<cwd-digest>.agents and only
                      resumes host-registered local requests after restart.
  modelRuntime.ts     Loads global Pi auth/model config, registers the local
                      H2O classifier at H2O_BASE_URL, ignores repo extensions.
  reviewTools.ts      Read-only repo tools exposed to Ask agent — currently
                      numbered `read_file` only.
shared/
  types.ts            API request/response types + zod schemas.
  reviewComments.ts   <review> open/close tag constants and regexes shared by
                      server insertion and client detection.
src/
  App.tsx             Entire frontend (single file). Renders the diff with
                      @pierre/diffs CodeView (virtualized, shadow-DOM items),
                      converts raw <review> storage rows into discussion cards,
                      and keeps those marker rows hidden in the rendered UI;
                      react-query for API state.
  styles.css          All styling. OKLCH color tokens with a documented
                      elevation ramp at the top — extend it, don't add ad hoc
                      colors.
```

Review comments and Ask agent only work when the diff ends at the working copy
(`-f` without `-t`), because they're inserted as real lines into files on disk.
Testing comment submit against a real repo writes `<review>` lines and managed
question markers into its files, even though those storage rows stay hidden in
the rendered frontend.
