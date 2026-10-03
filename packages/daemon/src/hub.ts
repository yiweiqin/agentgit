/**
 * The spine's publishing half: observe a workspace, rule on it, and write the ruling once.
 *
 * What lives here and what does not
 * ---------------------------------
 * The *ruling* is a pure function in `@agentgit/core/hub` — same events and same instant, same
 * answer, everywhere. This module is the stateful shell around it, and it owns the three things a
 * long-running process needs that a pure function cannot have:
 *
 * 1. **A memory of what it last published.** Publishing is append-only and the ledger is the
 *    source of truth, but re-reading the whole ledger on every tick to find out what the last
 *    ruling was would make a 2-second poll cost grow with the workspace. The memory is seeded from
 *    the ledger once, at startup, so a restart still republishes nothing.
 * 2. **Memoized `git` reads.** The integration order needs `git worktree list`, which a ledger
 *    change does not. It is cached for a second, the same way the commit graph is and for the same
 *    reason.
 * 3. **Failure containment.** The hub is an addition to a board that already worked. A defect here
 *    degrades to "no ruling" rather than to a board that will not render, so every entry point
 *    returns a value instead of throwing.
 *
 * @module @agentgit/daemon/hub
 */

import {
  buildIntegrationPlan,
  computeHubVerdict,
  lastPublishedRuling,
  publishHubVerdict,
  publishImpactProjection,
  readAllEvents,
  type HubIntegrationItem,
  type HubPublishedRuling,
  type HubVerdict,
  type WorkspacePaths,
} from '@agentgit/core'
import { buildBoardView } from '@agentgit/core'

/**
 * How long a `git`-derived answer is reused.
 *
 * Matches the commit graph's TTL. A branch move is then visible within a second even though no
 * ledger line was written, without paying for a `git` call on every tick of the poll.
 */
const GIT_TTL_MS = 1000

export interface HubPublisherOptions {
  /**
   * Whether a ruling may be appended to the ledger. Defaults to true.
   *
   * Off keeps the projection refreshed — readers still see the current conclusion — while the
   * ledger is left strictly alone, which is what a workspace owned by somebody else needs.
   */
  readonly publish?: boolean
  /** Injectable clock, so a test can pin the ownership-stability figure. */
  readonly now?: () => Date
}

export interface HubPublisher {
  /**
   * Rule on one workspace, publish it if it changed, and return it.
   *
   * `view` is accepted rather than derived so the board is built once per tick instead of twice:
   * the parallelism figure the ruling has to carry comes from that same view.
   */
  rule(workspaceId: string, paths: WorkspacePaths, view: ReturnType<typeof buildBoardView>): HubVerdict | null
  /** What was last published for a workspace, for diagnostics and for tests. */
  published(workspaceId: string): HubPublishedRuling | null
  /** Forget everything derived from `git` and from the ledger, as a restart would. */
  reset(): void
}

export function createHubPublisher(options: HubPublisherOptions = {}): HubPublisher {
  const clock = options.now ?? (() => new Date())
  const integrations = new Map<string, { at: number; items: HubIntegrationItem[] }>()
  const published = new Map<string, HubPublishedRuling | null>()

  /**
   * The integration order, cached briefly.
   *
   * A failure here is an empty order rather than an error: a workspace that is not a repository
   * yet is a normal first-run state, and it must not stop the board from rendering the rest.
   */
  const integrationFor = (workspaceId: string, paths: WorkspacePaths): HubIntegrationItem[] => {
    const at = Date.now()
    const cached = integrations.get(workspaceId)
    if (cached && at - cached.at < GIT_TTL_MS) return cached.items

    let items: HubIntegrationItem[] = []
    try {
      items = buildIntegrationPlan(paths).order
    } catch {
      items = []
    }

    integrations.set(workspaceId, { at, items })
    return items
  }

  /**
   * What this process last published, seeded from the ledger on first use.
   *
   * Lazily seeded rather than filled at construction, so a workspace only pays for the ledger read
   * when it is actually ruled on. The seed is what makes a restart quiet: the conclusion is already
   * in the ledger, and this process has simply not published it *yet*.
   */
  const previousFor = (workspaceId: string, paths: WorkspacePaths): HubPublishedRuling | null => {
    if (published.has(workspaceId)) return published.get(workspaceId) ?? null
    let seeded: HubPublishedRuling | null = null
    try {
      seeded = lastPublishedRuling(readAllEvents(paths).events)
    } catch {
      // An unreadable ledger means "we know of nothing published", which republishes once the
      // ledger becomes readable again. Erring toward publishing is the safe direction: a repeated
      // ruling is noise, a lost one is work done twice.
      seeded = null
    }
    published.set(workspaceId, seeded)
    return seeded
  }

  return {
    rule(workspaceId, paths, view) {
      // Failure in a delivery cache must not suppress the existing hub ruling.
      try { publishImpactProjection(paths, { now: clock() }) } catch { /* retry on the next tick */ }
      try {
        const verdict = computeHubVerdict(paths, clock(), {
          integration: integrationFor(workspaceId, paths),
          parallelism: {
            mean: view.report.parallelism.mean,
            peak: view.report.parallelism.peak,
            parallelFraction: view.report.parallelism.parallelFraction,
          },
        })
        const result = publishHubVerdict(paths, verdict, {
          publish: options.publish !== false,
          previous: previousFor(workspaceId, paths),
        })
        if (result.published) {
          const previous = previousFor(workspaceId, paths)
          published.set(workspaceId, {
            id: verdict.id,
            rulingCount: verdict.rulings.length,
            saysNothing: verdict.rulings.length === 0 && verdict.holders.length === 0,
            // The count from before this publish, so the next one can carry it forward without
            // going back to the ledger.
            published: (previous?.published ?? 0) + 1,
            at: verdict.generatedAt,
          })
        }
        return verdict
      } catch {
        return null
      }
    },

    published(workspaceId) {
      return published.get(workspaceId) ?? null
    },

    reset() {
      integrations.clear()
      published.clear()
    },
  }
}
