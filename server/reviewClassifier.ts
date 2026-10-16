/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { z } from 'zod'
import {
  createProvider,
  type ClassifierContext,
  type ClassifierModel,
  type ClassifierResult,
  type Provider,
} from '@earendil-works/pi-ai'
import { classify } from '@earendil-works/pi-ai/api/typesafe-system-one'

const API = 'typesafe-system-one'
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
const text = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) =>
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ),
  )
const configSchema = z.strictObject({
  provider: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,63}$/)
    .default('review-classifier'),
  model: text,
  endpoint: text,
  apiKeyEnv: envName.optional(),
  headers: z.record(z.string(), z.string()).default({}),
  headerEnv: z.record(z.string(), envName).default({}),
  contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(32768),
  maxRequestBytes: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024)
    .default(131072),
  timeoutMs: z.number().int().positive().max(60000).default(30000),
  cost: z
    .strictObject({
      input: z.number().nonnegative().finite(),
      output: z.number().nonnegative().finite(),
    })
    .default({ input: 0, output: 0 }),
})

// Transport-controlled and hop-by-hop headers must never be configurable.
const forbiddenHeader =
  /^(host|content-length|content-type|connection|transfer-encoding|te|trailer|upgrade|expect|keep-alive|accept-encoding|proxy-.*|sec-.*|origin|referer)$/i
const secretHeader = /authorization|cookie|token|secret|api[-_]?key/i
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const headerValue = /^[\x20-\x7e]*$/

function invalid(): never {
  throw new Error('Invalid review classifier configuration')
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

// JSON.stringify alone silently drops undefined/functions and replaces NaN with null.
function serialize(value: unknown, maxBytes: number): string {
  const seen = new Set<object>()
  function visit(v: unknown, depth: number): void {
    if (depth > 100) throw new Error('Invalid classifier input')
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return
    if (typeof v === 'number' && Number.isFinite(v)) return
    if (typeof v !== 'object' || !v || seen.has(v))
      throw new Error('Invalid classifier input')
    if (
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      throw new Error('Invalid classifier input')
    seen.add(v)
    for (const entry of Object.values(v)) visit(entry, depth + 1)
    seen.delete(v)
  }
  visit(value, 0)
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json) > maxBytes) throw new Error('Classifier request too large')
  return json
}

const questionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('bool'),
    instructions: z.string(),
    criteria: z.strictObject({ true: z.string(), false: z.string() }),
  }),
  z.strictObject({
    type: z.literal('choice'),
    instructions: z.string(),
    criteria: z.record(z.string(), z.string()).refine((v) => Object.keys(v).length >= 2),
  }),
  z.strictObject({
    type: z.literal('score'),
    instructions: z.string(),
    criteria: z.array(z.string()).min(2),
  }),
])
const contextSchema = z.strictObject({
  state: z.record(z.string(), z.unknown()),
  questions: z.record(z.string(), questionSchema).refine((v) => Object.keys(v).length > 0),
  images: z.array(z.never()).max(0).optional(),
})
const probability = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1
function validAnswers(result: ClassifierResult, context: ClassifierContext): boolean {
  return Object.entries(context.questions).every(([id, question]) => {
    const answer = result.answers[id]
    if (!answer || answer.type !== question.type) return false
    if (answer.type === 'bool') return probability(answer.probability)
    if (!probability(answer.confidence)) return false
    if (answer.type === 'score' && question.type === 'score') {
      return (
        Number.isFinite(answer.score) &&
        answer.score >= 0 &&
        answer.score <= question.criteria.length - 1
      )
    }
    if (answer.type !== 'choice' || question.type !== 'choice') return false
    const keys = Object.keys(question.criteria)
    const values = Object.values(answer.probabilities)
    return (
      Object.hasOwn(question.criteria, answer.choice) &&
      keys.length === values.length &&
      keys.every((k) => Object.hasOwn(answer.probabilities, k)) &&
      values.every(probability) &&
      Math.abs(values.reduce((a, b) => a + b, 0) - 1) <= 0.0001
    )
  })
}

/** Loads only a bounded JSON file; credentials stay inside the transport closure. */
export async function loadReviewClassifier(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  provider: Provider
  summary: { provider: string; model: string; endpoint: string }
  instructions: string
  policyKey: string
}> {
  let raw: unknown
  try {
    // O_NONBLOCK prevents a named pipe from hanging before the regular-file check.
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 65536) invalid()
      const buffer = Buffer.alloc(65537)
      let length = 0
      while (length < buffer.length) {
        // Sequential reads enforce the bound even if the file grows during loading.
        // eslint-disable-next-line no-await-in-loop
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > 65536) invalid()
      raw = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)),
      )
    } finally {
      await file.close()
    }
  } catch {
    throw new Error(
      'Cannot load review classifier configuration: use a readable regular JSON file (at most 64 KiB)',
    )
  }
  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) invalid()
  const config = parsed.data
  if (['anthropic', 'openai', 'openai-codex'].includes(config.provider)) invalid()
  try {
    const url = new URL(config.endpoint)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      config.endpoint.includes('?') ||
      config.endpoint.includes('#')
    )
      invalid()
    config.endpoint = url.href
  } catch {
    invalid()
  }

  const headers = new Headers({ 'content-type': 'application/json' })
  const names = new Set<string>()
  for (const [entries, secret] of [
    [config.headers, false],
    [config.headerEnv, true],
  ] as const) {
    for (const [name, value] of Object.entries(entries)) {
      const lower = name.toLowerCase()
      if (
        !headerName.test(name) ||
        forbiddenHeader.test(name) ||
        names.has(lower) ||
        (!secret && secretHeader.test(name))
      )
        invalid()
      names.add(lower)
      const resolved = secret ? env[value] : value
      if (resolved === undefined || (secret && !resolved.trim()))
        throw new Error('Review classifier environment credentials are missing')
      if (!headerValue.test(resolved)) invalid()
      headers.set(name, resolved)
    }
  }
  if (config.apiKeyEnv) {
    const key = env[config.apiKeyEnv]
    if (!key?.trim())
      throw new Error('Review classifier environment credentials are missing')
    if (!headerValue.test(key) || names.has('authorization')) invalid()
    headers.set('authorization', `Bearer ${key}`)
  }

  const model: ClassifierModel<typeof API> = {
    type: 'classifier',
    id: config.model,
    name: config.model,
    provider: config.provider,
    api: API,
    baseUrl: config.endpoint,
    input: ['text'],
    contextWindow: config.contextWindow,
    cost: { ...config.cost, cacheRead: 0, cacheWrite: 0 },
  }
  let active = 0
  const provider = createProvider({
    id: config.provider,
    auth: {
      apiKey: {
        name: 'Review classifier configuration',
        check: async () => ({ type: 'api_key', source: 'configured' }),
        resolve: async () => ({ auth: {}, source: 'configured' }),
      },
    },
    // Keep the transport model separate from mutable public catalog objects.
    models: [structuredClone(model)],
    classifiers: {
      [API]: {
        classify: async (requested, context, options) => {
          const failure = (aborted = false): ClassifierResult => ({
            api: API,
            provider: config.provider,
            model: config.model,
            answers: {},
            stopReason: aborted ? 'aborted' : 'error',
            errorMessage: aborted
              ? 'Review classifier request cancelled'
              : 'Review classifier request failed',
            timestamp: Date.now(),
          })
          if (active >= 4) return failure()
          active++
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), config.timeoutMs)
          const signal = options?.signal
            ? AbortSignal.any([controller.signal, options.signal])
            : controller.signal
          try {
            if (signal.aborted) return failure(true)
            if (
              requested.id !== model.id ||
              requested.provider !== model.provider ||
              requested.api !== API ||
              requested.type !== 'classifier'
            )
              return failure()
            const serialized = serialize(context, config.maxRequestBytes)
            const input = contextSchema.parse(JSON.parse(serialized)) as ClassifierContext
            // Never pass caller hooks, credentials, headers, fetch, or endpoint overrides.
            const result = await classify(model, input, {
              apiKey: 'review-classifier-transport-placeholder',
              signal,
              maxRetries: 0,
              fetch: async (_url, init) => {
                if (
                  typeof init?.body !== 'string' ||
                  Buffer.byteLength(init.body) > config.maxRequestBytes
                )
                  throw new Error('Classifier request too large')
                // The native adapter requires a key even for keyless servers. Its dummy
                // Authorization is discarded along with all native/request headers.
                const response = await globalThis.fetch(config.endpoint, {
                  method: 'POST',
                  headers,
                  body: init.body,
                  signal,
                  redirect: 'manual',
                })
                if (!response.ok) {
                  await response.body?.cancel()
                  throw new Error('Classifier HTTP failure')
                }
                const reader = response.body?.getReader()
                if (!reader) throw new Error('Classifier response missing')
                const chunks: Uint8Array[] = []
                let size = 0
                try {
                  while (true) {
                    // Stream incrementally so an untrusted response cannot exceed the cap.
                    // eslint-disable-next-line no-await-in-loop
                    const next = await reader.read()
                    if (next.done) break
                    size += next.value.byteLength
                    if (size > 1024 * 1024) throw new Error('Classifier response too large')
                    chunks.push(next.value)
                  }
                } finally {
                  await reader.cancel().catch(() => {})
                  reader.releaseLock()
                }
                return new Response(Buffer.concat(chunks), {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                })
              },
            })
            if (signal.aborted) return failure(Boolean(options?.signal?.aborted))
            if (result.stopReason !== 'stop' || !validAnswers(result, input)) {
              return { ...failure(), ...(result.usage ? { usage: result.usage } : {}) }
            }
            return result
          } catch {
            return failure(Boolean(options?.signal?.aborted))
          } finally {
            clearTimeout(timer)
            active--
          }
        },
      },
    },
  })
  return {
    provider,
    summary: { provider: config.provider, model: config.model, endpoint: config.endpoint },
    policyKey: createHash('sha256').update(canonical(config)).digest('hex'),
    instructions: `Use the configured classifier only for narrow structured classification, routing, ranking, scoring, or triage, not prose or general reasoning. Combine related questions over shared state. Always check stopReason before using answers; errors are not answers. A bool probability is P(true), not a boolean; a score is a continuous expected level (zero-based), not a selected category. Inspect probabilities and escalate ambiguous or consequential decisions. Text/JSON only, no images. Context window: ${config.contextWindow} tokens; maximum JSON request: ${config.maxRequestBytes} bytes. Summarize or split longer inputs conservatively.`,
  }
}
