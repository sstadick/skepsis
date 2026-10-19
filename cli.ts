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
import { realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Command, InvalidArgumentError } from '@commander-js/extra-typings'
import { startServer } from './server/main.ts'
import { parsePullRequestUrl, preparePullRequest } from './server/github.ts'
import { reviewDirectory, stateDirectory } from './server/statePaths.ts'
import type { PullRequest } from './shared/review.ts'
import type { DiffArgs, DiffEndpoints } from './shared/types.ts'

interface ServeOptions {
  revisions?: string
  from?: string
  to?: string
  git?: boolean
  dev?: boolean
  host: string
  port?: number
  model?: string
  classifierConfig?: string
  agent?: boolean
  open?: boolean
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
    let endpoints: DiffEndpoints
    if (opts.from || opts.to || !opts.revisions) {
      const from = opts.from ?? (opts.to ? undefined : 'fork_point(trunk() | @)')
      if (from) args.push('--from', from)
      if (opts.to) args.push('--to', opts.to)
      endpoints = { left: from ?? '@', right: { rev: opts.to ?? '@' } }
    } else {
      const rev = opts.revisions
      args.push('-r', rev)
      const range = parseRange(rev)
      if (range) {
        endpoints = { left: range.left, right: { rev: range.right } }
      } else if (!rev.includes('..')) {
        endpoints = { left: `${rev}-`, right: { rev } }
      } else {
        endpoints = null
      }
    }
    return { vcs: 'jj', args, files, endpoints }
  }

  let args: string[]
  let endpoints: DiffEndpoints
  let displayArgs: string[] | undefined
  if (opts.from || opts.to) {
    if (opts.to) {
      args = [opts.from ?? 'HEAD', opts.to]
      endpoints = { left: opts.from ?? 'HEAD', right: { rev: opts.to } }
    } else {
      args = [opts.from!]
      endpoints = { left: opts.from!, right: 'workingCopy' }
    }
  } else if (!opts.revisions) {
    const { base, mergeBase } = resolveGitBase()
    args = [mergeBase]
    displayArgs = ['--merge-base', base]
    endpoints = { left: mergeBase, right: 'workingCopy' }
  } else {
    const rev = opts.revisions
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
  return { vcs: 'git', args, files, endpoints, displayArgs }
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
  if (!['localhost', '127.0.0.1'].includes(hostname)) {
    throw new Error('Private review sessions must bind to localhost or 127.0.0.1')
  }
  const checkoutRoot = opts.dev ? requireCheckoutRoot() : undefined
  let cwd = await realpath(process.cwd())
  let pullRequest: PullRequest | undefined
  let diffSource: DiffArgs
  const first = files[0]
  if (first && /^https?:\/\//.test(first)) {
    if (!parsePullRequestUrl(first))
      throw new Error('Expected a github.com pull request URL')
    if (files.length !== 1 || opts.from || opts.to || opts.revisions || opts.git) {
      throw new Error('A PR URL cannot be combined with paths or revision flags')
    }
    const prepared = await preparePullRequest(first, stateDirectory())
    cwd = prepared.cwd
    pullRequest = prepared.pullRequest
    diffSource = {
      vcs: 'git',
      args: [pullRequest.diffBaseSha, pullRequest.headSha],
      files: [],
      endpoints: { left: pullRequest.diffBaseSha, right: { rev: pullRequest.headSha } },
    }
  } else {
    const vcs = opts.git ? 'git' : detectVcs()
    diffSource = buildDiffSource(opts, files, vcs)
  }
  const identity = pullRequest
    ? `github:${pullRequest.owner.toLowerCase()}/${pullRequest.repository.toLowerCase()}#${pullRequest.number}`
    : JSON.stringify([cwd, diffSource.vcs, opts.from, opts.to, opts.revisions, files])
  const { setupReviewAgent } = await import('./server/reviewAgent.ts')
  const agent = await setupReviewAgent(
    opts.agent === false ? false : opts.model,
    opts.classifierConfig,
  )
  const children: ReturnType<typeof spawn>[] = []
  const { port: apiPort, close } = await startServer({
    diffSource,
    cwd,
    hostname,
    port: opts.port,
    review: {
      directory: reviewDirectory(identity),
      pullRequest,
      models: agent.models,
      model: agent.model,
      agent: agent.status,
      classifierInstructions: agent.classifierInstructions,
      classifierConcurrency: agent.classifierConcurrency,
      toolPolicyKey: agent.toolPolicyKey,
      browserOrigin: opts.dev ? `http://${hostname}:5173` : undefined,
    },
  })
  console.info(pullRequest ? `${pullRequest.title} (${pullRequest.url})` : 'Local review')
  console.info(
    agent.status.available
      ? `Review agent: ${agent.status.model}`
      : (agent.status.error ?? 'Review agent disabled'),
  )
  if (agent.status.classifier) {
    const { provider, model, endpoint } = agent.status.classifier
    console.info(`Decision classifier: ${provider}/${model} (${endpoint})`)
  }
  let stopping = false
  const cleanup = async () => {
    if (stopping) return
    stopping = true
    for (const child of children) child.kill()
    const timeout = setTimeout(() => process.exit(1), 10_000)
    try {
      await close()
      clearTimeout(timeout)
      process.exit(0)
    } catch (error) {
      console.error(error)
      process.exit(1)
    }
  }
  process.on('SIGINT', () => void cleanup())
  process.on('SIGTERM', () => void cleanup())

  const shouldAutoOpen = hostname === 'localhost' && opts.open !== false
  if (opts.dev) {
    const viteArgs = ['vite', '--host', hostname, '--port', '5173', '--strictPort']
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

const program = new Command()
  .name('skepsis')
  .description('Local PR review UI with private, durable agent conversations')

program
  .argument('[files...]', 'GitHub PR URL, or paths to limit the local diff')
  .option('-r, --revisions <revsets>', 'Show changes in these revisions')
  .option('-f, --from <rev>', 'Show changes from this revision')
  .option('-t, --to <rev>', 'Show changes to this revision')
  .option('--git', 'force git mode (skip jj detection)')
  .option('--dev', 'run with Vite dev server for development')
  .option('--host <address>', 'loopback address to bind the HTTP server to', 'localhost')
  .option('--port <port>', 'HTTP port (default: auto; 0 selects a free port)', (value) => {
    if (!/^\d+$/.test(value) || Number(value) > 65535)
      throw new InvalidArgumentError('Port must be an integer from 0 to 65535')
    return Number(value)
  })
  .option(
    '--model <provider/model>',
    'review model (defaults to SKEPSIS_MODEL or Pi settings)',
  )
  .option(
    '--classifier-config <path>',
    'classifier JSON (env: SKEPSIS_CLASSIFIER_CONFIG; default: ~/.config/skepsis/classifier.json)',
  )
  .option('--no-agent', 'disable model calls; keep private history and review drafts')
  .option('--no-open', 'print the server URL without opening a browser')
  .action(async (files: string[], opts: ServeOptions) => {
    await runServe(files, opts)
  })

// Do not reinterpret removed worker commands as path filters and start a server.
// Prefix a literal file of the same name with "./" to review it.
const removedCommand = process.argv[2]
if (removedCommand && ['poll', 'answer', 'fail'].includes(removedCommand)) {
  program.error(
    `The "${removedCommand}" command has been removed. Use private chats in the review UI. To review a path named "${removedCommand}", pass "./${removedCommand}".`,
  )
}

await program.parseAsync()
