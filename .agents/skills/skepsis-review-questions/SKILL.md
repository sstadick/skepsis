---
name: skepsis-review-questions
description: Start or reuse a Skepsis review server, then claim and answer queued @pi, @claude, or @codex review threads with low-churn event-driven waits.
---

# Skepsis Review Questions

Use this skill to monitor and answer agent questions posted in the Skepsis review UI.

## Start or reuse the server

Always start Skepsis, or confirm that the server backing the user's open page is
already running, before waiting for questions. Run it from the root of the
repository being reviewed:

```bash
skepsis
```

When developing Skepsis from its source checkout, run:

```bash
node cli.ts --dev
```

The installed command is ready when it prints `skepsis on ...`; that same URL
serves the page and opens automatically. In source-development mode, wait for
both the API's `skepsis on ...` message and Vite's `Local:` page URL (normally
`http://localhost:5173/`). In that mode only, the two URLs are different: use
Vite's `Local:` URL for the page.

Keep this long-lived process running.
Reuse one server per review; starting a second server creates a separate
in-memory queue and a different page. Run all queue commands from the same
repository directory, or pass the same `--cwd <repository>` to each command.
The examples below use the installed `skepsis` executable. In a source checkout
without that executable installed, substitute `node cli.ts`.

## Trigger syntax

The first non-whitespace text on the first line of a review comment must begin
with exactly one supported backend marker:

```text
@pi Why is this needed?
@claude: Could this return null?
@codex - Is this safe under concurrent access?
```

The marker may be followed by a space, colon, or dash. The question must not be
empty and may continue on later lines. A marker later in the first line does not
queue a question. Follow-ups are posted in the thread's reply box and
automatically reuse its original backend.

## Wait with low churn

Begin waiting as soon as the server is ready; do not require another user prompt:

```bash
skepsis poll --backend codex --json --wait
```

Use `claude` or `pi` for the other backends. Bare `--wait` makes one immediate
claim and then blocks on server events until a matching question arrives.
`--wait 30` stops starting new claim requests after 30 seconds. It does not send
a claim request every second while idle; an already-started claim finishes (and
is printed if successful) so an accepted lease is never orphaned.

Keep one blocking command open. If the shell tool yields a process or cell ID,
wait on that same process using the longest interval the environment supports;
do not start replacement polls or perform frequent status checks. Never detach a
claim-only poll: a claimed question has a lease and must be answered or failed by
the process that receives it.

The idle CLI connection does not invoke a model and therefore does not itself
spend inference tokens. Resuming an interactive agent turn merely to inspect the
waiting process can spend runtime and tokens, so avoid periodic narration and
checks. Skepsis cannot wake a chat after its turn has ended; true unattended
answering requires a resident worker that owns the complete
claim-to-answer lifecycle.

If the wait reports a connection or discovery error, confirm the single review
server is still running and resume against it. The queue is in memory:
restarting the server loses queued jobs even though their source-backed cards
remain visible, so ask the user to resubmit any pending question after a restart.

## Answer one claim completely

The JSON claim includes:

- `id` and `leaseId`
- `file`, `line`, `lineText`, and `excerpt`
- `question`, the latest user message
- `messages`, the complete ordered user/assistant thread

Read the full `messages` history for context and answer the latest `question`.
Inspect more local code only when needed, then send a concise review reply:

```bash
printf '%s\n' "$ANSWER" | skepsis answer <id> --lease <leaseId> --stdin
```

If the question cannot be answered, release the lease by recording a failure:

```bash
skepsis fail <id> --lease <leaseId> --message "brief reason"
```

Finish the current lease before claiming another question. After answering or
failing, the poll process has exited: immediately start one fresh event-driven
`poll --wait`, then wait on that new process at the same low-frequency cadence.
Stop when the user asks, and terminate the server too if this workflow started
it for them.

## Reply style

- Be brief and concrete, like an inline code-review reply.
- Use the queued file context and prior thread messages first.
- State uncertainty directly.
- Do not include literal `<review>` or `</review>` tags.
