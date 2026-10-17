# skepsis

> [σκέψις](https://www.perseus.tufts.edu/hopper/text?doc=Perseus:text:1999.04.0057:entry=ske/yis): viewing, perception by the senses. Examination, speculation, consideration.

A fully local browser-based code review UI. Review your (or your agent's) diff _before_ inflicting it on the world.

- GitHub-style split or unified diff view with syntax highlighting
- Mark files as viewed
- Inline review comments are written directly into source files as code comments
- Ask agent questions inline; answers and follow-ups stay with the source
- Raw `<review>` storage markers stay hidden in the rendered frontend
- Optional per-hunk review-priority scoring for changed lines
- Works with [jj](https://jj-vcs.dev/) and git (tries jj first, falls back to git)
- Vim-style navigation shortcuts (press `?` to see the list)

https://github.com/user-attachments/assets/698365ab-964c-4e38-a605-82bec4879f60

## Setup

Requires [Node.js](https://nodejs.org/) v22.19+.

When running from a source checkout, Skepsis relies on Node's built-in
strip-only TypeScript support. The published npm package already ships compiled
JavaScript.

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

### Embedded model runtime

Skepsis owns its own embedded Ask agent/scoring runtime. There is no external
Skepsis worker CLI, no separate `pi` session to start, and no repo-local Pi
extensions or skills involved in the user-facing flow.

For **Ask agent**, Skepsis uses embedded
[`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable),
reads the current user's global Pi auth/model configuration and catalog
(normally under `~/.pi/`), and exposes exactly one repository tool to the
model: read-only `read_file` for numbered file snippets. Through Skepsis, the
agent cannot edit files, run commands, or load repo-local extensions.

Per managed review thread, Skepsis stores durable JSONL state plus a
host-registered request record under
`~/.local/share/skepsis/<cwd-digest>.agents`. After a restart, Skepsis only
resumes requests it previously registered locally; marker text found in source
files by itself does not start or resume work.

For **Score**, Skepsis uses the native H2O classifier endpoint configured by
`H2O_BASE_URL` (default `http://127.0.0.1:8009/v1`). Opening a diff does
**not** call a model by itself. Inference only starts when you submit
**Ask agent**, trigger **Score**, or Skepsis resumes a previously pending local
question after a restart.

## Usage

Takes `-r`/`--revisions`, `-f`/`--from`, and `-t`/`--to` flags for specifying
the commit range. The VCS is auto-detected. In jj mode, the flags are passed
straight to `jj diff`. In git mode, they have to be translated slightly. See the
examples below.

Each invocation picks a free port, so you can run multiple instances simultaneously.

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

## Local annotations: Review comment vs Ask agent

Open the composer from the gutter **+** button or press `c` on the selected line.

- **Review comment** leaves a local note inline in this diff. It does not ask a
  model for anything.
- **Ask agent** asks a question about this code. Skepsis answers inline with the
  configured Pi model, and follow-ups keep the full local thread context.

Both modes write source-backed local annotations into your working files. In
source, those live inside comment-wrapped `<review>...</review>` blocks, plus
Skepsis metadata markers for managed agent threads. The rendered frontend hides
those storage rows and shows an inline discussion card instead.

These are **not** GitHub review comments or GitHub discussions, and Skepsis has
no Publish step. If you want the content in a PR review, copy it manually
before resolving the local annotation or committing the file.

Review comments and Ask agent are only enabled when the diff includes the
working copy (for example, a jj revset ending in `@`, or a git diff that ends
at the working tree), because Skepsis inserts real comment lines into files on
disk. The default diff in both modes ends at the working copy, so local
annotations are enabled by default.

## Review priority scoring

Click **Score** in the top progress bar, or run `skepsis score` from the same
repository while Skepsis is running. The CLI discovers the already-running
server for that repository and tells it to start embedded scoring; it does not
start a second server and it does not require an external `pi` session.

Scoring uses Skepsis's embedded local `h2o-local/h2o-lightning-4b` native
classifier, not the chat model, and runs up to **four hunks concurrently**.
Each hunk gets the bool answer's **P(important)**. Only changed-line gutters
are colored, from transparent through amber to red; source backgrounds, file
headers, and viewed state are unchanged. This is an advisory attention signal,
**not a calibrated probability of a bug**. Low scores do not mean safe.

Scores appear incrementally over server events and survive reloads/restarts.
The cache lives under `~/.local/share/skepsis/`, isolated by repository and the
versioned scoring profile (model + rubric). Hunk content, path, and function
context identify a score; line-number shifts reuse it, changed hunks do not.
Entries expire after 30 days. Scores never write to source files and also work
for read-only revision ranges.

`skepsis score cancel` clears pending scoring work and visible scoring failures,
but keeps completed scores. Retry only needs to recompute failed or missing
hunks. Oversized hunks (over 24,000 UTF-8 bytes) remain unscored with an
explicit error rather than being silently truncated; binary and mode-only
changes have no text hunks to score.

## Marking files viewed

Viewed state is stored per file in `~/.local/share/skepsis/` using the file's
content hash (the git object ID from the diff header). If the file changes, the
hash no longer matches and it automatically shows as unviewed again.

## Development

Clone the repo when working on skepsis itself:

```
git clone https://github.com/oxidecomputer/skepsis.git
cd skepsis && npm install
```

Running from a checkout also requires Node v22.19+, since the CLI runs as
TypeScript directly via Node's built-in strip-only support. Point an alias at
the clone to run it from any repo:

```
alias sk="node /path/to/skepsis/cli.ts"
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
