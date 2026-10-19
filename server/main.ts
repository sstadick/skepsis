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
import { loadTheme, saveTheme, themeBootScript } from './settings.ts'
import {
  viewedRequestSchema,
  viewedDeleteSchema,
  viewedDeleteAllSchema,
  fileContentsQuerySchema,
  themeRequestSchema,
} from '../shared/types.ts'
import type {
  DiffResponse,
  ErrorResponse,
  FileContentsResponse,
  OkResponse,
  ThemeResponse,
} from '../shared/types.ts'

interface PublishedReviewChange {
  id: string
  event: 'thread-changed'
  data: { reason: 'thread-changed' }
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
  const reviewChangeListeners = new Set<(event: PublishedReviewChange) => void>()
  let reviewChangeId = 0
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

  // Register after the durable Host/Origin middleware, and before static/SPA
  // routes. Old clients get a JSON tombstone in both review and diff-only mode.
  for (const path of [
    '/api/comment',
    '/api/comment/*',
    '/api/questions',
    '/api/questions/*',
  ]) {
    app.all(path, (c) =>
      c.json(
        {
          error:
            'Source-backed comments and the external question queue have been removed. Use private chats instead.',
        } satisfies ErrorResponse,
        410,
      ),
    )
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
              event: event.event,
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
    return c.json({
      patch,
      revset: displayCommand(diffSource),
      vcs: diffSource.vcs,
      expandable: diffSource.endpoints !== null,
      fileHashes,
      viewed,
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
        console.info(`skepsis on ${url} (${displayCommand(diffSource)})`)
        resolve({
          port: assignedPort,
          close: async () => {
            server.close()
            if ('closeAllConnections' in server) server.closeAllConnections()
            await durable?.close()
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
