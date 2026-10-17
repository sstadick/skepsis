/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import {
  appendFile,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DiffArgs, DiffResponse, FileContentsResponse } from '../shared/types.ts'
import type { AgentQuestion, AgentRuntime } from './agentRuntime.ts'
import { exec, isolateVcsConfig } from './testUtil.ts'

// HOME is also where viewed state is stored, and it's read at module load —
// so isolation must run before main.ts is imported, hence the dynamic import.
const home = await isolateVcsConfig()
const { startServer } = await import('./main.ts')

interface PendingRuntimeCall extends AgentQuestion {
  signal: AbortSignal
  resolve: (value: string) => void
  reject: (error: unknown) => void
}

function abortError(reason: string): Error {
  const error = new Error(reason)
  error.name = 'AbortError'
  return error
}

function resumeKey(threadId: string, requestId: string): string {
  return `${threadId}:${requestId}`
}

type FakeRuntime = AgentRuntime & {
  canResume(threadId: string, requestId: string): Promise<boolean>
  calls: PendingRuntimeCall[]
  scoreCalls: { file: string; text: string; signal: AbortSignal }[]
  canResumeCalls: { threadId: string; requestId: string }[]
  canResumeDecisions: Map<string, boolean>
  setCanResume: (threadId: string, requestId: string, allowed: boolean) => void
  waitForCall: (count: number) => Promise<PendingRuntimeCall>
}

function createFakeRuntime(): FakeRuntime {
  const calls: PendingRuntimeCall[] = []
  const scoreCalls: { file: string; text: string; signal: AbortSignal }[] = []
  const canResumeCalls: { threadId: string; requestId: string }[] = []
  const canResumeDecisions = new Map<string, boolean>()
  const runtime: FakeRuntime = {
    calls,
    scoreCalls,
    canResumeCalls,
    canResumeDecisions,
    answer: (input, signal) =>
      new Promise<string>((resolve, reject) => {
        const call: PendingRuntimeCall = { ...input, signal, resolve, reject }
        signal.addEventListener('abort', () => reject(abortError('aborted')), {
          once: true,
        })
        calls.push(call)
      }),
    canResume: async (threadId: string, requestId: string) => {
      canResumeCalls.push({ threadId, requestId })
      return canResumeDecisions.get(resumeKey(threadId, requestId)) ?? true
    },
    score: async (hunk, signal) => {
      scoreCalls.push({ ...hunk, signal })
      return 0.5
    },
    close: async () => {
      for (const call of calls) {
        if (!call.signal.aborted) call.reject(abortError('closed'))
      }
    },
    setCanResume: (threadId, requestId, allowed) => {
      canResumeDecisions.set(resumeKey(threadId, requestId), allowed)
    },
    waitForCall: async (count) => {
      await expect.poll(() => calls.length).toBe(count)
      return calls[count - 1]!
    },
  }
  return runtime
}

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

const testVcses = (await exec('jj', ['--version']).then(
  () => ['git', 'jj'] as const,
  () => ['git'] as const,
)) as readonly ('git' | 'jj')[]

/**
 * Boot the real server against a real temp repo and exercise the API over
 * HTTP: the diff itself, the viewed round trip (including content-addressed
 * auto-unview), comment insert/remove into working-copy files, and full file
 * contents at the diff endpoints.
 */
describe.each(testVcses)('startServer (%s integration)', (vcs) => {
  let dir: string
  let origCwd: string
  let close: (() => Promise<void>) | undefined
  let url: string
  let runtime: ReturnType<typeof createFakeRuntime>
  let diffSource: DiffArgs

  const run = (cmd: string, args: string[]) => exec(cmd, args, { cwd: dir })

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), `skepsis-server-test-${vcs}-`))
    await run(vcs, vcs === 'git' ? ['init', '-q'] : ['git', 'init'])
    await writeFile(join(dir, 'f.txt'), 'hello\n')
    await writeFile(join(dir, 'g.txt'), 'one\ntwo\nthree\n')
    await writeFile(join(dir, 'del.txt'), 'bye\n')
    await writeFile(join(dir, 'r.txt'), 'rename me\n')
    await writeFile(join(dir, 'c.ts'), 'const one = 1\n')
    if (vcs === 'git') {
      await run('git', ['add', '.'])
      await run('git', ['commit', '-qm', 'init'])
    } else {
      await run('jj', ['commit', '-m', 'init'])
    }
    await writeFile(join(dir, 'f.txt'), 'hello\nworld\n')
    await appendFile(join(dir, 'g.txt'), 'four\n')
    await writeFile(join(dir, 'added.txt'), 'new\n')
    await rm(join(dir, 'del.txt'))
    await rename(join(dir, 'r.txt'), join(dir, 'r2.txt'))
    await appendFile(join(dir, 'r2.txt'), 'plus\n')
    await appendFile(join(dir, 'c.ts'), 'const two = 2\n')

    // getDiff and file-contents spawn git/jj in the process cwd (the CLI
    // always starts the server from inside the target repo), so chdir in.
    origCwd = process.cwd()
    process.chdir(dir)

    const base = { commentsEnabled: true, files: [] }
    diffSource =
      vcs === 'git'
        ? {
            vcs,
            args: ['HEAD'],
            ...base,
            endpoints: { left: 'HEAD', right: 'workingCopy' },
          }
        : {
            vcs,
            args: ['-r', '@'],
            ...base,
            endpoints: { left: '@-', right: { rev: '@' } },
          }
    runtime = createFakeRuntime()
    const started = await startServer({ diffSource, cwd: dir, runtime })
    close = started.close
    url = `http://localhost:${started.port}`
  })

  afterAll(async () => {
    await close?.()
    if (origCwd) process.chdir(origCwd)
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  async function getDiffResponse(): Promise<DiffResponse> {
    const res = await fetch(`${url}/api/diff`)
    expect(res.status).toBe(200)
    return res.json()
  }

  async function api(method: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${url}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async function readVisibleReviewSource(file: string): Promise<string> {
    const content = await readFile(join(dir, file), 'utf-8')
    return content.replace(
      /<review data-skepsis="1" data-thread-id="[0-9a-f-]{36}">/gi,
      '<review>',
    )
  }

  async function firstManagedThreadId(file: string): Promise<string> {
    const content = await readFile(join(dir, file), 'utf-8')
    const id = content.match(
      /<review data-skepsis="1" data-thread-id="([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})">/i,
    )?.[1]
    if (!id) throw new Error(`No managed review thread found in ${file}`)
    return id
  }

  // The default URL deliberately uses this suite's running server.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  async function openReviewEvents(baseUrl = url): Promise<{
    next: () => Promise<Record<string, unknown>>
    close: () => void
  }> {
    const controller = new AbortController()
    const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    const readNext = async (): Promise<Record<string, unknown>> => {
      for (;;) {
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
          return JSON.parse(data) as Record<string, unknown>
        }

        // The event frames must be consumed in stream order.
        // oxlint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read()
        if (done) throw new Error('Review event stream closed')
        buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n')
      }
    }

    return {
      next: async () => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            readNext(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('Timed out waiting for review event')),
                2000,
              )
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
      },
      close: () => {
        controller.abort()
        void reader.cancel().catch(() => {})
      },
    }
  }

  it('serves the diff with content-addressed file hashes', async () => {
    const diff = await getDiffResponse()
    expect(diff.vcs).toBe(vcs)
    expect(diff.commentsEnabled).toBe(true)
    expect(diff.expandable).toBe(true)
    expect(diff.patch).toContain('diff --git a/f.txt b/f.txt')
    expect(diff.patch).toContain('+world')
    // The per-file hash is the (abbreviated) git blob ID of the new contents —
    // the invariant the viewed state's content addressing depends on.
    // hash-object needs no repo, so it works the same in the jj case.
    const { stdout } = await run('git', ['hash-object', 'f.txt'])
    expect(stdout.trim()).toMatch(new RegExp(`^${diff.fileHashes['f.txt']}`))
  })

  it('round-trips viewed state and auto-unviews when content changes', async () => {
    let diff = await getDiffResponse()
    expect(diff.viewed).toEqual({})
    const hash = diff.fileHashes['f.txt']!

    const res = await api('POST', '/api/viewed', { file: 'f.txt', hash })
    expect(await res.json()).toEqual({ ok: true })
    diff = await getDiffResponse()
    expect(diff.viewed['f.txt']).toBe(hash)

    // Changing the file changes its blob ID, so it comes back unviewed with
    // no explicit invalidation.
    await appendFile(join(dir, 'f.txt'), 'more\n')
    diff = await getDiffResponse()
    expect(diff.viewed).toEqual({})
  })

  it('unmarks viewed state individually and in bulk', async () => {
    let diff = await getDiffResponse()
    const fHash = diff.fileHashes['f.txt']!
    const gHash = diff.fileHashes['g.txt']!
    await api('POST', '/api/viewed', { file: 'f.txt', hash: fHash })
    await api('POST', '/api/viewed', { file: 'g.txt', hash: gHash })
    diff = await getDiffResponse()
    expect(diff.viewed).toEqual({ 'f.txt': fHash, 'g.txt': gHash })

    let res = await api('DELETE', '/api/viewed', { file: 'f.txt', hash: fHash })
    expect(await res.json()).toEqual({ ok: true })
    diff = await getDiffResponse()
    expect(diff.viewed).toEqual({ 'g.txt': gHash })

    res = await api('DELETE', '/api/viewed-all', {
      files: [{ file: 'g.txt', hash: gHash }],
    })
    expect(await res.json()).toEqual({ ok: true })
    diff = await getDiffResponse()
    expect(diff.viewed).toEqual({})
  })

  it('inserts and removes review comments in the working copy', async () => {
    const before = await readVisibleReviewSource('g.txt')
    const events = await openReviewEvents()

    try {
      let res = await api('POST', '/api/comment', {
        file: 'g.txt',
        afterLine: 2,
        text: 'needs work',
      })
      expect(await res.json()).toEqual({ ok: true })
      expect(await events.next()).toEqual({
        reason: 'commented',
        file: 'g.txt',
        line: 2,
      })
      // The comment exists as real lines on disk, which is why it shows up in
      // the diff at all.
      const withComment = await readVisibleReviewSource('g.txt')
      expect(withComment).toBe(
        'one\ntwo\n<review>\nSkepsis-Comment: 1\n\nneeds work\n</review>\nthree\nfour\n',
      )
      const diff = await getDiffResponse()
      expect(diff.patch).toMatch(
        /\+<review data-skepsis="1" data-thread-id="[0-9a-f-]{36}">/,
      )
      expect(diff.patch).toContain('+needs work')

      const threadId = await firstManagedThreadId('g.txt')
      const staleDelete = await api('DELETE', '/api/comment', {
        file: 'g.txt',
        line: 3,
        threadId: '99999999-9999-4999-8999-999999999999',
      })
      expect(staleDelete.status).toBe(500)
      expect(await readVisibleReviewSource('g.txt')).toBe(withComment)

      // Remove by the open tag's line number and the file is back to normal
      res = await api('DELETE', '/api/comment', {
        file: 'g.txt',
        line: 3,
        threadId,
      })
      expect(await res.json()).toEqual({ ok: true })
      expect(await events.next()).toEqual({
        reason: 'resolved',
        file: 'g.txt',
        line: 3,
      })
      expect(await readVisibleReviewSource('g.txt')).toBe(before)
    } finally {
      events.close()
    }
  })

  it("wraps review comments in the file's comment syntax", async () => {
    const diff = await getDiffResponse()
    expect(diff.commentSyntaxes['c.ts']).toEqual({ prefix: '//' })

    let res = await api('POST', '/api/comment', {
      file: 'c.ts',
      afterLine: 1,
      text: 'why one?',
    })
    expect(await res.json()).toEqual({ ok: true })
    expect(await readVisibleReviewSource('c.ts')).toBe(
      'const one = 1\n// <review>\n// Skepsis-Comment: 1\n//\n// why one?\n// </review>\nconst two = 2\n',
    )

    res = await api('DELETE', '/api/comment', { file: 'c.ts', line: 2 })
    expect(await res.json()).toEqual({ ok: true })
    expect(await readVisibleReviewSource('c.ts')).toBe('const one = 1\nconst two = 2\n')
  })

  it('treats plain @pi text as a literal comment and never auto-runs it', async () => {
    const before = await readVisibleReviewSource('c.ts')
    const callCount = runtime.calls.length
    const res = await api('POST', '/api/comment', {
      file: 'c.ts',
      afterLine: 1,
      text: '@pi explain this literally',
      kind: 'comment',
    })
    expect(await res.json()).toEqual({ ok: true })
    expect(runtime.calls).toHaveLength(callCount)
    expect(await readVisibleReviewSource('c.ts')).toBe(
      'const one = 1\n// <review>\n// Skepsis-Comment: 1\n//\n// @pi explain this literally\n// </review>\nconst two = 2\n',
    )

    await getDiffResponse()
    expect(runtime.calls).toHaveLength(callCount)

    const resolved = await api('DELETE', '/api/comment', { file: 'c.ts', line: 2 })
    expect(await resolved.json()).toEqual({ ok: true })
    expect(await readVisibleReviewSource('c.ts')).toBe(before)
  })

  it('does not expose the external /api/questions worker protocol', async () => {
    const res = await api('POST', '/api/questions/claim', {})
    expect(res.status).toBe(404)
  })

  it('rejects comment mutations when comments are disabled', async () => {
    const disabledRuntime = createFakeRuntime()
    const started = await startServer({
      diffSource: { ...diffSource, commentsEnabled: false },
      cwd: dir,
      runtime: disabledRuntime,
    })
    const disabledUrl = `http://localhost:${started.port}`
    const request = (method: string, path: string, body: unknown) =>
      fetch(`${disabledUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    try {
      let res = await request('POST', '/api/comment', {
        file: 'g.txt',
        afterLine: 2,
        text: 'nope',
      })
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({
        error: 'Review comments are only available when diffing against the working copy',
      })

      res = await request('POST', '/api/comment/follow-up', {
        file: 'g.txt',
        line: 3,
        text: 'nope',
      })
      expect(res.status).toBe(500)

      res = await request('DELETE', '/api/comment', {
        file: 'g.txt',
        line: 3,
      })
      expect(res.status).toBe(500)
    } finally {
      await started.close()
    }
  })

  it('does not recover questions when comments are disabled', async () => {
    const file = 'g.txt'
    const before = await readFile(join(dir, file), 'utf8')
    await api('POST', '/api/comment', {
      file,
      afterLine: 2,
      text: 'Pending question',
      kind: 'question',
    })
    const readOnlyRuntime = createFakeRuntime()
    const started = await startServer({
      diffSource: { ...diffSource, commentsEnabled: false },
      cwd: dir,
      runtime: readOnlyRuntime,
    })
    try {
      const response = await fetch(`http://localhost:${started.port}/api/diff`)
      expect(response.status).toBe(200)
      expect(readOnlyRuntime.canResumeCalls).toEqual([])
      expect(readOnlyRuntime.calls).toEqual([])
    } finally {
      await started.close()
      await api('DELETE', '/api/comment', { file, line: 3 })
      await writeFile(join(dir, file), before)
    }
  })

  it('closes scoring, reviews, the runtime, and open SSE streams in order', async () => {
    const before = await readVisibleReviewSource('g.txt')
    const trace: string[] = []
    const localRuntime = createFakeRuntime()
    localRuntime.answer = (input, signal) =>
      new Promise<string>((resolve, reject) => {
        trace.push('answer-start')
        const call: PendingRuntimeCall = { ...input, signal, resolve, reject }
        signal.addEventListener(
          'abort',
          () => {
            trace.push('answer-abort')
            reject(abortError('aborted'))
          },
          { once: true },
        )
        localRuntime.calls.push(call)
      })
    localRuntime.score = async (hunk, signal) =>
      new Promise<number>((_resolve, reject) => {
        localRuntime.scoreCalls.push({ ...hunk, signal })
        trace.push(`score-start:${hunk.file}`)
        signal.addEventListener(
          'abort',
          () => {
            trace.push(`score-abort:${hunk.file}`)
            reject(abortError('aborted'))
          },
          { once: true },
        )
      })
    localRuntime.close = async () => {
      trace.push('runtime-close')
      for (const call of localRuntime.calls) {
        if (!call.signal.aborted) call.reject(abortError('closed'))
      }
    }

    const started = await startServer({ diffSource, cwd: dir, runtime: localRuntime })
    const localUrl = `http://localhost:${started.port}`
    const events = await openReviewEvents(localUrl)
    let startedClosed = false

    try {
      const queued = await fetch(`${localUrl}/api/comment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file: 'g.txt',
          afterLine: 2,
          text: 'close order?',
          kind: 'question',
        }),
      })
      expect(queued.status).toBe(200)
      await localRuntime.waitForCall(1)

      const score = await fetch(`${localUrl}/api/score`, { method: 'POST' })
      expect(score.status).toBe(200)
      const scoreBody = (await score.json()) as { queued: number; pending: number }
      expect(scoreBody.queued).toBeGreaterThan(0)
      expect(scoreBody.pending).toBeGreaterThan(0)
      await expect.poll(() => localRuntime.scoreCalls.length).toBeGreaterThan(0)

      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          started.close().then(() => 'closed' as const),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), 2000)
          }),
        ])
        expect(result).toBe('closed')
        startedClosed = true
      } finally {
        clearTimeout(timer)
      }

      const scoreAbortAt = trace.findIndex((entry) => entry.startsWith('score-abort:'))
      const answerAbortAt = trace.indexOf('answer-abort')
      const runtimeCloseAt = trace.indexOf('runtime-close')
      expect(scoreAbortAt).toBeGreaterThanOrEqual(0)
      expect(answerAbortAt).toBeGreaterThan(scoreAbortAt)
      expect(runtimeCloseAt).toBeGreaterThan(answerAbortAt)
    } finally {
      events.close()
      if (!startedClosed) await started.close().catch(() => {})
      await writeFile(join(dir, 'g.txt'), before)
    }
  })

  it('keeps legacy managed @agent blocks visible without auto-running or following up', async () => {
    const sourcePath = join(dir, 'g.txt')
    const before = await readFile(sourcePath, 'utf-8')
    const callCount = runtime.calls.length
    const threadId = '11111111-1111-4111-8111-111111111111'

    try {
      await writeFile(
        sourcePath,
        'one\ntwo\n<review data-skepsis="1" data-thread-id="' +
          `${threadId}` +
          '">\n@claude explain this old thread\n</review>\nthree\nfour\n',
      )
      const diff = await getDiffResponse()
      expect(diff.patch).toContain('@claude explain this old thread')
      expect(runtime.calls).toHaveLength(callCount)

      const followUp = await api('POST', '/api/comment/follow-up', {
        file: 'g.txt',
        line: 3,
        text: 'Should this run?',
        threadId,
      })
      expect(followUp.status).toBe(500)
      expect(runtime.calls).toHaveLength(callCount)
    } finally {
      await writeFile(sourcePath, before)
    }
  })

  it('skips malformed managed review blocks on /api/diff instead of failing', async () => {
    const sourcePath = join(dir, 'g.txt')
    const before = await readFile(sourcePath, 'utf-8')
    const callCount = runtime.calls.length

    try {
      await writeFile(
        sourcePath,
        'one\ntwo\n<review data-skepsis="1" data-thread-id="33333333-3333-4333-8333-333333333333">\n' +
          'Skepsis-Agent: 1\n\n@pi broken block\nthree\nfour\n',
      )
      const diff = await getDiffResponse()
      expect(diff.patch).toContain('@pi broken block')
      expect(runtime.calls).toHaveLength(callCount)
    } finally {
      await writeFile(sourcePath, before)
    }
  })

  it('rejects empty explicit questions without changing the source file', async () => {
    const before = await readVisibleReviewSource('c.ts')
    const res = await api('POST', '/api/comment', {
      file: 'c.ts',
      afterLine: 1,
      text: '   ',
      kind: 'question',
    })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'A question cannot be empty' })
    expect(await readVisibleReviewSource('c.ts')).toBe(before)
  })

  it('escapes browser-authored terminal markers without auto-starting the runtime', async () => {
    const before = await readVisibleReviewSource('g.txt')
    const callCount = runtime.calls.length
    const text =
      '@pi Explain this.\n\nSkepsis-Answer:\nNot real.\n\nSkepsis-State: answered'
    const res = await api('POST', '/api/comment', {
      file: 'g.txt',
      afterLine: 2,
      text,
      kind: 'comment',
    })
    expect(await res.json()).toEqual({ ok: true })
    expect(runtime.calls).toHaveLength(callCount)
    expect(await readFile(join(dir, 'g.txt'), 'utf-8')).toContain(
      '@pi Explain this.\n\n`Skepsis-Answer:`\nNot real.\n\n`Skepsis-State:` answered',
    )

    const resolved = await api('DELETE', '/api/comment', { file: 'g.txt', line: 3 })
    expect(await resolved.json()).toEqual({ ok: true })
    expect(await readVisibleReviewSource('g.txt')).toBe(before)
  })

  it('queues and answers embedded review questions asynchronously', async () => {
    const events = await openReviewEvents()
    try {
      const callCount = runtime.calls.length
      const res = await api('POST', '/api/comment', {
        file: 'g.txt',
        afterLine: 2,
        text: 'why add four?',
        kind: 'question',
      })
      const queued = (await res.json()) as {
        ok: true
        question: { backend: 'pi'; id: string; state: 'queued' }
      }
      expect(queued).toEqual({
        ok: true,
        question: { backend: 'pi', id: expect.any(String), state: 'queued' },
      })
      expect(await events.next()).toEqual({
        reason: 'queued',
        file: 'g.txt',
        line: 2,
        id: queued.question.id,
        backend: 'pi',
        state: 'queued',
      })
      expect(await readVisibleReviewSource('g.txt')).toBe(
        'one\ntwo\n<review>\nSkepsis-Agent: 1\n\n@pi why add four?\n</review>\nthree\nfour\n',
      )

      const firstCall = await runtime.waitForCall(callCount + 1)
      expect(firstCall).toMatchObject({
        threadId: expect.any(String),
        requestId: queued.question.id,
        file: 'g.txt',
        line: 2,
        question: 'why add four?',
        messages: [{ role: 'user', content: 'why add four?' }],
        excerpt: '  1 | one\n> 2 | two\n  3 | three\n  4 | four\n  5 | ',
      })
      const threadId = await firstManagedThreadId('g.txt')
      expect(firstCall.threadId).toBe(threadId)

      firstCall.resolve('Because the runtime said so.')
      expect(await events.next()).toEqual({
        reason: 'answered',
        file: 'g.txt',
        line: 2,
        id: queued.question.id,
        backend: 'pi',
        state: 'answered',
      })
      expect(await readVisibleReviewSource('g.txt')).toBe(
        'one\ntwo\n<review>\nSkepsis-Agent: 1\n\n@pi why add four?\n\nSkepsis-Answer:\n' +
          'Because the runtime said so.\n\nSkepsis-State: answered\n</review>\nthree\nfour\n',
      )

      const staleFollowUp = await api('POST', '/api/comment/follow-up', {
        file: 'g.txt',
        line: 3,
        text: 'This must not land in the wrong thread.',
        threadId: '99999999-9999-4999-8999-999999999999',
      })
      expect(staleFollowUp.status).toBe(500)

      const followUp = await api('POST', '/api/comment/follow-up', {
        file: 'g.txt',
        line: 3,
        text: 'What about three?',
        threadId,
      })
      const requeued = (await followUp.json()) as {
        ok: true
        question: { backend: 'pi'; id: string; state: 'queued' }
      }
      expect(requeued).toEqual({
        ok: true,
        question: { backend: 'pi', id: expect.any(String), state: 'queued' },
      })
      expect(await events.next()).toEqual({
        reason: 'queued',
        file: 'g.txt',
        line: 2,
        id: requeued.question.id,
        backend: 'pi',
        state: 'queued',
      })
      expect(await readVisibleReviewSource('g.txt')).toBe(
        'one\ntwo\n<review>\nSkepsis-Agent: 1\n\n@pi why add four?\n\nSkepsis-Answer:\n' +
          'Because the runtime said so.\n\nSkepsis-State: answered\n\nSkepsis-Thread: 1\n\n' +
          'Skepsis-Followup:\nWhat about three?\n</review>\nthree\nfour\n',
      )

      const followUpCall = await runtime.waitForCall(callCount + 2)
      expect(followUpCall.threadId).toBe(threadId)
      expect(followUpCall.requestId).toBe(requeued.question.id)
      expect(followUpCall.requestId).not.toBe(firstCall.requestId)
      expect(followUpCall).toMatchObject({
        file: 'g.txt',
        line: 2,
        question: 'What about three?',
        messages: [
          { role: 'user', content: 'why add four?' },
          {
            role: 'assistant',
            content: 'Because the runtime said so.',
            outcome: 'answered',
          },
          { role: 'user', content: 'What about three?' },
        ],
        excerpt: '   1 | one\n>  2 | two\n  13 | three\n  14 | four\n  15 | ',
      })

      followUpCall.resolve('Three is the previous value; four is the addition.')
      expect(await events.next()).toEqual({
        reason: 'answered',
        file: 'g.txt',
        line: 2,
        id: requeued.question.id,
        backend: 'pi',
        state: 'answered',
      })
      expect(await readVisibleReviewSource('g.txt')).toBe(
        'one\ntwo\n<review>\nSkepsis-Agent: 1\n\n@pi why add four?\n\nSkepsis-Answer:\n' +
          'Because the runtime said so.\n\nSkepsis-State: answered\n\nSkepsis-Thread: 1\n\n' +
          'Skepsis-Followup:\nWhat about three?\n\nSkepsis-Answer:\n' +
          'Three is the previous value; four is the addition.\n\n' +
          'Skepsis-State: answered\n</review>\nthree\nfour\n',
      )

      const resolved = await api('DELETE', '/api/comment', {
        file: 'g.txt',
        line: 3,
        threadId,
      })
      expect(await resolved.json()).toEqual({ ok: true })
      expect(await events.next()).toEqual({ reason: 'resolved', file: 'g.txt', line: 3 })
    } finally {
      events.close()
    }
  })

  it('serializes concurrent follow-ups so only one runtime request is queued', async () => {
    const before = await readVisibleReviewSource('g.txt')
    try {
      const callCount = runtime.calls.length
      const queued = await api('POST', '/api/comment', {
        file: 'g.txt',
        afterLine: 2,
        text: 'explain four',
        kind: 'question',
      })
      expect(queued.status).toBe(200)
      const initialCall = await runtime.waitForCall(callCount + 1)
      initialCall.resolve('Four was appended.')
      await expect
        .poll(() => readVisibleReviewSource('g.txt'))
        .toBe(
          'one\ntwo\n<review>\nSkepsis-Agent: 1\n\n@pi explain four\n\nSkepsis-Answer:\n' +
            'Four was appended.\n\nSkepsis-State: answered\n</review>\nthree\nfour\n',
        )

      const followUps = await Promise.all([
        api('POST', '/api/comment/follow-up', {
          file: 'g.txt',
          line: 3,
          text: 'First follow-up',
        }),
        api('POST', '/api/comment/follow-up', {
          file: 'g.txt',
          line: 3,
          text: 'Second follow-up',
        }),
      ])
      expect(followUps.map((response) => response.status).toSorted()).toEqual([200, 500])
      const followUpCall = await runtime.waitForCall(callCount + 2)
      expect(['First follow-up', 'Second follow-up']).toContain(followUpCall.question)
    } finally {
      const resolved = await api('DELETE', '/api/comment', { file: 'g.txt', line: 3 })
      expect(await resolved.json()).toEqual({ ok: true })
      expect(await readVisibleReviewSource('g.txt')).toBe(before)
    }
  })

  it('marks embedded questions failed when the runtime rejects', async () => {
    const events = await openReviewEvents()
    try {
      const callCount = runtime.calls.length
      const res = await api('POST', '/api/comment', {
        file: 'g.txt',
        afterLine: 2,
        text: 'why add four?',
        kind: 'question',
      })
      expect(res.status).toBe(200)
      const queued = (await res.json()) as {
        question: { id: string; backend: 'pi'; state: 'queued' }
      }
      expect(await events.next()).toEqual({
        reason: 'queued',
        file: 'g.txt',
        line: 2,
        id: queued.question.id,
        backend: 'pi',
        state: 'queued',
      })

      const call = await runtime.waitForCall(callCount + 1)
      call.reject(new Error('agent unavailable'))
      expect(await events.next()).toEqual({
        reason: 'failed',
        file: 'g.txt',
        line: 2,
        id: queued.question.id,
        backend: 'pi',
        state: 'failed',
      })
      expect(await readVisibleReviewSource('g.txt')).toBe(
        'one\ntwo\n<review>\nSkepsis-Agent: 1\n\n@pi why add four?\n\nSkepsis-Failure:\n' +
          'agent unavailable\n\nSkepsis-State: failed\n</review>\nthree\nfour\n',
      )

      const resolved = await api('DELETE', '/api/comment', { file: 'g.txt', line: 3 })
      expect(await resolved.json()).toEqual({ ok: true })
      expect(await events.next()).toEqual({ reason: 'resolved', file: 'g.txt', line: 3 })
    } finally {
      events.close()
    }
  })

  it('aborts pending work when a question is resolved', async () => {
    const before = await readVisibleReviewSource('g.txt')
    const callCount = runtime.calls.length
    const queued = await api('POST', '/api/comment', {
      file: 'g.txt',
      afterLine: 2,
      text: 'should this remain?',
      kind: 'question',
    })
    expect(queued.status).toBe(200)
    const call = await runtime.waitForCall(callCount + 1)

    const resolved = await api('DELETE', '/api/comment', { file: 'g.txt', line: 3 })
    expect(await resolved.json()).toEqual({ ok: true })
    expect(call.signal.aborted).toBe(true)
    call.resolve('Too late.')
    expect(await readVisibleReviewSource('g.txt')).toBe(before)
  })

  it('drops late answers when another thread replaces the source block', async () => {
    const before = await readVisibleReviewSource('g.txt')
    const replacementThreadId = '99999999-9999-4999-8999-999999999999'
    let currentThreadId: string | undefined

    try {
      const callCount = runtime.calls.length
      const queued = await api('POST', '/api/comment', {
        file: 'g.txt',
        afterLine: 2,
        text: 'can this reply land here?',
        kind: 'question',
      })
      expect(queued.status).toBe(200)
      const call = await runtime.waitForCall(callCount + 1)
      currentThreadId = await firstManagedThreadId('g.txt')

      const sourcePath = join(dir, 'g.txt')
      const source = await readFile(sourcePath, 'utf-8')
      const replaced = source.replace(currentThreadId, replacementThreadId)
      expect(replaced).not.toBe(source)
      await writeFile(sourcePath, replaced)
      currentThreadId = replacementThreadId

      call.resolve('This belongs to the old thread.')
      await expect
        .poll(async () => await readFile(sourcePath, 'utf-8'))
        .not.toContain('This belongs to the old thread.')
    } finally {
      if (currentThreadId) {
        const resolved = await api('DELETE', '/api/comment', {
          file: 'g.txt',
          line: 3,
          threadId: currentThreadId,
        })
        expect(await resolved.json()).toEqual({ ok: true })
      }
      expect(await readVisibleReviewSource('g.txt')).toBe(before)
    }
  })

  it('rejects comment writes outside the repo root', async () => {
    const outsideName = `skepsis-outside-${vcs}-${Date.now()}.txt`
    const outsidePath = join(dir, '..', outsideName)
    await writeFile(outsidePath, 'outside\n')

    try {
      const res = await api('POST', '/api/comment', {
        file: `../${outsideName}`,
        afterLine: 1,
        text: 'escape attempt',
      })
      expect(res.status).toBe(500)
      expect((await res.json()) as { error: string }).toEqual({
        error: `Unsafe review file path: ../${outsideName}`,
      })
      expect(await readFile(outsidePath, 'utf-8')).toBe('outside\n')
    } finally {
      await rm(outsidePath, { force: true })
    }
  })

  it('refuses late answer persistence after the source path becomes a symlink', async () => {
    const sourcePath = join(dir, 'f.txt')
    const outsideName = `skepsis-late-write-${vcs}-${Date.now()}.txt`
    const outsidePath = join(dir, '..', outsideName)
    const before = await readFile(sourcePath, 'utf-8')
    const callCount = runtime.calls.length
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await writeFile(outsidePath, 'outside target\n')
      const queued = await api('POST', '/api/comment', {
        file: 'f.txt',
        afterLine: 1,
        text: 'late write?',
        kind: 'question',
      })
      expect(queued.status).toBe(200)
      const call = await runtime.waitForCall(callCount + 1)
      const pendingSource = await readFile(sourcePath, 'utf-8')

      await rm(sourcePath)
      await symlink(outsidePath, sourcePath)
      call.resolve('This must not escape.')

      await expect.poll(() => errorSpy.mock.calls.length).toBeGreaterThan(0)
      expect(
        errorSpy.mock.calls.some(([message]) =>
          String(message).includes('agent review persistence failed'),
        ),
      ).toBe(true)
      expect(await readFile(outsidePath, 'utf-8')).toBe('outside target\n')

      await rm(sourcePath)
      await writeFile(sourcePath, pendingSource)
      const resolved = await api('DELETE', '/api/comment', { file: 'f.txt', line: 2 })
      expect(await resolved.json()).toEqual({ ok: true })
      expect(await readFile(sourcePath, 'utf-8')).toBe(before)
    } finally {
      errorSpy.mockRestore()
      await rm(sourcePath, { force: true })
      await writeFile(sourcePath, before)
      await rm(outsidePath, { force: true })
    }
  })

  it('skips recovery when the pending source path is no longer a safe file', async () => {
    const sourcePath = join(dir, 'g.txt')
    const outsideName = `skepsis-recovery-source-${vcs}-${Date.now()}.txt`
    const outsidePath = join(dir, '..', outsideName)
    const before = await readFile(sourcePath, 'utf-8')
    const callCount = runtime.calls.length
    const queued = await api('POST', '/api/comment', {
      file: 'g.txt',
      afterLine: 2,
      text: 'unsafe recovery?',
      kind: 'question',
    })
    expect(queued.status).toBe(200)
    await runtime.waitForCall(callCount + 1)
    const pendingSource = await readFile(sourcePath, 'utf-8')

    try {
      await close?.()
      await writeFile(outsidePath, pendingSource)
      await rm(sourcePath)
      await symlink(outsidePath, sourcePath)

      const recoveryRuntime = createFakeRuntime()
      const restarted = await startServer({
        diffSource,
        cwd: dir,
        runtime: recoveryRuntime,
      })
      try {
        const diff = await fetch(`http://localhost:${restarted.port}/api/diff`)
        expect(diff.status).toBe(200)
        expect(recoveryRuntime.canResumeCalls).toEqual([])
        expect(recoveryRuntime.calls).toHaveLength(0)
      } finally {
        await restarted.close()
      }
    } finally {
      await rm(sourcePath, { force: true })
      await writeFile(sourcePath, before)
      await rm(outsidePath, { force: true })
      runtime = createFakeRuntime()
      const restored = await startServer({ diffSource, cwd: dir, runtime })
      close = restored.close
      url = `http://localhost:${restored.port}`
    }
  })

  it('recovers pending managed questions on /api/diff with stable request ids', async () => {
    const before = await readVisibleReviewSource('g.txt')
    const callCount = runtime.calls.length
    const queued = await api('POST', '/api/comment', {
      file: 'g.txt',
      afterLine: 2,
      text: 'recover me?',
      kind: 'question',
    })
    const body = (await queued.json()) as {
      question: { id: string; backend: 'pi'; state: 'queued' }
    }
    const firstCall = await runtime.waitForCall(callCount + 1)
    const threadId = firstCall.threadId

    await close?.()
    runtime = createFakeRuntime()
    const restarted = await startServer({ diffSource, cwd: dir, runtime })
    close = restarted.close
    url = `http://localhost:${restarted.port}`

    const diff = await getDiffResponse()
    expect(diff.patch).toContain('@pi recover me?')
    expect(runtime.canResumeCalls).toEqual([{ threadId, requestId: body.question.id }])
    const recoveredCall = await runtime.waitForCall(1)
    expect(recoveredCall.threadId).toBe(threadId)
    expect(recoveredCall.requestId).toBe(body.question.id)
    expect(recoveredCall).toMatchObject({
      file: 'g.txt',
      line: 2,
      question: 'recover me?',
      messages: [{ role: 'user', content: 'recover me?' }],
    })

    recoveredCall.resolve('Recovered after restart.')
    await expect
      .poll(() => readVisibleReviewSource('g.txt'))
      .toBe(
        'one\ntwo\n<review>\nSkepsis-Agent: 1\n\n@pi recover me?\n\nSkepsis-Answer:\n' +
          'Recovered after restart.\n\nSkepsis-State: answered\n</review>\nthree\nfour\n',
      )

    const resolved = await api('DELETE', '/api/comment', { file: 'g.txt', line: 3 })
    expect(await resolved.json()).toEqual({ ok: true })
    expect(await readVisibleReviewSource('g.txt')).toBe(before)
  })

  it('skips recovery for pending questions the runtime does not recognize', async () => {
    const before = await readVisibleReviewSource('g.txt')
    const callCount = runtime.calls.length
    const queued = await api('POST', '/api/comment', {
      file: 'g.txt',
      afterLine: 2,
      text: 'should not resume?',
      kind: 'question',
    })
    const body = (await queued.json()) as {
      question: { id: string; backend: 'pi'; state: 'queued' }
    }
    const firstCall = await runtime.waitForCall(callCount + 1)
    const threadId = firstCall.threadId

    await close?.()
    runtime = createFakeRuntime()
    runtime.setCanResume(threadId, body.question.id, false)
    const restarted = await startServer({ diffSource, cwd: dir, runtime })
    close = restarted.close
    url = `http://localhost:${restarted.port}`

    const diff = await getDiffResponse()
    expect(diff.patch).toContain('@pi should not resume?')
    expect(runtime.canResumeCalls).toEqual([{ threadId, requestId: body.question.id }])
    expect(runtime.calls).toHaveLength(0)

    const resolved = await api('DELETE', '/api/comment', { file: 'g.txt', line: 3 })
    expect(await resolved.json()).toEqual({ ok: true })
    expect(await readVisibleReviewSource('g.txt')).toBe(before)
  })

  it('answers multiple questions after out-of-order insertions shift their lines', async () => {
    const before = await readVisibleReviewSource('g.txt')
    const callCount = runtime.calls.length

    const bottom = await api('POST', '/api/comment', {
      file: 'g.txt',
      afterLine: 3,
      text: 'why three?',
      kind: 'question',
    })
    expect(bottom.status).toBe(200)
    const bottomCall = await runtime.waitForCall(callCount + 1)
    expect(bottomCall.line).toBe(3)

    const top = await api('POST', '/api/comment', {
      file: 'g.txt',
      afterLine: 1,
      text: 'why one?',
      kind: 'question',
    })
    expect(top.status).toBe(200)
    const topCall = await runtime.waitForCall(callCount + 2)
    expect(topCall.line).toBe(1)

    bottomCall.resolve('bottom answer')
    topCall.resolve('top answer')

    await expect
      .poll(() => readVisibleReviewSource('g.txt'))
      .toBe(
        'one\n<review>\nSkepsis-Agent: 1\n\n@pi why one?\n\nSkepsis-Answer:\ntop answer\n\n' +
          'Skepsis-State: answered\n</review>\ntwo\nthree\n<review>\nSkepsis-Agent: 1\n\n@pi why three?\n\n' +
          'Skepsis-Answer:\nbottom answer\n\nSkepsis-State: answered\n</review>\nfour\n',
      )

    let resolved = await api('DELETE', '/api/comment', { file: 'g.txt', line: 2 })
    expect(await resolved.json()).toEqual({ ok: true })
    resolved = await api('DELETE', '/api/comment', { file: 'g.txt', line: 4 })
    expect(await resolved.json()).toEqual({ ok: true })
    expect(await readVisibleReviewSource('g.txt')).toBe(before)
  })

  it('serves full file contents at both diff endpoints', async () => {
    const res = await fetch(`${url}/api/file-contents?path=f.txt`)
    expect(res.status).toBe(200)
    const contents: FileContentsResponse = await res.json()
    expect(contents.oldContents).toBe('hello\n')
    expect(contents.newContents).toBe(await readFile(join(dir, 'f.txt'), 'utf-8'))
  })

  it('returns null for the missing side of added and deleted files', async () => {
    let res = await fetch(`${url}/api/file-contents?path=added.txt`)
    expect((await res.json()) as FileContentsResponse).toEqual({
      oldContents: null,
      newContents: 'new\n',
    })
    res = await fetch(`${url}/api/file-contents?path=del.txt`)
    expect((await res.json()) as FileContentsResponse).toEqual({
      oldContents: 'bye\n',
      newContents: null,
    })
  })

  it('serves old contents via oldPath for renamed files', async () => {
    const res = await fetch(`${url}/api/file-contents?path=r2.txt&oldPath=r.txt`)
    expect(res.status).toBe(200)
    expect((await res.json()) as FileContentsResponse).toEqual({
      oldContents: 'rename me\n',
      newContents: 'rename me\nplus\n',
    })
  })

  it('rejects malformed requests', async () => {
    const res = await api('POST', '/api/viewed', { file: 'f.txt' }) // missing hash
    expect(res.status).toBe(400)
  })

  // Bad diff args should fail startServer itself, before the first /api/diff.
  it('startServer rejects when the diff command fails', async () => {
    const badSource: DiffArgs =
      vcs === 'git'
        ? { vcs, args: ['not-a-ref'], commentsEnabled: true, files: [], endpoints: null }
        : {
            vcs,
            args: ['-r', 'no_such_rev'],
            commentsEnabled: true,
            files: [],
            endpoints: null,
          }
    await expect(startServer({ diffSource: badSource, cwd: dir })).rejects.toThrow(
      /diff failed/,
    )
  })
})
