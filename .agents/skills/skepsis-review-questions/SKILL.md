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
drafts without running model work.

The built-in agent answers private line questions and follow-ups. **Do not poll
for questions or relay answers back through the launching agent.** Its complete
lifecycle and history belong to Pi Durable, and unfinished work resumes when
Skepsis is relaunched. The launcher's chat does not need to stay active.

Private conversation and publishable review drafts are distinct. The user can
copy an answer into an editable draft and explicitly submit selected drafts to
GitHub. Never publish a review or submit test questions against a real project
without the user's request. The UI's conversation/draft actions do not edit
source files. Stop/Resolve cancels embedded agent work; closing Skepsis preserves
unfinished work for resumption.
