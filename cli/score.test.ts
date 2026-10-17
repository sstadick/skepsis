/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const TOKEN = 'test-token'
const projectRoot = join(import.meta.dirname, '..')
const cliPath = join(projectRoot, 'cli.ts')

interface RecordedRequest {
  method: string | undefined
  path: string | undefined
  headers: IncomingHttpHeaders
}

interface ScoreServer {
  url: string
  requests: RecordedRequest[]
  close: () => Promise<void>
}

interface CliResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

function runCli(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CliResult> {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
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

async function createDiscoveredServer(server: ScoreServer): Promise<{
  home: string
  repo: string
  env: NodeJS.ProcessEnv
  close: () => Promise<void>
}> {
  const home = await mkdtemp(join(tmpdir(), 'skepsis-score-home-'))
  const repo = await mkdtemp(join(tmpdir(), 'skepsis-score-repo-'))
  const infoPath = serverInfoPath(home, repo)
  await mkdir(join(home, '.local', 'share', 'skepsis'), { recursive: true })
  await writeFile(infoPath, JSON.stringify({ url: server.url, token: TOKEN }) + '\n')
  return {
    home,
    repo,
    env: { ...process.env, HOME: home },
    close: async () => {
      await rm(home, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    },
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
    server.closeAllConnections()
  })
}

async function startMockScoreServer(
  options: {
    onTrigger?: () => { queued: number; pending: number }
  } = {},
): Promise<ScoreServer> {
  const requests: RecordedRequest[] = []
  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, headers: req.headers })

    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad token' }))
      return
    }

    if (req.method === 'POST' && req.url === '/api/score') {
      req.resume()
      const body = options.onTrigger?.() ?? { queued: 2, pending: 2 }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
      return
    }

    if (req.method === 'DELETE' && req.url === '/api/score') {
      req.resume()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new Error('mock score server failed to bind')
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  }
}

describe('skepsis score CLI', () => {
  it('discovers the running server and queues embedded scoring with the default command', async () => {
    const server = await startMockScoreServer({
      onTrigger: () => ({ queued: 3, pending: 5 }),
    })
    const discovered = await createDiscoveredServer(server)

    try {
      const result = await runCli(['score', '--cwd', discovered.repo], {
        env: discovered.env,
      })

      expect(result).toMatchObject({
        code: 0,
        signal: null,
        stdout: 'queued 3, pending 5\n',
        stderr: '',
      })
      expect(server.requests).toEqual([
        expect.objectContaining({
          method: 'POST',
          path: '/api/score',
          headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }),
        }),
      ])
    } finally {
      await discovered.close()
      await server.close()
    }
  })

  it('discovers the running server and cancels pending scoring work', async () => {
    const server = await startMockScoreServer()
    const discovered = await createDiscoveredServer(server)

    try {
      const result = await runCli(['score', '--cwd', discovered.repo, 'cancel'], {
        env: discovered.env,
      })

      expect(result).toMatchObject({ code: 0, signal: null, stdout: '', stderr: '' })
      expect(server.requests).toEqual([
        expect.objectContaining({
          method: 'DELETE',
          path: '/api/score',
          headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }),
        }),
      ])
    } finally {
      await discovered.close()
      await server.close()
    }
  })

  it('reports removed score worker subcommands with a helpful migration error', async () => {
    const commands = ['claim', 'submit', 'fail', 'config', 'trigger']
    const results = await Promise.all(commands.map((command) => runCli(['score', command])))

    for (const [index, command] of commands.entries()) {
      const result = results[index]!
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain(`skepsis score ${command} was removed`)
      expect(result.stderr).toContain('Use skepsis score to queue embedded scoring')
      expect(result.stderr).toContain('skepsis score cancel')
    }
  })
})
