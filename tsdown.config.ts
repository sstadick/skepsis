/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { readdirSync } from 'node:fs'
import { defineConfig } from 'tsdown'

// Pi's OAuth loader computes relative module paths at runtime, so those modules
// need stable filenames rather than only tree-shaken, hashed chunks.
const oauthDirectory = 'node_modules/@earendil-works/pi-ai/dist/auth/oauth'
const oauthEntries = Object.fromEntries(
  readdirSync(oauthDirectory)
    .filter((name) => name.endsWith('.js'))
    .map((name) => [name.slice(0, -3), `${oauthDirectory}/${name}`]),
)

export default defineConfig({
  entry: {
    ...oauthEntries,
    cli: 'cli.ts',
    worker: 'node_modules/@earendil-works/pi-codemode/dist/runtime/worker.js',
  },
  copy: [
    {
      from: 'node_modules/quickjs-wasi/package.json',
      to: 'dist/node_modules/quickjs-wasi',
    },
    {
      from: 'node_modules/quickjs-wasi/quickjs.wasm',
      to: 'dist/node_modules/quickjs-wasi',
    },
  ],
  outDir: 'dist',
  clean: false,
  dts: false,
  outExtensions: () => ({ js: '.js' }),
})
