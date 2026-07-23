---
name: skepsis-review-questions
description: Claim and answer queued Skepsis review questions from the command line. Use when working in a repository with a running Skepsis server and the user wants this agent to answer inline review questions like @codex or @claude comments.
---

# Skepsis Review Questions

Use this skill when you need to answer queued review questions from Skepsis.

## Workflow

1. Claim one queued question for your backend:

```bash
skepsis poll --backend codex --json
```

For Claude, replace `codex` with `claude`.

2. If the command prints nothing, there is no queued work right now.
3. If it prints JSON, parse these fields:
   - `id`
   - `leaseId`
   - `file`
   - `line`
   - `question`
   - `excerpt`
4. Read any additional local files you need, then write a concise inline-review-style answer.
5. Send the answer back:

```bash
printf '%s
' "$ANSWER" | skepsis answer <id> --lease <leaseId> --stdin
```

6. If you cannot answer, report failure instead of hanging the lease:

```bash
skepsis fail <id> --lease <leaseId> --message "brief reason"
```

## Answering guidance

- Be brief and concrete.
- Answer like a code review reply, not a long essay.
- Use the queued question context first: file, line, and excerpt.
- Read more files only when needed.
- Do not include literal `<review>` or `</review>` tags in the answer.
- If the answer depends on uncertainty, say what you are unsure about.

## Backend names

- Codex should claim with `--backend codex`
- Claude should claim with `--backend claude`
- Pi uses `--backend pi`

## Suggested loop

When asked to keep answering review questions, repeat:

1. `skepsis poll --backend <backend> --json`
2. If empty, stop or sleep briefly and try again if the user asked for a loop.
3. If a question is returned, answer it with `skepsis answer ...`
4. On error, use `skepsis fail ...`
