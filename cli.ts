#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn, execFileSync } from 'child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Command } from '@commander-js/extra-typings'
import { readServerInfo } from './server/discovery.ts'
import { startServer } from './server/main.ts'
import { AGENT_BACKENDS } from './shared/types.ts'
import type {
  AgentBackend,
  DiffArgs,
  DiffEndpoints,
  ErrorResponse,
  OkResponse,
  QuestionClaim,
  QuestionClaimResponse,
} from './shared/types.ts'

interface ServeOptions {
  revisions?: string
  from?: string
  to?: string
  git?: boolean
  dev?: boolean
  host: string
}

interface QueueOptions {
  cwd?: string
  server?: string
  token?: string
}

function detectVcs(): 'jj' | 'git' {
  try {
    execFileSync('jj', ['root'], { stdio: 'ignore' })
    return 'jj'
  } catch {
    try {
      execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' })
      return 'git'
    } catch {
      throw new Error('Not in a jj or git repository')
    }
  }
}

/* Base rev candidates for the default git diff. A remote's default branch
 * (origin/HEAD) is optional — "Having a default branch for a remote is not
 * required" (https://git-scm.com/docs/git-remote, set-head) — so fall back to
 * common default-branch names, remote-tracking first — a poor man's version
 * of what jj's trunk() does. */
const GIT_BASE_CANDIDATES = [
  'origin/HEAD',
  'origin/main',
  'origin/master',
  'main',
  'master',
]

/** Find the trunk-ish base for the default diff, plus its merge base with
 *  HEAD. Probing with `git merge-base` both verifies the candidate exists and
 *  yields the fork-point sha in one step. */
function resolveGitBase(): { base: string; mergeBase: string } {
  for (const base of GIT_BASE_CANDIDATES) {
    try {
      const mergeBase = execFileSync('git', ['merge-base', base, 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
      return { base, mergeBase }
    } catch (error) {
      const { code, stderr } = error as { code?: string; stderr?: string }
      if (code === 'ENOENT' || stderr?.includes('not a git repository')) {
        console.error(stderr?.trim() || (error as Error).message)
        process.exit(1)
      }
    }
  }
  console.error(
    `No base revision found for the default diff (tried ${GIT_BASE_CANDIDATES.join(', ')}).\n` +
      'Specify a range explicitly with -r or -f/-t.',
  )
  process.exit(1)
}

/** Split an `A..B` range into its two revs. Returns null for anything that
 *  isn't a simple two-sided range with both sides non-empty. */
function parseRange(rev: string): { left: string; right: string } | null {
  const idx = rev.indexOf('..')
  if (idx < 0 || rev.includes('...')) return null
  const left = rev.slice(0, idx)
  const right = rev.slice(idx + 2)
  if (!left || !right || right.includes('..')) return null
  return { left, right }
}

function buildDiffSource(opts: ServeOptions, files: string[], vcs: 'jj' | 'git'): DiffArgs {
  if (vcs === 'jj') {
    const args: string[] = []
    let commentsEnabled: boolean
    let endpoints: DiffEndpoints
    if (opts.from || opts.to || !opts.revisions) {
      const from = opts.from ?? (opts.to ? undefined : 'fork_point(trunk() | @)')
      if (from) args.push('--from', from)
      if (opts.to) args.push('--to', opts.to)
      commentsEnabled = !opts.to || opts.to === '@'
      endpoints = { left: from ?? '@', right: { rev: opts.to ?? '@' } }
    } else {
      const rev = opts.revisions
      args.push('-r', rev)
      commentsEnabled = rev === '@' || rev.endsWith('..@')
      const range = parseRange(rev)
      if (range) {
        endpoints = { left: range.left, right: { rev: range.right } }
      } else if (!rev.includes('..')) {
        endpoints = { left: `${rev}-`, right: { rev } }
      } else {
        endpoints = null
      }
    }
    return { vcs: 'jj', args, commentsEnabled, files, endpoints }
  }

  let args: string[]
  let commentsEnabled: boolean
  let endpoints: DiffEndpoints
  let displayArgs: string[] | undefined
  if (opts.from || opts.to) {
    if (opts.to) {
      args = [opts.from ?? 'HEAD', opts.to]
      commentsEnabled = false
      endpoints = { left: opts.from ?? 'HEAD', right: { rev: opts.to } }
    } else {
      args = [opts.from!]
      commentsEnabled = true
      endpoints = { left: opts.from!, right: 'workingCopy' }
    }
  } else if (!opts.revisions) {
    const { base, mergeBase } = resolveGitBase()
    args = [mergeBase]
    displayArgs = ['--merge-base', base]
    commentsEnabled = true
    endpoints = { left: mergeBase, right: 'workingCopy' }
  } else {
    const rev = opts.revisions
    commentsEnabled = !rev.includes('..')
    args = [rev]
    const range = parseRange(rev)
    if (range) {
      endpoints = { left: range.left, right: { rev: range.right } }
    } else if (!rev.includes('..')) {
      endpoints = { left: rev, right: 'workingCopy' }
    } else {
      endpoints = null
    }
  }
  return { vcs: 'git', args, commentsEnabled, files, endpoints, displayArgs }
}

function findCheckoutRoot(): string | null {
  const sourceRoot = import.meta.dirname
  if (existsSync(join(sourceRoot, 'vite.config.ts'))) return sourceRoot

  const packageRoot = dirname(sourceRoot)
  if (existsSync(join(packageRoot, 'vite.config.ts'))) return packageRoot

  return null
}

function requireCheckoutRoot(): string {
  const checkoutRoot = findCheckoutRoot()
  if (checkoutRoot !== null) return checkoutRoot
  throw new Error(
    '--dev only works from a skepsis source checkout, not the installed package.\n' +
      'Clone https://github.com/oxidecomputer/skepsis and run: node cli.ts --dev',
  )
}

function urlOpenCommand(url: string): { cmd: string; args: string[] } {
  switch (process.platform) {
    case 'darwin':
      return { cmd: 'open', args: [url] }
    case 'win32':
      return { cmd: 'cmd', args: ['/c', 'start', '', url] }
    default:
      return { cmd: 'xdg-open', args: [url] }
  }
}

async function runServe(files: string[], opts: ServeOptions): Promise<void> {
  const hostname = opts.host
  const vcs = opts.git ? 'git' : detectVcs()
  const diffSource = buildDiffSource(opts, files, vcs)
  const cwd = process.cwd()
  const children: ReturnType<typeof spawn>[] = []

  function cleanup(code = 0): never {
    for (const child of children) child.kill()
    process.exit(code)
  }

  process.on('SIGINT', () => cleanup())
  process.on('SIGTERM', () => cleanup())

  const checkoutRoot = opts.dev ? requireCheckoutRoot() : undefined
  const { port: apiPort } = await startServer({ diffSource, cwd, hostname })

  const shouldAutoOpen = hostname === 'localhost'
  if (opts.dev) {
    const viteArgs = ['vite', '--host', hostname]
    if (shouldAutoOpen) viteArgs.push('--open')
    const vite = spawn('npx', viteArgs, {
      cwd: checkoutRoot,
      stdio: 'inherit',
      env: { ...process.env, API_HOST: hostname, API_PORT: String(apiPort) },
    })
    children.push(vite)
  } else if (shouldAutoOpen) {
    const url = `http://localhost:${apiPort}`
    const { cmd, args } = urlOpenCommand(url)
    const opener = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    opener.on('error', () => {})
    opener.unref()
  }
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf-8')
}

async function resolveServerAccess(
  opts: QueueOptions,
): Promise<{ url: string; token: string }> {
  const url = opts.server ?? process.env['SKEPSIS_SERVER_URL']
  const token = opts.token ?? process.env['SKEPSIS_SERVER_TOKEN']
  if (url && token) return { url, token }

  const cwd = opts.cwd ?? process.cwd()
  try {
    const discovered = await readServerInfo(cwd)
    return { url: url ?? discovered.url, token: token ?? discovered.token }
  } catch (error) {
    if (url && token) return { url, token }
    throw new Error(
      `No running Skepsis server discovered for ${cwd}. Start Skepsis there first or pass --server/--token.`,
      { cause: error },
    )
  }
}

async function apiFetch<T>(
  endpoint: string,
  init: { method: string; body?: unknown; access: { url: string; token: string } },
): Promise<T> {
  const res = await fetch(new URL(endpoint, init.access.url), {
    method: init.method,
    headers: {
      authorization: `Bearer ${init.access.token}`,
      'content-type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  if (!res.ok) {
    const error = (await res.json().catch(() => null)) as ErrorResponse | null
    throw new Error(error?.error ?? `Request failed (${res.status})`)
  }
  return res.json() as Promise<T>
}

function parseBackend(raw: string | undefined): AgentBackend | undefined {
  if (raw == null) return undefined
  if ((AGENT_BACKENDS as readonly string[]).includes(raw)) return raw as AgentBackend
  throw new Error(`Unknown backend: ${raw}`)
}

/** Undefined is one-shot, null waits indefinitely, and a number is a timeout. */
function parsePollWait(raw: string | boolean | undefined): number | null | undefined {
  if (raw === undefined || raw === false) return undefined
  if (raw === true) return null

  const seconds = Number(raw)
  const milliseconds = seconds * 1000
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(milliseconds)) {
    throw new Error('--wait must be a positive number of seconds')
  }
  return milliseconds
}

interface QueueEventStream {
  nextQueued: () => Promise<void>
  close: () => void
}

/**
 * Subscribe before the initial claim so a question queued during that request
 * cannot be missed. Subsequent claims happen only after a matching queue
 * event, avoiding the old one-request-per-second idle loop.
 */
async function openQueueEventStream(
  access: { url: string; token: string },
  backend: AgentBackend | undefined,
  signal: AbortSignal,
): Promise<QueueEventStream> {
  const res = await fetch(new URL('/api/events', access.url), {
    headers: { authorization: `Bearer ${access.token}` },
    signal,
  })
  if (!res.ok) throw new Error(`Event stream failed (${res.status})`)
  if (!res.body) throw new Error('Event stream returned no response body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  return {
    nextQueued: async () => {
      // Event frames and chunks have independent boundaries, so retain the
      // unfinished tail between reads and consume complete frames in order.
      // oxlint-disable no-await-in-loop
      while (true) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary >= 0) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const event = block
            .split('\n')
            .find((line) => line.startsWith('event: '))
            ?.slice('event: '.length)
          if (event !== 'review-changed') continue
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice('data: '.length))
            .join('\n')
          const change = JSON.parse(data) as {
            reason?: string
            backend?: AgentBackend
          }
          if (
            change.reason === 'queued' &&
            (backend === undefined || change.backend === backend)
          ) {
            return
          }
          continue
        }

        const { done, value } = await reader.read()
        if (done) throw new Error('Skepsis event stream closed')
        buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n')
      }
      // oxlint-enable no-await-in-loop
    },
    close: () => {
      void reader.cancel().catch(() => {})
    },
  }
}

function printQuestion(question: QuestionClaim, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(JSON.stringify(question) + '\n')
    return
  }
  const conversation =
    question.messages.length > 1
      ? [
          'conversation:',
          ...question.messages.flatMap((message) => {
            const label =
              message.role === 'user' ? 'user' : `assistant (${message.outcome})`
            const [first = '', ...rest] = message.content.split('\n')
            return [`  ${label}: ${first}`, ...rest.map((line) => `    ${line}`)]
          }),
          '',
        ]
      : []
  process.stdout.write(
    [
      `id: ${question.id}`,
      `backend: ${question.backend}`,
      `file: ${question.file}`,
      `line: ${question.line}`,
      `lease: ${question.leaseId}`,
      `question: ${question.question}`,
      '',
      ...conversation,
      question.excerpt,
      '',
    ].join('\n'),
  )
}

const program = new Command()
  .name('skepsis')
  .description('Local diff review UI and review-question queue')

program
  .argument('[files...]', 'Limit diff to these paths (passed through to jj/git)')
  .option('-r, --revisions <revsets>', 'Show changes in these revisions')
  .option('-f, --from <rev>', 'Show changes from this revision')
  .option('-t, --to <rev>', 'Show changes to this revision')
  .option('--git', 'force git mode (skip jj detection)')
  .option('--dev', 'run with Vite dev server for development')
  .option('--host <address>', 'address to bind the HTTP server to', 'localhost')
  .action(async (files: string[], opts: ServeOptions) => {
    await runServe(files, opts)
  })

program
  .command('poll')
  .description('Claim one queued review question for an agent backend')
  .option('--backend <backend>', 'limit to a specific backend (pi, claude, codex)')
  .option('--worker <name>', 'worker name recorded on the claim', `${process.pid}`)
  .option('--json', 'print the claimed question as JSON')
  .option(
    '--wait [seconds]',
    'wait for a question; optional seconds stop starting new claims',
  )
  .option('--cwd <path>', 'repository cwd used for server discovery')
  .option('--server <url>', 'explicit Skepsis server URL')
  .option('--token <token>', 'explicit Skepsis server token')
  .action(
    async (opts: {
      backend?: string
      worker: string
      json?: boolean
      wait?: string | boolean
      cwd?: string
      server?: string
      token?: string
    }) => {
      const wait = parsePollWait(opts.wait)
      const backend = parseBackend(opts.backend)
      const access = await resolveServerAccess(opts)

      const claim = () =>
        apiFetch<QuestionClaimResponse>('/api/questions/claim', {
          method: 'POST',
          access,
          body: { backend, worker: opts.worker },
        })

      if (wait === undefined) {
        const res = await claim()
        if (res.question) printQuestion(res.question, opts.json ?? false)
        return
      }

      const controller = new AbortController()
      const deadline = typeof wait === 'number' ? performance.now() + wait : undefined
      const expired = () => deadline !== undefined && performance.now() >= deadline
      let timedOut = false
      const timer =
        typeof wait === 'number'
          ? setTimeout(() => {
              timedOut = true
              controller.abort()
            }, wait)
          : undefined
      let events: QueueEventStream | undefined
      try {
        events = await openQueueEventStream(access, backend, controller.signal)
        if (expired()) return
        // One immediate attempt catches work queued before the subscription.
        let res = await claim()
        if (res.question) {
          printQuestion(res.question, opts.json ?? false)
          return
        }

        while (true) {
          if (expired()) return
          // The single blocking stream read is the idle path. Claims remain
          // sequential so this invocation can never lease more than one job.
          // oxlint-disable-next-line no-await-in-loop
          await events.nextQueued()
          if (expired()) return
          // oxlint-disable-next-line no-await-in-loop
          res = await claim()
          if (res.question) {
            printQuestion(res.question, opts.json ?? false)
            return
          }
        }
      } catch (error) {
        const expectedTimeout =
          timedOut && error instanceof Error && error.name === 'AbortError'
        if (!expectedTimeout) throw error
      } finally {
        clearTimeout(timer)
        controller.abort()
        events?.close()
      }
    },
  )

program
  .command('answer')
  .description('Answer a claimed review question')
  .argument('<id>', 'question id')
  .requiredOption('--lease <leaseId>', 'lease returned from skepsis poll')
  .option('--text <answer>', 'answer text')
  .option('--stdin', 'read answer text from stdin')
  .option('--cwd <path>', 'repository cwd used for server discovery')
  .option('--server <url>', 'explicit Skepsis server URL')
  .option('--token <token>', 'explicit Skepsis server token')
  .action(
    async (
      id: string,
      opts: {
        lease: string
        text?: string
        stdin?: boolean
        cwd?: string
        server?: string
        token?: string
      },
    ) => {
      const answer = opts.stdin ? await readStdin() : opts.text
      if (!answer?.trim()) throw new Error('Provide answer text with --text or --stdin')
      const access = await resolveServerAccess(opts)
      await apiFetch<OkResponse>(`/api/questions/${id}/answer`, {
        method: 'POST',
        access,
        body: { leaseId: opts.lease, answer },
      })
    },
  )

program
  .command('fail')
  .description('Mark a claimed review question as failed')
  .argument('<id>', 'question id')
  .requiredOption('--lease <leaseId>', 'lease returned from skepsis poll')
  .requiredOption('--message <text>', 'failure message')
  .option('--cwd <path>', 'repository cwd used for server discovery')
  .option('--server <url>', 'explicit Skepsis server URL')
  .option('--token <token>', 'explicit Skepsis server token')
  .action(
    async (
      id: string,
      opts: {
        lease: string
        message: string
        cwd?: string
        server?: string
        token?: string
      },
    ) => {
      const access = await resolveServerAccess(opts)
      await apiFetch<OkResponse>(`/api/questions/${id}/fail`, {
        method: 'POST',
        access,
        body: { leaseId: opts.lease, error: opts.message },
      })
    },
  )

await program.parseAsync()
