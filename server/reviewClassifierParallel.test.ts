/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import type { MutableModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { defineTool } from '@earendil-works/pi-durable'
import { expect, it, vi } from 'vitest'
import { setupReviewAgentWithEnvironment } from './reviewAgent.ts'
import { openReviewStore, type ReviewStore } from './reviewStore.ts'

function answer({ response, id }: { response: ServerResponse; id: number }) {
  response.setHeader('content-type', 'application/json')
  response.end(
    JSON.stringify({
      answers: {
        flag: { type: 'noul', noul: 0.7 },
        level: { type: 'score', score: id / 10, confidence: 0.6 },
        pick: {
          type: 'choice',
          choice: 'yes',
          probabilities: { yes: 0.8, no: 0.2 },
          confidence: 0.8,
        },
      },
    }),
  )
}

it('runs eight HTTP classifiers at once, then drains the FIFO, from ONE real codemode script', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'skepsis-classifier-parallel-'))
  const requests: {
    url: string
    authorization?: string
    token?: string | string[]
    body: { state: { id: number }; questions: Record<string, { type: string }> }
  }[] = []
  const responses: { response: ServerResponse; id: number }[] = []
  let active = 0
  let peak = 0
  let respondImmediately = false
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push({
      url: request.url!,
      authorization: request.headers.authorization,
      token: request.headers['x-custom-token'],
      body,
    })
    active++
    peak = Math.max(peak, active)
    response.once('close', () => {
      active--
    })
    const pending = { response, id: body.state.id }
    responses.push(pending)
    if (respondImmediately) answer(pending)
  })
  let store: ReviewStore | undefined
  let finalChecked = false
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing address')
    const endpoint = `http://127.0.0.1:${address.port}/custom/parallel/decision`
    const configPath = join(directory, 'classifier.json')
    const config = {
      provider: 'fixture-decider',
      model: 'parallel-decision-model',
      endpoint,
      apiKeyEnv: 'DECISION_KEY',
      headerEnv: { 'X-Custom-Token': 'DECISION_TOKEN' },
      maxConcurrency: 8,
      maxQueuedRequests: 4,
      timeoutMs: 20000,
    }
    await writeFile(configPath, JSON.stringify(config))
    const cwd = join(directory, 'source')
    await mkdir(cwd)
    await writeFile(join(cwd, 'source.ts'), 'original\n')
    const env = {
      OPENAI_API_KEY: 'catalog-only-secret',
      DECISION_KEY: 'transport-only-secret',
      DECISION_TOKEN: 'header-only-secret',
    }
    const agent = await setupReviewAgentWithEnvironment(
      undefined,
      env,
      directory,
      configPath,
    )
    expect(agent.classifierInstructions).toContain(
      'up to 8 classifier requests in parallel',
    )
    expect(agent.classifierInstructions).toContain('Promise.allSettled')
    // As in the replay integration fixture, only the chat provider is faux. The
    // classifier uses the real native adapter and the VM's real models.* bridge.
    const faux = fauxProvider({ tokensPerSecond: 100000 })
    ;(agent.models as MutableModels).setProvider(faux.provider)
    const model = faux.getModel()
    const code = `const catalog = await models.getAvailableOfType('classifier');
      if (catalog.length !== 1 || catalog[0].id !== 'parallel-decision-model')
        throw new Error('Unexpected classifier catalog');
      text(JSON.stringify(catalog));
      const settled = await Promise.allSettled(Array.from({ length: 12 }, (_, id) =>
        tools.classify_review({ model: catalog[0], context: {
          state: { id, text: 'independent review fixture' }, questions: {
            flag: { type: 'bool', instructions: 'Flag?', criteria: { true: 'Yes', false: 'No' } },
            level: { type: 'score', instructions: 'Level', criteria: ['low', 'medium', 'high'] },
            pick: { type: 'choice', instructions: 'Pick', criteria: { yes: 'Yes', no: 'No' } }
          }
        }})
      ));
      const scores = settled.map((entry, id) => {
        if (entry.status !== 'fulfilled' || entry.value.stopReason !== 'stop')
          throw new Error('Classification failed');
        const answers = entry.value.answers;
        if (answers.flag.type !== 'bool' || answers.flag.probability !== 0.7 ||
            answers.level.type !== 'score' || answers.level.score !== id / 10 || answers.level.confidence !== 0.6 ||
            answers.pick.type !== 'choice' || answers.pick.choice !== 'yes' ||
            answers.pick.probabilities.yes !== 0.8 || answers.pick.probabilities.no !== 0.2)
          throw new Error('Incorrect normalized answers');
        return answers.level.score;
      });
      text({ completed: settled.length, scores });`
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('codemode', { code }), { stopReason: 'toolUse' }),
      (ctx) => {
        const result = ctx.messages.findLast((message) => message.role === 'toolResult')
        expect(result).toMatchObject({ isError: false })
        const output = JSON.stringify(result)
        expect(output).toContain('Script completed')
        expect(output).toContain('completed')
        expect(output).toContain('12')
        expect(output).not.toContain('noul')
        for (const secret of Object.values(env))
          expect(JSON.stringify(ctx.messages)).not.toContain(secret)
        finalChecked = true
        return fauxAssistantMessage('All twelve classified in one script')
      },
    ])
    store = await openReviewStore({
      directory: join(directory, 'store'),
      cwd,
      models: agent.models,
      model: { provider: model.provider, modelId: model.id },
      tools: [],
      classifierInstructions: agent.classifierInstructions,
      toolPolicyKey: agent.toolPolicyKey,
      onChange() {},
      maxRunMs: 30000,
    })
    await store.ask({
      id: 'one',
      anchor: { path: 'source.ts', side: 'RIGHT', line: 1, revision: 'a' },
      text: 'Classify independent items in parallel',
      context: '',
    })
    // A barrier, not elapsed-time inference: no HTTP response has been sent yet.
    // Reaching eight proves more than four simultaneous requests from this one VM.
    await expect.poll(() => requests.length, { timeout: 10000 }).toBe(8)
    expect(active).toBe(8)
    expect(peak).toBe(8)
    expect(faux.state.callCount).toBe(1)
    const running = await store.snapshot()
    expect(running.threads).toHaveLength(1)
    expect(running.threads[0]?.status).toBe('running')
    answer(responses[0]!)
    await expect.poll(() => requests.length, { timeout: 5000 }).toBe(9)
    expect(active).toBe(8)
    expect(peak).toBe(8)
    respondImmediately = true
    for (const pending of responses.slice(1)) answer(pending)
    await expect
      .poll(async () => (await store!.snapshot()).threads[0]?.status, { timeout: 10000 })
      .toBe('answered')
    expect(finalChecked).toBe(true)
    expect(faux.state.callCount).toBe(2)
    expect(peak).toBe(8)
    expect(active).toBe(0)
    expect(requests).toHaveLength(12)
    expect(new Set(requests.map((request) => request.body.state.id)).size).toBe(12)
    for (const request of requests) {
      expect(request).toMatchObject({
        url: '/custom/parallel/decision',
        authorization: `Bearer ${env.DECISION_KEY}`,
        token: env.DECISION_TOKEN,
        body: { questions: { flag: { type: 'noul' } } },
      })
    }
    const snapshot = await store.snapshot()
    expect(snapshot.threads[0]?.turns[0]?.answer).toBe(
      'All twelve classified in one script',
    )
    for (const secret of Object.values(env))
      expect(JSON.stringify(snapshot)).not.toContain(secret)
    expect(await readFile(join(cwd, 'source.ts'), 'utf8')).toBe('original\n')
    expect(await readdir(cwd)).toEqual(['source.ts'])
  } finally {
    await store?.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

function cancellableBatch(batch: string, count: number) {
  return `
      const [model] = await models.getAvailableOfType('classifier');
      const settled = await Promise.allSettled(Array.from({ length: ${count} }, async (_, id) => {
        const result = await tools.classify_review({ model, context: {
          state: { batch: '${batch}', id }, questions: {
            flag: { type: 'bool', instructions: 'Flag?', criteria: { true: 'Yes', false: 'No' } },
            level: { type: 'score', instructions: 'Level', criteria: ['low', 'medium', 'high'] },
            pick: { type: 'choice', instructions: 'Pick', criteria: { yes: 'Yes', no: 'No' } }
          }
        }});
        if (result.stopReason !== 'stop') {
          if ('${batch}' === 'stopped' && result.stopReason === 'error' &&
              result.errorMessage === 'Review classifier request failed' &&
              Object.keys(result.answers).length === 0)
            await tools.queue_full({ id });
          throw new Error('Classification did not finish');
        }
        if (result.answers.level.type !== 'score' || result.answers.level.score !== id / 10)
          throw new Error('Incorrect result');
      }));
      if (settled.some(result => result.status !== 'fulfilled')) throw new Error('Batch failed');
      text({ completed: settled.length });`
}

it('Stop aborts active and queued alias classifiers and restores capacity for a follow-up', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'skepsis-classifier-stop-'))
  const requests: { batch: string; id: number }[] = []
  const responses: { response: ServerResponse; id: number }[] = []
  const aborted: number[] = []
  const overflowed: number[] = []
  const transportSettlement = Promise.withResolvers<undefined>()
  let heldAbortedTransports = 0
  let settledAbortedTransports = 0
  let restoreFetch: (() => void) | undefined
  let active = 0
  let peak = 0
  let respondImmediately = false
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const { state } = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(state)
    active++
    peak = Math.max(peak, active)
    response.once('close', () => {
      active--
      if (!response.writableFinished) aborted.push(state.id)
    })
    // Leave stopped requests awaiting HTTP responses: they must be aborted,
    // never completed by the fixture just to free capacity.
    if (state.batch !== 'stopped') {
      const pending = { response, id: state.id }
      responses.push(pending)
      if (respondImmediately) answer(pending)
    }
  })
  let store: ReviewStore | undefined
  let finalChecked = false
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing address')
    const endpoint = `http://127.0.0.1:${address.port}/decision`
    const nativeFetch = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      try {
        return await nativeFetch(url, init)
      } catch (error) {
        if (url === endpoint && init?.signal?.aborted) {
          heldAbortedTransports++
          // Real localhost HTTP has aborted, but transport cleanup has not yet
          // settled. Native tool cancellation must wait, not race the signal.
          await transportSettlement.promise
          settledAbortedTransports++
        }
        throw error
      }
    })
    restoreFetch = () => fetchSpy.mockRestore()
    const configPath = join(directory, 'classifier.json')
    await writeFile(
      configPath,
      JSON.stringify({
        provider: 'fixture-decider',
        model: 'stop-decision-model',
        endpoint,
        maxConcurrency: 2,
        maxQueuedRequests: 4,
        timeoutMs: 20000,
      }),
    )
    const cwd = join(directory, 'source')
    await mkdir(cwd)
    await writeFile(join(cwd, 'source.ts'), 'original\n')
    const agent = await setupReviewAgentWithEnvironment(
      undefined,
      { OPENAI_API_KEY: 'catalog-only-secret' },
      directory,
      configPath,
    )
    const faux = fauxProvider({ tokensPerSecond: 100000 })
    ;(agent.models as MutableModels).setProvider(faux.provider)
    const model = faux.getModel()
    const queueFull = defineTool({
      name: 'queue_full',
      description: 'Observe the classifier queue saturation barrier',
      parameters: Type.Object({ id: Type.Integer() }),
      execute: async ({ id }) => {
        overflowed.push(id)
        return {}
      },
    })
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall('codemode', { code: cancellableBatch('stopped', 7) }),
        {
          stopReason: 'toolUse',
        },
      ),
      fauxAssistantMessage(
        fauxToolCall('codemode', { code: cancellableBatch('followup', 6) }),
        {
          stopReason: 'toolUse',
        },
      ),
      (ctx) => {
        const result = ctx.messages.findLast((message) => message.role === 'toolResult')
        expect(result).toMatchObject({ isError: false })
        expect(JSON.stringify(result)).toContain('Script completed')
        expect(JSON.stringify(result)).toContain('completed')
        expect(JSON.stringify(result)).toContain('6')
        finalChecked = true
        return fauxAssistantMessage('All six follow-up classifications completed')
      },
    ])
    store = await openReviewStore({
      directory: join(directory, 'store'),
      cwd,
      models: agent.models,
      model: { provider: model.provider, modelId: model.id },
      tools: [queueFull],
      classifierInstructions: agent.classifierInstructions,
      toolPolicyKey: agent.toolPolicyKey,
      onChange() {},
      maxRunMs: 30000,
    })
    await store.ask({
      id: 'one',
      anchor: { path: 'source.ts', side: 'RIGHT', line: 1, revision: 'a' },
      text: 'Start a batch to stop',
      context: '',
    })
    // Seven calls with two slots and four waiting places: an overflow result is
    // the barrier proving the queue is full, not an arbitrary sleep after two HTTPs.
    await expect.poll(() => overflowed.length, { timeout: 10000 }).toBe(1)
    await expect.poll(() => requests.length, { timeout: 5000 }).toBe(2)
    expect(active).toBe(2)
    expect(faux.state.callCount).toBe(1)
    expect((await store.snapshot()).threads[0]?.status).toBe('running')
    const stoppedIds = requests.map(({ id }) => id)
    expect(stoppedIds).not.toContain(overflowed[0])

    let stopFinished = false
    const stopping = store.cancel('one').then(() => {
      stopFinished = true
    })
    await expect.poll(() => heldAbortedTransports, { timeout: 5000 }).toBe(2)
    // Wait for transport quiescence at the HTTP server, not just an abort signal
    // or the UI's optimistic cancelled status. Neither response was completed.
    await expect.poll(() => aborted.length, { timeout: 5000 }).toBe(2)
    expect(aborted.toSorted()).toEqual(stoppedIds.toSorted())
    expect(active).toBe(0)
    expect(requests).toHaveLength(2)
    expect(overflowed).toHaveLength(1)
    expect(faux.state.callCount).toBe(1)
    expect(settledAbortedTransports).toBe(0)
    expect(stopFinished).toBe(false)
    transportSettlement.resolve(undefined)
    await stopping
    expect(settledAbortedTransports).toBe(2)
    const cancelled = await store.snapshot()
    expect(cancelled.threads[0]).toMatchObject({
      status: 'cancelled',
      turns: [{ id: 'one', error: 'Cancelled' }],
    })
    expect(cancelled.threads[0]?.turns[0]?.answer).toBeUndefined()

    // Reuse the same store AND provider limiter. Both active slots and all four
    // waiting places must be available again, without reopening/resetting either.
    await store.reply('one', { id: 'two', text: 'Try a fresh batch', context: '' })
    await expect.poll(() => responses.length, { timeout: 10000 }).toBe(2)
    expect(active).toBe(2)
    expect(peak).toBe(2)
    answer(responses[0]!)
    await expect.poll(() => responses.length, { timeout: 5000 }).toBe(3)
    expect(active).toBe(2)
    respondImmediately = true
    for (const pending of responses.slice(1)) answer(pending)
    await expect
      .poll(async () => (await store!.snapshot()).threads[0]?.status, { timeout: 10000 })
      .toBe('answered')
    expect(finalChecked).toBe(true)
    expect(faux.state.callCount).toBe(3)
    expect(active).toBe(0)
    expect(peak).toBe(2)
    // None of the four old queued calls may reach HTTP, even during/after Stop.
    expect(requests.filter(({ batch }) => batch === 'stopped').map(({ id }) => id)).toEqual(
      stoppedIds,
    )
    expect(
      requests
        .filter(({ batch }) => batch === 'followup')
        .map(({ id }) => id)
        .toSorted(),
    ).toEqual([0, 1, 2, 3, 4, 5])
    expect(requests).toHaveLength(8)
    expect((await store.snapshot()).threads[0]?.turns[1]?.answer).toBe(
      'All six follow-up classifications completed',
    )
    expect(await readFile(join(cwd, 'source.ts'), 'utf8')).toBe('original\n')
  } finally {
    transportSettlement.resolve(undefined)
    await store?.close()
    restoreFetch?.()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
