/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface CliResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

function runCli(args: string[], cwd = import.meta.dirname): Promise<CliResult> {
  const child = spawn(process.execPath, [join(import.meta.dirname, 'cli.ts'), ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  let stdout = ''
  let stderr = ''
  let timedOut = false
  child.stdout.on('data', (chunk: string) => (stdout += chunk))
  child.stderr.on('data', (chunk: string) => (stderr += chunk))

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 10_000)

    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`CLI timed out\nstdout: ${stdout}\nstderr: ${stderr}`))
        return
      }
      resolve({ code, signal, stdout, stderr })
    })
  })
}

describe('skepsis CLI', () => {
  it('documents private reviews and current options, without removed worker commands', async () => {
    const result = await runCli(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('skepsis [options] [files...]')
    expect(result.stdout).toContain('GitHub PR URL')
    expect(result.stdout).toContain('private, durable agent conversations')
    for (const option of [
      '--no-agent',
      '--model',
      '--classifier-config',
      '--no-open',
      '--port',
    ]) {
      expect(result.stdout).toContain(option)
    }
    expect(result.stdout).not.toMatch(
      /\bpoll\b|\banswer\b|\bfail\b|--server|--token|--lease/,
    )
    expect(result.stderr).toBe('')
  })

  it.each(['-1', '65536', '1.5', '1e3', 'abc', ''])(
    'rejects invalid port %j before starting a server',
    async (port) => {
      const result = await runCli(['--port', port, '--no-agent'])
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('Port must be an integer from 0 to 65535')
    },
  )

  it.each(['poll', 'answer', 'fail'])(
    'rejects removed %s invocations before repository access or server startup',
    async (command) => {
      const cwd = await mkdtemp(join(tmpdir(), 'skepsis-removed-command-'))
      try {
        const results = await Promise.all([
          runCli([command], cwd),
          runCli([command, '--help'], cwd),
          runCli([command, '--server', 'http://127.0.0.1:1', '--token', 'unused'], cwd),
        ])
        for (const result of results) {
          expect(result).toMatchObject({ code: 1, signal: null, stdout: '' })
          expect(result.stderr).toContain(`The "${command}" command has been removed`)
          expect(result.stderr).toContain('Use private chats in the review UI')
          expect(result.stderr).toContain(`pass "./${command}"`)
          expect(result.stderr).not.toContain('Not in a jj or git repository')
        }
        expect(await readdir(cwd)).toEqual([])
      } finally {
        await rm(cwd, { recursive: true, force: true })
      }
    },
  )

  it.each(['poll', 'answer', 'fail'])(
    'accepts ./%s as a literal path rather than a removed command',
    async (name) => {
      // Reach the serve action's host guard without starting a server or model.
      const result = await runCli([`./${name}`, '--no-agent', '--host', '0.0.0.0'])
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('Private review sessions must bind to localhost')
      expect(result.stderr).not.toContain('command has been removed')
    },
  )
})
