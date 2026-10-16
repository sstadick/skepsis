/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'
import lockfile from 'proper-lockfile'
import {
  draftSchema,
  submitReviewSchema,
  type PullRequest,
  type ReviewDraft,
  type SubmitReview,
} from '../shared/review.ts'

export interface PullRequestReference {
  owner: string
  repository: string
  number: number
}
type Metadata = Omit<PullRequest, 'diffBaseSha'>
type PublishedReview = { id: number; url: string }

/** Publication was rejected before POST or by an explicit non-mutating HTTP
 * rejection. Network errors and server errors remain ambiguous.
 */
export class PublicationRejected extends Error {}

export function publicationRejection(response: string): PublicationRejected | undefined {
  const status = Number(response.match(/^HTTP\/[\d.]+\s+(\d{3})\b/m)?.[1])
  if ([401, 403, 404, 405, 409, 410, 415, 422].includes(status)) {
    return new PublicationRejected(
      `GitHub rejected the review (HTTP ${status}). Check permissions and review validity before trying again.`,
    )
  }
  return undefined
}

export function parsePullRequestUrl(input: string): PullRequestReference | null {
  // Match the original string as well as the URL: URL normalization must not
  // turn credentials, dot segments, escaped names, or a different port into a PR.
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)(?:\/files)?\/?$/.exec(
      input,
    )
  if (!match || match[0] !== input || match[2] === '.' || match[2] === '..') return null
  const number = Number(match[3])
  if (!Number.isSafeInteger(number)) return null
  return { owner: match[1]!, repository: match[2]!, number }
}

export interface GitHubCommand {
  command: 'gh' | 'git'
  args: string[]
  cwd?: string
  input?: string
}
export type GitHubRunner = (command: GitHubCommand) => Promise<string>

const run: GitHubRunner = ({ command, args, cwd, input }) =>
  new Promise((resolve, reject) => {
    const env = { ...process.env }
    // Do not inherit a launcher's git worktree, config injection, or alternate
    // object store. Global filters/templates could execute repository code.
    for (const key of Object.keys(env)) {
      if (key.startsWith('GIT_')) delete env[key]
    }
    Object.assign(env, {
      GH_HOST: 'github.com',
      GH_PROMPT_DISABLED: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    })
    const child = execFile(
      command,
      args,
      { cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          const rejection =
            command === 'gh' && input !== undefined
              ? publicationRejection(stdout)
              : undefined
          if (rejection) {
            reject(rejection)
            return
          }
          // Avoid exposing auth tokens, private payloads, or command input in errors.
          reject(
            new Error(
              `${command} operation failed. Check network access and gh authentication for github.com.`,
              { cause: error },
            ),
          )
        } else resolve(stdout)
      },
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })

function referencePath(pr: PullRequestReference): string {
  const url = `https://github.com/${pr.owner}/${pr.repository}/pull/${pr.number}`
  if (!parsePullRequestUrl(url)) throw new Error('Invalid GitHub pull request reference.')
  return `repos/${pr.owner}/${pr.repository}/pulls/${pr.number}`
}

function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error('GitHub returned an invalid commit SHA.')
  }
  return value
}

function published(value: { id: number; html_url: string }): PublishedReview {
  if (
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    typeof value.html_url !== 'string' ||
    !value.html_url.startsWith('https://github.com/')
  ) {
    throw new Error(
      'GitHub returned an invalid review response. Check GitHub before submitting again.',
    )
  }
  return { id: value.id, url: value.html_url }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

interface PullFile {
  filename: string
  patch?: string
}

// A context line belongs to both sides; additions only to RIGHT and deletions
// only to LEFT. Only explicitly present patch lines are accepted (not ranges
// inferred from hunk headers, which could include truncated content).
function patchAnchors(patch: string): Set<string> {
  const anchors = new Set<string>()
  let left = 0
  let right = 0
  let leftRemaining = 0
  let rightRemaining = 0
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      left = Number(hunk[1])
      right = Number(hunk[3])
      leftRemaining = Number(hunk[2] ?? 1)
      rightRemaining = Number(hunk[4] ?? 1)
    } else if (line.startsWith(' ') && leftRemaining > 0 && rightRemaining > 0) {
      anchors.add(`LEFT:${left++}`)
      anchors.add(`RIGHT:${right++}`)
      leftRemaining--
      rightRemaining--
    } else if (line.startsWith('-') && leftRemaining > 0) {
      anchors.add(`LEFT:${left++}`)
      leftRemaining--
    } else if (line.startsWith('+') && rightRemaining > 0) {
      anchors.add(`RIGHT:${right++}`)
      rightRemaining--
    }
  }
  return anchors
}

/** Injectable transport for tests; the production exports below use execFile. */
export function createGitHubClient(runner: GitHubRunner = run) {
  async function api<T>(endpoint: string, payload?: unknown): Promise<T> {
    const args = [
      'api',
      '--hostname',
      'github.com',
      '--method',
      payload === undefined ? 'GET' : 'POST',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
      endpoint,
    ]
    if (payload !== undefined) args.push('--include', '--input', '-')
    const output = await runner({
      command: 'gh',
      args,
      ...(payload === undefined ? {} : { input: JSON.stringify(payload) }),
    })
    try {
      const normalized = output.replaceAll('\r\n', '\n')
      const body = normalized.startsWith('HTTP/')
        ? normalized.slice(normalized.indexOf('\n\n') + 2)
        : normalized
      return JSON.parse(body) as T
    } catch {
      throw new Error('GitHub returned an invalid JSON response.')
    }
  }

  async function pages<T>(endpoint: string, maxPages: number): Promise<T[]> {
    const result: T[] = []
    for (let page = 1; page <= maxPages; page++) {
      // Pages are sequential so we stop at the first partial page.
      // eslint-disable-next-line no-await-in-loop
      const batch = await api<T[]>(`${endpoint}?per_page=100&page=${page}`)
      if (!Array.isArray(batch))
        throw new Error('GitHub returned an invalid paginated response.')
      result.push(...batch)
      if (batch.length < 100) return result
    }
    throw new Error(
      'This pull request exceeds the supported GitHub pagination limit; refusing an incomplete review.',
    )
  }

  async function getPullRequest(reference: PullRequestReference): Promise<Metadata> {
    const data = await api<{ title: string; base: { sha: string }; head: { sha: string } }>(
      referencePath(reference),
    )
    if (typeof data.title !== 'string')
      throw new Error('GitHub returned invalid pull request metadata.')
    return {
      owner: reference.owner,
      repository: reference.repository,
      number: reference.number,
      url: `https://github.com/${reference.owner}/${reference.repository}/pull/${reference.number}`,
      title: data.title,
      baseSha: sha(data.base?.sha),
      headSha: sha(data.head?.sha),
    }
  }

  async function preparePullRequest(
    url: string,
    stateDir: string,
  ): Promise<{ pullRequest: PullRequest; cwd: string }> {
    const reference = parsePullRequestUrl(url)
    if (!reference) throw new Error('Expected an HTTPS github.com pull request URL.')
    const root = resolvePath(
      stateDir,
      'github',
      reference.owner.toLowerCase(),
      reference.repository.toLowerCase(),
      String(reference.number),
    )
    await mkdir(root, { recursive: true, mode: 0o700 })
    const release = await lockfile.lock(root, {
      retries: { retries: 30, minTimeout: 100, maxTimeout: 1000 },
    })
    try {
      const metadata = await getPullRequest(reference)
      const repository = join(root, 'repository.git')
      const ownerFile = join(root, 'owner.json')
      const ownership = JSON.stringify({ version: 1, url: metadata.url.toLowerCase() })
      const git = async (args: string[], cwd = root) =>
        (
          await runner({
            command: 'git',
            args: [
              '-c',
              'core.hooksPath=/dev/null',
              '-c',
              'core.attributesFile=/dev/null',
              '-c',
              'credential.helper=',
              '-c',
              'credential.https://github.com.helper=!gh auth git-credential',
              ...args,
            ],
            cwd,
          })
        ).trim()
      if (await exists(ownerFile)) {
        if ((await readFile(ownerFile, 'utf8')) !== ownership)
          throw new Error(
            'The PR checkout belongs to another review; refusing to modify it.',
          )
      } else {
        if (await exists(repository))
          throw new Error('Unmanaged PR repository exists; refusing to modify it.')
        await writeFile(ownerFile, ownership, { flag: 'wx', mode: 0o600 })
      }
      if (!(await exists(repository)))
        await git(['init', '--bare', '--template=', repository])
      const remote = `https://github.com/${reference.owner}/${reference.repository}.git`
      // Fetch the base repository's PR ref, NOT a fork branch name. FETCH_HEAD
      // is only used while holding the lock; all later operations use SHAs.
      await git(
        [
          'fetch',
          '--no-tags',
          '--no-recurse-submodules',
          remote,
          `refs/pull/${reference.number}/head`,
        ],
        repository,
      )
      const fetchedHead = await git(['rev-parse', 'FETCH_HEAD'], repository)
      if (fetchedHead !== metadata.headSha)
        throw new Error('Pull request head changed while loading. Reload the pull request.')
      await git(
        ['fetch', '--no-tags', '--no-recurse-submodules', remote, metadata.baseSha],
        repository,
      )
      const diffBaseSha = sha(
        await git(['merge-base', metadata.baseSha, metadata.headSha], repository),
      )
      const cwd = join(root, `${metadata.headSha}-${metadata.baseSha}-${diffBaseSha}`)
      if (!(await exists(cwd))) {
        await git(['worktree', 'add', '--detach', cwd, metadata.headSha], repository)
      } else if ((await git(['rev-parse', 'HEAD'], cwd)) !== metadata.headSha) {
        throw new Error(
          'Cached PR checkout has changed revision; refusing to reset an active review.',
        )
      }
      return { pullRequest: { ...metadata, diffBaseSha }, cwd }
    } finally {
      await release()
    }
  }

  async function assertCurrent(pr: PullRequest) {
    const current = await getPullRequest(pr)
    if (current.headSha !== pr.headSha || current.baseSha !== pr.baseSha) {
      throw new Error(
        'Pull request head or base changed. Reload and review the new revision before publishing.',
      )
    }
  }

  async function validateReview(
    pr: PullRequest,
    input: SubmitReview,
    drafts: ReviewDraft[],
  ) {
    const submission = submitReviewSchema.parse(input)
    if (new Set(submission.draftIds).size !== submission.draftIds.length)
      throw new Error('Duplicate review draft selection.')
    const selected = submission.draftIds.map((id) => {
      const matches = drafts.filter((draft) => draft.id === id)
      if (matches.length !== 1 || matches[0]!.publishedReviewId !== undefined)
        throw new Error('Selected review draft is missing or already published.')
      return draftSchema.parse(matches[0])
    })
    if (submission.event === 'REQUEST_CHANGES' && !submission.body.trim())
      throw new Error('Request changes requires a nonempty summary.')
    if (submission.event === 'COMMENT' && !submission.body.trim() && !selected.length)
      throw new Error('Comment review requires a summary or inline comments.')
    sha(pr.headSha)
    await assertCurrent(pr)
    if (selected.length) {
      const files = await pages<PullFile>(`${referencePath(pr)}/files`, 30)
      const anchors = new Map(
        files.map((file) => [file.filename, patchAnchors(file.patch ?? '')]),
      )
      for (const { anchor } of selected) {
        if (!anchors.get(anchor.path)?.has(`${anchor.side}:${anchor.line}`)) {
          throw new Error(
            'A selected comment is not on an available GitHub diff line. Reload and check its anchor.',
          )
        }
      }
      // File pagination is not a snapshot; check again before the single POST.
      await assertCurrent(pr)
    }
    return { submission, selected, endpoint: `${referencePath(pr)}/reviews` }
  }

  /** Read-only validation before creating a durable publication intent. */
  async function preflightReview(
    pr: PullRequest,
    input: SubmitReview,
    drafts: ReviewDraft[],
  ): Promise<void> {
    await validateReview(pr, input, drafts)
  }

  async function publishReview(
    pr: PullRequest,
    input: SubmitReview,
    drafts: ReviewDraft[],
  ): Promise<PublishedReview> {
    let validated: Awaited<ReturnType<typeof validateReview>>
    try {
      validated = await validateReview(pr, input, drafts)
    } catch (error) {
      throw new PublicationRejected(
        error instanceof Error ? error.message : 'Review validation failed.',
        { cause: error },
      )
    }
    const { submission, selected, endpoint } = validated
    const response = await api<{ id: number; html_url: string }>(endpoint, {
      event: submission.event,
      commit_id: pr.headSha,
      body: `${submission.body}${submission.body ? '\n\n' : ''}<!-- skepsis-review:${submission.id} -->`,
      // Explicit allowlist: private thread/chat data is never serialized.
      comments: selected.map(({ body, anchor }) => ({
        body,
        path: anchor.path,
        side: anchor.side,
        line: anchor.line,
      })),
    })
    // No retry: a lost response may mean the review was already published.
    return published(response)
  }

  async function findPublishedReview(
    pr: PullRequest,
    id: string,
  ): Promise<PublishedReview | null> {
    const markerId = submitReviewSchema.shape.id.parse(id)
    const reviews = await pages<{
      id: number
      html_url: string
      body: string | null
      commit_id: string
    }>(`${referencePath(pr)}/reviews`, 100)
    // A review session survives new PR revisions. Its unique publication marker
    // must still find a receipt posted against a previous head after a restart.
    const match = reviews.find((review) =>
      review.body?.includes(`<!-- skepsis-review:${markerId} -->`),
    )
    return match ? published(match) : null
  }

  return {
    getPullRequest,
    preparePullRequest,
    preflightReview,
    publishReview,
    findPublishedReview,
  }
}

export const {
  getPullRequest,
  preparePullRequest,
  preflightReview,
  publishReview,
  findPublishedReview,
} = createGitHubClient()
