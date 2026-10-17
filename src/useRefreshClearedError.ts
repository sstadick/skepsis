/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { useCallback, useEffect, useState } from 'react'

export interface RefreshClearedErrorState {
  message: string
  clearAfterDataUpdatedAt: number
}

export function createRefreshClearedError(
  message: string,
  dataUpdatedAt: number,
): RefreshClearedErrorState {
  return { message, clearAfterDataUpdatedAt: dataUpdatedAt }
}

export function resolveRefreshClearedError(
  errorState: RefreshClearedErrorState | null,
  dataUpdatedAt: number,
): RefreshClearedErrorState | null {
  return errorState && dataUpdatedAt > errorState.clearAfterDataUpdatedAt
    ? null
    : errorState
}

export function useRefreshClearedError(dataUpdatedAt: number) {
  const [errorState, setErrorState] = useState<RefreshClearedErrorState | null>(null)

  useEffect(() => {
    setErrorState((previous) => resolveRefreshClearedError(previous, dataUpdatedAt))
  }, [dataUpdatedAt])

  const clear = useCallback(() => setErrorState(null), [])
  const set = useCallback(
    (message: string) => {
      setErrorState(createRefreshClearedError(message, dataUpdatedAt))
    },
    [dataUpdatedAt],
  )

  return {
    error: errorState?.message ?? null,
    clear,
    set,
  }
}
