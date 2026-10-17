/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Models } from '@earendil-works/pi-ai'
import { typesafeSystemOneApi } from '@earendil-works/pi-ai/api/typesafe-system-one.lazy'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { ModelRef } from '@earendil-works/pi-durable'
import {
  SCORE_CLASSIFIER,
  SCORE_MAX_HUNK_BYTES,
  SCORE_PROFILE,
  SCORE_QUESTION,
} from '../shared/scoring.ts'

const DEFAULT_AGENT_DIR = join(homedir(), '.pi', 'agent')
const DEFAULT_H2O_BASE_URL = 'http://127.0.0.1:8009/v1'
const SETTINGS_FILE = 'settings.json'
const AUTH_FILE = 'auth.json'
const MODELS_FILE = 'models.json'
const SCORE_ANSWER_KEY = 'review' as const
const OVERSIZED_HUNK_ERROR = 'Hunk exceeds classifier context budget; review it manually.'

export interface ReviewModelsResult {
  models: Models
  model?: ModelRef
  modelError?: string
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

function getAgentDir(): string {
  return envValue('PI_CODING_AGENT_DIR') ?? DEFAULT_AGENT_DIR
}

function formatError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

function createAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

async function loadConfiguredChatModel(settingsPath: string): Promise<{
  model?: ModelRef
  error?: string
}> {
  let raw: string
  try {
    raw = await readFile(settingsPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        error:
          `No default Pi chat model is configured. Set SKEPSIS_AGENT_PROVIDER and ` +
          `SKEPSIS_AGENT_MODEL together, or configure defaultProvider/defaultModel in ${settingsPath}.`,
      }
    }
    return {
      error: `Could not read global Pi settings at ${settingsPath}: ${formatError(error)}`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/u, ''))
  } catch (error) {
    return {
      error: `Could not parse global Pi settings at ${settingsPath}: ${formatError(error)}`,
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      error: `Global Pi settings at ${settingsPath} must contain a JSON object.`,
    }
  }

  const settings = parsed as Record<string, unknown>
  const provider =
    typeof settings['defaultProvider'] === 'string'
      ? settings['defaultProvider']
      : undefined
  const modelId =
    typeof settings['defaultModel'] === 'string' ? settings['defaultModel'] : undefined

  if (provider && modelId) return { model: { provider, modelId } }
  if (provider || modelId) {
    return {
      error:
        `Global Pi settings at ${settingsPath} must set both defaultProvider and defaultModel ` +
        `for Skepsis review questions, or neither.`,
    }
  }

  return {
    error:
      `No default Pi chat model is configured. Set SKEPSIS_AGENT_PROVIDER and ` +
      `SKEPSIS_AGENT_MODEL together, or configure defaultProvider/defaultModel in ${settingsPath}.`,
  }
}

function validateChatModel(
  models: Models,
  model: ModelRef,
  source: string,
): string | undefined {
  if (models.getModel(model.provider, model.modelId)) return undefined
  return (
    `Configured review chat model ${model.provider}/${model.modelId} from ${source} is not ` +
    `available as a chat model in the global Pi catalog.`
  )
}

function registerLocalScoreProvider(runtime: ModelRuntime): void {
  runtime.registerProvider(SCORE_CLASSIFIER.provider, {
    name: 'Local H2O-Lightning',
    baseUrl: envValue('H2O_BASE_URL') ?? DEFAULT_H2O_BASE_URL,
    apiKey: 'local',
    models: [
      {
        type: 'classifier',
        id: SCORE_CLASSIFIER.id,
        name: 'H2O-Lightning 4B (local)',
        api: 'typesafe-system-one',
        input: ['text'],
        contextWindow: 32_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    classifiers: {
      'typesafe-system-one': typesafeSystemOneApi(),
    },
  })
}

/**
 * Build a Pi-backed model registry from the user's global Pi configuration only.
 * This intentionally ignores project config and extensions. Local H2O scoring can
 * be pointed at a non-default endpoint with H2O_BASE_URL.
 */
export async function createReviewModels(): Promise<ReviewModelsResult> {
  const agentDir = getAgentDir()
  const authPath = join(agentDir, AUTH_FILE)
  const modelsPath = join(agentDir, MODELS_FILE)
  const settingsPath = join(agentDir, SETTINGS_FILE)

  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath,
    allowModelNetwork: false,
  })
  registerLocalScoreProvider(runtime)

  const overrideProvider = envValue('SKEPSIS_AGENT_PROVIDER')
  const overrideModel = envValue('SKEPSIS_AGENT_MODEL')
  if (overrideProvider || overrideModel) {
    if (!overrideProvider || !overrideModel) {
      return {
        models: runtime,
        modelError:
          'Set SKEPSIS_AGENT_PROVIDER and SKEPSIS_AGENT_MODEL together, or unset both ' +
          `to use ${settingsPath}.`,
      }
    }

    const model = { provider: overrideProvider, modelId: overrideModel }
    const error = validateChatModel(
      runtime,
      model,
      'SKEPSIS_AGENT_PROVIDER/SKEPSIS_AGENT_MODEL',
    )
    return {
      models: runtime,
      ...(error ? { modelError: error } : { model }),
    }
  }

  const configured = await loadConfiguredChatModel(settingsPath)
  if (!configured.model) {
    return {
      models: runtime,
      modelError: configured.error,
    }
  }

  const error = validateChatModel(runtime, configured.model, settingsPath)
  if (error) {
    return {
      models: runtime,
      modelError: error,
    }
  }

  return {
    models: runtime,
    model: configured.model,
  }
}

export async function scoreHunk(
  models: Models,
  hunk: { file: string; text: string },
  signal: AbortSignal,
): Promise<number> {
  if (Buffer.byteLength(hunk.text) > SCORE_MAX_HUNK_BYTES) {
    throw new Error(OVERSIZED_HUNK_ERROR)
  }

  const classifier = models.getModelOfType(
    'classifier',
    SCORE_CLASSIFIER.provider,
    SCORE_CLASSIFIER.id,
  )
  if (!classifier) {
    throw new Error(
      `Local review classifier ${SCORE_CLASSIFIER.provider}/${SCORE_CLASSIFIER.id} is unavailable. ` +
        `Set H2O_BASE_URL if the service is not listening on ${DEFAULT_H2O_BASE_URL}.`,
    )
  }

  const result = await models.classify(
    classifier,
    {
      state: {
        profile: SCORE_PROFILE,
        file: hunk.file,
        text: hunk.text,
      },
      questions: {
        [SCORE_ANSWER_KEY]: SCORE_QUESTION,
      },
    },
    { signal },
  )

  if (signal.aborted || result.stopReason === 'aborted') {
    throw createAbortError(signal)
  }
  if (result.stopReason !== 'stop') {
    throw new Error(
      result.errorMessage?.trim() ||
        `Local review classifier ${SCORE_CLASSIFIER.provider}/${SCORE_CLASSIFIER.id} failed. ` +
          `Set H2O_BASE_URL if the service is not listening on ${DEFAULT_H2O_BASE_URL}.`,
    )
  }
  if (
    result.provider !== SCORE_CLASSIFIER.provider ||
    result.model !== SCORE_CLASSIFIER.id
  ) {
    throw new Error(
      `Local review classifier identity mismatch: expected ` +
        `${SCORE_CLASSIFIER.provider}/${SCORE_CLASSIFIER.id}, got ${result.provider}/${result.model}.`,
    )
  }

  const answer = result.answers[SCORE_ANSWER_KEY]
  if (!answer || answer.type !== 'bool') {
    throw new Error('Local review classifier returned a non-bool score answer.')
  }
  if (
    !Number.isFinite(answer.probability) ||
    answer.probability < 0 ||
    answer.probability > 1
  ) {
    throw new Error('Local review classifier returned an invalid bool probability.')
  }

  return answer.probability
}
