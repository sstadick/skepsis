/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { exec } from './server/testUtil.ts'
import type { ReviewSnapshot } from './shared/review.ts'

async function launch(
  entry: string,
  cwd: string,
  state: string,
  classifierConfig?: string,
  port = 0,
) {
  const child = spawn(
    process.execPath,
    [
      entry,
      '-f',
      'HEAD',
      ...(classifierConfig
        ? [
            '--model',
            'openai/gpt-5-mini',
            ...(classifierConfig === 'default'
              ? []
              : ['--classifier-config', classifierConfig]),
          ]
        : ['--no-agent']),
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd,
      env: {
        ...process.env,
        SKEPSIS_STATE_DIR: state,
        XDG_CONFIG_HOME: join(state, 'config'),
        SKEPSIS_CLASSIFIER_CONFIG: undefined,
        // No real credentials or inference: this smoke test only loads config,
        // inspects capabilities, and saves drafts in its isolated state directory.
        PI_CODING_AGENT_DIR: join(state, 'fixture-auth'),
        OPENAI_API_KEY: 'fixture-chat-key',
        CLASSIFIER_TEST_KEY: 'fixture-private-classifier-key',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const ended = new Promise<number | null>((resolve) => child.once('exit', resolve))
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Startup timed out: ${output}\n${stderr}`))
    }, 15000)
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
      const address = output.match(/skepsis on (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
      if (address) {
        clearTimeout(timer)
        resolve(address)
      }
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', () => {
      clearTimeout(timer)
      reject(new Error(`Exited during startup: ${stderr}`))
    })
  })
  return {
    url,
    close: async () => {
      child.kill('SIGTERM')
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
      try {
        expect(await ended, stderr).toBe(0)
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

it.each(['source', 'packed', 'packed-classifier', 'packed-default-classifier'] as const)(
  'launches a %s local review, persists drafts and leaves source untouched',
  async (mode) => {
    if (mode !== 'source' && !existsSync(join(import.meta.dirname, 'dist/cli.js'))) return
    const directory = await mkdtemp(join(tmpdir(), 'skepsis-cli-review-'))
    const state = join(directory, 'state')
    let server: Awaited<ReturnType<typeof launch>> | undefined
    try {
      await exec('git', ['init', '-q'], { cwd: directory })
      await writeFile(join(directory, 'code.ts'), 'const before = 1\n')
      await exec('git', ['add', 'code.ts'], { cwd: directory })
      await exec(
        'git',
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          'commit',
          '-qm',
          'base',
        ],
        { cwd: directory },
      )
      const contents = 'const before = 2\n'
      await writeFile(join(directory, 'code.ts'), contents)
      let entry = join(import.meta.dirname, 'cli.ts')
      if (mode !== 'source') {
        // No node_modules here: every lazy runtime chunk must ship in dist.
        await cp(join(import.meta.dirname, 'dist'), join(directory, 'package/dist'), {
          recursive: true,
        })
        await writeFile(join(directory, 'package/package.json'), '{"type":"module"}')
        entry = join(directory, 'package/dist/cli.js')
      }
      let classifierConfig: string | undefined
      if (mode === 'packed-classifier' || mode === 'packed-default-classifier') {
        const configDirectory =
          mode === 'packed-default-classifier'
            ? join(state, 'config', 'skepsis')
            : directory
        await mkdir(configDirectory, { recursive: true })
        classifierConfig = join(configDirectory, 'classifier.json')
        await writeFile(
          classifierConfig,
          JSON.stringify({
            provider: 'test-decider',
            model: 'arbitrary-model',
            endpoint: 'http://127.0.0.1:1/custom/systemone',
            apiKeyEnv: 'CLASSIFIER_TEST_KEY',
          }),
        )
      }
      const classifierOption =
        mode === 'packed-default-classifier' ? 'default' : classifierConfig
      server = await launch(entry, directory, state, classifierOption)
      const snapshot = (await fetch(`${server.url}/api/review`).then((r) =>
        r.json(),
      )) as ReviewSnapshot
      expect(snapshot.agent.available).toBe(Boolean(classifierConfig))
      if (classifierConfig) {
        expect(snapshot.agent.codemode).toBe(true)
        expect(snapshot.agent.classifier).toEqual({
          provider: 'test-decider',
          model: 'arbitrary-model',
          endpoint: 'http://127.0.0.1:1/custom/systemone',
        })
        expect(JSON.stringify(snapshot)).not.toContain('fixture-private-classifier-key')
      }
      const { token } = (await fetch(`${server.url}/api/session`).then((r) =>
        r.json(),
      )) as { token: string }
      const draft = {
        id: randomUUID(),
        anchor: { path: 'code.ts', side: 'LEFT', line: 1, revision: snapshot.revision },
        body: 'Public draft, not yet published',
      }
      const denied = await fetch(`${server.url}/api/drafts`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      })
      expect(denied.status).toBe(403)
      const saved = await fetch(`${server.url}/api/drafts`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-skepsis-token': token },
        body: JSON.stringify(draft),
      })
      expect(saved.status, await saved.text()).toBe(200)
      expect(await readFile(join(directory, 'code.ts'), 'utf8')).toBe(contents)
      expect((await fetch(`${server.url}/`)).status).toBe(200)
      const originalUrl = server.url
      await server.close()
      server = undefined
      server = await launch(
        entry,
        directory,
        state,
        classifierOption,
        Number(new URL(originalUrl).port),
      )
      expect(server.url).toBe(originalUrl)
      const reopened = (await fetch(`${server.url}/api/review`).then((r) =>
        r.json(),
      )) as ReviewSnapshot
      expect(reopened.drafts).toEqual([draft])
      expect(reopened.revision).toBe(snapshot.revision)
    } finally {
      await server?.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
  30000,
)
