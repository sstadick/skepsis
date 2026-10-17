/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const projectRoot = import.meta.dirname
const builtCli = join(projectRoot, 'dist', 'cli.js')

describe('published package smoke', () => {
  it(
    'packs an installable bin-only package with embedded runtime assets',
    { timeout: 180_000 },
    async () => {
      if (!existsSync(builtCli)) {
        return
      }

      const tempRoot = await mkdtemp(join(tmpdir(), 'skepsis-package-smoke-'))
      const installDir = join(tempRoot, 'install')
      const npmCache = join(tempRoot, 'npm-cache')
      let tarballPath: string | undefined

      try {
        const { stdout: packJson } = await exec(
          'npm',
          ['pack', '--json', '--ignore-scripts', '--pack-destination', tempRoot],
          {
            cwd: projectRoot,
            env: { ...process.env, npm_config_cache: npmCache },
          },
        )
        const packed = JSON.parse(packJson) as Array<{ filename: string }>
        tarballPath = join(tempRoot, packed[0]!.filename)

        const { stdout: tarListing } = await exec('tar', ['-tf', tarballPath])
        expect(tarListing).toContain('package/dist/cli.js')
        expect(tarListing).toContain('package/dist/worker.js')
        expect(tarListing).toContain('package/dist/node_modules/quickjs-wasi/package.json')
        expect(tarListing).toContain('package/dist/node_modules/quickjs-wasi/quickjs.wasm')

        await mkdir(installDir, { recursive: true })
        await exec('npm', ['init', '-y'], {
          cwd: installDir,
          env: { ...process.env, npm_config_cache: npmCache },
        })

        await exec('npm', ['install', '--omit=dev', tarballPath], {
          cwd: installDir,
          env: { ...process.env, npm_config_cache: npmCache },
        })

        const { stdout: helpStdout } = await exec(
          process.execPath,
          ['node_modules/@oxide/skepsis/dist/cli.js', '--help'],
          { cwd: installDir },
        )
        expect(helpStdout).toContain('Local diff review UI')

        const checkScript = [
          "import { createRequire } from 'node:module'",
          "import { access, readdir } from 'node:fs/promises'",
          "import { constants } from 'node:fs'",
          "const cliUrl = new URL('./node_modules/@oxide/skepsis/dist/cli.js', import.meta.url)",
          'const require = createRequire(cliUrl)',
          "const quickjsPath = require.resolve('quickjs-wasi/quickjs.wasm')",
          'await access(quickjsPath, constants.R_OK)',
          "await import(new URL('./node_modules/@oxide/skepsis/dist/worker.js', import.meta.url))",
          "const distUrl = new URL('./node_modules/@oxide/skepsis/dist/', import.meta.url)",
          'const chunk = (await readdir(distUrl)).find(name => /^modelRuntime-.*\\.js$/.test(name))',
          "if (!chunk) throw new Error('Missing bundled model runtime')",
          'const { createReviewModels } = await import(new URL(chunk, distUrl))',
          'const { models } = await createReviewModels()',
          "if (!models.getModelOfType('classifier', 'h2o-local', 'h2o-lightning-4b')) throw new Error('Missing classifier')",
          "for (const name of ['anthropic', 'github-copilot', 'openai-codex', 'openai-chatgpt', 'kimi-coding', 'meta', 'openrouter', 'radius', 'xai']) await import(new URL(name + '.js', distUrl))",
          'console.log(quickjsPath)',
        ].join('\n')
        const { stdout: checkStdout } = await exec(
          process.execPath,
          ['--input-type=module', '-e', checkScript],
          {
            cwd: installDir,
            env: { ...process.env, PI_CODING_AGENT_DIR: join(tempRoot, 'pi-config') },
          },
        )
        expect(checkStdout).toContain('quickjs.wasm')
      } finally {
        await rm(tempRoot, { recursive: true, force: true })
        if (tarballPath) {
          await rm(tarballPath, { force: true })
        }
      }
    },
  )
})
