/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it.skipIf(!existsSync(resolve('dist/reviewCodemode.js')))(
  'executes the bundled worker and wasm outside node_modules and the source cwd',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'skepsis-packed-code-'))
    try {
      // npm run ci builds first. Do not rebuild shared dist during parallel tests.
      await cp(resolve('dist'), join(directory, 'dist'), { recursive: true })
      await writeFile(join(directory, 'package.json'), '{"type":"module"}')
      await writeFile(
        join(directory, 'run.mjs'),
        `
      import { ReviewCodemodeSandbox } from './dist/reviewCodemode.js';
      const sandbox = new ReviewCodemodeSandbox();
      try {
        const result = await sandbox.execute('text(typeof process); return 6 * 7');
        if (!result.ok || result.value !== 42) throw new Error(JSON.stringify(result));
        console.log(JSON.stringify(result.output));
      } finally { await sandbox.close(); }
    `,
      )
      const result = await promisify(execFile)(
        process.execPath,
        [join(directory, 'run.mjs')],
        { cwd: tmpdir(), timeout: 10000 },
      )
      expect(result.stdout).toContain('undefined')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  90000,
)
