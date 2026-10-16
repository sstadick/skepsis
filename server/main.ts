/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { zValidator } from '@hono/zod-validator'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { DiffArgs } from '../shared/types.ts'
import type { ReviewOptions } from './reviewApi.ts'
import { getDiff } from './diff.ts'
import { displayCommand } from './displayCommand.ts'
import { getFileContents } from './fileContents.ts'
import { loadViewed, markViewed, unmarkViewed, unmarkViewedAll } from './viewed.ts'
import { appendComment, insertComment, readComment, removeComment } from './comment.ts'
import { clearServerInfo, createServerToken, writeServerInfo } from './discovery.ts'
import {
  appendQuestionFollowUp,
  getQuestionContext,
  parseAgentQuestion,
  questionAnswerSuffix,
  questionFailureSuffix,
  QuestionStore,
  serializeNewReviewBody,
} from './questions.ts'
import { BARE_COMMENT, parseReviewThread } from '../shared/reviewComments.ts'
import { getCommentSyntaxes } from './commentSyntax.ts'
import { loadTheme, saveTheme, themeBootScript } from './settings.ts'
import {
  viewedRequestSchema,
  viewedDeleteSchema,
  viewedDeleteAllSchema,
  commentRequestSchema,
  commentDeleteSchema,
  commentFollowUpSchema,
  questionClaimRequestSchema,
  questionAnswerRequestSchema,
  questionFailRequestSchema,
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
  QuestionClaimResponse,
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

interface PublishedReviewChange {
  id: string
  event?: 'thread-changed'
  data: ReviewChange | { reason: 'thread-changed' }
}

const EVENT_HEARTBEAT_MS = 15_000

export async function startServer(opts: {
  diffSource: DiffArgs
  port?: number
  hostname?: string
  cwd: string
  review?: ReviewOptions
}): Promise<{ port: number; close: () => Promise<void> }> {
  const { diffSource, port = 0, hostname = 'localhost', cwd } = opts
  // Fail fast on bad args by running the exact diff command we'll serve.
  // Result is discarded: /api/diff re-runs it per request to stay fresh.
  await getDiff(diffSource, cwd)

  const app = new Hono()
  const questions = new QuestionStore()
  const serverToken = createServerToken()
  const reviewChangeListeners = new Set<(event: PublishedReviewChange) => void>()
  let reviewChangeId = 0
  let reviewMutationTail: Promise<void> = Promise.resolve()
  let origin = `http://${hostname}:${port}`
  const durable = opts.review
    ? await (
        await import('./reviewApi.ts')
      ).mountReviewApi(app, {
        cwd,
        diffSource,
        review: opts.review,
        getOrigin: () => origin,
        publish: () => {
          const event: PublishedReviewChange = {
            id: String(++reviewChangeId),
            event: 'thread-changed',
            data: { reason: 'thread-changed' },
          }
          for (const listener of reviewChangeListeners) listener(event)
        },
      })
    : undefined

  function unauthorized(auth: string | undefined): ErrorResponse | null {
    return auth === `Bearer ${serverToken}` ? null : { error: 'Unauthorized' }
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

  async function assertThreadIdentity(
    file: string,
    commentOpenLine: number,
    threadId: string,
  ): Promise<void> {
    const current = await readComment(cwd, file, commentOpenLine)
    const thread = parseReviewThread(
      current.text.split('\n'),
      BARE_COMMENT,
      '',
      current.threadId,
    )
    if (thread.threadId !== threadId) {
      throw new Error('The review thread moved; refresh and try again')
    }
  }

  app.get('/api/events', (c) => {
    // Disable buffering in reverse proxies while remaining harmless for the
    // normal direct localhost connection.
    c.header('X-Accel-Buffering', 'no')
    return streamSSE(c, async (stream) => {
      const pending: PublishedReviewChange[] = []
      let wake: (() => void) | undefined
      const listener = (event: PublishedReviewChange) => {
        pending.push(event)
        wake?.()
      }
      reviewChangeListeners.add(listener)

      const cleanUp = () => {
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
              event: event.event ?? 'review-changed',
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
    const { patch, fileHashes } = await getDiff(diffSource, cwd)
    const viewed = await loadViewed(cwd, fileHashes)
    const commentSyntaxes = diffSource.commentsEnabled
      ? await getCommentSyntaxes(cwd, Object.keys(fileHashes))
      : {}
    return c.json({
      patch,
      revset: displayCommand(diffSource),
      vcs: diffSource.vcs,
      commentsEnabled: diffSource.commentsEnabled,
      expandable: diffSource.endpoints !== null,
      fileHashes,
      viewed,
      commentSyntaxes,
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
    const { file, afterLine, text } = c.req.valid('json')
    const parsed = parseAgentQuestion(text)
    const storedText = serializeNewReviewBody(text)
    return withReviewMutation(async () => {
      if (!parsed) {
        const inserted = await insertComment(cwd, file, afterLine, storedText)
        questions.shiftAfter(file, afterLine, inserted.insertedLineCount)
        publishReviewChange({ reason: 'commented', file, line: afterLine })
        return c.json({ ok: true } satisfies CommentResponse)
      }

      // Read context before insertion so the claimed excerpt contains source,
      // not the newly inserted <review> block. Parsing first also ensures an
      // invalid empty backend mention cannot mutate the working copy.
      const context = await getQuestionContext(cwd, file, afterLine)
      const inserted = await insertComment(cwd, file, afterLine, storedText)
      questions.shiftAfter(file, afterLine, inserted.insertedLineCount)
      const job = questions.enqueue({
        threadId: inserted.threadId,
        backend: parsed.backend,
        file,
        line: afterLine,
        question: parsed.question,
        messages: [{ role: 'user', content: parsed.question }],
        ...context,
        commentOpenLine: inserted.openLine,
      })
      publishReviewChange({
        reason: 'queued',
        file,
        line: afterLine,
        id: job.id,
        backend: job.backend,
        state: 'queued',
      })
      return c.json({
        ok: true,
        question: { id: job.id, backend: job.backend, state: 'queued' },
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
        const current = await readComment(cwd, file, line)
        const currentThread = parseReviewThread(
          current.text.split('\n'),
          BARE_COMMENT,
          '',
          current.threadId,
        )
        if (currentThread.kind !== 'question') {
          throw new Error('This review thread is not an agent question')
        }
        if (threadId && currentThread.threadId !== threadId) {
          throw new Error('The review thread moved; refresh and try again')
        }
        if (currentThread.status === 'pending') {
          throw new Error('Wait for the pending response before posting a follow-up')
        }

        const nextBody = appendQuestionFollowUp(current.text, followUp, current.threadId)
        const nextThread = parseReviewThread(
          nextBody.split('\n'),
          BARE_COMMENT,
          '',
          current.threadId,
        )
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
        const appended = await appendComment(
          cwd,
          file,
          line,
          nextBody.slice(current.text.length),
        )
        questions.cancelAtComment(file, line)
        questions.shiftAfter(file, appended.previousCloseLine, appended.insertedLineCount)
        const job = questions.enqueue({
          threadId: nextThread.threadId,
          backend: currentThread.backend,
          file,
          line: line - 1,
          question: followUp,
          messages: nextThread.messages,
          ...context,
          commentOpenLine: line,
        })
        publishReviewChange({
          reason: 'queued',
          file,
          line: line - 1,
          id: job.id,
          backend: job.backend,
          state: 'queued',
        })
        return c.json({
          ok: true,
          question: { id: job.id, backend: job.backend, state: 'queued' },
        } satisfies CommentResponse)
      })
    },
  )

  app.delete('/api/comment', zValidator('json', commentDeleteSchema), async (c) => {
    const { file, line, threadId } = c.req.valid('json')
    return withReviewMutation(async () => {
      if (threadId) {
        const current = await readComment(cwd, file, line)
        const thread = parseReviewThread(
          current.text.split('\n'),
          BARE_COMMENT,
          '',
          current.threadId,
        )
        if (thread.threadId !== threadId) {
          throw new Error('The review thread moved; refresh and try again')
        }
      }
      const removed = await removeComment(cwd, file, line)
      questions.cancelAtComment(file, line)
      questions.shiftAfter(
        file,
        line + removed.removedLineCount - 1,
        -removed.removedLineCount,
      )
      publishReviewChange({ reason: 'resolved', file, line })
      return c.json({ ok: true } satisfies OkResponse)
    })
  })

  app.post(
    '/api/questions/claim',
    zValidator('json', questionClaimRequestSchema),
    async (c) => {
      const err = unauthorized(c.req.header('authorization'))
      if (err) return c.json(err satisfies ErrorResponse, 401)
      const { backend, worker } = c.req.valid('json')
      return withReviewMutation(() =>
        c.json({
          question: questions.claim(backend, worker),
        } satisfies QuestionClaimResponse),
      )
    },
  )

  app.post(
    '/api/questions/:id/answer',
    zValidator('json', questionAnswerRequestSchema),
    async (c) => {
      const err = unauthorized(c.req.header('authorization'))
      if (err) return c.json(err satisfies ErrorResponse, 401)
      const { leaseId, answer } = c.req.valid('json')
      if (!answer.trim()) throw new Error('An answer cannot be empty')
      return withReviewMutation(async () => {
        const job = questions.getClaimed(c.req.param('id'), leaseId)
        await assertThreadIdentity(job.file, job.commentOpenLine, job.threadId)
        const appended = await appendComment(
          cwd,
          job.file,
          job.commentOpenLine,
          questionAnswerSuffix(answer),
        )
        questions.shiftAfter(
          job.file,
          appended.previousCloseLine,
          appended.insertedLineCount,
        )
        questions.markAnswered(job.id, answer)
        publishReviewChange({
          reason: 'answered',
          file: job.file,
          line: job.line,
          id: job.id,
          backend: job.backend,
          state: 'answered',
        })
        return c.json({ ok: true } satisfies OkResponse)
      })
    },
  )

  app.post(
    '/api/questions/:id/fail',
    zValidator('json', questionFailRequestSchema),
    async (c) => {
      const err = unauthorized(c.req.header('authorization'))
      if (err) return c.json(err satisfies ErrorResponse, 401)
      const { leaseId, error } = c.req.valid('json')
      if (!error.trim()) throw new Error('A failure message cannot be empty')
      return withReviewMutation(async () => {
        const job = questions.getClaimed(c.req.param('id'), leaseId)
        await assertThreadIdentity(job.file, job.commentOpenLine, job.threadId)
        const appended = await appendComment(
          cwd,
          job.file,
          job.commentOpenLine,
          questionFailureSuffix(error),
        )
        questions.shiftAfter(
          job.file,
          appended.previousCloseLine,
          appended.insertedLineCount,
        )
        questions.markFailed(job.id, error)
        publishReviewChange({
          reason: 'failed',
          file: job.file,
          line: job.line,
          id: job.id,
          backend: job.backend,
          state: 'failed',
        })
        return c.json({ ok: true } satisfies OkResponse)
      })
    },
  )

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

  // PR checkouts need not share the launcher's cwd. Serve assets from the
  // package itself, independently of the repository being reviewed.
  app.use('*', serveStatic({ root: distDir }))

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
        origin = url
        await writeServerInfo(cwd, { url, token: serverToken })
        console.info(`skepsis on ${url} (${displayCommand(diffSource)})`)
        resolve({
          port: assignedPort,
          close: async () => {
            server.close()
            if ('closeAllConnections' in server) server.closeAllConnections()
            await reviewMutationTail
            await durable?.close()
            await clearServerInfo(cwd, { url, token: serverToken })
          },
        })
      } catch (error) {
        server.close()
        await durable?.close()
        reject(error)
      }
    })
    server.on('error', (error) => {
      void durable?.close()
      reject(error)
    })
  })
}
