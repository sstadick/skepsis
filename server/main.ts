/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { zValidator } from '@hono/zod-validator'
import { join, relative } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { DiffArgs } from '../shared/types.ts'
import { getDiff } from './diff.ts'
import { displayCommand } from './displayCommand.ts'
import { getFileContents } from './fileContents.ts'
import { loadViewed, markViewed, unmarkViewed, unmarkViewedAll } from './viewed.ts'
import { insertComment, removeComment, replaceComment } from './comment.ts'
import { clearServerInfo, createServerToken, writeServerInfo } from './discovery.ts'
import {
  appendQuestionAnswer,
  getQuestionContext,
  parseAgentQuestion,
  QuestionStore,
} from './questions.ts'
import { getCommentSyntaxes } from './commentSyntax.ts'
import { loadTheme, saveTheme, themeBootScript } from './settings.ts'
import {
  viewedRequestSchema,
  viewedDeleteSchema,
  viewedDeleteAllSchema,
  commentRequestSchema,
  commentDeleteSchema,
  questionClaimRequestSchema,
  questionAnswerRequestSchema,
  questionFailRequestSchema,
  fileContentsQuerySchema,
  themeRequestSchema,
} from '../shared/types.ts'
import type {
  CommentResponse,
  DiffResponse,
  ErrorResponse,
  FileContentsResponse,
  OkResponse,
  QuestionClaimResponse,
  ThemeResponse,
} from '../shared/types.ts'

export async function startServer(opts: {
  diffSource: DiffArgs
  port?: number
  hostname?: string
  cwd: string
}): Promise<{ port: number; close: () => void }> {
  const { diffSource, port = 0, hostname = 'localhost', cwd } = opts
  // Fail fast on bad args by running the exact diff command we'll serve.
  // Result is discarded: /api/diff re-runs it per request to stay fresh.
  await getDiff(diffSource)

  const app = new Hono()
  const questions = new QuestionStore()
  const serverToken = createServerToken()

  function unauthorized(auth: string | undefined): ErrorResponse | null {
    return auth === `Bearer ${serverToken}` ? null : { error: 'Unauthorized' }
  }

  app.get('/api/diff', async (c) => {
    const { patch, fileHashes } = await getDiff(diffSource)
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
    const inserted = await insertComment(cwd, file, afterLine, text)
    const parsed = parseAgentQuestion(text)
    if (!parsed) return c.json({ ok: true } satisfies CommentResponse)

    const context = await getQuestionContext(cwd, file, afterLine)
    const job = questions.enqueue({
      backend: parsed.backend,
      file,
      line: afterLine,
      question: parsed.question,
      ...context,
      commentOpenLine: inserted.openLine,
      commentBody: text,
    })
    return c.json({
      ok: true,
      question: { id: job.id, backend: job.backend, state: 'queued' },
    } satisfies CommentResponse)
  })

  app.delete('/api/comment', zValidator('json', commentDeleteSchema), async (c) => {
    const { file, line } = c.req.valid('json')
    await removeComment(cwd, file, line)
    return c.json({ ok: true } satisfies OkResponse)
  })

  app.post(
    '/api/questions/claim',
    zValidator('json', questionClaimRequestSchema),
    async (c) => {
      const err = unauthorized(c.req.header('authorization'))
      if (err) return c.json(err satisfies ErrorResponse, 401)
      const { backend, worker } = c.req.valid('json')
      return c.json({
        question: questions.claim(backend, worker),
      } satisfies QuestionClaimResponse)
    },
  )

  app.post(
    '/api/questions/:id/answer',
    zValidator('json', questionAnswerRequestSchema),
    async (c) => {
      const err = unauthorized(c.req.header('authorization'))
      if (err) return c.json(err satisfies ErrorResponse, 401)
      const { leaseId, answer } = c.req.valid('json')
      const job = questions.getClaimed(c.req.param('id'), leaseId)
      await replaceComment(
        cwd,
        job.file,
        job.commentOpenLine,
        appendQuestionAnswer(job.commentBody, answer),
      )
      questions.markAnswered(job.id, answer)
      return c.json({ ok: true } satisfies OkResponse)
    },
  )

  app.post(
    '/api/questions/:id/fail',
    zValidator('json', questionFailRequestSchema),
    async (c) => {
      const err = unauthorized(c.req.header('authorization'))
      if (err) return c.json(err satisfies ErrorResponse, 401)
      const { leaseId, error } = c.req.valid('json')
      const job = questions.getClaimed(c.req.param('id'), leaseId)
      questions.markFailed(job.id, error)
      return c.json({ ok: true } satisfies OkResponse)
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
          close: () => {
            void clearServerInfo(cwd, { url, token: serverToken })
            server.close()
          },
        })
      } catch (error) {
        server.close()
        reject(error)
      }
    })
  })
}
