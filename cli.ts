#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn, execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Command } from '@commander-js/extra-typings'
import { registerScoreCommands } from './cli/score.ts'
import { startServer } from './server/main.ts'
import type { DiffArgs, DiffEndpoints } from './shared/types.ts'

export interface ServeOptions {
  revisions?: string
  from?: string
  to?: string
  git?: boolean
  dev?: boolean
  host: string
}

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const
const CHILD_STOP_TIMEOUT_MS = 5_000

type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number]

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
        throw new Error(stderr?.trim() || (error as Error).message, {
          cause: error,
        })
      }
    }
  }

  throw new Error(
    `No base revision found for the default diff (tried ${GIT_BASE_CANDIDATES.join(', ')}).\n` +
      'Specify a range explicitly with -r or -f/-t.',
  )
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

// Graceful shutdown should not hang forever behind a stubborn child process.
export function stopChild(
  child: ChildProcess,
  timeoutMs: number = CHILD_STOP_TIMEOUT_MS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()

  return new Promise((resolve, reject) => {
    let finished = false
    let failTimer: ReturnType<typeof setTimeout> | undefined

    const finish = () => {
      if (finished) return
      finished = true
      if (killTimer) clearTimeout(killTimer)
      if (failTimer) clearTimeout(failTimer)
      child.off('close', finish)
      child.off('exit', finish)
      child.off('error', finish)
      resolve()
    }

    const fail = () => {
      if (finished) return
      finished = true
      if (killTimer) clearTimeout(killTimer)
      if (failTimer) clearTimeout(failTimer)
      child.off('close', finish)
      child.off('exit', finish)
      child.off('error', finish)
      reject(
        new Error(
          `Timed out waiting for child process ${child.pid ?? '<unknown>'} to exit`,
        ),
      )
    }

    const killTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        finish()
        return
      }
      child.kill('SIGKILL')
      failTimer = setTimeout(fail, timeoutMs)
    }, timeoutMs)
    child.once('close', finish)
    child.once('exit', finish)
    child.once('error', finish)
    if (child.exitCode !== null || child.signalCode !== null) finish()
    else child.kill('SIGTERM')
  })
}

interface ServeDeps {
  startServer: typeof startServer
  spawn: typeof spawn
}

const DEFAULT_SERVE_DEPS: ServeDeps = {
  startServer,
  spawn,
}

export async function runServe(
  files: string[],
  opts: ServeOptions,
  deps: ServeDeps = DEFAULT_SERVE_DEPS,
): Promise<void> {
  const hostname = opts.host
  const vcs = opts.git ? 'git' : detectVcs()
  const diffSource = buildDiffSource(opts, files, vcs)
  const cwd = process.cwd()
  const children: ChildProcess[] = []
  const checkoutRoot = opts.dev ? requireCheckoutRoot() : undefined
  const serverPromise = deps.startServer({ diffSource, cwd, hostname })

  let resolveStopped!: () => void
  let rejectStopped!: (error: unknown) => void
  const stopped = new Promise<void>((resolve, reject) => {
    resolveStopped = resolve
    rejectStopped = reject
  })

  let shutdownPromise: Promise<void> | undefined
  const isShuttingDown = () => shutdownPromise !== undefined
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise

    for (const signal of SHUTDOWN_SIGNALS) process.off(signal, onSignal)

    shutdownPromise = (async () => {
      const server = await serverPromise
      const results = await Promise.allSettled([
        server.close(),
        ...children.map((child) => stopChild(child)),
      ])
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      if (rejected) throw rejected.reason
    })()

    shutdownPromise.then(resolveStopped, rejectStopped)
    return shutdownPromise
  }

  const onSignal = (_signal: ShutdownSignal) => {
    void shutdown()
  }
  for (const signal of SHUTDOWN_SIGNALS) process.once(signal, onSignal)

  try {
    const { port: apiPort } = await serverPromise
    // A shutdown signal may arrive while startServer() is still resolving.
    // Do not launch Vite or a browser after shutdown has already begun.
    if (isShuttingDown()) {
      await stopped
      return
    }

    const shouldAutoOpen = hostname === 'localhost'
    if (opts.dev) {
      const viteArgs = ['vite', '--host', hostname]
      if (shouldAutoOpen) viteArgs.push('--open')
      const vite = deps.spawn('npx', viteArgs, {
        cwd: checkoutRoot,
        stdio: 'inherit',
        env: { ...process.env, API_HOST: hostname, API_PORT: String(apiPort) },
      })
      children.push(vite)
    } else if (shouldAutoOpen) {
      const url = `http://localhost:${apiPort}`
      const { cmd, args } = urlOpenCommand(url)
      const opener = deps.spawn(cmd, args, { detached: true, stdio: 'ignore' })
      opener.on('error', () => {})
      opener.unref()
    }

    await stopped
  } catch (error) {
    for (const signal of SHUTDOWN_SIGNALS) process.off(signal, onSignal)
    throw error
  }
}

export function removedCommandMessage(name: 'poll' | 'answer' | 'fail'): string {
  return (
    `skepsis ${name} was removed. Ask agent requests are now handled by the running Skepsis server from the browser UI. ` +
    'There is no external question worker CLI anymore.'
  )
}

export function createProgram(): Command {
  const program = new Command()
    .name('skepsis')
    .description(
      'Local diff review UI with source-backed review comments, Ask agent, and scoring',
    )

  program.showHelpAfterError()
  program.showSuggestionAfterError()

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

  for (const removed of ['poll', 'answer', 'fail'] as const) {
    program
      .command(removed, { hidden: true })
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .argument('[args...]')
      .action(() => {
        throw new Error(removedCommandMessage(removed))
      })
  }

  registerScoreCommands(program)
  return program
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  await createProgram()
    .parseAsync(argv)
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}

if (import.meta.main) await main()
