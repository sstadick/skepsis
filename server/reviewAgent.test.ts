/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import lockfile from 'proper-lockfile'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPiCredentialStore, setupReviewAgentWithEnvironment } from './reviewAgent.ts'

let directory: string
let path: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'skepsis-auth-test-'))
  path = join(directory, 'auth.json')
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const oauth = {
  type: 'oauth' as const,
  access: 'fixture-access',
  refresh: 'fixture-refresh',
  expires: 1,
}
const setup = (option?: string | false, env: NodeJS.ProcessEnv = {}) =>
  setupReviewAgentWithEnvironment(
    option,
    { PI_CODING_AGENT_DIR: directory, ...env },
    directory,
  )

describe('review agent selection', () => {
  it('uses API env without auth.json and ignores inherited PI_MODEL', async () => {
    const result = await setup(undefined, {
      OPENAI_API_KEY: 'fixture-key',
      PI_MODEL: 'anthropic/invalid',
    })
    expect(result.model).toEqual({ provider: 'openai', modelId: 'gpt-5-mini' })
    expect(result.status.available).toBe(true)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('prioritizes explicit, Skepsis env, then Pi settings without running extensions', async () => {
    await writeFile(
      join(directory, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'anthropic',
        defaultModel: 'claude-sonnet-4-5',
        extensions: ['!do-not-execute'],
      }),
    )
    const env = { OPENAI_API_KEY: 'fixture-key', ANTHROPIC_API_KEY: 'fixture-key' }
    expect((await setup(undefined, env)).model?.provider).toBe('anthropic')
    expect(
      (await setup(undefined, { ...env, SKEPSIS_MODEL: 'openai/gpt-5-mini' })).model
        ?.provider,
    ).toBe('openai')
    expect(
      (
        await setup('anthropic/claude-sonnet-4-5', {
          ...env,
          SKEPSIS_MODEL: 'openai/gpt-5-mini',
        })
      ).model?.provider,
    ).toBe('anthropic')
  })

  it('disables admissions even with credentials and invalid settings', async () => {
    await writeFile(join(directory, 'settings.json'), 'invalid')
    const result = await setup(false, { OPENAI_API_KEY: 'fixture-key' })
    expect(result.status).toEqual({ model: null, available: false })
    expect(result.model).toBeUndefined()
    expect(result.models.getProviders()).toEqual([])
  })

  it('reports unsupported models and missing auth without throwing', async () => {
    expect((await setup('google/gemini')).status.error).toContain('Supported providers')
    const result = await setup('openai/gpt-5-mini')
    expect(result.status.available).toBe(false)
    expect(result.model).toBeUndefined()
    expect(result.status.error).toContain('Authentication')
  })

  it('checks expired OAuth availability without refreshing or making model calls', async () => {
    await writeFile(path, JSON.stringify({ anthropic: oauth }))
    expect((await setup('anthropic/claude-sonnet-4-5')).status.available).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8')).anthropic).toEqual(oauth)
  })

  it('rejects commands and malformed credentials without exposing their contents', async () => {
    const marker = join(directory, 'executed')
    await writeFile(
      path,
      JSON.stringify({ openai: { type: 'api_key', key: `!touch ${marker}` } }),
    )
    const result = await setup('openai/gpt-5-mini')
    expect(result.status.error).toContain('Shell')
    expect(result.status.error).not.toContain(marker)
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(path, '{"private-secret": invalid')
    expect((await setup('openai/gpt-5-mini')).status.error).not.toContain('private-secret')
    await writeFile(
      path,
      JSON.stringify({ openai: { ...oauth, expires: 'private-secret' } }),
    )
    expect((await setup('openai/gpt-5-mini')).status.available).toBe(false)
  })
})

async function userConfig(model = 'user-default', configHome = join(directory, '.config')) {
  const folder = join(configHome, 'skepsis')
  await mkdir(folder, { recursive: true })
  const file = join(folder, 'classifier.json')
  await writeFile(
    file,
    JSON.stringify({
      model,
      endpoint: `https://example.test/${model}/systemone`,
      maxConcurrency: 8,
    }),
  )
  return file
}

describe('configured decision models', () => {
  it('loads the persistent user default without network calls or importing Pi extensions', async () => {
    await userConfig()
    await writeFile(
      join(directory, 'settings.json'),
      JSON.stringify({ extensions: ['!do-not-execute'] }),
    )
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('No inference during setup'))
    try {
      const result = await setup(undefined, { OPENAI_API_KEY: 'fixture-key' })
      expect(result.status.classifier).toEqual({
        provider: 'review-classifier',
        model: 'user-default',
        endpoint: 'https://example.test/user-default/systemone',
      })
      expect(result.classifierConcurrency).toBe(8)
      expect(await result.models.getAvailableOfType('classifier')).toHaveLength(1)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      fetch.mockRestore()
    }
  })

  it('honors absolute XDG_CONFIG_HOME and ignores relative XDG paths', async () => {
    await userConfig()
    const xdg = join(directory, 'xdg')
    await userConfig('xdg-default', xdg)
    expect(
      (await setup(undefined, { XDG_CONFIG_HOME: xdg })).status.classifier?.model,
    ).toBe('xdg-default')
    expect(
      (await setup(undefined, { XDG_CONFIG_HOME: 'relative-project-config' })).status
        .classifier?.model,
    ).toBe('user-default')
  })

  it('prioritizes explicit paths then environment over the user default, never falls back on errors', async () => {
    const global = await userConfig()
    const override = await userConfig('override', join(directory, 'override'))
    expect(
      (await setup(undefined, { SKEPSIS_CLASSIFIER_CONFIG: override })).status.classifier
        ?.model,
    ).toBe('override')
    await expect(
      setup(undefined, { SKEPSIS_CLASSIFIER_CONFIG: join(directory, 'missing.json') }),
    ).rejects.toThrow('classifier configuration')
    await writeFile(global, 'invalid')
    expect(
      (
        await setupReviewAgentWithEnvironment(
          undefined,
          { SKEPSIS_CLASSIFIER_CONFIG: 'missing' },
          directory,
          override,
        )
      ).status.classifier?.model,
    ).toBe('override')
    await expect(setup()).rejects.toThrow('classifier configuration')
    expect((await setup(false)).models.getProviders()).toEqual([])
  })

  it('fails closed for an installed but dangling default config, and no-agent skips it', async () => {
    const config = await userConfig()
    await rm(config)
    await symlink(join(directory, 'missing.json'), config)
    await expect(setup()).rejects.toThrow('classifier configuration')
    expect((await setup(false)).status).toEqual({ model: null, available: false })
  })
  it('is opt-in: chat credentials alone expose no classifiers', async () => {
    const result = await setup(undefined, { OPENAI_API_KEY: 'fixture-key' })
    expect(result.status.codemode).toBe(true)
    expect(result.models.getModelsOfType('classifier')).toEqual([])
    expect(result.models.getModelsOfType('image')).toEqual([])
    expect(result.toolPolicyKey).toContain('no-classifier')
  })

  it('registers only the configured endpoint without inheriting same-named Pi credentials', async () => {
    const configPath = join(directory, 'classifier.json')
    await writeFile(
      configPath,
      JSON.stringify({
        provider: 'my-decider',
        model: 'any-system-one-model',
        endpoint: 'http://127.0.0.1:7777/custom/classify',
        apiKeyEnv: 'DECIDER_KEY',
      }),
    )
    await writeFile(
      path,
      JSON.stringify({ 'my-decider': { type: 'oauth', invalid: true } }),
    )
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('No network allowed during setup'))
    try {
      const result = await setup(undefined, {
        OPENAI_API_KEY: 'fixture-chat-key',
        DECIDER_KEY: 'private-fixture-key',
        SKEPSIS_CLASSIFIER_CONFIG: configPath,
      })
      expect(result.status.available).toBe(true)
      expect(result.status.classifier).toEqual({
        provider: 'my-decider',
        model: 'any-system-one-model',
        endpoint: 'http://127.0.0.1:7777/custom/classify',
      })
      expect(await result.models.getAvailableOfType('classifier')).toHaveLength(1)
      expect(JSON.stringify(result.models.getAllModels())).not.toContain(
        'private-fixture-key',
      )
      expect(JSON.stringify(result.status)).not.toContain('private-fixture-key')
      expect(result.classifierInstructions).toContain('my-decider')
      expect(result.classifierInstructions).toContain('stopReason')
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      fetch.mockRestore()
    }
  })

  it('explicit config overrides the environment, invalid config fails closed, and no-agent skips it', async () => {
    const configPath = join(directory, 'valid.json')
    await writeFile(
      configPath,
      JSON.stringify({ model: 'decision', endpoint: 'https://example.test/v1/systemone' }),
    )
    const env = {
      PI_CODING_AGENT_DIR: directory,
      OPENAI_API_KEY: 'fixture-key',
      SKEPSIS_CLASSIFIER_CONFIG: join(directory, 'missing.json'),
    }
    const configured = await setupReviewAgentWithEnvironment(
      undefined,
      env,
      directory,
      configPath,
    )
    expect(configured.models.getModelsOfType('classifier')).toHaveLength(1)
    await expect(
      setupReviewAgentWithEnvironment(undefined, env, directory),
    ).rejects.toThrow('classifier configuration')
    const disabled = await setupReviewAgentWithEnvironment(false, env, directory)
    expect(disabled.models.getProviders()).toEqual([])
    expect(disabled.toolPolicyKey).toBeUndefined()
  })
})

describe('Pi credential store', () => {
  it('resolves env keys but lists only metadata', async () => {
    await writeFile(path, JSON.stringify({ openai: { type: 'api_key', key: 'TEST_KEY' } }))
    const store = createPiCredentialStore(path, { TEST_KEY: 'fixture-secret' })
    expect(await store.read('openai')).toEqual({ type: 'api_key', key: 'fixture-secret' })
    expect(await store.list()).toEqual([{ providerId: 'openai', type: 'api_key' }])
    await store.modify('openai', async () => undefined)
    expect(await readFile(path, 'utf8')).toContain('TEST_KEY')
  })

  it('serializes concurrent refreshes across stores and preserves other providers', async () => {
    const other = { type: 'future-provider-format', value: 'preserve-me' }
    await writeFile(path, JSON.stringify({ anthropic: oauth, other }))
    const first = createPiCredentialStore(path, {})
    const second = createPiCredentialStore(path, {})
    let refreshes = 0
    const refresh = async (current: Awaited<ReturnType<typeof first.read>>) => {
      if (current?.type !== 'oauth' || current.expires > 1) return undefined
      refreshes++
      await delay(60)
      return { ...current, access: 'new-access', expires: 9999999999999 }
    }
    await Promise.all([
      first.modify('anthropic', refresh),
      second.modify('anthropic', refresh),
      second.modify('openai', async () => ({ type: 'api_key', key: 'fixture-key' })),
    ])
    expect(refreshes).toBe(1)
    const saved = JSON.parse(await readFile(path, 'utf8'))
    expect(saved.other).toEqual(other)
    expect(saved.openai.key).toBe('fixture-key')
    expect(saved.anthropic.access).toBe('new-access')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await first.delete('openai')
    expect(JSON.parse(await readFile(path, 'utf8')).other).toEqual(other)
  })

  it('honors Pi locks and cancellation while waiting', async () => {
    const release = await lockfile.lock(path, { realpath: false, stale: 30_000 })
    try {
      const store = createPiCredentialStore(path, {})
      const controller = new AbortController()
      const pending = store.modify(
        'openai',
        async () => ({ type: 'api_key', key: 'unused' }),
        { signal: controller.signal },
      )
      controller.abort()
      await expect(pending).rejects.toBeDefined()
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await release()
    }
  })

  it('refuses to write after the lock is compromised', async () => {
    await writeFile(path, JSON.stringify({ anthropic: oauth }))
    let compromise: (() => void) | undefined
    const original = lockfile.lock
    const spy = vi.spyOn(lockfile, 'lock').mockImplementation(async (file, options) => {
      compromise = () =>
        options?.onCompromised?.(Object.assign(new Error('lost'), { code: 'ECOMPROMISED' }))
      return original(file, options)
    })
    try {
      const store = createPiCredentialStore(path, {})
      await expect(
        store.modify('anthropic', async () => {
          compromise!()
          return { ...oauth, access: 'must-not-write' }
        }),
      ).rejects.toThrow('compromised')
      expect(await store.read('anthropic')).toEqual(oauth)
    } finally {
      spy.mockRestore()
    }
  })

  it('does not commit a refresh cancelled during the callback', async () => {
    await writeFile(path, JSON.stringify({ anthropic: oauth }))
    const controller = new AbortController()
    const store = createPiCredentialStore(path, {})
    await expect(
      store.modify(
        'anthropic',
        async () => {
          controller.abort()
          return { ...oauth, access: 'must-not-write' }
        },
        { signal: controller.signal },
      ),
    ).rejects.toBeDefined()
    expect(await store.read('anthropic')).toEqual(oauth)
  })
})
