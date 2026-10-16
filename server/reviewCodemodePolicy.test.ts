/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { openReviewStore } from './reviewStore.ts'

it('preserves paused work without a model, then cancels all old-policy work before resuming', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'skepsis-policy-'))
  const faux = fauxProvider({ tokensPerSecond: 2, tokenSize: { min: 1, max: 1 } })
  const models = createModels()
  models.setProvider(faux.provider)
  const model = faux.getModel()
  const opts = {
    directory,
    cwd: directory,
    models,
    model: { provider: model.provider, modelId: model.id },
    tools: [],
    onChange() {},
    toolPolicyKey: 'old',
    maxRunMs: 30000,
  }
  faux.setResponses([fauxAssistantMessage('unfinished model call')])
  let store = await openReviewStore(opts)
  try {
    const anchor = { path: 'x', side: 'RIGHT' as const, line: 1, revision: 'a' }
    await store.ask({ id: 'one', anchor, text: 'first', context: '' })
    await store.ask({ id: 'two', anchor, text: 'queued', context: '' })
    await expect.poll(() => faux.state.callCount).toBe(1)
    await store.close()
    store = await openReviewStore({ ...opts, model: undefined, toolPolicyKey: 'new' })
    expect((await store.snapshot()).threads.map((t) => t.status)).toEqual([
      'running',
      'queued',
    ])
    await store.close()
    store = await openReviewStore({ ...opts, toolPolicyKey: 'new' })
    expect((await store.snapshot()).threads.map((t) => t.status)).toEqual([
      'failed',
      'failed',
    ])
    expect(faux.state.callCount).toBe(1)
    expect(
      (await store.snapshot()).threads.every((t) =>
        t.turns[0]?.error?.includes('policy changed'),
      ),
    ).toBe(true)
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
