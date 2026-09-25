/**
 * `dsh-coord-governor` library barrel.
 *
 * **The Cordis plugin entry is `host.ts`, not this file.** That distinction is load-bearing:
 * `fs/write-intent` is only delivered to a listener registered synchronously in `apply`, and
 * this barrel statically pulls in the whole analysis graph, which delays `apply` past that
 * point and silently empties the instrument. `host.ts` therefore ships a builtins-only import
 * list and loads this graph itself, dynamically. See `host.ts` for the measurements.
 *
 * Note also the absence of a schemastery `Config`: the plugin ships no runtime import of any
 * `@deepseek-ai/*` package, because a path-mounted plugin that resolves one ends up
 * duplicating the host's request-extension registry and breaks every model call. See
 * `message.ts`.
 *
 * @module dsh-coord-governor
 */

export { apply, inject, name } from './host.ts'
export { createGovernor, resolveConfig, type Governor, type PluginConfig } from './plugin.ts'

export {
  ARM_NAMES,
  ARMS,
  canAdvise,
  canBlock,
  describeCapabilities,
  overrideArm,
  resolveArm,
  seesOtherSessions,
  type ArmName,
  type CoordConfig,
  type LedgerScope,
} from './config.ts'

export {
  GovernorRuntime,
  keyForPath,
  type GovernorError,
  type ObserveInput,
  type TaskIdSource,
} from './governor.ts'

export {
  DEFAULT_POLICY,
  buildAdvisory,
  decideWrite,
  extractIdentifiers,
  intentSimilarity,
  renderOverview,
  tokenize,
  type DecisionBasis,
  type DetectionBasis,
  type GovAction,
  type GovDecision,
  type InterventionClass,
  type PolicyConfig,
  type WriteProposal,
} from './policy.ts'

export {
  Ledger,
  MIN_RATE_WINDOW_HOURS,
  SCHEMA_VERSION,
  backlogSeries,
  buildCapsules,
  buildContention,
  buildReport,
  compareCodepoint,
  computeParallelism,
  computeRates,
  entityKey,
  fromWire,
  normalizeEntity,
  normalizePath,
  parseWireLine,
  serializeEvent,
  sessionContextLoss,
  sortEvents,
  toWire,
} from './ledger.ts'

export {
  classifyTool,
  extractIntent,
  extractPaths,
  guardDecision,
  safeHandler,
  sessionIdOf,
  toEntities,
  type ToolClass,
} from './adapter.ts'

export { LEDGER_FILENAME, appendLedgerLine, ledgerFilePath } from './store.ts'

export {
  TASKPACK_SCHEMA_VERSION,
  evaluatePack,
  parsePack,
  priorContention,
  type DetectionMetrics,
  type PackPriorEvent,
  type PackProposal,
  type ProposalOutcome,
  type PurposeTruth,
  type TaskPack,
  type TruthKind,
} from './e2.ts'

export type {
  BacklogPoint,
  Capsule,
  ContentionRecord,
  CoordEvent,
  CoordEventKind,
  Entity,
  EntityRecord,
  LedgerReport,
  LifecycleState,
  Parallelism,
  Rates,
  WireEvent,
} from './types.ts'
