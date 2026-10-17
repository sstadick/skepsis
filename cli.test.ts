/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runServe, stopChild } from './cli.ts'

const projectRoot = import.meta.dirname
const cliPath = join(projectRoot, 'cli.ts')

interface CliResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function runCli(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CliResult> {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: opts.cwd ?? projectRoot,
    env: opts.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  let stdout = ''
  let stderr = ''
  let timedOut = false
  child.stdout.on('data', (chunk: string) => (stdout += chunk))
  child.stderr.on('data', (chunk: string) => (stderr += chunk))

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs ?? 10_000)

    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`CLI timed out\nstdout: ${stdout}\nstderr: ${stderr}`))
        return
      }
      resolve({ code, signal, stdout, stderr })
    })
  })
}

function serverInfoPath(home: string, cwd: string): string {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12)
  return join(home, '.local', 'share', 'skepsis', `${hash}.server.json`)
}

async function initGitRepo(): Promise<{ home: string; repo: string; serverInfo: string }> {
  const home = await mkdtemp(join(tmpdir(), 'skepsis-cli-home-'))
  const repo = await mkdtemp(join(tmpdir(), 'skepsis-cli-repo-'))
  const resolvedRepo = await realpath(repo)
  execFileSync('git', ['init'], { cwd: resolvedRepo, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Skepsis Test'], {
    cwd: resolvedRepo,
    stdio: 'ignore',
  })
  execFileSync('git', ['config', 'user.email', 'skepsis@example.com'], {
    cwd: resolvedRepo,
    stdio: 'ignore',
  })
  await writeFile(join(resolvedRepo, 'example.ts'), 'export const value = 1\n')
  execFileSync('git', ['add', 'example.ts'], { cwd: resolvedRepo, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: resolvedRepo, stdio: 'ignore' })
  await writeFile(join(resolvedRepo, 'example.ts'), 'export const value = 2\n')
  return { home, repo: resolvedRepo, serverInfo: serverInfoPath(home, resolvedRepo) }
}

async function waitFor(
  check: () => boolean,
  failure: string,
  timeoutMs: number = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(failure)
}

describe('skepsis CLI', () => {
  it(
    'reports removed external-question commands with a helpful migration error',
    { timeout: 15_000 },
    async () => {
      const results = await Promise.all(
        ['poll', 'answer', 'fail'].map((command) => runCli([command])),
      )

      for (const [index, command] of ['poll', 'answer', 'fail'].entries()) {
        const result = results[index]!
        expect(result.code).toBe(1)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain(`skepsis ${command} was removed`)
        expect(result.stderr).toContain('There is no external question worker CLI anymore.')
      }
    },
  )

  it('does not spawn late children after SIGTERM races startup', async () => {
    const server = deferred<{ port: number; close: () => Promise<void> }>()
    let closed = 0
    let spawned = 0

    const serving = runServe(
      [],
      { git: true, revisions: 'HEAD', dev: true, host: 'localhost' },
      {
        startServer: async () => server.promise,
        spawn: (() => {
          spawned += 1
          throw new Error('runServe spawned a child after shutdown started')
        }) as typeof spawn,
      },
    )

    expect(process.emit('SIGTERM', 'SIGTERM')).toBe(true)
    server.resolve({
      port: 43123,
      close: async () => {
        closed += 1
      },
    })

    await expect(serving).resolves.toBeUndefined()
    expect(closed).toBe(1)
    expect(spawned).toBe(0)
  })

  it('bounds child shutdown by escalating to SIGKILL when needed', async () => {
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"],
      {
        stdio: 'ignore',
      },
    )

    const start = Date.now()
    await stopChild(child, 100)
    const elapsedMs = Date.now() - start

    expect(elapsedMs).toBeLessThan(5_000)
    expect(child.signalCode ?? child.exitCode).not.toBeNull()
  })

  it(
    'clears discovery state and exits cleanly after SIGTERM',
    { timeout: 15_000 },
    async () => {
      const { home, repo, serverInfo } = await initGitRepo()
      const child = spawn(
        process.execPath,
        [cliPath, '--git', '-r', 'HEAD', '--host', '127.0.0.1'],
        {
          cwd: repo,
          env: { ...process.env, HOME: home },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')

      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })

      try {
        await waitFor(
          () => stdout.includes('skepsis on http://127.0.0.1:'),
          `server never started\nstdout: ${stdout}\nstderr: ${stderr}`,
        )
        await waitFor(() => existsSync(serverInfo), 'discovery file was never written')

        child.kill('SIGTERM')
        const result = await new Promise<CliResult>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL')
            reject(
              new Error(`CLI timed out on shutdown\nstdout: ${stdout}\nstderr: ${stderr}`),
            )
          }, 10_000)
          child.once('error', (error) => {
            clearTimeout(timer)
            reject(error)
          })
          child.once('close', (code, signal) => {
            clearTimeout(timer)
            resolve({ code, signal, stdout, stderr })
          })
        })

        expect(result).toMatchObject({ code: 0, signal: null, stderr: '' })
        expect(existsSync(serverInfo)).toBe(false)
      } finally {
        child.kill('SIGKILL')
        await rm(home, { recursive: true, force: true })
        await rm(repo, { recursive: true, force: true })
      }
    },
  )
})
