/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

// These tests intentionally sequence requests against one isolated HTTP stub.
/* eslint-disable no-await-in-loop */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createModels, type ClassifierContext } from '@earendil-works/pi-ai'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { loadReviewClassifier } from './reviewClassifier.ts'

let directory: string
let endpoint: string
let requests: {
  url: string
  headers: IncomingMessage['headers']
  body: { state: ClassifierContext['state']; questions: Record<string, { type: string }> }
}[]
let handler: (request: IncomingMessage, response: ServerResponse) => void
const server = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  requests.push({
    url: request.url!,
    headers: request.headers,
    body: JSON.parse(Buffer.concat(chunks).toString()),
  })
  handler(request, response)
})
const answers = {
  pick: {
    type: 'choice',
    choice: 'yes',
    probabilities: { yes: 0.8, no: 0.2 },
    confidence: 0.8,
  },
  flag: { type: 'noul', noul: 0.7 },
  level: { type: 'score', score: 1.2, confidence: 0.6 },
}
const context: ClassifierContext = {
  state: { text: 'example' },
  questions: {
    pick: { type: 'choice', instructions: 'Pick', criteria: { yes: 'Yes', no: 'No' } },
    flag: { type: 'bool', instructions: 'Flag?', criteria: { true: 'Yes', false: 'No' } },
    level: { type: 'score', instructions: 'Level', criteria: ['low', 'medium', 'high'] },
  },
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'skepsis-classifier-'))
  requests = []
  handler = (_request, response) =>
    response.end(JSON.stringify({ answers, usage: { input_tokens: 10, output_tokens: 2 } }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test address')
  endpoint = `http://127.0.0.1:${address.port}/arbitrary/prefix/predict`
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(directory, { recursive: true, force: true })
})
async function setup(overrides: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
  const path = join(directory, 'classifier.json')
  await writeFile(
    path,
    JSON.stringify({ model: 'arbitrary-model', endpoint, ...overrides }),
  )
  const loaded = await loadReviewClassifier(path, env)
  const models = createModels()
  models.setProvider(loaded.provider)
  const model = models.getModelOfType(
    'classifier',
    loaded.summary.provider,
    loaded.summary.model,
  )!
  return { ...loaded, models, model, path }
}

it('uses the exact endpoint, native bool mapping and normalized results without network discovery', async () => {
  const { models, model } = await setup()
  expect(await models.getAvailableOfType('classifier')).toHaveLength(1)
  expect(requests).toHaveLength(0)
  const result = await models.classify(model, context)
  expect(result.stopReason).toBe('stop')
  expect(result.answers.flag).toEqual({ type: 'bool', probability: 0.7 })
  expect(result.answers.level).toEqual(answers.level)
  expect(result.answers.pick).toEqual(answers.pick)
  expect(requests[0]!.url).toBe('/arbitrary/prefix/predict')
  expect(requests[0]!.headers.authorization).toBeUndefined()
  expect(requests[0]!.body.questions.flag!.type).toBe('noul')
  expect(result.usage?.input).toBe(10)
})

it('keeps credentials in the transport only and ignores request overrides', async () => {
  const { models, model, provider } = await setup(
    {
      apiKeyEnv: 'KEY',
      headerEnv: { 'X-Custom-Token': 'TOKEN' },
      headers: { 'X-Client': 'skepsis' },
    },
    { KEY: 'secret-key', TOKEN: 'secret-token' },
  )
  expect(JSON.stringify(provider)).not.toContain('secret-')
  expect(JSON.stringify(models.getAllModels())).not.toContain('secret-')
  expect(await models.getAuth(provider.id)).toMatchObject({ auth: {} })
  const result = await models.classify(model, context, {
    apiKey: 'override',
    headers: { Authorization: 'override' },
  })
  expect(requests[0]!.headers.authorization).toBe('Bearer secret-key')
  expect(requests[0]!.headers['x-custom-token']).toBe('secret-token')
  expect(JSON.stringify(result)).not.toContain('secret-')
})

it.each([
  { apiKeyEnv: 'MISSING' },
  { headerEnv: { 'X-Token': 'MISSING' } },
  { provider: 'openai' },
  { provider: 'anthropic' },
  { provider: 'openai-codex' },
  { provider: '../bad' },
  { apiKey: 'secret-value' },
  { timeoutMs: 60001 },
  { maxRequestBytes: 16777217 },
  ...[0, -1, 65, 1.5, '8', null, true, [], {}].map((maxConcurrency) => ({
    maxConcurrency,
  })),
  ...[-1, 257, 0.5, '64', null, false, [], {}].map((maxQueuedRequests) => ({
    maxQueuedRequests,
  })),
  { endpoint: 'https://user:secret@example.com/path' },
  { endpoint: 'https://example.com/path?secret=value' },
  { endpoint: 'https://example.com/#secret' },
  { headers: { Host: 'secret' } },
  { headers: { Authorization: 'secret' } },
  { headers: { 'Content-Length': '3' } },
  { headers: { 'X-Client': 'secret\nvalue' } },
  { headerEnv: { 'Proxy-Authorization': 'TOKEN' } },
])('rejects invalid configuration without echoing its contents: %j', async (overrides) => {
  await expect(setup(overrides)).rejects.toThrow(/configuration|credentials/)
  expect(requests).toHaveLength(0)
})

it('supports custom Authorization from the supplied environment only', async () => {
  const { models, model } = await setup(
    { headerEnv: { Authorization: 'CUSTOM_AUTH' } },
    { CUSTOM_AUTH: 'Custom fixture-token' },
  )
  const result = await models.classify(model, context, {
    fetch: async () => {
      throw new Error('caller fetch must not run')
    },
    onPayload: () => {
      throw new Error('caller payload hook must not run')
    },
    onResponse: () => {
      throw new Error('caller response hook must not run')
    },
  })
  expect(result.stopReason).toBe('stop')
  expect(requests[0]!.headers.authorization).toBe('Custom fixture-token')
})

it('handles missing, oversized, malformed and nonregular config files safely', async () => {
  await expect(loadReviewClassifier(join(directory, 'absent'))).rejects.toThrow(
    'Cannot load',
  )
  await expect(loadReviewClassifier(directory)).rejects.toThrow('Cannot load')
  const path = join(directory, 'bad')
  for (const body of ['{"secret-value":', ' '.repeat(65537)]) {
    await writeFile(path, body)
    await expect(loadReviewClassifier(path)).rejects.toThrow(
      /^Cannot load review classifier configuration/,
    )
  }
})

it.each(['malformed', 'http', 'redirect', 'oversized', 'probability', 'choice', 'score'])(
  'sanitizes %s responses without retrying or forwarding',
  async (mode) => {
    handler = (_request, response) => {
      if (mode === 'http') {
        response.statusCode = 500
        response.end('secret-value')
      } else if (mode === 'redirect') {
        response.writeHead(307, { Location: `${endpoint}/forward` })
        response.end('secret-value')
      } else if (mode === 'oversized') response.end('secret-value'.repeat(100000))
      else if (mode === 'malformed') response.end('{secret-value')
      else
        response.end(
          JSON.stringify({
            answers: {
              ...answers,
              ...(mode === 'probability' ? { flag: { type: 'noul', noul: 2 } } : {}),
              ...(mode === 'choice'
                ? { pick: { ...answers.pick, choice: 'secret-value' } }
                : {}),
              ...(mode === 'score' ? { level: { ...answers.level, score: 99 } } : {}),
            },
          }),
        )
    }
    const { models, model } = await setup()
    const result = await models.classify(model, context)
    expect(result.stopReason).toBe('error')
    expect(result.answers).toEqual({})
    expect(JSON.stringify(result)).not.toContain('secret-value')
    expect(requests).toHaveLength(1)
  },
)

it.each([
  { ...answers.pick, probabilities: { yes: 0.9, no: 0.9 } },
  { ...answers.pick, probabilities: { yes: 0.8, wrong: 0.2 } },
  { ...answers.pick, probabilities: { yes: 1.2, no: -0.2 } },
  { ...answers.pick, confidence: 1.1 },
])('rejects malformed probability distributions', async (pick) => {
  handler = (_request, response) =>
    response.end(JSON.stringify({ answers: { ...answers, pick } }))
  const { models, model } = await setup()
  expect((await models.classify(model, context)).stopReason).toBe('error')
})

it('bounds request bytes and fails closed on non-JSON state and images', async () => {
  const { models, model } = await setup({ maxRequestBytes: 1024 })
  const cycle: ClassifierContext['state'] = {}
  cycle.self = cycle
  for (const state of [
    { text: 'x'.repeat(1025) },
    { invalid: undefined },
    { invalid: NaN },
    cycle,
  ]) {
    expect(
      (
        await models.classify(model, {
          ...context,
          state: state as ClassifierContext['state'],
        })
      ).stopReason,
    ).toBe('error')
  }
  expect(
    (
      await models.classify(model, {
        ...context,
        images: [{ type: 'image', mimeType: 'image/png', data: 'abc' }],
      })
    ).stopReason,
  ).toBe('error')
  expect((await models.classify({ ...model, id: 'other' }, context)).stopReason).toBe(
    'error',
  )
  expect((await models.classify({ ...model, api: 'other' }, context)).stopReason).toBe(
    'error',
  )
  expect(requests).toHaveLength(0)
})

it('honors cancellation and timeout', async () => {
  handler = () => {}
  const { models, model } = await setup({ timeoutMs: 50 })
  expect((await models.classify(model, context)).stopReason).toBe('error')
  const controller = new AbortController()
  const pending = models.classify(model, context, { signal: controller.signal })
  await delay(10)
  controller.abort('secret-value')
  const result = await pending
  expect(result.stopReason).toBe('aborted')
  expect(JSON.stringify(result)).not.toContain('secret-value')
})

it('times out while reading a response body, not just waiting for headers', async () => {
  handler = (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.write('{')
  }
  const { models, model } = await setup({ timeoutMs: 50 })
  expect((await models.classify(model, context)).stopReason).toBe('error')
})

it('can disable queueing, failing fast above the default four concurrent requests', async () => {
  const responses: ServerResponse[] = []
  handler = (_request, response) => {
    responses.push(response)
  }
  const { models, model } = await setup({ maxQueuedRequests: 0 })
  const pending = Array.from({ length: 4 }, () => models.classify(model, context))
  for (let n = 0; n < 100 && responses.length < 4; n++) await delay(5)
  expect(responses).toHaveLength(4)
  expect((await models.classify(model, context)).stopReason).toBe('error')
  expect(requests).toHaveLength(4)
  for (const response of responses) response.end(JSON.stringify({ answers }))
  expect((await Promise.all(pending)).every((result) => result.stopReason === 'stop')).toBe(
    true,
  )
  handler = (_request, response) => response.end(JSON.stringify({ answers }))
  expect((await models.classify(model, context)).stopReason).toBe('stop')
})

it.each([
  { maxConcurrency: 1, maxQueuedRequests: 0 },
  { maxConcurrency: 64, maxQueuedRequests: 256 },
])('accepts configuration bounds and advertises the limits: %j', async (limits) => {
  const { instructions, models, model } = await setup({ ...limits, timeoutMs: 1234 })
  expect(instructions).toContain('Promise.allSettled')
  expect(instructions).toContain(`up to ${limits.maxConcurrency} classifier requests`)
  expect(instructions).toContain(`at most ${limits.maxQueuedRequests} additional requests`)
  expect(instructions).toContain('1234 ms deadline covers queue wait plus execution')
  expect(instructions).toContain("each result's stopReason")
  expect((await models.classify(model, context)).stopReason).toBe('stop')
})

it.each([4, 8])(
  'allows %s active requests (default 4), defaults to 64 queued, and sanitizes overflow',
  async (concurrency) => {
    const responses: ServerResponse[] = []
    handler = (_request, response) => {
      responses.push(response)
    }
    const { provider, model, policyKey } = await setup(
      concurrency === 4 ? {} : { maxConcurrency: concurrency },
    )
    const explicit = await setup({ maxConcurrency: concurrency, maxQueuedRequests: 64 })
    expect(explicit.policyKey).toBe(policyKey)
    const pending = Array.from({ length: concurrency + 64 }, () =>
      provider.classify!(model, context),
    )
    await expect.poll(() => responses.length).toBe(concurrency)
    const overflow = await provider.classify!(model, context)
    expect(overflow).toMatchObject({
      stopReason: 'error',
      answers: {},
      errorMessage: 'Review classifier request failed',
    })
    expect(requests).toHaveLength(concurrency)
    handler = (_request, response) => response.end(JSON.stringify({ answers }))
    for (const response of responses) response.end(JSON.stringify({ answers }))
    expect(
      (await Promise.all(pending)).every((result) => result.stopReason === 'stop'),
    ).toBe(true)
    expect(requests).toHaveLength(concurrency + 64)
  },
)

it('admits queued requests FIFO, ahead of new arrivals, with snapshotted inputs', async () => {
  const responses: ServerResponse[] = []
  handler = (_request, response) => {
    responses.push(response)
  }
  const { provider, model } = await setup({ maxConcurrency: 1, maxQueuedRequests: 3 })
  const input = (id: number): ClassifierContext => ({ ...context, state: { id } })
  const first = provider.classify!(model, input(0))
  await expect.poll(() => responses.length).toBe(1)
  const mutable = input(1)
  const second = provider.classify!(model, mutable)
  mutable.state.id = 'secret-value'
  const third = provider.classify!(model, input(2))
  responses[0]!.end(JSON.stringify({ answers }))
  expect((await first).stopReason).toBe('stop')
  const fourth = provider.classify!(model, input(3))
  for (let n = 1; n < 4; n++) {
    await expect.poll(() => responses.length).toBe(n + 1)
    expect(requests[n]!.body.state).toEqual({ id: n })
    responses[n]!.end(JSON.stringify({ answers }))
  }
  expect(
    (await Promise.all([second, third, fourth])).every((r) => r.stopReason === 'stop'),
  ).toBe(true)
})

it.each([0, 1])(
  'removes cancelled queue entries (position %s) without sending them',
  async (position) => {
    const responses: ServerResponse[] = []
    handler = (_request, response) => {
      responses.push(response)
    }
    const { provider, model } = await setup({ maxConcurrency: 1, maxQueuedRequests: 2 })
    const first = provider.classify!(model, context)
    await expect.poll(() => responses.length).toBe(1)
    const controller = new AbortController()
    const queued = [0, 1].map((id) =>
      provider.classify!(
        model,
        { ...context, state: { id } },
        {
          signal: id === position ? controller.signal : undefined,
        },
      ),
    )
    expect((await provider.classify!(model, context)).stopReason).toBe('error')
    controller.abort('secret-value')
    expect(await queued[position]).toMatchObject({
      stopReason: 'aborted',
      answers: {},
      errorMessage: 'Review classifier request cancelled',
    })
    const replacement = provider.classify!(model, { ...context, state: { id: 2 } })
    handler = (_request, response) => response.end(JSON.stringify({ answers }))
    responses[0]!.end(JSON.stringify({ answers }))
    expect((await first).stopReason).toBe('stop')
    expect((await queued[1 - position])!.stopReason).toBe('stop')
    expect((await replacement).stopReason).toBe('stop')
    expect(requests.map((request) => request.body.state.id)).toEqual([
      undefined,
      1 - position,
      2,
    ])
  },
)

it('checks already-aborted signals first and validates inputs before queue admission', async () => {
  const responses: ServerResponse[] = []
  handler = (_request, response) => {
    responses.push(response)
  }
  const { provider, model } = await setup({ maxConcurrency: 1, maxQueuedRequests: 1 })
  const first = provider.classify!(model, context)
  await expect.poll(() => responses.length).toBe(1)
  const access = vi.fn(() => {
    throw new Error('secret-value')
  })
  const invalid = {
    ...context,
    state: {
      get secret() {
        return access()
      },
    },
  }
  const aborted = AbortSignal.abort('secret-value')
  expect(await provider.classify!(model, invalid, { signal: aborted })).toMatchObject({
    stopReason: 'aborted',
    errorMessage: 'Review classifier request cancelled',
  })
  expect(access).not.toHaveBeenCalled()
  expect(await provider.classify!(model, invalid)).toMatchObject({
    stopReason: 'error',
    errorMessage: 'Review classifier request failed',
  })
  expect(access).toHaveBeenCalledOnce()
  expect((await provider.classify!(model, { ...context, questions: {} })).stopReason).toBe(
    'error',
  )
  const queued = provider.classify!(model, context)
  // Even a full queue must not mask already-cancelled callers or skip validation.
  expect((await provider.classify!(model, invalid, { signal: aborted })).stopReason).toBe(
    'aborted',
  )
  expect((await provider.classify!(model, invalid)).stopReason).toBe('error')
  expect(access).toHaveBeenCalledTimes(2)
  handler = (_request, response) => response.end(JSON.stringify({ answers }))
  responses[0]!.end(JSON.stringify({ answers }))
  expect((await first).stopReason).toBe('stop')
  expect((await queued).stopReason).toBe('stop')
  expect(requests).toHaveLength(2)
})

// Deliberately ignore abort in the transport to prove a signal alone cannot free a slot.
// The real native adapter still runs; only fetch and the deadline clock are controlled.
function heldTransport() {
  const calls: { signal: AbortSignal; finish: () => void }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (_url, init) =>
      new Promise((resolve) => {
        calls.push({
          signal: init!.signal!,
          finish: () => resolve(new Response(JSON.stringify({ answers }))),
        })
      }),
  )
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  return calls
}

it.each(['cancel', 'timeout'])(
  'retains active capacity after %s until HTTP settles; queued timeouts free queue space',
  async (mode) => {
    const { provider, model } = await setup({
      maxConcurrency: 1,
      maxQueuedRequests: 1,
      timeoutMs: 100,
    })
    const calls = heldTransport()
    const controller = new AbortController()
    const first = provider.classify!(model, context, { signal: controller.signal })
    await vi.advanceTimersByTimeAsync(25)
    expect(calls).toHaveLength(1)
    const expired = provider.classify!(model, context)
    if (mode === 'cancel') controller.abort('secret-value')
    await vi.advanceTimersByTimeAsync(100)
    expect(calls[0]!.signal.aborted).toBe(true)
    expect(await expired).toMatchObject({
      stopReason: 'error',
      errorMessage: 'Review classifier request failed',
      answers: {},
    })
    const replacement = provider.classify!(model, context)
    expect((await provider.classify!(model, context)).stopReason).toBe('error')
    expect(calls).toHaveLength(1)
    calls[0]!.finish()
    expect(await first).toMatchObject({
      stopReason: mode === 'cancel' ? 'aborted' : 'error',
      answers: {},
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(2)
    calls[1]!.finish()
    expect((await replacement).stopReason).toBe('stop')
    expect(vi.getTimerCount()).toBe(0)
  },
)

it('does not reset the deadline when a queued request enters execution', async () => {
  const { provider, model } = await setup({
    maxConcurrency: 1,
    maxQueuedRequests: 1,
    timeoutMs: 100,
  })
  const calls = heldTransport()
  const first = provider.classify!(model, context)
  await vi.advanceTimersByTimeAsync(40)
  const second = provider.classify!(model, context)
  await vi.advanceTimersByTimeAsync(40)
  expect(calls).toHaveLength(1)
  calls[0]!.finish()
  expect((await first).stopReason).toBe('stop')
  await vi.advanceTimersByTimeAsync(59)
  expect(calls).toHaveLength(2)
  expect(calls[1]!.signal.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(calls[1]!.signal.aborted).toBe(true)
  calls[1]!.finish()
  expect((await second).stopReason).toBe('error')
  expect(vi.getTimerCount()).toBe(0)
})

it('has a stable policy key independent of resolved credentials but sensitive to configuration', async () => {
  const first = await setup(
    { apiKeyEnv: 'KEY', headers: { 'X-Client': 'a' } },
    { KEY: 'one' },
  )
  const second = await setup(
    { headers: { 'X-Client': 'a' }, apiKeyEnv: 'KEY' },
    { KEY: 'two' },
  )
  expect(first.policyKey).toBe(second.policyKey)
  for (const override of [
    { endpoint: `${endpoint}/other` },
    { model: 'other' },
    { apiKeyEnv: 'OTHER' },
    { headers: { 'X-Client': 'b' } },
    { maxConcurrency: 8 },
    { maxQueuedRequests: 0 },
  ]) {
    const changed = await setup(
      { apiKeyEnv: 'KEY', headers: { 'X-Client': 'a' }, ...override },
      { KEY: 'one', OTHER: 'one' },
    )
    expect(changed.policyKey).not.toBe(first.policyKey)
  }
})
