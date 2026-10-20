/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { randomBytes } from 'node:crypto'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Models } from '@earendil-works/pi-ai/models'
import {
  createThreadSchema,
  threadMessageSchema,
  draftSchema,
  submitReviewSchema,
  confirmProviderSchema,
  abandonPublicationSchema,
  reviewDraftsDigest,
  type ReviewDraft,
  type PullRequest,
  type ReviewSnapshot,
  type ReviewAnchor,
} from '../shared/review.ts'
import type { DiffArgs } from '../shared/types.ts'
import { priorityRequestSchema } from '../shared/priorities.ts'
import { createReviewPriorities, PriorityRequestError } from './reviewPriorities.ts'
import { openReviewStore, ReviewRequestConflict, type ReviewStore } from './reviewStore.ts'
import { createReviewContext, ReviewValidationError } from './reviewContext.ts'
import { mountAgentReviewApi } from './agentReviewApi.ts'
import { mountGitHubCommentsApi } from './githubCommentsApi.ts'
import {
  preflightReview,
  findPublishedReview,
  publishReview,
  PublicationRejected,
} from './github.ts'

export interface ReviewOptions {
  directory: string
  pullRequest?: PullRequest
  models: Models
  model?: { provider: string; modelId: string }
  agent: ReviewSnapshot['agent']
  classifierInstructions?: string
  classifierConcurrency?: number
  toolPolicyKey?: string
  browserOrigin?: string
}

export async function mountReviewApi(
  app: Hono,
  opts: {
    cwd: string
    diffSource: DiffArgs
    review: ReviewOptions
    publish: () => void
    getOrigin: () => string
  },
): Promise<ReviewStore> {
  const token = randomBytes(32).toString('hex')
  // Keep publication preflight and draft selection atomic with respect to API edits.
  let mutations: Promise<void> = Promise.resolve()
  const context = createReviewContext(opts.cwd, opts.diffSource, opts.review.pullRequest)
  // Progress snapshots must not spawn git/jj. Refresh on diff reloads and anchor
  // actions, including rejected stale actions so the browser can recover.
  let revision = (await context.current()).revision
  const updateRevision = async (next: string) => {
    if (next !== revision) {
      await store.updateRevision(next)
      revision = next
      priorities.invalidate(next)
      opts.publish()
    }
    return next
  }
  const priorities = createReviewPriorities({
    revision,
    models: opts.review.models,
    classifier: opts.review.agent.classifier,
    classifierConcurrency: opts.review.classifierConcurrency,
    current: async (signal) => {
      const state = await context.current(signal)
      await updateRevision(state.revision)
      return state
    },
    publish: opts.publish,
  })
  const refreshRevision = async (patch?: string) =>
    updateRevision(
      (await (patch === undefined ? context.current() : context.revisionForPatch(patch)))
        .revision,
    )
  const anchorContext = async (anchor: ReviewAnchor, requireHunk = false) => {
    try {
      return await context.anchorContext(anchor, requireHunk)
    } finally {
      await refreshRevision()
    }
  }
  const store = await openReviewStore({
    ...opts.review,
    cwd: opts.cwd,
    currentRevision: revision,
    inferenceEnabled: opts.review.agent.enabled ?? opts.review.agent.available,
    tools: context.tools,
    onChange: opts.publish,
  })
  app.use('/api/*', async (c, next) => {
    const origins = [new URL(opts.getOrigin()).origin]
    if (opts.review.browserOrigin) origins.push(new URL(opts.review.browserOrigin).origin)
    const host = c.req.header('host') ?? new URL(c.req.url).host
    if (
      !origins.some((origin) => new URL(origin).host === host) ||
      (c.req.header('origin') !== undefined &&
        !origins.includes(c.req.header('origin')!)) ||
      c.req.header('sec-fetch-site') === 'cross-site'
    )
      return c.json({ error: 'Forbidden origin or host' }, 403)
    const path = c.req.path
    if (
      ['/api/diff', '/api/review', '/api/session', '/api/priorities'].includes(path) ||
      path.startsWith('/api/github/') ||
      path.startsWith('/api/agent-review')
    )
      c.header('Cache-Control', 'no-store')
    const mutation =
      !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
      (path === '/api/agent-review' ||
        path.startsWith('/api/agent-review/') ||
        path.startsWith('/api/github/') ||
        path === '/api/priorities' ||
        path.startsWith('/api/priorities/') ||
        path === '/api/threads' ||
        path.startsWith('/api/threads/') ||
        path === '/api/drafts' ||
        path.startsWith('/api/drafts/') ||
        path.startsWith('/api/review/'))
    if (mutation && c.req.header('x-skepsis-token') !== token)
      return c.json({ error: 'Invalid session token' }, 403)
    const serialized =
      mutation &&
      ((path.startsWith('/api/agent-review/') && path.endsWith('/accept')) ||
        path === '/api/drafts' ||
        path.startsWith('/api/drafts/') ||
        path.startsWith('/api/review/'))
    if (!serialized) {
      await next()
      if (path === '/api/diff' && c.req.method === 'GET' && c.res.ok) {
        const response = await c.res.json()
        const reviewRevision = await refreshRevision(response.patch)
        c.res = c.json({ ...response, reviewRevision })
      }
      return
    }
    const previous = mutations
    let release!: () => void
    mutations = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      await next()
    } finally {
      release()
    }
  })
  app.use('/api/threads/*', bodyLimit({ maxSize: 65536 }))
  app.use('/api/threads', bodyLimit({ maxSize: 65536 }))
  app.use('/api/drafts', bodyLimit({ maxSize: 65536 }))
  app.use('/api/review/*', bodyLimit({ maxSize: 65536 }))
  app.use('/api/agent-review', bodyLimit({ maxSize: 65536 }))
  app.use('/api/agent-review/*', bodyLimit({ maxSize: 65536 }))
  app.use('/api/github/*', bodyLimit({ maxSize: 65536 }))
  app.use('/api/priorities', bodyLimit({ maxSize: 65536 }))
  app.use('/api/priorities/*', bodyLimit({ maxSize: 65536 }))
  // Route-local boundary: legacy endpoints retain their own error handling.
  app.use('/api/*', async (c, next) => {
    await next()
    if (c.error instanceof PriorityRequestError)
      c.res = c.json({ error: c.error.message }, c.error.status)
    if (
      c.error instanceof ReviewValidationError ||
      c.error instanceof PublicationRejected ||
      c.error instanceof ReviewRequestConflict
    )
      c.res = c.json({ error: c.error.message }, 409)
  })
  app.get('/api/session', (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json({ token })
  })
  app.get('/api/review', async (c) =>
    c.json({
      ...(await store.snapshot()),
      revision,
      pullRequest: opts.review.pullRequest ?? null,
      agent: opts.review.agent,
    } satisfies ReviewSnapshot),
  )
  mountGitHubCommentsApi(app, opts.review.pullRequest)
  mountAgentReviewApi(app, {
    store,
    context,
    models: opts.review.models,
    enabled: opts.review.agent.enabled ?? opts.review.agent.available,
    defaultModel: opts.review.model,
    updateRevision,
  })
  app.get('/api/priorities', (c) => c.json(priorities.snapshot()))
  app.post('/api/priorities', async (c) => {
    const parsed = priorityRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid priority request' }, 400)
    const result = await priorities.start(parsed.data)
    return c.json(result, result.status === 'running' ? 202 : 200)
  })
  app.post('/api/priorities/cancel', async (c) => {
    const parsed = priorityRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid priority cancellation' }, 400)
    return c.json(priorities.cancel(parsed.data))
  })
  app.post('/api/threads', async (c) => {
    const parsed = createThreadSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid thread' }, 400)
    if (!opts.review.agent.available)
      return c.json({ error: 'Review agent unavailable' }, 503)
    await store.ask({
      ...parsed.data,
      context: await anchorContext(parsed.data.anchor),
    })
    return c.json({ ok: true })
  })
  app.post('/api/threads/:id/messages', async (c) => {
    const parsed = threadMessageSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid message' }, 400)
    const thread = (await store.snapshot()).threads.find(
      (item) => item.id === c.req.param('id'),
    )
    if (!thread) return c.json({ error: 'Unknown thread' }, 404)
    if (!opts.review.agent.available)
      return c.json({ error: 'Review agent unavailable' }, 503)
    if (thread.providerChange)
      return c.json(
        { error: 'Confirm the provider change before sending private history' },
        409,
      )
    await store.reply(thread.id, {
      ...parsed.data,
      context: await anchorContext(thread.anchor),
    })
    return c.json({ ok: true })
  })
  app.post('/api/threads/:id/provider', async (c) => {
    const parsed = confirmProviderSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid provider confirmation' }, 400)
    const thread = (await store.snapshot()).threads.find(
      (item) => item.id === c.req.param('id'),
    )
    if (!thread) return c.json({ error: 'Unknown thread' }, 404)
    if (!opts.review.agent.available)
      return c.json({ error: 'Review agent unavailable' }, 503)
    if (
      thread.providerChange?.to !== parsed.data.provider ||
      opts.review.model?.provider !== parsed.data.provider
    )
      return c.json({ error: 'Provider confirmation target is outdated' }, 409)
    await store.confirmProvider(thread.id, parsed.data.provider)
    return c.json({ ok: true })
  })
  for (const action of ['cancel', 'resolve'] as const) {
    app.post(`/api/threads/:id/${action}`, async (c) => {
      const id = c.req.param('id')
      if (!(await store.snapshot()).threads.some((thread) => thread.id === id))
        return c.json({ error: 'Unknown thread' }, 404)
      await store[action](id)
      return c.json({ ok: true })
    })
  }
  app.put('/api/drafts', async (c) => {
    const parsed = draftSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid draft' }, 400)
    const old = (await store.snapshot()).drafts.find((draft) => draft.id === parsed.data.id)
    if (!old || JSON.stringify(old.anchor) !== JSON.stringify(parsed.data.anchor))
      await anchorContext(parsed.data.anchor)
    await store.saveDraft(parsed.data)
    return c.json({ ok: true })
  })
  app.delete('/api/drafts/:id', async (c) => {
    await store.deleteDraft(c.req.param('id'))
    return c.json({ ok: true })
  })
  app.post('/api/review/submit', async (c) => {
    const parsed = submitReviewSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid review' }, 400)
    const pr = opts.review.pullRequest
    if (!pr) return c.json({ error: 'Not a GitHub review' }, 400)
    const input = parsed.data
    if (new Set(input.draftIds).size !== input.draftIds.length)
      return c.json({ error: 'Duplicate draft selection' }, 400)
    const snapshot = await store.snapshot()
    if (
      snapshot.publication?.id === input.id &&
      snapshot.publication.status === 'published'
    )
      return c.json({ ok: true })
    if (
      snapshot.publication?.id === input.id &&
      snapshot.publication.status === 'abandoned'
    )
      return c.json({ error: 'Publication was abandoned; start a new submission' }, 409)
    if (
      snapshot.publication &&
      ['publishing', 'uncertain'].includes(snapshot.publication.status)
    )
      return c.json({ error: 'Reconcile the pending review first' }, 409)
    const selected = input.draftIds.map((id) =>
      snapshot.drafts.find((draft) => draft.id === id),
    )
    if (selected.some((draft) => !draft || draft.publishedReviewId !== undefined))
      return c.json({ error: 'Invalid draft selection' }, 409)
    if (
      selected.length &&
      input.draftsDigest !== (await reviewDraftsDigest(selected as ReviewDraft[]))
    )
      return c.json(
        {
          error: 'Selected drafts changed or were not previewed; preview the review again',
        },
        409,
      )
    await Promise.all(selected.map((draft) => anchorContext(draft!.anchor, true)))
    try {
      await preflightReview(pr, input, snapshot.drafts)
    } catch (error) {
      throw new ReviewValidationError(
        error instanceof Error ? error.message : 'GitHub preflight failed',
      )
    }
    // Definitive local validation precedes the durable publication intent.
    // GitHub rechecks remote anchors/currentness immediately before its POST.
    await store.publish(input, (submission, drafts) =>
      publishReview(pr, submission, drafts),
    )
    return c.json({ ok: true })
  })
  app.post('/api/review/reconcile', async (c) => {
    const pr = opts.review.pullRequest
    if (!pr) return c.json({ error: 'Not a GitHub review' }, 400)
    await store.reconcile((id) => findPublishedReview(pr, id))
    return c.json({ ok: true })
  })
  app.post('/api/review/abandon', async (c) => {
    const parsed = abandonPublicationSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success)
      return c.json(
        { error: 'Explicit acknowledgement of duplicate-publication risk is required' },
        400,
      )
    const pr = opts.review.pullRequest
    if (!pr) return c.json({ error: 'Not a GitHub review' }, 400)
    const publication = (await store.snapshot()).publication
    if (publication?.id !== parsed.data.id || publication.status !== 'uncertain')
      return c.json(
        { error: 'The uncertain publication has changed; refresh before unlocking' },
        409,
      )
    // A late receipt always wins over manual unlocking. Failure to check GitHub
    // leaves the uncertainty/freeze intact; this endpoint never sends a review.
    await store.reconcile((id) => findPublishedReview(pr, id))
    if ((await store.snapshot()).publication?.status === 'published')
      return c.json({ ok: true })
    await store.abandonPublication(parsed.data.id)
    return c.json({ ok: true })
  })
  const closeStore = store.close.bind(store)
  let closing: Promise<void> | undefined
  // Begin both shutdowns immediately: a slow classifier transport must not
  // keep the conversational agent running while we wait for it to settle.
  store.close = () =>
    (closing ??= Promise.all([priorities.close(), closeStore()]).then(() => {}))
  return store
}
