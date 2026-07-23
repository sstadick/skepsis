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

function printQuestion(question: QuestionClaim, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(JSON.stringify(question) + '\n')
    return
  }
  process.stdout.write(
    [
      `id: ${question.id}`,
      `backend: ${question.backend}`,
      `file: ${question.file}`,
      `line: ${question.line}`,
      `lease: ${question.leaseId}`,
      `question: ${question.question}`,
      '',
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
  .option('--cwd <path>', 'repository cwd used for server discovery')
  .option('--server <url>', 'explicit Skepsis server URL')
  .option('--token <token>', 'explicit Skepsis server token')
  .action(
    async (opts: {
      backend?: string
      worker: string
      json?: boolean
      cwd?: string
      server?: string
      token?: string
    }) => {
      const access = await resolveServerAccess(opts)
      const res = await apiFetch<QuestionClaimResponse>('/api/questions/claim', {
        method: 'POST',
        access,
        body: { backend: parseBackend(opts.backend), worker: opts.worker },
      })
      if (!res.question) return
      printQuestion(res.question, opts.json ?? false)
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
