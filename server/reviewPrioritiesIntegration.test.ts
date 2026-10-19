/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePatchFiles } from '@pierre/diffs'
import { Type } from '@earendil-works/pi-ai'
import type { MutableModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { defineTool } from '@earendil-works/pi-durable'
import { expect, it } from 'vitest'
import { setupReviewAgentWithEnvironment } from './reviewAgent.ts'
import { createReviewPriorities } from './reviewPriorities.ts'
import { openReviewStore, type ReviewStore } from './reviewStore.ts'

type RequestBody = {
  state: { path?: string; batch?: string; id?: number; patch?: string }
  questions: Record<string, { type: string; criteria: unknown }>
}
type Pending = {
  body: RequestBody
  response: ServerResponse
  url?: string
  authorization?: string
  token?: string | string[]
}
function answer({ body, response }: Pending) {
  const id = Number(body.state.path?.match(/file(\d+)\.txt/)?.[1])
  response.setHeader('content-type', 'application/json')
  response.end(
    JSON.stringify({
      answers:
        body.state.batch === 'chat'
          ? { flag: { type: 'noul', noul: 0.7 } }
          : {
              priority: { type: 'score', score: id === 0 ? 0 : 2.75, confidence: 0.8 },
              category: {
                type: 'choice',
                choice: 'correctness',
                confidence: 0.6,
                probabilities: {
                  mechanical: 0.05,
                  correctness: 0.6,
                  security: 0.1,
                  performance: 0.1,
                  tests: 0.05,
                  documentation: 0.05,
                  other: 0.05,
                },
              },
            },
    }),
  )
}

it('scores eight native System One HTTP hunks in parallel and shares the bounded FIFO with chat codemode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'review-priorities-native-'))
  const requests: Pending[] = []
  let active = 0
  let peak = 0
  let respondImmediately = false
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()) as RequestBody
    const pending = {
      body,
      response,
      url: request.url,
      authorization: request.headers.authorization,
      token: request.headers['x-classifier-token'],
    }
    requests.push(pending)
    active++
    peak = Math.max(peak, active)
    response.once('close', () => {
      active--
    })
    if (respondImmediately) answer(pending)
  })
  let priorities: ReturnType<typeof createReviewPriorities> | undefined
  let store: ReviewStore | undefined
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing address')
    const configPath = join(directory, 'classifier.json')
    await writeFile(
      configPath,
      JSON.stringify({
        provider: 'priority-fixture',
        model: 'native-priority-model',
        endpoint: `http://127.0.0.1:${address.port}/configured/decision`,
        apiKeyEnv: 'PRIORITY_KEY',
        headerEnv: { 'X-Classifier-Token': 'PRIORITY_TOKEN' },
        maxConcurrency: 8,
        maxQueuedRequests: 2,
        timeoutMs: 20000,
      }),
    )
    const env = { PRIORITY_KEY: 'transport-only-key', PRIORITY_TOKEN: 'header-only-key' }
    const setup = await setupReviewAgentWithEnvironment(
      undefined,
      env,
      directory,
      configPath,
    )
    // Only the conversational provider is faux. No classify/getModelOfType spy:
    // configuration, provider limiter, native HTTP adapter and scores() all run.
    const faux = fauxProvider({ tokensPerSecond: 100000 })
    ;(setup.models as MutableModels).setProvider(faux.provider)
    const model = faux.getModel()
    const cwd = join(directory, 'source')
    await mkdir(cwd)
    await writeFile(join(cwd, 'source.txt'), 'unchanged source\n')
    const overflowed: number[] = []
    const queueFull = defineTool({
      name: 'queue_full',
      description: 'Signal that a configured classifier request overflowed its FIFO',
      parameters: Type.Object({ id: Type.Integer() }),
      execute: async ({ id }) => {
        overflowed.push(id)
        return {}
      },
    })
    let finalChecked = false
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall('codemode', {
          code: `const [model] = await models.getAvailableOfType('classifier');
            const results = await Promise.allSettled(Array.from({ length: 3 }, async (_, id) => {
              const result = await tools.classify_review({ model, context: {
                state: { batch: 'chat', id }, questions: {
                  flag: { type: 'bool', instructions: 'Flag?', criteria: { true: 'Yes', false: 'No' } }
                }
              }});
              if (result.stopReason === 'error' &&
                  result.errorMessage === 'Review classifier request failed' &&
                  Object.keys(result.answers).length === 0) {
                await tools.queue_full({ id });
                return 'overflow';
              }
              if (result.stopReason !== 'stop' || result.answers.flag.type !== 'bool' ||
                  result.answers.flag.probability !== 0.7) throw new Error('Bad classifier answer');
              return 'scored';
            }));
            if (results.some(result => result.status !== 'fulfilled')) throw new Error('Batch rejected');
            const values = results.map(result => result.value);
            if (values.filter(value => value === 'scored').length !== 2 ||
                values.filter(value => value === 'overflow').length !== 1) throw new Error('Wrong shared queue capacity');
            text('Two queued chat classifications scored; one overflowed');`,
        }),
        { stopReason: 'toolUse' },
      ),
      (context) => {
        const result = context.messages.findLast((message) => message.role === 'toolResult')
        expect(result).toMatchObject({ isError: false })
        expect(JSON.stringify(result)).toContain(
          'Two queued chat classifications scored; one overflowed',
        )
        for (const secret of Object.values(env))
          expect(JSON.stringify(context)).not.toContain(secret)
        finalChecked = true
        return fauxAssistantMessage('Private chat classification finished')
      },
    ])
    store = await openReviewStore({
      directory: join(directory, 'store'),
      cwd,
      models: setup.models,
      model: { provider: model.provider, modelId: model.id },
      tools: [queueFull],
      classifierInstructions: setup.classifierInstructions,
      toolPolicyKey: setup.toolPolicyKey,
      onChange() {},
      maxRunMs: 30000,
    })
    const anchor = { path: 'source.txt', side: 'RIGHT' as const, line: 1, revision: 'one' }
    await store.saveDraft({
      id: 'private-draft',
      anchor,
      body: 'PRIVATE-DRAFT-NOT-FOR-CLASSIFIER',
    })
    const patch = Array.from(
      { length: 12 },
      (_, id) => `diff --git a/file${id}.txt b/file${id}.txt
--- a/file${id}.txt
+++ b/file${id}.txt
@@ -1,2 +1,2 @@
 context
-before${id}
+after${id}
`,
    ).join('')
    const state = {
      revision: 'one',
      patch,
      files: parsePatchFiles(patch).flatMap((entry) => entry.files),
    }
    priorities = createReviewPriorities({
      revision: state.revision,
      models: setup.models,
      classifier: setup.status.classifier,
      classifierConcurrency: setup.classifierConcurrency,
      current: async () => state,
      publish() {},
    })
    expect(priorities.snapshot()).toMatchObject({ available: true, status: 'idle' })
    expect(requests).toEqual([])
    await priorities.start({ id: randomUUID(), revision: state.revision })
    // An HTTP response barrier proves real concurrency, not just concurrent
    // classify() promises waiting behind a four-request adapter limit.
    await expect.poll(() => requests.length, { timeout: 5000 }).toBe(8)
    expect(active).toBe(8)
    expect(peak).toBe(8)
    expect(faux.state.callCount).toBe(0)
    expect(priorities.snapshot()).toMatchObject({ completed: 0, total: 12 })
    await store.ask({
      id: 'chat',
      anchor,
      text: 'PRIVATE-THREAD-NOT-FOR-CLASSIFIER',
      context: '',
    })
    // Three real native alias calls compete with the eight priority HTTPs.
    // Seeing the third overflow proves the two waiting places are occupied.
    await expect.poll(() => overflowed.length, { timeout: 10000 }).toBe(1)
    expect(requests).toHaveLength(8)
    expect((await store.snapshot()).threads[0]?.status).toBe('running')
    expect(faux.state.callCount).toBe(1)
    answer(requests[0]!)
    await expect.poll(() => requests.length, { timeout: 5000 }).toBe(9)
    expect(requests[8]!.body.state.batch).toBe('chat')
    expect(active).toBe(8)
    expect(peak).toBe(8)
    // The oldest queued chat call wins over the priority pool's next hunk.
    // Now drain both workloads through the SAME provider without resetting it.
    respondImmediately = true
    for (const pending of requests.slice(1)) answer(pending)
    await expect
      .poll(() => priorities!.snapshot().status, { timeout: 10000 })
      .toBe('complete')
    await expect
      .poll(async () => (await store!.snapshot()).threads[0]?.status, { timeout: 10000 })
      .toBe('answered')
    expect(finalChecked).toBe(true)
    expect(faux.state.callCount).toBe(2)
    expect(peak).toBe(8)
    expect(active).toBe(0)
    expect(requests).toHaveLength(14)
    const priorityRequests = requests.filter(({ body }) => body.state.path)
    expect(priorityRequests).toHaveLength(12)
    expect(new Set(priorityRequests.map(({ body }) => body.state.path)).size).toBe(12)
    const chatRequests = requests.filter(({ body }) => body.state.batch === 'chat')
    expect(chatRequests).toHaveLength(2)
    expect(chatRequests.map(({ body }) => body.state.id)).not.toContain(overflowed[0])
    for (const pending of requests) {
      expect(pending).toMatchObject({
        url: '/configured/decision',
        authorization: `Bearer ${env.PRIORITY_KEY}`,
        token: env.PRIORITY_TOKEN,
      })
      expect(JSON.stringify(pending.body)).not.toMatch(/PRIVATE-DRAFT|PRIVATE-THREAD/)
    }
    for (const { body } of priorityRequests) {
      expect(body.questions).toMatchObject({
        priority: { type: 'score', criteria: expect.any(Array) },
        category: { type: 'choice', criteria: expect.any(Object) },
      })
      const id = Number(body.state.path!.match(/file(\d+)\.txt/)![1])
      expect(body.state.patch).toBe(` context\n-before${id}\n+after${id}\n`)
    }
    const scored = priorities.snapshot()
    expect(scored).toMatchObject({ status: 'complete', completed: 12, total: 12 })
    scored.results.forEach((result, id) => {
      expect(result).toMatchObject({
        status: 'scored',
        score: id === 0 ? 0 : 2.75,
        confidence: 0.6,
        category: 'correctness',
      })
      expect(result.error).toBeUndefined()
    })
    const snapshot = await store.snapshot()
    expect(snapshot.threads).toHaveLength(1)
    expect(snapshot.drafts).toHaveLength(1)
    expect(snapshot.drafts[0]?.body).toBe('PRIVATE-DRAFT-NOT-FOR-CLASSIFIER')
    expect(snapshot.publication).toBeNull()
    for (const secret of Object.values(env)) {
      expect(JSON.stringify(scored)).not.toContain(secret)
      expect(JSON.stringify(snapshot)).not.toContain(secret)
    }
    expect(await readFile(join(cwd, 'source.txt'), 'utf8')).toBe('unchanged source\n')
    expect(await readdir(cwd)).toEqual(['source.txt'])
  } finally {
    await Promise.all([priorities?.close(), store?.close()])
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
