/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Models } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SCORE_CLASSIFIER,
  SCORE_MAX_HUNK_BYTES,
  SCORE_PROFILE,
  SCORE_QUESTION,
} from '../shared/scoring.ts'

const createModelRuntime = vi.fn()
const typesafeSystemOneApi = vi.fn(() => ({ classify: vi.fn() }))

vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRuntime: {
    create: createModelRuntime,
  },
}))

vi.mock('@earendil-works/pi-ai/api/typesafe-system-one.lazy', () => ({
  typesafeSystemOneApi,
}))

const { createReviewModels, scoreHunk } = await import('./modelRuntime.ts')

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('createReviewModels', () => {
  it('registers the local H2O classifier and reads the global default chat model', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'skepsis-model-runtime-'))
    try {
      await writeFile(
        join(agentDir, 'settings.json'),
        JSON.stringify({
          defaultProvider: 'anthropic',
          defaultModel: 'claude-sonnet-4-5',
        }),
      )

      const registerProvider = vi.fn()
      const runtime = {
        registerProvider,
        getModel: vi.fn((provider: string, modelId: string) =>
          provider === 'anthropic' && modelId === 'claude-sonnet-4-5' ? {} : undefined,
        ),
      }
      createModelRuntime.mockResolvedValue(runtime)
      vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)

      const result = await createReviewModels()

      expect(createModelRuntime).toHaveBeenCalledWith({
        authPath: join(agentDir, 'auth.json'),
        modelsPath: join(agentDir, 'models.json'),
        allowModelNetwork: false,
      })
      expect(typesafeSystemOneApi).toHaveBeenCalledTimes(1)
      expect(registerProvider).toHaveBeenCalledWith(
        SCORE_CLASSIFIER.provider,
        expect.objectContaining({
          name: 'Local H2O-Lightning',
          baseUrl: 'http://127.0.0.1:8009/v1',
          apiKey: 'local',
          models: [
            expect.objectContaining({
              type: 'classifier',
              id: SCORE_CLASSIFIER.id,
              api: 'typesafe-system-one',
              input: ['text'],
              contextWindow: 32_000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            }),
          ],
          classifiers: {
            'typesafe-system-one': expect.any(Object),
          },
        }),
      )
      expect(result).toEqual({
        models: runtime,
        model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
      })
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  it('requires SKEPSIS_AGENT_PROVIDER and SKEPSIS_AGENT_MODEL together', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'skepsis-model-runtime-'))
    try {
      await writeFile(
        join(agentDir, 'settings.json'),
        JSON.stringify({
          defaultProvider: 'anthropic',
          defaultModel: 'claude-sonnet-4-5',
        }),
      )

      const runtime = {
        registerProvider: vi.fn(),
        getModel: vi.fn(),
      }
      createModelRuntime.mockResolvedValue(runtime)
      vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
      vi.stubEnv('SKEPSIS_AGENT_PROVIDER', 'openai')

      const result = await createReviewModels()

      expect(result.models).toBe(runtime)
      expect(result.model).toBeUndefined()
      expect(result.modelError).toContain(
        'Set SKEPSIS_AGENT_PROVIDER and SKEPSIS_AGENT_MODEL together',
      )
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  it('uses the explicit env override when both override variables are set', async () => {
    const runtime = {
      registerProvider: vi.fn(),
      getModel: vi.fn((provider: string, modelId: string) =>
        provider === 'openai' && modelId === 'gpt-5-mini' ? {} : undefined,
      ),
    }
    createModelRuntime.mockResolvedValue(runtime)
    vi.stubEnv('SKEPSIS_AGENT_PROVIDER', 'openai')
    vi.stubEnv('SKEPSIS_AGENT_MODEL', 'gpt-5-mini')
    vi.stubEnv('H2O_BASE_URL', 'http://localhost:9000/v1')

    const result = await createReviewModels()

    expect(runtime.registerProvider).toHaveBeenCalledWith(
      SCORE_CLASSIFIER.provider,
      expect.objectContaining({ baseUrl: 'http://localhost:9000/v1' }),
    )
    expect(result).toEqual({
      models: runtime,
      model: { provider: 'openai', modelId: 'gpt-5-mini' },
    })
  })
})

describe('scoreHunk', () => {
  it('returns the bool probability, forwards the abort signal, and sends the shared score profile', async () => {
    const signal = new AbortController().signal
    const classifier = { provider: SCORE_CLASSIFIER.provider, id: SCORE_CLASSIFIER.id }
    const classify = vi.fn(async (_model, context, options) => {
      expect(options).toEqual({ signal })
      expect(context).toEqual({
        state: {
          profile: SCORE_PROFILE,
          file: 'src/app.ts',
          text: '@@ -1 +1 @@\n-old\n+new',
        },
        questions: {
          review: SCORE_QUESTION,
        },
      })
      return {
        api: 'typesafe-system-one',
        provider: SCORE_CLASSIFIER.provider,
        model: SCORE_CLASSIFIER.id,
        answers: {
          review: { type: 'bool', probability: 0.73 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      }
    })

    const models = {
      getModelOfType: vi.fn(() => classifier),
      classify,
    } as unknown as Models

    await expect(
      scoreHunk(models, { file: 'src/app.ts', text: '@@ -1 +1 @@\n-old\n+new' }, signal),
    ).resolves.toBe(0.73)
    expect(models.getModelOfType).toHaveBeenCalledWith(
      'classifier',
      SCORE_CLASSIFIER.provider,
      SCORE_CLASSIFIER.id,
    )
  })

  it('checks stopReason before reading answers', async () => {
    const classifier = { provider: SCORE_CLASSIFIER.provider, id: SCORE_CLASSIFIER.id }
    const models = {
      getModelOfType: vi.fn(() => classifier),
      classify: vi.fn(async () => ({
        api: 'typesafe-system-one',
        provider: SCORE_CLASSIFIER.provider,
        model: SCORE_CLASSIFIER.id,
        answers: {
          review: { type: 'bool', probability: 0.4 },
        },
        stopReason: 'error',
        errorMessage: 'service unavailable',
        timestamp: Date.now(),
      })),
    } as unknown as Models

    await expect(
      scoreHunk(
        models,
        { file: 'src/app.ts', text: 'patch' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('service unavailable')
  })

  it('rejects invalid bool probabilities', async () => {
    const classifier = { provider: SCORE_CLASSIFIER.provider, id: SCORE_CLASSIFIER.id }
    const models = {
      getModelOfType: vi.fn(() => classifier),
      classify: vi.fn(async () => ({
        api: 'typesafe-system-one',
        provider: SCORE_CLASSIFIER.provider,
        model: SCORE_CLASSIFIER.id,
        answers: {
          review: { type: 'bool', probability: 1.5 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      })),
    } as unknown as Models

    await expect(
      scoreHunk(
        models,
        { file: 'src/app.ts', text: 'patch' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('invalid bool probability')
  })

  it('fails oversized hunks before calling the classifier', async () => {
    const models = {
      getModelOfType: vi.fn(),
      classify: vi.fn(),
    } as unknown as Models

    await expect(
      scoreHunk(
        models,
        { file: 'src/app.ts', text: 'x'.repeat(SCORE_MAX_HUNK_BYTES + 1) },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Hunk exceeds classifier context budget')
    expect(models.getModelOfType).not.toHaveBeenCalled()
    expect(models.classify).not.toHaveBeenCalled()
  })
})
