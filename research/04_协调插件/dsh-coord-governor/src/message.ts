/**
 * Local construction of plugin-sourced user messages.
 *
 * The host's `createUserMessage` is deliberately **not** imported, and the reason is not
 * stylistic. The harness mounts each experimental arm by filesystem path (so that no arm
 * mutates a shared profile), and a path-mounted plugin must not reach host packages at
 * runtime. When it does, `@deepseek-ai/*` becomes resolvable through a second location,
 * the process ends up with two instances of the DeepSeek request-extension registry, and
 * that registry asserts single ownership of each top-level request field. The result is
 * that every model call dies with:
 *
 *     REQUEST_EXTENSION: DeepSeek request extension preparation failed
 *
 * Measured on the experiment host, which is how this was found rather than reasoned about:
 *
 *   - a plugin whose only content is `import { createUserMessage } from '@deepseek-ai/dsh-llm'`,
 *     with no handlers at all, reproduces the failure;
 *   - the identical file passes when moved to a directory with no ancestor `node_modules`
 *     that can satisfy `@deepseek-ai/*`;
 *   - the no-op control passes in both positions, so the mount mechanism is not at fault.
 *
 * The host's helper is a four-field constructor — a fresh identity, the `user` role, the
 * supplied content and source, frozen before publication — so reproducing it costs little
 * and removes the failure mode entirely. Types still come from the host: `import type` is
 * erased by Node's type stripping and so cannot create a second module instance.
 *
 * @module dsh-coord-governor/message
 */

import { randomUUID } from 'node:crypto'

import type { ContentBlock, MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'

/** The fields the host constructor accepts, minus the identity it mints. */
export interface NewUserMessage {
  readonly content: ContentBlock[]
  readonly source: MessageSource
}

/**
 * Freeze a freshly built message, recursively.
 *
 * The host publishes these into the durable session log and documents them as immutable, so
 * a mutable object would let a later mutation change what the log appears to contain. Doing
 * it here rather than at each call site keeps every caller honest.
 */
function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Array.isArray(value) ? value : Object.values(value)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Build one identified user-role message.
 *
 * Mirrors the host helper's contract: a fresh stable `id`, the `user` role, and the result
 * frozen before it is handed to the host.
 */
export function createUserMessage(input: NewUserMessage): UserMessage {
  const message = freezeDeep({
    id: randomUUID(),
    role: 'user' as const,
    content: input.content,
    source: input.source,
  })
  return message as UserMessage
}
