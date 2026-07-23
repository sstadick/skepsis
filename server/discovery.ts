/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const BASE_DIR = join(process.env['HOME'] ?? '~', '.local', 'share', 'skepsis')

export interface ServerInfo {
  url: string
  token: string
}

function repoStatePath(cwd: string, suffix: string): string {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12)
  return join(BASE_DIR, `${hash}.${suffix}`)
}

function serverInfoPath(cwd: string): string {
  return repoStatePath(cwd, 'server.json')
}

export function createServerToken(): string {
  return randomBytes(24).toString('hex')
}

export async function writeServerInfo(cwd: string, info: ServerInfo): Promise<void> {
  await mkdir(BASE_DIR, { recursive: true })
  await writeFile(serverInfoPath(cwd), JSON.stringify(info, null, 2) + '\n')
}

export async function readServerInfo(cwd: string): Promise<ServerInfo> {
  const raw: unknown = JSON.parse(await readFile(serverInfoPath(cwd), 'utf-8'))
  const url = (raw as { url?: unknown }).url
  const token = (raw as { token?: unknown }).token
  if (typeof url !== 'string' || typeof token !== 'string') {
    throw new Error('Invalid Skepsis server discovery file')
  }
  return { url, token }
}

export async function clearServerInfo(cwd: string, info: ServerInfo): Promise<void> {
  try {
    const current = await readServerInfo(cwd)
    if (current.url !== info.url || current.token !== info.token) return
  } catch {
    return
  }
  await rm(serverInfoPath(cwd), { force: true })
}
