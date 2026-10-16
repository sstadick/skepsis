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
import { afterEach, beforeEach, expect, it } from 'vitest'
import { loadReviewClassifier } from './reviewClassifier.ts'

let directory: string
let endpoint: string
let requests: {
  url: string
  headers: IncomingMessage['headers']
  body: { questions: Record<string, { type: string }> }
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

it('fails fast above four concurrent requests and releases slots', async () => {
  const responses: ServerResponse[] = []
  handler = (_request, response) => {
    responses.push(response)
  }
  const { models, model } = await setup()
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
  ]) {
    const changed = await setup(
      { apiKeyEnv: 'KEY', headers: { 'X-Client': 'a' }, ...override },
      { KEY: 'one', OTHER: 'one' },
    )
    expect(changed.policyKey).not.toBe(first.policyKey)
  }
})
