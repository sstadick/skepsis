/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { QuestionClaim, QuestionClaimResponse } from './shared/types.ts'

const TOKEN = 'test-token'

interface RecordedRequest {
  method: string | undefined
  path: string | undefined
  headers: IncomingHttpHeaders
  body: unknown
}

interface FakeQueue {
  url: string
  requests: RecordedRequest[]
  emitQueued: (backend: 'pi' | 'claude' | 'codex') => void
  close: () => Promise<void>
}

interface CliResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
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

async function startFakeQueue(
  responseForClaim: (
    claimNumber: number,
  ) => QuestionClaimResponse | Promise<QuestionClaimResponse>,
): Promise<FakeQueue> {
  const requests: RecordedRequest[] = []
  const eventClients = new Set<ServerResponse>()
  let claimCount = 0
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/events') {
      requests.push({
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: undefined,
      })
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      res.write('retry: 1000\n: connected\n\n')
      eventClients.add(res)
      res.on('close', () => eventClients.delete(res))
      return
    }

    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      requests.push({
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: rawBody ? (JSON.parse(rawBody) as unknown) : undefined,
      })
      const response = responseForClaim(++claimCount)
      void Promise.resolve(response).then((body) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      })
    })
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
    throw new Error('Fake queue did not bind a TCP port')
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    emitQueued: (backend) => {
      const frame =
        'event: review-changed\n' +
        `data: ${JSON.stringify({ reason: 'queued', backend })}\n\n`
      for (const client of eventClients) client.write(frame)
    },
    close: () => closeServer(server),
  }
}

function runCli(args: string[], timeoutMs = 10_000): Promise<CliResult> {
  const child = spawn(process.execPath, ['cli.ts', ...args], {
    cwd: import.meta.dirname,
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
    }, timeoutMs)

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

function serverArgs(queue: FakeQueue): string[] {
  return ['--server', queue.url, '--token', TOKEN]
}

function claimRequests(queue: FakeQueue): RecordedRequest[] {
  return queue.requests.filter((request) => request.path === '/api/questions/claim')
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitForRequest(queue: FakeQueue, path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (queue.requests.some((request) => request.path === path)) return
    // The spawned TypeScript CLI has a short startup cost.
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${path}`)
}

describe('skepsis poll CLI', () => {
  it('makes one authenticated claim request in one-shot mode', async () => {
    const queue = await startFakeQueue(() => ({ question: null }))
    try {
      const result = await runCli([
        'poll',
        '--backend',
        'claude',
        '--worker',
        'test-worker',
        '--json',
        ...serverArgs(queue),
      ])

      expect(result).toMatchObject({ code: 0, signal: null, stdout: '', stderr: '' })
      expect(claimRequests(queue)).toHaveLength(1)
      expect(claimRequests(queue)[0]).toMatchObject({
        method: 'POST',
        path: '/api/questions/claim',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body: { backend: 'claude', worker: 'test-worker' },
      })
    } finally {
      await queue.close()
    }
  })

  it('prints the ordered conversation for a threaded non-JSON claim', async () => {
    const question = {
      id: 'question-thread',
      backend: 'codex',
      file: 'src/example.ts',
      line: 7,
      question: 'And under concurrency?',
      messages: [
        { role: 'user' as const, content: 'Is this safe?' },
        {
          role: 'assistant' as const,
          content: 'It is safe for one caller.',
          outcome: 'answered' as const,
        },
        { role: 'user' as const, content: 'And under concurrency?' },
      ],
      excerpt: '> 7 | return value',
      lineText: 'return value',
      leaseId: 'lease-thread',
    } satisfies QuestionClaim
    const queue = await startFakeQueue(() => ({ question }))
    try {
      const result = await runCli(['poll', '--backend', 'codex', ...serverArgs(queue)])

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('question: And under concurrency?')
      expect(result.stdout).toContain('conversation:\n  user: Is this safe?')
      expect(result.stdout).toContain('  assistant (answered): It is safe for one caller.')
      expect(result.stdout).toContain('  user: And under concurrency?')
    } finally {
      await queue.close()
    }
  })

  it('waits until one question is available, then exits without over-claiming', async () => {
    const question = {
      id: 'question-1',
      backend: 'codex',
      file: 'src/example.ts',
      line: 7,
      question: 'Why is this needed?',
      messages: [{ role: 'user', content: 'Why is this needed?' }],
      excerpt: '> 7 | return value',
      lineText: 'return value',
      leaseId: 'lease-1',
    } satisfies QuestionClaim
    const queue = await startFakeQueue((requestNumber) => ({
      question: requestNumber === 2 ? question : null,
    }))

    try {
      const resultPromise = runCli([
        'poll',
        '--backend',
        'codex',
        '--worker',
        'wait-worker',
        '--json',
        '--wait',
        ...serverArgs(queue),
      ])
      await waitForRequest(queue, '/api/events')
      queue.emitQueued('claude')
      queue.emitQueued('codex')
      const result = await resultPromise

      expect(result).toMatchObject({ code: 0, signal: null, stderr: '' })
      expect(JSON.parse(result.stdout) as unknown).toEqual(question)
      expect(claimRequests(queue)).toHaveLength(2)
      expect(
        queue.requests.filter((request) => request.path === '/api/events'),
      ).toHaveLength(1)
    } finally {
      await queue.close()
    }
  })

  it('exits silently when a numeric wait expires with no question', async () => {
    const queue = await startFakeQueue(() => ({ question: null }))
    try {
      const result = await runCli([
        'poll',
        '--json',
        '--wait',
        '0.05',
        ...serverArgs(queue),
      ])

      expect(result).toMatchObject({ code: 0, signal: null, stdout: '', stderr: '' })
      expect(claimRequests(queue)).toHaveLength(1)
      expect(
        queue.requests.filter((request) => request.path === '/api/events'),
      ).toHaveLength(1)
    } finally {
      await queue.close()
    }
  })

  it('finishes and prints a claim started before the numeric deadline', async () => {
    const question = {
      id: 'question-delayed',
      backend: 'codex',
      file: 'src/example.ts',
      line: 7,
      question: 'Why wait?',
      messages: [{ role: 'user', content: 'Why wait?' }],
      excerpt: '> 7 | return value',
      lineText: 'return value',
      leaseId: 'lease-delayed',
    } satisfies QuestionClaim
    const queue = await startFakeQueue(async () => {
      await delay(100)
      return { question }
    })
    try {
      const result = await runCli([
        'poll',
        '--json',
        '--wait',
        '0.05',
        ...serverArgs(queue),
      ])

      expect(result).toMatchObject({ code: 0, signal: null, stderr: '' })
      expect(JSON.parse(result.stdout) as unknown).toEqual(question)
      expect(claimRequests(queue)).toHaveLength(1)
    } finally {
      await queue.close()
    }
  })

  it('does not start another claim after a delayed empty claim crosses the deadline', async () => {
    const queue = await startFakeQueue(async () => {
      await delay(100)
      return { question: null }
    })
    try {
      const resultPromise = runCli([
        'poll',
        '--backend',
        'codex',
        '--json',
        '--wait',
        '0.05',
        ...serverArgs(queue),
      ])
      await waitForRequest(queue, '/api/questions/claim')
      queue.emitQueued('codex')
      const result = await resultPromise

      expect(result).toMatchObject({ code: 0, signal: null, stdout: '', stderr: '' })
      expect(claimRequests(queue)).toHaveLength(1)
    } finally {
      await queue.close()
    }
  })

  it('rejects invalid and nonpositive wait values before polling', async () => {
    const queue = await startFakeQueue(() => ({ question: null }))
    try {
      const results = await Promise.all(
        ['nope', '0', '-1'].map((value) =>
          runCli(['poll', `--wait=${value}`, '--json', ...serverArgs(queue)]),
        ),
      )
      for (const result of results) {
        expect(result.code).toBe(1)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain('--wait must be a positive number of seconds')
      }
      expect(queue.requests).toHaveLength(0)
    } finally {
      await queue.close()
    }
  })
})
