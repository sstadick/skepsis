/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { readServerInfo } from '../server/discovery.ts'
import type { ErrorResponse } from '../shared/types.ts'

export interface ServerAccessOptions {
  cwd?: string
  server?: string
  token?: string
}

export async function resolveServerAccess(
  opts: ServerAccessOptions,
): Promise<{ url: string; token: string }> {
  const url = opts.server ?? process.env['SKEPSIS_SERVER_URL']
  const token = opts.token ?? process.env['SKEPSIS_SERVER_TOKEN']
  if (url && token) return { url, token }

  const cwd = opts.cwd ?? process.cwd()
  try {
    const discovered = await readServerInfo(cwd)
    return { url: url ?? discovered.url, token: token ?? discovered.token }
  } catch (error) {
    if (url && token) return { url, token }
    throw new Error(
      `No running Skepsis server discovered for ${cwd}. Start Skepsis there first, or pass --server/--token.`,
      { cause: error },
    )
  }
}

export async function apiFetch<T>(
  endpoint: string,
  init: { method: string; body?: unknown; access: { url: string; token: string } },
): Promise<T> {
  const res = await fetch(new URL(endpoint, init.access.url), {
    method: init.method,
    headers: {
      authorization: `Bearer ${init.access.token}`,
      'content-type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  if (!res.ok) {
    const error = (await res.json().catch(() => null)) as ErrorResponse | null
    throw new Error(error?.error ?? `Request failed (${res.status})`)
  }
  return res.json() as Promise<T>
}
