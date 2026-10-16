# skepsis

> [σκέψις](https://www.perseus.tufts.edu/hopper/text?doc=Perseus:text:1999.04.0057:entry=ske/yis): viewing, perception by the senses. Examination, speculation, consideration.

A local browser-based code review UI with a built-in review agent. Review a GitHub PR or your local jj/git diff, ask private questions on individual lines, and publish only the review comments you choose.

- GitHub-style split or unified diff view with syntax highlighting
- Mark files as viewed
- Private, durable line conversations with an embedded Pi agent
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

Each invocation picks a free loopback port. Different reviews can run simultaneously, but only one server may own a given durable review session.

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

An agent can launch this command, keep the server process alive, and give you the
printed URL. It does **not** need to poll for questions or relay answers. The
embedded agent owns the conversation independently.

Model selection uses `--model`, then `SKEPSIS_MODEL`, then Pi's
`defaultProvider/defaultModel` settings, then an available default. Initially,
Anthropic, OpenAI and OpenAI Codex providers are supported. Credentials come from
Pi's `~/.pi/agent/auth.json` (or `PI_CODING_AGENT_DIR`) or provider environment
variables such as `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. OAuth refresh shares
Pi's credential-file lock. Shell-command credentials and custom `models.json`
providers are not loaded. Use `--no-agent` to pause model work. When a different
provider is selected, existing threads require explicit consent before their
retained private history can be sent there; interrupted work is not automatically
requeued. New threads use the selected provider.

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

### Configuring a decision model

Any endpoint implementing the **TypeSafe System One JSON protocol** can be used;
this is not restricted to a particular model or hosting provider. An OpenAI-compatible
chat/completions endpoint alone is not sufficient. Classifiers are opt-in and
independent of `--model`, which selects the conversational reviewer.

Create a trusted JSON configuration file, for example `~/.config/skepsis/classifier.json`:

```json
{
  "provider": "my-decider",
  "model": "your-model-id",
  "endpoint": "http://127.0.0.1:8080/v1/systemone",
  "contextWindow": 32768,
  "maxRequestBytes": 131072,
  "timeoutMs": 30000
}
```

```sh
skepsis https://github.com/owner/repo/pull/123 \
  --classifier-config ~/.config/skepsis/classifier.json
# Alternatively set SKEPSIS_CLASSIFIER_CONFIG to the file's path.
```

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
`models.getAvailableOfType("classifier")` and invoke `models.classify()` from codemode.
It is instructed to check `stopReason`, interpret booleans as P(true) and scores as
expected levels, and escalate ambiguous or consequential decisions rather than
inventing answers. Classification is for narrow structured tasks, not prose.

Optional `cost: {"input": 0, "output": 0}` specifies prices per million tokens for
usage accounting. `contextWindow` is advisory model metadata; `maxRequestBytes`
limits actual JSON requests (maximum 16 MiB). No automatic truncation is performed.
Requests time out after `timeoutMs` (maximum 60 seconds), responses are limited to
1 MiB, and at most four requests run concurrently. Excess requests return an error;
scripts should use small batches. HTTP redirects and automatic transport retries
are disabled. Use HTTPS for remote services; HTTP sends request data unencrypted.

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

Use the gutter `+` on either side of the diff to **Ask agent (private)** or save a
**Draft review comment**. Follow-ups stay in their line's conversation. An agent
answer can be copied into an editable review draft; doing so never publishes it.
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

Existing `<review>` source blocks remain ordinary visible source text. The legacy
source-comment/worker APIs are not used by this interface; no source comments are
created or removed by the new conversation flow.

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
  renamed flags, changed flag defaults, changed `<review>` comment or
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
