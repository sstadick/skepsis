/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { Hono } from 'hono'
import { type SSEStreamingApi, streamSSE } from 'hono/streaming'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { join, relative } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { DiffArgs } from '../shared/types.ts'
import { getDiff } from './diff.ts'
import { parseHunks } from './hunks.ts'
import { loadFileScores } from './scores.ts'
import { registerScoreRoutes } from './scoreRoutes.ts'
import { displayCommand } from './displayCommand.ts'
import { getFileContents } from './fileContents.ts'
import { loadViewed, markViewed, unmarkViewed, unmarkViewedAll } from './viewed.ts'
import { appendComment, insertComment, readComment, removeComment } from './comment.ts'
import { clearServerInfo, createServerToken, writeServerInfo } from './discovery.ts'
import { AgentReviewCoordinator, buildManagedQuestion } from './agentReview.ts'
import {
  appendQuestionFollowUp,
  getQuestionContext,
  hasSerializedQuestionMarker,
  parseStoredReviewThread,
  resolveSafeReviewFilePath,
  serializeEmbeddedQuestion,
  serializeNewReviewBody,
} from './questions.ts'
import { getCommentSyntaxes } from './commentSyntax.ts'
import { loadTheme, saveTheme, themeBootScript } from './settings.ts'
import { createEmbeddedRuntime } from './embeddedRuntime.ts'
import type { AgentRuntime } from './agentRuntime.ts'
import {
  viewedRequestSchema,
  viewedDeleteSchema,
  viewedDeleteAllSchema,
  commentDeleteSchema,
  commentFollowUpSchema,
  commentRequestSchema as sharedCommentRequestSchema,
  fileContentsQuerySchema,
  themeRequestSchema,
} from '../shared/types.ts'
import type {
  AgentBackend,
  CommentResponse,
  DiffResponse,
  ErrorResponse,
  FileContentsResponse,
  OkResponse,
  ThemeResponse,
} from '../shared/types.ts'

type ReviewChange =
  | { reason: 'commented' | 'resolved'; file: string; line: number }
  | {
      reason: 'queued' | 'answered' | 'failed'
      file: string
      line: number
      id: string
      backend: AgentBackend
      state: 'queued' | 'answered' | 'failed'
    }
  | { reason: 'score-queued' | 'scored'; pending: number }

interface PublishedReviewChange {
  id: string
  data: ReviewChange
}

const EVENT_HEARTBEAT_MS = 15_000
const commentRequestSchema =
  'kind' in sharedCommentRequestSchema.shape
    ? sharedCommentRequestSchema
    : sharedCommentRequestSchema.extend({
        // Compatibility fallback until shared/types.ts grows the enum.
        kind: z.enum(['comment', 'question']).default('comment'),
      })

export async function startServer(opts: {
  diffSource: DiffArgs
  port?: number
  hostname?: string
  cwd: string
  runtime?: AgentRuntime
}): Promise<{ port: number; close: () => Promise<void> }> {
  const { diffSource, port = 0, hostname = 'localhost', cwd } = opts
  // Fail fast on bad args by running the exact diff command we'll serve.
  // Result is discarded: /api/diff re-runs it per request to stay fresh.
  await getDiff(diffSource)

  const app = new Hono()
  const runtime = opts.runtime ?? createEmbeddedRuntime(cwd)
  const serverToken = createServerToken()
  const reviewChangeListeners = new Set<(event: PublishedReviewChange) => void>()
  const reviewEventStreams = new Set<SSEStreamingApi>()
  let reviewChangeId = 0
  let reviewMutationTail: Promise<void> = Promise.resolve()

  function assertCommentsEnabled(): void {
    if (!diffSource.commentsEnabled) {
      throw new Error(
        'Review comments are only available when diffing against the working copy',
      )
    }
  }

  async function assertSafeReviewFile(file: string): Promise<void> {
    await resolveSafeReviewFilePath(cwd, file)
  }

  function closeReviewEventStreams(): void {
    for (const stream of reviewEventStreams) stream.abort()
  }

  function publishReviewChange(data: ReviewChange): void {
    const event = { id: String(++reviewChangeId), data }
    for (const listener of reviewChangeListeners) listener(event)
  }

  /**
   * Comment helpers rewrite whole files, and question locations live in memory.
   * Serialize those edits so the file and its stored coordinates change as one
   * ordered operation even when browser and agent requests arrive together.
   */
  function withReviewMutation<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = reviewMutationTail.then(operation)
    reviewMutationTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const agentReviews = new AgentReviewCoordinator({
    cwd,
    runtime,
    mutate: withReviewMutation,
    publish: (data) => publishReviewChange(data),
  })
  const scoring = registerScoreRoutes(app, {
    cwd,
    runtime,
    patch: async () => (await getDiff(diffSource)).patch,
    publish: (reason, pending) => publishReviewChange({ reason, pending }),
    mutate: withReviewMutation,
  })

  app.get('/api/events', (c) => {
    // Disable buffering in reverse proxies while remaining harmless for the
    // normal direct localhost connection.
    c.header('X-Accel-Buffering', 'no')
    return streamSSE(c, async (stream) => {
      reviewEventStreams.add(stream)
      const pending: PublishedReviewChange[] = []
      let wake: (() => void) | undefined
      const listener = (event: PublishedReviewChange) => {
        pending.push(event)
        wake?.()
      }
      reviewChangeListeners.add(listener)

      const cleanUp = () => {
        reviewEventStreams.delete(stream)
        reviewChangeListeners.delete(listener)
        wake?.()
      }
      stream.onAbort(cleanUp)

      try {
        // Flush headers immediately and tell EventSource to reconnect quickly
        // if the local server connection is interrupted.
        await stream.write('retry: 1000\n: connected\n\n')

        // This is a single ordered consumer: parallelizing these awaits would
        // interleave event frames and defeat stream backpressure.
        // oxlint-disable no-await-in-loop
        while (!stream.aborted) {
          const event = pending.shift()
          if (event) {
            await stream.writeSSE({
              event: 'review-changed',
              id: event.id,
              data: JSON.stringify(event.data),
            })
            continue
          }

          const result = await new Promise<'event' | 'heartbeat'>((resolve) => {
            const onEvent = () => {
              clearTimeout(timer)
              if (wake === onEvent) wake = undefined
              resolve('event')
            }
            const timer = setTimeout(() => {
              if (wake === onEvent) wake = undefined
              resolve('heartbeat')
            }, EVENT_HEARTBEAT_MS)
            wake = onEvent
            if (pending.length > 0 || stream.aborted) onEvent()
          })
          if (result === 'heartbeat' && !stream.aborted) {
            await stream.write(': heartbeat\n\n')
          }
        }
        // oxlint-enable no-await-in-loop
      } finally {
        cleanUp()
      }
    })
  })

  app.get('/api/diff', async (c) => {
    const snapshot = await withReviewMutation(async () => {
      const { patch, fileHashes } = await getDiff(diffSource)
      const viewed = await loadViewed(cwd, fileHashes)
      const hunks = parseHunks(patch)
      const scores = await loadFileScores(cwd, hunks)
      const changedFiles = Object.keys(fileHashes)
      if (diffSource.commentsEnabled) {
        await agentReviews.recoverPendingQuestions(changedFiles)
      }
      const commentSyntaxes = diffSource.commentsEnabled
        ? await getCommentSyntaxes(cwd, changedFiles)
        : {}
      return { patch, fileHashes, viewed, hunks, scores, commentSyntaxes }
    })

    return c.json({
      patch: snapshot.patch,
      revset: displayCommand(diffSource),
      vcs: diffSource.vcs,
      commentsEnabled: diffSource.commentsEnabled,
      expandable: diffSource.endpoints !== null,
      fileHashes: snapshot.fileHashes,
      viewed: snapshot.viewed,
      commentSyntaxes: snapshot.commentSyntaxes,
      scores: snapshot.scores,
      scoring: await scoring.snapshot(snapshot.hunks),
    } satisfies DiffResponse)
  })

  app.get('/api/file-contents', zValidator('query', fileContentsQuerySchema), async (c) => {
    const { path, oldPath } = c.req.valid('query')
    const contents = await getFileContents(diffSource, cwd, path, oldPath)
    return c.json(contents satisfies FileContentsResponse)
  })

  app.post('/api/viewed', zValidator('json', viewedRequestSchema), async (c) => {
    const { file, hash } = c.req.valid('json')
    await markViewed(cwd, file, hash)
    return c.json({ ok: true } satisfies OkResponse)
  })

  app.delete('/api/viewed', zValidator('json', viewedDeleteSchema), async (c) => {
    const { file, hash } = c.req.valid('json')
    await unmarkViewed(cwd, file, hash)
    return c.json({ ok: true } satisfies OkResponse)
  })

  app.delete('/api/viewed-all', zValidator('json', viewedDeleteAllSchema), async (c) => {
    const { files } = c.req.valid('json')
    await unmarkViewedAll(cwd, files)
    return c.json({ ok: true } satisfies OkResponse)
  })

  app.post('/api/comment', zValidator('json', commentRequestSchema), async (c) => {
    const { file, afterLine, text, kind } = c.req.valid('json')
    return withReviewMutation(async () => {
      assertCommentsEnabled()
      await assertSafeReviewFile(file)
      if (kind === 'comment') {
        await insertComment(cwd, file, afterLine, serializeNewReviewBody(text, kind))
        publishReviewChange({ reason: 'commented', file, line: afterLine })
        return c.json({ ok: true } satisfies CommentResponse)
      }

      // Read context before insertion so the agent sees source, not the new
      // review block. Validation also happens before mutating the file.
      const { backend, question, body } = serializeEmbeddedQuestion(text)
      const context = await getQuestionContext(cwd, file, afterLine)
      const inserted = await insertComment(cwd, file, afterLine, body)
      const managedQuestion = buildManagedQuestion({
        threadId: inserted.threadId,
        backend,
        file,
        line: afterLine,
        question,
        messages: [{ role: 'user', content: question }],
        ...context,
        commentOpenLine: inserted.openLine,
      })
      const id = agentReviews.start(managedQuestion)
      publishReviewChange({
        reason: 'queued',
        file,
        line: afterLine,
        id,
        backend,
        state: 'queued',
      })
      return c.json({
        ok: true,
        question: { id, backend, state: 'queued' },
      } satisfies CommentResponse)
    })
  })

  app.post(
    '/api/comment/follow-up',
    zValidator('json', commentFollowUpSchema),
    async (c) => {
      const { file, line, text, threadId } = c.req.valid('json')
      const followUp = text.trim()
      if (!followUp) throw new Error('A follow-up message cannot be empty')

      return withReviewMutation(async () => {
        assertCommentsEnabled()
        await assertSafeReviewFile(file)
        const current = await readComment(cwd, file, line)
        const currentThread = parseStoredReviewThread(current.text, current.threadId)
        if (currentThread.kind !== 'question') {
          throw new Error('This review thread is not an agent question')
        }
        if (!currentThread.threadId) {
          throw new Error('This review thread is not a Skepsis-managed question')
        }
        if (!hasSerializedQuestionMarker(current.text)) {
          throw new Error('This review thread cannot accept agent follow-ups')
        }
        if (threadId && currentThread.threadId !== threadId) {
          throw new Error('The review thread moved; refresh and try again')
        }
        if (currentThread.status === 'pending') {
          throw new Error('Wait for the pending response before posting a follow-up')
        }

        const nextBody = appendQuestionFollowUp(current.text, followUp, current.threadId)
        const nextThread = parseStoredReviewThread(nextBody, current.threadId)
        if (nextThread.kind !== 'question' || nextThread.status !== 'pending') {
          throw new Error('Could not serialize the follow-up thread')
        }
        if (!nextThread.threadId) {
          throw new Error('Could not identify the follow-up thread')
        }
        const context = await getQuestionContext(cwd, file, line - 1, {
          start: line,
          end: current.closeLine,
        })
        await appendComment(cwd, file, line, nextBody.slice(current.text.length))
        const id = agentReviews.start(
          buildManagedQuestion({
            threadId: nextThread.threadId,
            backend: currentThread.backend,
            file,
            line: line - 1,
            question: followUp,
            messages: nextThread.messages,
            ...context,
            commentOpenLine: line,
          }),
        )
        publishReviewChange({
          reason: 'queued',
          file,
          line: line - 1,
          id,
          backend: currentThread.backend,
          state: 'queued',
        })
        return c.json({
          ok: true,
          question: { id, backend: currentThread.backend, state: 'queued' },
        } satisfies CommentResponse)
      })
    },
  )

  app.delete('/api/comment', zValidator('json', commentDeleteSchema), async (c) => {
    const { file, line, threadId } = c.req.valid('json')
    return withReviewMutation(async () => {
      assertCommentsEnabled()
      await assertSafeReviewFile(file)
      const current = await readComment(cwd, file, line)
      const thread = parseStoredReviewThread(current.text, current.threadId)
      if (threadId && thread.threadId !== threadId) {
        throw new Error('The review thread moved; refresh and try again')
      }
      if (thread.threadId) agentReviews.abortThread(thread.threadId)
      await removeComment(cwd, file, line)
      publishReviewChange({ reason: 'resolved', file, line })
      return c.json({ ok: true } satisfies OkResponse)
    })
  })

  app.get('/api/theme', async (c) => {
    return c.json({ theme: await loadTheme() } satisfies ThemeResponse)
  })

  // Loaded by a render-blocking <script> in index.html (see themeBootScript).
  // no-store: a cached copy would re-apply an old preference before React
  // corrects it, flashing the wrong theme — the exact problem this solves.
  app.get('/api/theme.js', async (c) => {
    c.header('Cache-Control', 'no-store')
    c.header('Content-Type', 'text/javascript')
    return c.body(themeBootScript(await loadTheme()))
  })

  app.post('/api/theme', zValidator('json', themeRequestSchema), async (c) => {
    await saveTheme(c.req.valid('json').theme)
    return c.json({ ok: true } satisfies OkResponse)
  })

  // Keep this path valid from source (`server/`) and from the published bundle
  // (`dist/cli.js`): both are one directory below the package root.
  const distDir = join(import.meta.dirname, '..', 'dist', 'web')

  // @hono/node-server resolves `root` relative to cwd. On Windows, this cannot
  // cross drive letters; installed-package use is expected on Unix-like hosts.
  app.use('*', serveStatic({ root: relative(cwd, distDir) }))

  // SPA fallback
  app.get('*', async (c) => {
    const html = await readFile(join(distDir, 'index.html'), 'utf-8')
    return c.html(html)
  })

  app.onError((err, c) => {
    return c.json({ error: err.message } satisfies ErrorResponse, 500)
  })

  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname }, async (info) => {
      try {
        const assignedPort = typeof info === 'string' ? port : info.port
        const url = `http://${hostname}:${assignedPort}`
        await writeServerInfo(cwd, { url, token: serverToken })
        console.info(`skepsis on ${url} (${displayCommand(diffSource)})`)
        resolve({
          port: assignedPort,
          close: async () => {
            await scoring.close()
            await agentReviews.close()
            await runtime.close()
            closeReviewEventStreams()
            await reviewMutationTail.catch(() => undefined)
            await clearServerInfo(cwd, { url, token: serverToken })
            await new Promise<void>((resolveClose, rejectClose) => {
              server.close((error) => (error ? rejectClose(error) : resolveClose()))
            })
          },
        })
      } catch (error) {
        closeReviewEventStreams()
        await scoring.close().catch(() => {})
        await agentReviews.close().catch(() => {})
        await runtime.close().catch(() => {})
        server.close()
        reject(error)
      }
    })
  })
}
