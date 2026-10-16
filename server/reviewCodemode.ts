/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CodemodeSandbox,
  loadQuickJSWasm,
  type CodemodeExecuteOptions,
  type CodemodeRunOptions,
} from '@earendil-works/pi-codemode'

const MAX_TIMEOUT_MS = 60_000
// Shared across stores: a cancelled result does not mean its worker has exited.
let activeWorkers = 0
const boundedTimeout = (timeout?: number) =>
  timeout === undefined || !Number.isFinite(timeout)
    ? MAX_TIMEOUT_MS
    : Math.max(1, Math.min(MAX_TIMEOUT_MS, timeout))

export class ReviewCodemodeSandbox extends CodemodeSandbox {
  private readonly exits: Set<Promise<void>>

  constructor() {
    const exits = new Set<Promise<void>>()
    const bundledWorker = new URL('codemodeWorker.js', import.meta.url)
    const bundled = existsSync(bundledWorker)
    super({
      memoryLimitBytes: 64 * 1024 * 1024,
      timeoutMs: MAX_TIMEOUT_MS,
      ...(bundled
        ? {
            workerUrl: bundledWorker,
            wasm: loadQuickJSWasm(fileURLToPath(new URL('quickjs.wasm', import.meta.url))),
          }
        : {}),
      acquireWorker() {
        if (activeWorkers >= 2) throw new Error('Review script worker limit reached')
        activeWorkers++
        return () => {
          activeWorkers--
        }
      },
      onWorkerStarted(exited) {
        exits.add(exited)
        void exited.then(() => exits.delete(exited))
      },
    })
    this.exits = exits
  }

  override start(code: string, options: CodemodeRunOptions) {
    return super.start(code, { ...options, timeoutMs: boundedTimeout(options.timeoutMs) })
  }

  override execute(code: string, options: CodemodeExecuteOptions = {}) {
    return super.execute(code, { ...options, timeoutMs: boundedTimeout(options.timeoutMs) })
  }

  override async close() {
    // The native sandbox unrefs terminating workers. Keep Node alive until exit
    // has actually released their admission slots (including top-level await).
    const keepAlive = setInterval(() => {}, 1000)
    try {
      await super.close()
      await Promise.all(this.exits)
    } finally {
      clearInterval(keepAlive)
    }
  }
}
