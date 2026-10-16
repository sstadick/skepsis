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
import { Type, type ClassifierModel } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { defineTool } from '@earendil-works/pi-durable'
import { openReviewStore } from './reviewStore.ts'
import { ReviewCodemodeSandbox } from './reviewCodemode.ts'

const script = (code: string) =>
  fauxAssistantMessage(fauxToolCall('codemode', { code }), { stopReason: 'toolUse' })

it('runs native codemode with parallel read tools and durable store across reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'skepsis-code-'))
  const faux = fauxProvider({ tokensPerSecond: 100000 })
  const models = createModels()
  const model = faux.getModel()
  const classifier: ClassifierModel<'test-classifier'> = {
    ...model,
    type: 'classifier',
    api: 'test-classifier',
    id: 'local-classifier',
  }
  let classifications = 0
  models.setProvider({
    ...faux.provider,
    getAllModels: () => [model, classifier],
    classify: async (_model, input) => {
      classifications++
      expect(input.state).toEqual({ value: 'test' })
      return {
        api: classifier.api,
        provider: classifier.provider,
        model: classifier.id,
        stopReason: 'stop',
        answers: { ok: { type: 'bool', probability: 0.9 } },
        timestamp: Date.now(),
      }
    },
  })
  const calls: number[] = []
  const read = defineTool({
    name: 'read_context',
    description: 'Read context',
    parameters: Type.Object({ n: Type.Number() }),
    execute: async ({ n }) => {
      calls.push(n)
      return { output: [{ type: 'text' as const, text: String(n) }] }
    },
  })
  const opts = {
    directory,
    cwd: directory,
    models,
    model: { provider: model.provider, modelId: model.id },
    tools: [read],
    onChange() {},
  }
  faux.setResponses([
    script(`const results = await Promise.all([tools.read_context({n:1}), tools.read_context({n:2})]);
      const model = await models.getModelOfType('classifier', '${model.provider}', 'local-classifier');
      const result = await models.classify(model, {state:{value:'test'}, questions:{ok:{type:'bool',instructions:'Check',criteria:{true:'yes',false:'no'}}}});
      if (result.stopReason !== 'stop' || result.answers.ok.probability !== 0.9) throw new Error('classification failed');
      store("saved", results); text(results)`),
    (ctx) => {
      expect(ctx.messages.findLast((m) => m.role === 'toolResult')).toMatchObject({
        isError: false,
      })
      expect(JSON.stringify(ctx.messages)).toContain('Script completed')
      return fauxAssistantMessage('done')
    },
  ])
  let store = await openReviewStore(opts)
  try {
    await store.ask({
      id: 'one',
      anchor: { path: 'x', side: 'RIGHT', line: 1, revision: 'a' },
      text: 'read',
      context: '',
    })
    await expect
      .poll(async () => (await store.snapshot()).threads[0]?.status)
      .toBe('answered')
    expect(calls.toSorted()).toEqual([1, 2])
    expect(classifications).toBe(1)
    await store.close()
    store = await openReviewStore(opts)
    faux.setResponses([
      script(
        'if (JSON.stringify(load("saved")) !== JSON.stringify(["1", "2"])) throw new Error("lost store"); text({ saved: load("saved"), ambient: [typeof process, typeof require, typeof fetch, typeof WebAssembly] })',
      ),
      (ctx) => {
        const result = ctx.messages.findLast((m) => m.role === 'toolResult')
        expect(result).toMatchObject({ isError: false })
        expect(JSON.stringify(result)).toContain('saved')
        expect(JSON.stringify(result)).toContain('undefined')
        expect(JSON.stringify(result)).not.toContain('Script failed')
        return fauxAssistantMessage('persisted')
      },
    ])
    await store.reply('one', { id: 'two', text: 'load', context: '' })
    await expect
      .poll(async () => (await store.snapshot()).threads[0]?.turns[1]?.answer)
      .toBe('persisted')
    const previousCalls = faux.state.callCount
    faux.setResponses([script('while (true) {}')])
    await store.reply('one', { id: 'three', text: 'loop', context: '' })
    await expect.poll(() => faux.state.callCount).toBe(previousCalls + 1)
    await new Promise((resolve) => setTimeout(resolve, 150))
    await store.cancel('one')
    expect((await store.snapshot()).threads[0]?.status).toBe('cancelled')
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('limits worker admission until actual exit', async () => {
  const sandbox = new ReviewCodemodeSandbox()
  const controller = new AbortController()
  const options = { signal: controller.signal }
  try {
    const first = sandbox.execute('while (true) {}', options)
    const second = sandbox.execute('while (true) {}', options)
    const third = await sandbox.execute('while (true) {}', options)
    expect(third).toMatchObject({ ok: false, error: { kind: 'sandbox' } })
    controller.abort()
    await Promise.all([first, second])
  } finally {
    controller.abort()
    await sandbox.close()
  }
})

it('cancels an infinite loop and joins the actual worker', async () => {
  const sandbox = new ReviewCodemodeSandbox()
  try {
    const controller = new AbortController()
    const result = sandbox.execute('while (true) {}', {
      signal: controller.signal,
      timeoutMs: Infinity,
    })
    setTimeout(() => controller.abort(), 100)
    expect(await result).toMatchObject({ ok: false, error: { kind: 'aborted' } })
  } finally {
    await sandbox.close()
  }
})
