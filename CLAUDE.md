# skepsis

Local diff review UI: a CLI starts an HTTP server that serves a web app for
reviewing a GitHub PR or jj/git diff in the browser (per-file viewed state,
keyboard navigation, read-only published PR discussion, private Pi Durable line
conversations and whole-diff Agent Review, and editable review drafts explicitly
published to GitHub). The normal UI never writes comments into source files.

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
                      starts the API server, spawns Vite in --dev mode.
server/
  main.ts             Hono server. GET /api/diff; POST/DELETE /api/viewed;
                      GET /api/file-contents; GET/POST /api/theme;
                      GET /api/theme.js (pre-first-paint theme boot script
                      loaded by index.html); serves dist/web statics.
  settings.ts         Global (not per-repo) UI settings — currently just the
                      theme — in ~/.local/share/skepsis/settings.json.
  diff.ts             Runs `jj diff --git`/`git diff`, extracts per-file blob
                      hashes from index lines.
  viewed.ts           Viewed state, content-addressed by git blob ID — files
                      auto-unview when content changes; no invalidation logic.
                      TSV per repo in ~/.local/share/skepsis/.
  repositoryFiles.ts  Shared bounded path validation and symlink-safe reads
                      for agent context and browser file expansion.
  reviewProposal.ts   Per-turn question/proposal protocol; suggestions remain
                      private text, never edits or automatically saved drafts.
  reviewPriorities.ts Explicit bounded classifier-only hunk-priority batches;
                      original-patch anchors, ephemeral results, cancellation.
  githubComments.ts   Read-only, bounded/paginated GitHub PR discussion via gh.
  githubCommentsApi.ts PR-only cached reads and explicit refresh; no draft writes.
  agentReviewApi.ts   Authenticated model catalog, whole-diff size/revision checks,
                      start/stop, finding decisions and private finding follow-ups.
  agentReviewProtocol.ts Whole-diff prompt and validated, diff-anchored findings.
shared/
  types.ts            API request/response types + zod schemas.
  review.ts           Anchors, question/proposal intents, private threads,
                      review drafts and publication request types.
  githubComments.ts   Published PR comments, review summaries and reply threads.
  agentReview.ts      Model/reasoning choices, runs and pending findings.
src/
  App.tsx             Diff/navigation frontend. Renders the diff with
                      @pierre/diffs CodeView (virtualized, shadow-DOM items);
                      react-query for API state.
  ReviewPanel.tsx     Private chats/proposals, editable draft comments and
                      explicitly confirmed GitHub publication.
  GitHubComments.tsx Read-only published discussion, grouped replies, refresh.
  AgentReview.tsx    Whole-diff review prompt/model picker and finding actions.
  FindingChat.tsx    Private per-finding follow-ups in the original review conversation.
  reviewAnnotations.ts Diff anchors for published threads and private findings.
  ReviewMarkdown.tsx Safe Markdown rendering: no raw HTML or remote images.
  FileSidebar.tsx     Collapsible/filterable file tree and navigation.
  HunkPriorities.tsx  Explicit scoring controls, ranked results and inline badges.
  styles.css          Base styles and shared OKLCH color/elevation tokens.
                      review.css, fileSidebar.css, priorities.css,
                      githubComments.css and agentReview.css reuse them;
                      extend the ramp, don't add ad hoc colors.
```

The normal flow uses `shared/review.ts`, `server/reviewApi.ts`,
`server/reviewContext.ts` (read-only bounded tools and revision anchors),
`server/reviewStore.ts` (Pi Durable SQLite), `server/reviewAgent.ts`
(model/auth, including GitHub Copilot), `server/github.ts` (PR checkout,
read-only discussion transport, publication), and
`src/ReviewPanel.tsx`. `server/reviewCodemode.ts` adds the bounded QuickJS worker
sandbox, and `server/reviewClassifier.ts` loads explicit System One endpoint
configuration (`--classifier-config`, `SKEPSIS_CLASSIFIER_CONFIG`, then the user's
`~/.config/skepsis/classifier.json`; absolute XDG_CONFIG_HOME overrides `.config`).
The default is a data-only user opt-in, never repository config or executable Pi
extensions. Invalid selected config fails closed; `--no-agent` skips it. Classifier
credentials remain in server-side closures; never put them in model catalog
metadata. Use a localhost HTTP stub for classifier tests, never the user's real
endpoint. The build ships `codemodeWorker.js` and `quickjs.wasm` alongside the CLI;
exercise both outside `node_modules` when changing packaging.

The source-backed comment system and external queue are deleted. Only HTTP 410
and CLI migration errors remain for old callers; never reintroduce source-tag
parsing, source-writing routes, discovery records, or poll/answer/fail clients.
Proposal requests use the private thread APIs with intent `propose-change`. They
must not edit files, save drafts automatically, or publish. Human copy/save/preview
and submission remain separate steps.

Published GitHub PR discussion (conversation comments, review summaries and grouped
inline replies) is read-only and separate from private threads/drafts. Keep resolved
and outdated threads visible; bounded pagination fails closed instead of returning
partial data. Refresh is explicit, uses `gh` authentication, and never starts a
model run. Agent Review is an explicit, pinned-revision whole-original-diff run in
the same durable Pi store. Show only available authenticated chat models and each
model's supported reasoning levels; allow a custom prompt, with Conventional
Comments as the default. Reject diffs over 128,000 UTF-8 bytes whole, not by
truncating or substituting expanded browser hunks; narrow to fewer files. Findings
stay pending until individually accepted as editable private drafts or dismissed.
Acceptance never selects or publishes a draft; stale findings cannot be accepted.
Finding chats explicitly continue the original pinned-model review conversation;
turns carry findingId for UI scoping. Parse only the original review as findings:
follow-up Markdown must never replace findings/summary or alter drafts/decisions.
Allow one outstanding follow-up per run, durable idempotent retries, and cancellation.
Stale runs and --no-agent retain chat history but reject new messages.
`--no-agent` pauses Agent Review, not read-only GitHub discussion. Stub GitHub reads
and model runs in tests; never use real credentials or services.

Classifier `maxConcurrency` (1–64, default 4) and `maxQueuedRequests` (0–256,
default 64) govern independent codemode calls. The FIFO queue is bounded and
abortable; request timeouts cover waiting plus execution. `tools.classify_review`
reuses Pi Durable's native classifier tool through ordinary nested calls, avoiding
its models.classify global's fixed four-call cap. Keep its native replay, usage,
model resolution and cancellation behavior; verify this alias on dependency updates.
Only release active
capacity when transport settles, not merely when its abort signal fires.
Conversational runs remain single-admission per review store. Hunk priorities use
one separate, explicit classifier-only batch through the same provider limiter.
They never send conversation history or fall back to chat, and are ephemeral rather
than durable: no inference on GET, browser reload, or server restart. Always bind
results to the original served-patch revision, never expanded browser hunks.
Never use a real GitHub publication as a test.
Use the faux provider and temp repositories for agent tests; never spend model
tokens or mutate user repositories just to test chat. Publication is an explicit
human action; private conversation is never included in its payload.

Pi Durable's experimental dependencies are pinned together. Node >=22.19 is
required. Model work is paused with --no-agent. PR reviews must be on loopback;
the browser gets a per-server token for mutating review endpoints. The published
package still has no production dependencies: smoke-test bundled provider/OAuth
imports when changing the build.
