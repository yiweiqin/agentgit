/**
 * Experimental arms as configuration.
 *
 * Arm isolation is a research-validity requirement, not a convenience. If
 * recording and intervening cannot be switched independently, then a measured
 * difference between "the round with the plugin" and "the round without" mixes
 * the observation effect with the governance effect and neither can be
 * attributed. Every capability below is therefore a separate flag, and
 * `tests/config.test.ts` asserts the arms do not leak into one another.
 *
 * @module dsh-coord-governor/config
 */

import { DEFAULT_POLICY, type GovAction, type PolicyConfig } from './policy.ts'

/** How much of the ledger this plugin instance may see. */
export type LedgerScope =
  /** Do not record or retain anything. */
  | 'off'
  /** Only this session's events. The key ablation for "is the shared ledger the mechanism?" */
  | 'session'
  /** All sessions that share the ledger directory. */
  | 'cross-session'

export interface CoordConfig {
  /** Whether observation events are collected at all. */
  readonly recordObservations: boolean
  readonly ledgerScope: LedgerScope
  /** Whether a cross-session advisory may be injected before a step. */
  readonly advisory: boolean
  /** Hard cap on advisory length; E6 measures the token cost this buys. */
  readonly advisoryMaxChars: number
  /** Whether a write may be refused, and by which decision kind. */
  readonly gate: 'off' | Extract<GovAction, 'deny' | 'ask'>
  readonly policy: PolicyConfig
  /** Where the append-only ledger lives, relative to the workspace root. */
  readonly ledgerPath: string
}

export type ArmName =
  | 'A0-baseline'
  | 'A1-instrument'
  | 'A2-inert'
  | 'A3-advisory'
  | 'A4-gated'
  | 'A4-session-only'
  | 'A4-detect-only'

/**
 * The control arms `A0`/`A2` differ only in whether the plugin is present in the
 * process. That is the point: `A2` prices the plugin's mere existence (load,
 * registration, handler overhead) so `A1 - A2` isolates recording cost and
 * `A3 - A1` isolates the advisory's effect.
 */
export const ARMS: Readonly<Record<ArmName, CoordConfig>> = {
  /** No instrumentation and no governance. The true baseline. */
  'A0-baseline': {
    recordObservations: false,
    ledgerScope: 'off',
    advisory: false,
    advisoryMaxChars: 0,
    gate: 'off',
    policy: { ...DEFAULT_POLICY, action: 'none' },
    ledgerPath: '.coord-ledger',
  },

  /** Loaded in the process but touching nothing: prices mere presence. */
  'A2-inert': {
    recordObservations: false,
    ledgerScope: 'off',
    advisory: false,
    advisoryMaxChars: 0,
    gate: 'off',
    policy: { ...DEFAULT_POLICY, action: 'none' },
    ledgerPath: '.coord-ledger',
  },

  /** Measurement only. Produces lambda_produced and B(t); never intervenes. */
  'A1-instrument': {
    recordObservations: true,
    ledgerScope: 'cross-session',
    advisory: false,
    advisoryMaxChars: 0,
    gate: 'off',
    policy: { ...DEFAULT_POLICY, action: 'none' },
    ledgerPath: '.coord-ledger',
  },

  /** Coordination: raise R by supplying the cross-session view. The framework's claim. */
  'A3-advisory': {
    recordObservations: true,
    ledgerScope: 'cross-session',
    advisory: true,
    advisoryMaxChars: 1200,
    gate: 'off',
    policy: { ...DEFAULT_POLICY, action: 'advise' },
    ledgerPath: '.coord-ledger',
  },

  /** Admission control: refuse the write. Lowers lambda; expected to trip K4 if it wins. */
  'A4-gated': {
    recordObservations: true,
    ledgerScope: 'cross-session',
    advisory: false,
    advisoryMaxChars: 0,
    gate: 'deny',
    policy: { ...DEFAULT_POLICY, action: 'deny' },
    ledgerPath: '.coord-ledger',
  },

  /**
   * Ablation: gate on, but the ledger only contains this session.
   *
   * The governor still blocks duplicates it can see locally, but has no
   * cross-session memory. If this arm matches `A4-gated`, the shared ledger —
   * the paper's actual contribution — is not what produces the effect.
   */
  'A4-session-only': {
    recordObservations: true,
    ledgerScope: 'session',
    advisory: false,
    advisoryMaxChars: 0,
    gate: 'deny',
    policy: { ...DEFAULT_POLICY, action: 'deny' },
    ledgerPath: '.coord-ledger',
  },

  /**
   * Ablation: full detection, no action.
   *
   * Every decision is computed and logged — so the arm pays the governor's own
   * compute cost and produces the same records — but nothing is refused and
   * nothing is injected. If this arm already improves outcomes, the improvement
   * is not caused by the intervention at all (and the effect is likely
   * measurement noise or a harness artefact).
   */
  'A4-detect-only': {
    recordObservations: true,
    ledgerScope: 'cross-session',
    advisory: false,
    advisoryMaxChars: 0,
    gate: 'deny',
    policy: { ...DEFAULT_POLICY, action: 'deny', dryRun: true },
    ledgerPath: '.coord-ledger',
  },
}

export const ARM_NAMES: readonly ArmName[] = Object.keys(ARMS) as ArmName[]

export function resolveArm(name: ArmName): CoordConfig {
  const config = ARMS[name]
  if (!config) throw new Error(`unknown arm: ${name}`)
  return config
}

/** True when this config may ever refuse a write. */
export function canBlock(config: CoordConfig): boolean {
  return config.gate !== 'off' && config.policy.action !== 'none'
}

/** True when this config may ever inject context. */
export function canAdvise(config: CoordConfig): boolean {
  return config.advisory && config.policy.action === 'advise'
}

/** True when this config reads other sessions' events. */
export function seesOtherSessions(config: CoordConfig): boolean {
  return config.ledgerScope === 'cross-session'
}

/** A human-readable capability summary, logged with every run. */
export function describeCapabilities(config: CoordConfig): string {
  return [
    `record=${config.recordObservations}`,
    `scope=${config.ledgerScope}`,
    `advisory=${config.advisory}`,
    `gate=${config.gate}`,
    `policy=${config.policy.action}`,
    `dryRun=${config.policy.dryRun}`,
  ].join(' ')
}

/**
 * Fields that define *which experiment is being run*. An override may not change
 * these: allowing it would let one arm silently become another and invalidate
 * every comparison made against it.
 */
const STRUCTURAL_FIELDS = ['recordObservations', 'ledgerScope', 'advisory', 'gate'] as const
const STRUCTURAL_POLICY_FIELDS = ['action', 'dryRun'] as const

/**
 * Merge tuning overrides onto an arm, refusing anything that would change the
 * arm's identity.
 *
 * Tuning (thresholds, caps, ledger path) is free; structure (does it record, does
 * it see other sessions, does it advise, does it block) is not. The earlier
 * version only guarded `recordObservations` and blocking, so an override could
 * quietly switch `A1-instrument`'s gate on — which is how this guard came to
 * exist.
 */
export function overrideArm(base: CoordConfig, overrides: Partial<CoordConfig>): CoordConfig {
  for (const field of STRUCTURAL_FIELDS) {
    if (field in overrides && overrides[field] !== base[field]) {
      throw new Error(
        `override may not change ${field}: that changes which arm this is ` +
          `(${JSON.stringify(base[field])} -> ${JSON.stringify(overrides[field])})`,
      )
    }
  }
  for (const field of STRUCTURAL_POLICY_FIELDS) {
    const value = overrides.policy?.[field]
    if (value !== undefined && value !== base.policy[field]) {
      throw new Error(`override may not change policy.${field}: that changes which arm this is`)
    }
  }
  return { ...base, ...overrides, policy: { ...base.policy, ...(overrides.policy ?? {}) } }
}
