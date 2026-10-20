/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

/* oxlint-disable no-await-in-loop -- Lock acquisition and ordered provider selection must be sequential. */
/* oxlint-disable preserve-caught-error -- Credential errors must not retain secret-bearing causes. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import lockfile from 'proper-lockfile'
import { createModels } from '@earendil-works/pi-ai/models'
import type { Credential, CredentialStore, Models } from '@earendil-works/pi-ai'
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot'
import type { ReviewSnapshot } from '../shared/review.ts'
import { loadReviewClassifier } from './reviewClassifier.ts'

// Despite its name, this entry point uses Node-compatible flows, not Bun APIs.
// Static registration is needed because the default OAuth imports are bundler-opaque.
registerBunOAuthFlows()

const authError =
  'Cannot read Pi credentials. Check auth.json or sign in again with Pi. Shell (!command) credentials are not supported; use an API key or environment variable.'

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function readObject(
  path: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, { encoding: 'utf8', signal }))
    if (!object(value)) throw new Error('Invalid object')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    // JSON parse and filesystem errors can contain credential contents or paths.
    throw new Error(authError)
  }
}

function credential(value: unknown): Credential | undefined {
  if (value === undefined) return undefined
  if (!object(value)) throw new Error(authError)
  if (value.type === 'api_key' && typeof value.key === 'string' && value.key.trim()) {
    if (value.key.trimStart().startsWith('!')) throw new Error(authError)
    if (
      value.env !== undefined &&
      (!object(value.env) || Object.values(value.env).some((v) => typeof v !== 'string'))
    )
      throw new Error(authError)
    return value as unknown as Credential
  }
  if (
    value.type === 'oauth' &&
    typeof value.access === 'string' &&
    value.access &&
    typeof value.refresh === 'string' &&
    value.refresh &&
    typeof value.expires === 'number' &&
    Number.isFinite(value.expires)
  ) {
    return value as unknown as Credential
  }
  throw new Error(authError)
}

/** Pi-compatible, whole-file locking also protects unrelated providers during refresh. */
export function createPiCredentialStore(
  credentialPath: string,
  env: NodeJS.ProcessEnv = process.env,
): CredentialStore {
  const authPath = resolve(credentialPath)
  function resolveCredential(value: unknown) {
    const entry = credential(value)
    if (entry?.type !== 'api_key' || !entry.key) return entry
    return { ...entry, key: env[entry.key] ?? entry.key }
  }
  async function transaction<T>(
    signal: AbortSignal | undefined,
    fn: (data: Record<string, unknown>, check: () => void) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted()
    await mkdir(dirname(authPath), { recursive: true, mode: 0o700 })
    let compromised = false
    let release: (() => Promise<void>) | undefined
    const check = () => {
      signal?.throwIfAborted()
      if (compromised)
        throw new Error('Pi credential lock was compromised; retry authentication.')
    }
    // Retry ourselves so waiting for another Pi process is bounded and cancellable.
    const expires = Date.now() + 30_000
    while (!release) {
      check()
      if (Date.now() >= expires) throw new Error('Timed out waiting for Pi credential lock')
      try {
        release = await lockfile.lock(authPath, {
          realpath: false,
          stale: 30_000,
          retries: 0,
          onCompromised: () => {
            compromised = true
          },
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw new Error(authError)
        await delay(25, undefined, { signal })
      }
    }
    try {
      check()
      return await fn(await readObject(authPath, signal), check)
    } finally {
      await release().catch(() => {
        /* A compromised lock may already be gone. */
      })
    }
  }
  async function save(data: Record<string, unknown>, check: () => void) {
    const temporary = `${authPath}.${randomUUID()}.tmp`
    try {
      check()
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      })
      check()
      await rename(temporary, authPath)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  return {
    async read(providerId, options) {
      options?.signal?.throwIfAborted()
      return resolveCredential((await readObject(authPath, options?.signal))[providerId])
    },
    async list(options) {
      options?.signal?.throwIfAborted()
      const data = await readObject(authPath, options?.signal)
      return Object.entries(data).flatMap(([providerId, value]) =>
        object(value) && (value.type === 'api_key' || value.type === 'oauth')
          ? [{ providerId, type: value.type }]
          : [],
      )
    },
    async modify(providerId, fn, options) {
      return transaction(options?.signal, async (data, check) => {
        // Keep the stored representation for mutation: never persist resolved env secrets.
        const current = credential(data[providerId])
        const next = await fn(current)
        check()
        if (next !== undefined) {
          credential(next)
          Object.defineProperty(data, providerId, {
            value: next,
            enumerable: true,
            configurable: true,
            writable: true,
          })
          await save(data, check)
        }
        return next ?? current
      })
    },
    async delete(providerId, options) {
      await transaction(options?.signal, async (data, check) => {
        delete data[providerId]
        await save(data, check)
      })
    },
  }
}

type Setup = {
  models: Models
  model?: { provider: string; modelId: string }
  status: ReviewSnapshot['agent']
  classifierInstructions?: string
  classifierConcurrency?: number
  toolPolicyKey?: string
}

export async function setupReviewAgent(
  modelOption?: string | false,
  classifierConfig?: string,
): Promise<Setup> {
  return setupReviewAgentWithEnvironment(
    modelOption,
    process.env,
    homedir(),
    classifierConfig,
  )
}

// Installing a data-only user config is a persistent opt-in. Never look in the
// reviewed working directory or load executable Pi extensions to discover one.
async function defaultClassifierConfig(env: NodeJS.ProcessEnv, home: string) {
  const configHome =
    env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : join(home, '.config')
  const path = join(configHome, 'skepsis', 'classifier.json')
  try {
    await lstat(path)
    return path
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('Cannot read the default classifier configuration')
  }
}

/** Explicit environment/home injection keeps tests away from real user credentials. */
export async function setupReviewAgentWithEnvironment(
  modelOption: string | false | undefined,
  env: NodeJS.ProcessEnv,
  home: string,
  classifierConfig?: string,
): Promise<Setup> {
  // Explicit paths win over the persistent user default; invalid selected
  // config fails closed rather than falling back to a different endpoint.
  const configPath =
    modelOption === false
      ? undefined
      : (classifierConfig ??
        env.SKEPSIS_CLASSIFIER_CONFIG ??
        (await defaultClassifierConfig(env, home)))
  const classifier =
    configPath !== undefined
      ? await loadReviewClassifier(resolve(configPath.replace(/^~(?=\/|$)/, home)), env)
      : undefined
  const directory =
    env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/|$)/, home) || join(home, '.pi', 'agent')
  const credentials = createPiCredentialStore(join(directory, 'auth.json'), env)
  const models = createModels({
    credentials: {
      ...credentials,
      // The endpoint's auth is exclusively its explicit configuration, not a
      // potentially unrelated Pi credential sharing the same provider label.
      read: (id, options) =>
        id === classifier?.summary.provider
          ? Promise.resolve(undefined)
          : credentials.read(id, options),
    },
    authContext: { env: async (name) => env[name], fileExists: async () => false },
  })
  const result: Setup = {
    models,
    status: { model: null, available: false, enabled: modelOption !== false },
  }
  if (modelOption === false) return result
  models.setProvider(anthropicProvider())
  const openai = openaiProvider()
  // A chat API key must not silently opt the user into a second inference
  // service. Codemode exposes only the classifier explicitly configured here.
  models.setProvider({ ...openai, getAllModels: () => openai.getModels() })
  models.setProvider(openaiCodexProvider())
  models.setProvider(githubCopilotProvider())
  result.status.codemode = true
  result.toolPolicyKey = `review-codemode-v2:${classifier?.policyKey ?? 'no-classifier'}`
  if (classifier) {
    models.setProvider(classifier.provider)
    result.status.classifier = classifier.summary
    result.classifierConcurrency = classifier.concurrency
    result.classifierInstructions = `Configured decision model: models.getModelOfType("classifier", ${JSON.stringify(classifier.summary.provider)}, ${JSON.stringify(classifier.summary.model)}). ${classifier.instructions}`
  } else {
    result.classifierInstructions =
      'No decision classifier is configured. Use codemode for batching read-only tools; do not substitute chat or image services for a classifier.'
  }
  try {
    let selection = modelOption ?? env.SKEPSIS_MODEL
    if (selection === undefined) {
      const settings = await readObject(join(directory, 'settings.json'))
      if (
        typeof settings.defaultProvider === 'string' &&
        typeof settings.defaultModel === 'string'
      ) {
        selection = `${settings.defaultProvider}/${settings.defaultModel}`
      }
    }
    if (selection === undefined) {
      const defaults = [
        ['anthropic', 'claude-sonnet-4-5'],
        ['openai', 'gpt-5-mini'],
        ['openai-codex', 'gpt-5.3-codex'],
        ['github-copilot', 'gpt-5.3-codex'],
      ]
      for (const [provider, id] of defaults) {
        const available = await models.getAvailable(provider)
        const model = available.find((m) => m.id === id) ?? available[0]
        if (model) {
          selection = `${provider}/${model.id}`
          break
        }
      }
    }
    if (!selection) {
      result.status.error =
        'No review model configured. Set --model provider/modelId or SKEPSIS_MODEL and configure Pi auth or an API key. Supported providers: anthropic, openai, openai-codex, github-copilot.'
      return result
    }
    const slash = selection.indexOf('/')
    const provider = selection.slice(0, slash)
    const modelId = selection.slice(slash + 1)
    if (slash < 1 || !models.getModel(provider, modelId)) {
      result.status.error =
        'Unknown review model. Use provider/modelId from the Pi catalog. Supported providers: anthropic, openai, openai-codex, github-copilot.'
      return result
    }
    result.status.model = selection
    const available = await models.getAvailable(provider)
    if (!available.some((m) => m.id === modelId)) {
      result.status.error =
        'Authentication is unavailable for the selected review model. Configure Pi auth or an API key.'
      return result
    }
    result.model = { provider, modelId }
    result.status.available = true
  } catch {
    result.status.error = authError
  }
  return result
}
