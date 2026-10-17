/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { describe, expect, it } from 'vitest'
import {
  createRefreshClearedError,
  resolveRefreshClearedError,
} from './useRefreshClearedError.ts'

describe('useRefreshClearedError helpers', () => {
  it('holds a local action error until a newer refresh timestamp arrives', () => {
    const error = createRefreshClearedError('Scoring request failed', 100)

    expect(resolveRefreshClearedError(error, 100)).toEqual(error)
    expect(resolveRefreshClearedError(error, 99)).toEqual(error)
    expect(resolveRefreshClearedError(error, 101)).toBeNull()
  })

  it('treats the next success independently from later local errors', () => {
    const first = createRefreshClearedError('First failure', 10)
    const second = createRefreshClearedError('Second failure', 20)

    expect(resolveRefreshClearedError(first, 20)).toBeNull()
    expect(resolveRefreshClearedError(second, 20)).toEqual(second)
    expect(resolveRefreshClearedError(second, 21)).toBeNull()
  })
})
