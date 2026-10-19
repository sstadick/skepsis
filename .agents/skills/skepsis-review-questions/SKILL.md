---
name: skepsis-review-questions
description: Launch a Skepsis PR or local diff review with private line conversations answered by its built-in Pi Durable agent.
---

# Skepsis Reviews

Launch Skepsis for the requested PR URL (works outside a repository):

```sh
skepsis https://github.com/owner/repo/pull/123 --no-open
```

For a local diff, run `skepsis --no-open` in the target repository. In a source
checkout without an installed command, substitute `node /path/to/skepsis/cli.ts`.
For frontend development add `--dev`; use Vite's printed URL for the browser,
not the API server URL.

Keep the long-lived server process running and give the user the printed URL.
Reuse an existing server for the same review rather than start another owner.
GitHub PRs require git and `gh auth login`; do not perform a login on the user's
behalf. `--model provider/modelId` selects the embedded model; otherwise Skepsis
uses its configured model/Pi settings. `--no-agent` opens saved history and
drafts without running model work. `--classifier-config <path>` optionally loads
a user-specified System One endpoint; it does not inherit the launcher's classifier.
A saved `~/.config/skepsis/classifier.json` (or absolute XDG_CONFIG_HOME equivalent)
is loaded by default, so a user's copied Pi connection needs no repeated launch flag.
Use `--port <port>` to retain the same URL and SSH tunnel across restarts.
Its `maxConcurrency` setting allows parallel scoring within codemode and through
**Prioritize hunks** in the browser. Priority scoring is explicitly started by the
user; results are revision-bound and survive browser reloads, not server restarts.

The built-in agent answers private line questions and follow-ups. **Do not poll
for questions or relay answers back through the launching agent.** Its complete
lifecycle and history belong to Pi Durable, and unfinished work resumes when
Skepsis is relaunched. The launcher's chat does not need to stay active.

The old source-backed comments and poll/answer/fail clients have been removed.
For a proposed fix, use **Propose a change (private)** in the line composer or
**Propose a change** within a thread. A draft comment can be copied into the
request with **Use comment as change request**. These actions ask for private
proposal text; they do not edit source or publish anything.

Private conversation and publishable review drafts are distinct. The user can
copy an answer into an editable draft and explicitly submit selected drafts to
GitHub. Never publish a review or submit test questions against a real project
without the user's request. The UI's conversation/draft actions do not edit
source files. Stop/Resolve cancels embedded agent work; closing Skepsis preserves
unfinished work for resumption.
