/**
 * Everything a user can tune, in one place, with what it costs to get it wrong.
 *
 * Why this is data rather than three paragraphs in a README
 * ---------------------------------------------------------
 * The product's behaviour is a set of heuristics over intent text, timing windows and TTLs.
 * Every one of them will be wrong for somebody's repository, and the honest response is not
 * to defend the default but to make the knob findable, explain what it does, and say what
 * the default was chosen for. A user who can see that `duplicateIntentThreshold` is the
 * number deciding whether two agents are called duplicates is a user who can tell us the
 * number is wrong for them - which is the feedback this product needs to improve.
 *
 * So each entry carries the thing a settings screen usually omits: what the value *does*,
 * and what happens when it is set badly. `agentgit config` renders exactly these fields, so
 * a knob cannot be added without that sentence being written.
 *
 * @module @agentgit/core/tunables
 */

import { ARM_EFFECTS, PRODUCT_ARMS, resolveProductArm, type WorkspaceConfig } from './workspace.ts'

export interface TunableRange {
  readonly min: number
  readonly max: number
}

export interface Tunable {
  /** The key as written in `.agentgit/config.json` and on the command line. */
  readonly key: keyof WorkspaceConfig
  readonly type: 'number' | 'arm' | 'list'
  readonly effect: string
  /** What goes wrong when this is set too high, too low, or to the wrong thing. */
  readonly caution: string
  /** Present for numbers. Enforced on set, so a bad value is refused rather than clamped. */
  readonly range?: TunableRange
}

/**
 * The registry. One entry per field a user may change.
 *
 * `version` and the list fields are deliberately absent: `version` is the schema's, and
 * `ignore`/`quiet` are path patterns whose format is documented by their own defaults,
 * which a user edits in the file directly.
 */
export const TUNABLES: readonly Tunable[] = [
  {
    key: 'arm',
    type: 'arm',
    effect:
      'Which experimental arm this workspace runs: what is recorded, and whether this session can see other ' +
      'sessions at all. Switching it changes what every verdict can know.',
    caution:
      'A non-default arm makes this workspace incomparable with one running another arm, and each verdict depends ' +
      'on which arm wrote the events it reads. Set it deliberately, and record it if you report numbers.',
  },
  {
    key: 'duplicateIntentThreshold',
    type: 'number',
    range: { min: 0, max: 1 },
    effect:
      'How similar two agents\' own words for their intent must be before their work is called the same. ' +
      'This is the number behind the REUSE verdict.',
    caution:
      'Too low and unrelated work is flagged as duplicate, which is how a team learns to ignore the tool. Too high ' +
      'and real duplicates pass silently. The matcher is lexical, so two agents describing one job in different ' +
      'words score low no matter where this is set: raising it hides the miss rather than fixing it.',
  },
  {
    key: 'inFlightMinutes',
    type: 'number',
    range: { min: 1, max: 100_000 },
    effect:
      'How long a task that said nothing is still treated as working. This bounds the only verdict that can ' +
      'otherwise hold forever: WAIT.',
    caution:
      'Too long and one agent that quit leaves every consumer waiting on an interface that will never land; a lease ' +
      'expiry cannot save them, because WAIT is driven by the ledger. Too short and a slow producer is treated as ' +
      'finished, so consumers replan against a moving target.',
  },
  {
    key: 'leaseMinutes',
    type: 'number',
    range: { min: 1, max: 100_000 },
    effect: 'How long a claim on an entity lasts before it expires without a renewal.',
    caution:
      'Too long and a crashed agent keeps the ground reserved, so others get REPLAN on work nobody is doing. Too ' +
      'short and a long edit loses its reservation midway, which is the collision the lease exists to prevent.',
  },
]

export interface TunableView {
  readonly key: string
  readonly value: unknown
  readonly default: unknown
  readonly type: Tunable['type']
  readonly effect: string
  readonly caution: string
  readonly isDefault: boolean
  /** For arms, the one-line meaning of the value currently set. */
  readonly note?: string
}

/** What each tunable is set to right now, against what it ships as. */
export function describeTunables(config: WorkspaceConfig, defaults: WorkspaceConfig): TunableView[] {
  return TUNABLES.map((tunable) => {
    const value = config[tunable.key]
    const fallback = defaults[tunable.key]
    const isDefault = JSON.stringify(value) === JSON.stringify(fallback)
    return {
      key: tunable.key,
      value,
      default: fallback,
      type: tunable.type,
      effect: tunable.effect,
      caution: tunable.caution,
      isDefault,
      ...(tunable.key === 'arm' && typeof value === 'string' && value in ARM_EFFECTS
        ? { note: ARM_EFFECTS[value as keyof typeof ARM_EFFECTS] }
        : {}),
    }
  })
}

/** The arms, for a listing command. */
export function describeArms(current: string): { readonly name: string; readonly effect: string; readonly current: boolean }[] {
  return PRODUCT_ARMS.map((name) => ({ name, effect: ARM_EFFECTS[name], current: name === current }))
}

/**
 * Parse a value from the command line for one tunable.
 *
 * Throws with the key, the accepted form and the range, because the caller is a person at a
 * shell who has just mistyped something and does not want to go read the source. Never
 * clamps: a threshold silently moved to the nearest legal number would leave someone
 * believing they had set 1.5.
 */
export function parseTunable(key: string, raw: string): { key: keyof WorkspaceConfig; value: unknown } {
  const tunable = TUNABLES.find((entry) => entry.key === key)
  if (!tunable) {
    throw new Error(`unknown setting '${key}'. Known settings: ${TUNABLES.map((entry) => entry.key).join(', ')}`)
  }

  if (tunable.type === 'arm') {
    /*
     * Delegated rather than re-checked, and that is the point: the *reason* an arm is
     * refused lives in `resolveProductArm`, next to the arm list it is derived from. An
     * earlier version of this function did its own membership test, so `config arm
     * A4-gated` printed a generic "not an arm this product runs" and dropped the one
     * sentence explaining that it would block writes — which is the only part a user needs.
     */
    return { key: tunable.key, value: resolveProductArm(raw) }
  }

  const number = Number(raw)
  if (!Number.isFinite(number)) {
    throw new Error(`${key} takes a number, got '${raw}'`)
  }
  if (tunable.key === 'inFlightMinutes' || tunable.key === 'leaseMinutes') {
    if (!Number.isInteger(number) || number < 1) {
      throw new Error(`${key} is whole minutes and must be at least 1, got '${raw}'`)
    }
    return { key: tunable.key, value: number }
  }
  const range = tunable.range
  if (range && (number < range.min || number > range.max)) {
    throw new Error(`${key} is a fraction between ${range.min} and ${range.max}, got '${raw}'`)
  }
  return { key: tunable.key, value: number }
}
