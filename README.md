# skepsis

> [σκέψις](https://www.perseus.tufts.edu/hopper/text?doc=Perseus:text:1999.04.0057:entry=ske/yis): viewing, perception by the senses. Examination, speculation, consideration.

A local browser-based code review UI with a built-in review agent. Review a GitHub PR or your local jj/git diff, ask private questions on individual lines, and publish only the review comments you choose.

- GitHub-style split or unified diff view with syntax highlighting
- Collapsible, filterable file tree with viewed state and change counts
- Mark files as viewed
- Private, durable line conversations with Markdown rendering and an embedded Pi agent
- Read-only published GitHub PR discussion, separate from private conversations and drafts
- On-demand whole-diff Agent Review with individually accepted draft suggestions
- Explicit parallel hunk-priority scoring with a configured decision classifier
- Editable review-comment drafts, explicitly submitted to GitHub
- No source-file changes when chatting or drafting
- Works with [jj](https://jj-vcs.dev/) and git (tries jj first, falls back to git)
- Vim-style navigation shortcuts (press `?` to see the list)

https://github.com/user-attachments/assets/698365ab-964c-4e38-a605-82bec4879f60

## Setup

Requires [Node.js](https://nodejs.org/) v22.19+. GitHub PR reviews also require git and an authenticated [GitHub CLI](https://cli.github.com/) (`gh auth login`).

Run it without installing:

```
npx @oxide/skepsis
```

`npx` may reuse a cached package version. To force the newest published
version, run:

```
npx @oxide/skepsis@latest
```

To install a persistent command:

```
npm install --global @oxide/skepsis
skepsis
```

Either way, you may want a shorter alias:

```
alias sk="npx @oxide/skepsis"
```

## Usage

Takes `-r`/`--revision`, `-f`/`--from`, and `-t`/`--to` flags for specifying
the commit range. The VCS is auto-detected. In jj mode, the flags are passed
straight to `jj diff`. In git mode, they have to be translated slightly. See the
examples below.

Each invocation picks a free loopback port unless you set `--port <port>` (use `0`
for automatic selection). A fixed port keeps browser URLs and SSH tunnels stable
across restarts. Different reviews can run simultaneously, but only one server may
own a given durable review session.

### GitHub PRs and embedded agent

```sh
skepsis https://github.com/owner/repo/pull/123
skepsis https://github.com/owner/repo/pull/123 --model anthropic/claude-sonnet-4-5
skepsis --no-agent --no-open       # drafts/history only, print URL without a browser
```

A PR URL works outside a repository. Skepsis fetches the base repository's PR ref
(including fork PRs) into its own isolated worktree, pins the reviewed commits,
and leaves your working checkout untouched. Relaunch the URL to review a new PR
revision; old conversations and drafts remain accessible as outdated, not silently
reattached to different code.

The **Published on GitHub** section shows existing PR conversation comments,
published review summaries and inline threads with replies, including resolved
and outdated threads. This is read-only GitHub discussion, not private agent chat
or local drafts. It uses your authenticated `gh` CLI credentials; click
**Refresh comments** to fetch newer discussion; there is no background polling.
Fetches paginate with limits and fail rather than showing incomplete discussion.

An agent can launch this command, keep the server process alive, and give you the
printed URL. It does **not** need to poll for questions or relay answers. The
embedded agent owns the conversation independently.

Model selection uses `--model`, then `SKEPSIS_MODEL`, then Pi's
`defaultProvider/defaultModel` settings, then an available default. Anthropic,
OpenAI, OpenAI Codex and GitHub Copilot providers are supported. Credentials
come from Pi's `~/.pi/agent/auth.json` (or `PI_CODING_AGENT_DIR`) or provider
environment variables such as `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. OAuth
refresh shares Pi's credential-file lock. Shell-command credentials and custom
`models.json` providers are not loaded. Use `--no-agent` to pause model work.
When a different provider is selected, existing threads require explicit consent
before their retained private history can be sent there; interrupted work is not
automatically requeued. New threads use the selected provider.

The agent has bounded, read-only file/list/search tools, not Bash or GitHub write
access. Working-copy symlinks are rejected, including links to ignored secrets.
Project extensions, skills and executable instructions are not loaded. Codemode
runs JavaScript in a QuickJS worker sandbox, with access only to the same read-only
tools and any explicitly configured decision classifier. It has no Node APIs,
shell, direct network access, or source-writing tools. Scripts have a 64 MiB memory
limit and a maximum 60-second execution timeout, and Stop cancels nested calls.
Private means **not published to GitHub**: prompts and inspected code are sent to
your configured chat provider and may also be sent to your decision endpoint.
No inference is performed while idle.

### Browser review workflow

Use **Hide files / Show files** to collapse the left file tree. Filter by path
(including a rename's old path), collapse folders, or click a file to jump to it.
Navigation never marks files viewed. The tree tracks the focused file and viewed
state; on narrow screens it becomes a bounded drawer above the diff.

Private conversations render Markdown, including lists, tables, links and fenced
code with a copy button. Raw HTML and remote images are disabled. **Write / Preview**
shows how a question, proposal or draft will render without changing its source.
**Create review comment** copies an answer into an editable, unpublished draft;
copying, saving and publishing remain separate explicit actions.

With a configured decision classifier, click **Prioritize hunks** to score the
current displayed diff in parallel. Scores appear next to each hunk's first changed
line; **Show priorities** lists them highest-first with links to the exact old/new
line. **Discuss hunk** opens a private composer without sending anything.
The file sidebar colors each file and folder by its **highest scored hunk**:
gray for minimal, green for low, blue for normal, amber for high, and red for critical.
Numeric scores and tooltips accompany the colors; `*` marks partial coverage, `?`
uncertainty, `…` pending, and `—` unscored. Folder colors remain visible when collapsed.
Colors clear when the reviewed revision changes, and navigation never marks files viewed.
Scores are continuous expected review-attention levels (0 mechanical through 4
critical), not confirmed defects. Uncertain results need human inspection; failed
or oversized hunks are marked **Not scored**, never assigned a fake zero.

Scoring sends only the original diff hunks to the configured classifier, not private
conversation history. It shares the classifier's concurrency/queue limits and has
its own **Stop scoring** control. There is no chat-model fallback or automatic retry.
Revision changes invalidate scores. Batches are limited to 1,000 hunks and 24,000
characters of classifier input per hunk; oversized hunks are skipped whole.
Unlike durable conversations, priority results live only until the server restarts:
browser reloads retain them, but restarting requires an explicit new scoring run.
Nothing is edited, marked viewed, or published by scoring.

### Agent Review

Open **Agent Review** to run an explicit review of the entire original diff at
the current pinned revision. Write a custom review prompt, choose an available
authenticated chat model and one of its supported reasoning levels, then click
**Start review**. The default prompt asks for actionable findings using
Conventional Comments. Runs and findings are durable in the same Pi review store
as private conversations; they are not GitHub comments. `--no-agent` pauses model
work, including Agent Review.

Each finding starts as a private pending suggestion. Inspect it, then individually
**Accept for review** to create an editable, unpublished review draft, or
**Dismiss** it. Acceptance does not select the draft for publication or publish
anything: edit the saved draft if needed, then select, preview and confirm a
GitHub review separately. Findings tied to an outdated revision cannot be
accepted. Agent Review requires the _entire original diff_ (not just
visible/expanded browser hunks) to fit a hard 128,000 UTF-8-byte limit; an
oversized diff is rejected, not silently truncated. Narrow the comparison to
fewer files before starting again.

Use **Chat with agent** on a suggestion to ask for evidence, clarification, or a
reassessment before deciding. Follow-ups use the original review conversation,
diff, model, and reasoning level; private replies stay attached to that finding
and survive reloads. Opening chat does not run the agent. Send explicitly, or
**Stop reply** to cancel. Chat never changes suggestions or saved drafts, accepts
findings, or publishes anything. Outdated reviews and `--no-agent` keep history
readable but disable new messages.

### Configuring a decision model

Any endpoint implementing the **TypeSafe System One JSON protocol** can be used;
this is not restricted to a particular model or hosting provider. An OpenAI-compatible
chat/completions endpoint alone is not sufficient. Classifiers are opt-in and
independent of `--model`, which selects the conversational reviewer.

Create `~/.config/skepsis/classifier.json` to make a classifier your persistent
default (or `$XDG_CONFIG_HOME/skepsis/classifier.json` when `XDG_CONFIG_HOME` is an
absolute path). Skepsis loads it automatically; no extra launch flag is needed.
For example:

```json
{
  "provider": "my-decider",
  "model": "your-model-id",
  "endpoint": "http://127.0.0.1:8080/v1/systemone",
  "contextWindow": 32768,
  "maxRequestBytes": 131072,
  "timeoutMs": 30000,
  "maxConcurrency": 8,
  "maxQueuedRequests": 64
}
```

```sh
skepsis https://github.com/owner/repo/pull/123 \
  --classifier-config ~/.config/skepsis/classifier.json
# Or just run skepsis when the config is in the default user location.
# SKEPSIS_CLASSIFIER_CONFIG can also select a different file.
```

Selection order is `--classifier-config`, `SKEPSIS_CLASSIFIER_CONFIG`, then the
user default. A missing default means no classifier; an invalid selected config
fails closed instead of choosing another endpoint. `--no-agent` skips all classifier
configuration. To reuse a Pi classifier, copy only its model and connection settings
into this user file; Skepsis does not execute Pi extensions or read project-local
classifier configuration. Keep real endpoints and credentials outside the repository.

`endpoint` is the **complete POST URL**, including any custom path; Skepsis does
not append `/systemone`. Unauthenticated local servers work as shown. For bearer
authentication add `"apiKeyEnv": "MY_SYSTEM_ONE_API_KEY"` and set that environment
variable in the launching process. For custom authentication/proxy headers, use
`"headerEnv": {"X-API-Key": "MY_SYSTEM_ONE_API_KEY"}`. Non-secret static headers can
use `"headers": {"X-Client": "skepsis"}`. Credentials never enter model catalogs,
conversation state, or the browser. No credential commands are executed.

The endpoint receives `{ model, state, questions }`; public `bool` questions/results
are mapped to/from System One's `noul` wire format. Choice probabilities and score
results are normalized and validated. The agent can discover the model with
`models.getAvailableOfType("classifier")` and call
`tools.classify_review({model, context: {state, questions}})` from codemode. This
uses Pi Durable's native classifier tool and journals each result for recovery.
The built-in `models.classify(model, context)` also works, but has a separate
four-call per-script cap; use `classify_review` to make use of higher parallelism.
It is instructed to check `stopReason`, interpret booleans as P(true) and scores as
expected levels, and escalate ambiguous or consequential decisions rather than
inventing answers. Classification is for narrow structured tasks, not prose.

Optional `cost: {"input": 0, "output": 0}` specifies prices per million tokens for
usage accounting. `contextWindow` is advisory model metadata; `maxRequestBytes`
limits actual JSON requests (maximum 16 MiB). No automatic truncation is performed.
Responses are limited to 1 MiB. `maxConcurrency` controls parallel classifier
requests (default 4, range 1–64); raise it to match your endpoint's capacity.
`maxQueuedRequests` bounds the shared FIFO waiting queue (default 64, range 0–256);
set it to 0 to reject excess calls immediately. Overflow returns a sanitized error.
The agent is instructed to batch independent scoring/classification items with
`Promise.allSettled` or a bounded pool, checking each result's `stopReason` even
when its promise fulfilled. Related questions over the same state can share one
request. This parallelizes classifier calls, not conversational agent turns.

Each request's `timeoutMs` (maximum 60 seconds) includes queue wait and execution;
it is not reset on admission. Stop/Resolve cancels queued and running calls.
Codemode's separate 60-second script limit still applies. HTTP redirects and
automatic transport retries are disabled. Use HTTPS for remote services; HTTP
sends request data unencrypted.

The CLI and Review panel show the selected endpoint. Changing configuration on
restart cancels unfinished old-policy work rather than redirecting it to a new
service; send a fresh follow-up to continue. `--no-agent` pauses all model work
and skips classifier setup. Pi's custom `models.json`, extensions, and the launching
session's decision-model setup are not imported automatically.

### jj examples

The examples use `skepsis`, the installed bin name. An `sk` alias works the
same way.

```
skepsis                          # review branch vs trunk, GitHub PR style
                                 # (jj diff --from 'fork_point(trunk() | @)')
skepsis -r @                     # review working copy only
skepsis -r 'mybranch..@'         # review a range
skepsis -f main -t @             # diff between two revisions
```

### git examples

Ranges passed with `-r` are passed through verbatim to `git diff`.

```
skepsis                          # review branch + working tree vs origin
                                 # (git diff --merge-base origin/HEAD; falls
                                 # back to origin/main, origin/master, main,
                                 # master)
skepsis -f main                  # diff since main: git diff main HEAD
skepsis -r main..my-branch       # review commits on my-branch
skepsis -r HEAD~5..HEAD          # review the last 5 commits
skepsis -f v1.2.0 -t v1.3.0      # compare two tags
skepsis --git                    # force git in a jj-colocated repo
```

## How it works

The CLI starts a local HTTP server that shells out to `jj diff`
or `git diff`, then serves the diff to a React frontend that uses
[`@pierre/diffs`](https://diffs.com/) to render it with syntax highlighting.

The npm package ships compiled CLI/server JavaScript plus a prebuilt frontend
bundle, so installing or running with `npx` does not build anything. In dev
mode (`--dev`), a Vite dev server runs alongside the API server with hot
reload from a source checkout.

### Conversations and review comments

Click a line number or the gutter `+` on either side of the diff to **Ask agent
(private)**, **Propose a change (private)**, or save a **Draft review comment**.
Per-line composition remains available before and after hunk prioritization;
**Discuss hunk** is an additional shortcut, not a replacement. Follow-ups stay
in their line's conversation. An agent answer can be copied into an editable
review draft; doing so never publishes it.

To request a fix, choose **Propose a change (private)** and describe what should
change. In an existing thread, **Propose a change** uses your follow-up text, or
asks for a minimal fix to the issue already discussed. **Use comment as change
request** copies a draft comment (including unsaved edits) into the private request
composer without changing or saving that draft; sending remains explicit.

Proposals are private answers, not file edits or automatically created public
comments. The agent is instructed to give a minimal change and rationale. A
verified single-line RIGHT-side replacement can use a GitHub `suggestion` block;
broader changes and LEFT-side anchors use a fenced diff with paths and scope.
Check the proposal, then use **Create review comment** and **Save draft** if you
want to include it in a public review. Nothing applies the proposed code locally.

The authenticated API hooks are `POST /api/threads` with
`{ id, anchor, text, intent: "propose-change" }` and
`POST /api/threads/:id/messages` with `{ id, text, intent: "propose-change" }`.
They use the same session-token, revision, provider-consent, and cancellation
checks as questions. Omitted intent means `"question"`; request IDs must be UUIDs.

Local revision comparisons support conversations too, even when they don't end
at the working copy. Changes to any tracked working-copy dependency invalidate
old context, even in path-filtered reviews. Unsaved compositions remain recoverable
in the Review panel's outdated section; they are never silently relocated.

Open the **Review** panel to select saved drafts, write a public summary, and
**Preview review** before explicitly confirming a Comment, Approve, or Request
changes review to GitHub. The preview shows the exact selected saved bodies;
changes from another tab require a new preview. Only
that summary and the selected drafts are sent—never the private chat, tool output,
or agent context. Inline publication is limited to lines in GitHub's current PR
diff; expanded unchanged lines can still have private conversations. Publication
is rejected if the PR head or base has changed.

If a publish request loses its response, Skepsis records an **uncertain** result
and does not resend it automatically. **Reconcile publication** searches GitHub
for its unique review marker. If no result is found, it stays uncertain rather
than risk a duplicate. After checking GitHub, you may explicitly **Unlock without
resubmitting**, acknowledging the risk of a duplicate. This rechecks for a receipt:
if found it records success; otherwise it abandons the intent and releases the
drafts. It never automatically retries or undoes a GitHub review. The journal
retains the manual override.

Conversations, queued work, drafts and publication receipts are persisted with Pi
Durable in SQLite under `~/.local/share/skepsis/reviews/`; PR worktrees live under
`~/.local/share/skepsis/github/`. `SKEPSIS_STATE_DIR` overrides those locations.
Keep this directory private: it contains review discussions and inspected code.
One model run is admitted at a time, with a persisted five-minute execution
budget. Queue time and fully paused/shutdown time do not consume it. Graceful
shutdown preserves the remainder; crash recovery conservatively charges a small
checkpoint interval (normally at most about one second). Interrupted work resumes
on the next launch only when its revision and provider remain valid. Stop/Resolve
cancels it, including while publication is in flight. Resolved threads remain in
the Review panel.

The source-backed comment system and external-worker queue have been removed,
including their storage helpers, discovery protocol, and `poll`/`answer`/`fail`
clients. Old API URLs return HTTP 410 and removed CLI commands fail with a
migration message. Existing `<review>` blocks remain ordinary visible source;
they are not parsed, migrated, hidden, edited, or deleted by Skepsis. No source
comments are created by the conversation flow.

Browser file expansion and agent tools share bounded, symlink-safe working-file
reads. Expansion only reads tracked files at the selected endpoints; traversal,
repository metadata, ignored/untracked working files, and binary/oversized files
are not exposed.

### Marking files viewed

Viewed state is stored per file in `~/.local/share/skepsis/` using the file's
content hash (the git object ID from the diff header). If the file changes, the
hash no longer matches and it automatically shows as unviewed again.

## Development

Clone the repo when working on skepsis itself:

```
git clone https://github.com/oxidecomputer/skepsis.git
cd skepsis && npm install
```

Running from a checkout requires Node v22.19+, since the CLI runs as
TypeScript directly via Node's built-in type stripping. Point an alias at the
clone to run it from any repo:

```
alias sk="node ~/repos/skepsis/cli.ts"
```

`--dev` runs a Vite dev server with hot reload alongside the API server:

```
sk --dev
```

Before committing changes, run:

```
npm run ci
```

## Versioning

- **patch** — bug fixes, dependency bumps, internal changes
- **minor** — new features: flags, keyboard shortcuts, UI capabilities
- **major** — breaking changes to anything scriptable or on disk: removed or
  renamed flags, changed flag defaults, changed review API or
  viewed-state formats

## Releases

To publish a release, bump the version and land the change on `main`:

```
npm version patch --no-git-tag-version   # or minor/major — bumps package.json
jj commit -m 'v0.1.1'                    # land the bump on main via PR
```

On every push to `main`, CI checks whether the `package.json` version is
already on the registry. If not, it publishes and creates a matching [GitHub
release](https://github.com/oxidecomputer/skepsis/releases) like `v0.1.1` with
auto-generated notes listing the PRs merged since the previous release.

To publish a canary build of a PR, go to the [Release
workflow](https://github.com/oxidecomputer/skepsis/actions/workflows/release.yml),
click "Run workflow", and enter the PR number. It publishes the PR's head as
`<version>-canary.<pr>.<sha>` under the `canary` dist-tag and comments the
version on the PR.
