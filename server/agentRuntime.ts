/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import type { QuestionConversationMessage } from '../shared/types.ts'

/** Shutdown suspends durable requests; resolution/timeouts cancel them instead. */
export const AGENT_SHUTDOWN = new Error('Server closing')

/** Host-owned Pi runtime: no external worker processes or public claim protocol. */
export interface AgentQuestion {
  threadId: string
  requestId: string
  file: string
  line: number
  excerpt: string
  question: string
  messages: QuestionConversationMessage[]
}

export interface AgentRuntime {
  canResume(threadId: string, requestId: string): Promise<boolean>
  answer(input: AgentQuestion, signal: AbortSignal): Promise<string>
  score(hunk: { file: string; text: string }, signal: AbortSignal): Promise<number>
  close(): Promise<void>
}
