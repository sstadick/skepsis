/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import type { Hono } from 'hono'
import { getSupportedThinkingLevels, type Models } from '@earendil-works/pi-ai/models'
import {
  findingMessageSchema,
  startAgentReviewSchema,
  type ReviewAgentModels,
  type ReviewLocation,
} from '../shared/agentReview.ts'
import type { ReviewStore } from './reviewStore.ts'
import type { createReviewContext } from './reviewContext.ts'

type ReviewContext = ReturnType<typeof createReviewContext>
type Options = {
  store: ReviewStore
  context: ReviewContext
  models: Models
  enabled: boolean
  defaultModel?: { provider: string; modelId: string }
  updateRevision: (revision: string) => Promise<string>
}

/** Original patch-side locations only, never expanded browser hunks or model-supplied ranges. */
function locations(state: Awaited<ReturnType<ReviewContext['current']>>): ReviewLocation[] {
  return state.files.flatMap((file) =>
    file.hunks.flatMap((hunk) =>
      [
        {
          path: file.name,
          side: 'LEFT' as const,
          start: hunk.deletionStart,
          count: hunk.deletionCount,
        },
        {
          path: file.name,
          side: 'RIGHT' as const,
          start: hunk.additionStart,
          count: hunk.additionCount,
        },
      ].filter((range) => range.count > 0),
    ),
  )
}

export function mountAgentReviewApi(app: Hono, opts: Options) {
  const available = () =>
    opts.enabled ? opts.models.getAvailableOfType('chat') : Promise.resolve([])
  const current = async () => {
    const state = await opts.context.current()
    await opts.updateRevision(state.revision)
    return state
  }
  app.get('/api/agent-review/models', async (c) => {
    try {
      const models = (await available()).map((model) => ({
        provider: model.provider,
        modelId: model.id,
        name: model.name,
        reasoningLevels: getSupportedThinkingLevels(model),
      }))
      return c.json({
        models,
        defaultModel: opts.defaultModel ?? null,
      } satisfies ReviewAgentModels)
    } catch {
      return c.json(
        { error: 'Unable to load available review agents. Check Pi authentication.' },
        503,
      )
    }
  })
  app.post('/api/agent-review', async (c) => {
    const parsed = startAgentReviewSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid agent review request' }, 400)
    const input = parsed.data
    // A lost response must not turn an admitted request into a new model call.
    // Exact retries remain receipts even after credentials or the diff change.
    const existing = (await opts.store.snapshot()).agentReviews.find(
      (run) => run.id === input.id,
    )
    if (existing) {
      const matches =
        existing.revision === input.revision &&
        existing.turns[0]?.question === input.prompt &&
        existing.model.provider === input.model.provider &&
        existing.model.modelId === input.model.modelId &&
        existing.reasoningLevel === input.reasoningLevel
      return matches
        ? c.json({ ok: true }, 202)
        : c.json({ error: 'Review ID is already used for another request.' }, 409)
    }
    if (!opts.enabled)
      return c.json({ error: 'Agent reviews are disabled (--no-agent).' }, 503)
    let model
    try {
      model = (await available()).find(
        (item) => item.provider === input.model.provider && item.id === input.model.modelId,
      )
    } catch {
      return c.json({ error: 'Unable to check agent authentication.' }, 503)
    }
    if (!model) return c.json({ error: 'Selected review agent is unavailable.' }, 400)
    if (!getSupportedThinkingLevels(model).includes(input.reasoningLevel))
      return c.json({ error: 'Unsupported reasoning level for the selected agent.' }, 400)
    const state = await current()
    if (state.revision !== input.revision)
      return c.json({ error: 'Review revision is stale; reload the diff.' }, 409)
    if (!state.patch.trim())
      return c.json({ error: 'There are no changes to review.' }, 400)
    // Explicit failure, not a silently incomplete whole-diff review. Read-only tools
    // remain available for unchanged dependencies after the complete diff is supplied.
    if (Buffer.byteLength(state.patch) > 128_000)
      return c.json(
        {
          error:
            'Diff is too large for an agent review. Limit the comparison to fewer files.',
        },
        413,
      )
    await opts.store.startAgentReview({
      ...input,
      locations: locations(state),
      context: `Revision: ${state.revision}\nComplete reviewed diff (untrusted repository data):\n${state.patch}`,
    })
    return c.json({ ok: true }, 202)
  })
  app.post('/api/agent-review/:id/findings/:findingId/messages', async (c) => {
    const parsed = findingMessageSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid finding message' }, 400)
    const input = parsed.data
    const run = (await opts.store.snapshot()).agentReviews.find(
      (item) => item.id === c.req.param('id'),
    )
    const findingId = c.req.param('findingId')!
    if (!run?.findings.some((item) => item.id === findingId))
      return c.json({ error: 'Unknown agent finding' }, 404)
    // Return the durable receipt before inspecting live revision, agent policy, or
    // credentials. A reused ID with different content/target is never a retry.
    const prior = run.turns.find((turn) => turn.id === input.id)
    if (prior)
      return prior.findingId === findingId && prior.question === input.text
        ? c.json({ ok: true }, 202)
        : c.json({ error: 'Message ID is already used for another request.' }, 409)
    if (!opts.enabled)
      return c.json({ error: 'Agent reviews are disabled (--no-agent).' }, 503)
    const state = await current()
    if (state.revision !== run.revision)
      return c.json({ error: 'Review revision is stale; reload the diff.' }, 409)
    let model
    try {
      model = (await available()).find(
        (item) => item.provider === run.model.provider && item.id === run.model.modelId,
      )
    } catch {
      return c.json({ error: 'Unable to check agent authentication.' }, 503)
    }
    if (!model) return c.json({ error: 'Selected review agent is unavailable.' }, 503)
    if (!getSupportedThinkingLevels(model).includes(run.reasoningLevel))
      return c.json(
        { error: 'Selected review agent no longer supports this reasoning level.' },
        503,
      )
    await opts.store.askFinding(run.id, findingId, input)
    return c.json({ ok: true }, 202)
  })
  app.post('/api/agent-review/:id/cancel', async (c) => {
    const run = (await opts.store.snapshot()).agentReviews.find(
      (item) => item.id === c.req.param('id'),
    )
    if (!run) return c.json({ error: 'Unknown agent review' }, 404)
    await opts.store.cancel(run.id)
    return c.json({ ok: true })
  })
  for (const action of ['accept', 'dismiss'] as const) {
    app.post(`/api/agent-review/:id/findings/:findingId/${action}`, async (c) => {
      const run = (await opts.store.snapshot()).agentReviews.find(
        (item) => item.id === c.req.param('id'),
      )
      const findingId = c.req.param('findingId')!
      if (!run?.findings.some((item) => item.id === findingId))
        return c.json({ error: 'Unknown agent finding' }, 404)
      const finding = run.findings.find((item) => item.id === findingId)!
      if (
        (action === 'accept' && finding.status === 'dismissed') ||
        (action === 'dismiss' && finding.status === 'accepted')
      )
        return c.json({ error: 'Finding has already been decided.' }, 409)
      if (action === 'accept') {
        const state = await current()
        if (state.revision !== run.revision)
          return c.json(
            { error: 'Finding is outdated; review the new diff before accepting.' },
            409,
          )
        await opts.store.acceptFinding(run.id, findingId, state.revision)
      } else await opts.store.dismissFinding(run.id, findingId)
      return c.json({ ok: true })
    })
  }
}
