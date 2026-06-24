/**
 * Automatic query-resolution detector.
 *
 * The system needs to know — without a manual button and without an extra LLM
 * call — when a learner's query has effectively been resolved, so it can offer
 * a reflective close instead of probing forever. This module combines signals
 * the pipeline already produces this turn:
 *
 *   + the targeted misconception(s) have decayed below threshold / cleared
 *   + the learner explicitly signalled comprehension
 *   + the learner articulated the cause or self-corrected
 *   + learner confidence has been high for consecutive turns
 *   - a new misconception just appeared / strong misconception still active
 *   - the learner is confused or just demanding the answer
 *
 * These are deliberately pedagogical heuristics (see paper §4.4 / §6.2), not
 * calibrated probabilities. All weights and thresholds are documented here and
 * in docs/PLAN.md §4 for replicability.
 *
 * It also reports a `frustration` flag so the caller can offer a non-answer
 * off-ramp to a stuck learner (the "bail-out" reviewers asked about) without
 * ever revealing the solution.
 */

import { config } from './config';
import type { MessageIntent } from './misconceptions';

export type ResolutionStatus = 'active' | 'likely_resolved' | 'resolved';
export type ResolutionAction = 'continue' | 'confirm_resolution' | 'auto_resolve';

export interface ResolutionState {
    status: ResolutionStatus;
    score: number;
    signals: string[];
    action: ResolutionAction;
    frustration: boolean;
}

export interface ResolutionInput {
    /** Misconceptions still active in the learner state after this turn's update. */
    activeMap: { id: string; confidence: number }[];
    /** Whether any misconception was ever targeted in this query. */
    everTargeted: boolean;
    /** Misconceptions that crossed below the resolution threshold this turn. */
    resolutionEventsThisTurn: number;
    /** Whether a brand-new misconception was introduced this turn. */
    newMisconceptionThisTurn: boolean;
    messageIntent: MessageIntent;
    understanding: boolean;
    articulatedCause: boolean;
    confusion: boolean;
    solutionSeeking: boolean;
    /** Consecutive turns with learner confidence >= 0.7. */
    highConfidenceStreak: number;
    /** Consecutive low-progress turns (used only for the frustration flag). */
    frustrationStreak: number;
}

// --- Signal weights (documented; sum is clamped to [0,1]) -------------------
const W_CLEARED = 0.5;            // targeted misconception(s) cleared
const W_CLEAN_CLOSE = 0.3;        // understanding + no misconception was tracked
const W_RESOLVED_THIS_TURN = 0.3; // a misconception dropped below threshold this turn
const W_UNDERSTANDING = 0.4;      // explicit comprehension language
const W_ARTICULATED = 0.2;        // articulated cause / self-correction
const W_SUSTAINED_CONF = 0.2;     // sustained high learner confidence
const W_LOW_RESIDUAL = 0.1;       // all remaining misconceptions are weak (<0.4)

const P_NEW_MISCONCEPTION = 0.4;  // penalty: new gap appeared
const P_STRONG_ACTIVE = 0.25;     // penalty: a misconception is still strong (>=0.6)
const P_CONFUSION = 0.25;         // penalty: learner confused
const P_SOLUTION_SEEKING = 0.15;  // penalty: learner demanding the answer

const STRONG_ACTIVE = 0.6;
const WEAK_RESIDUAL = 0.4;
const HIGH_CONF_STREAK = 2;

function clamp01(n: number): number {
    return Math.max(0, Math.min(1, n));
}

export function assessResolution(
    input: ResolutionInput,
    opts: { confirmScore?: number; autoScore?: number; frustrationTurns?: number } = {}
): ResolutionState {
    const confirmScore = opts.confirmScore ?? config.thresholds.resolveConfirmScore;
    const autoScore = opts.autoScore ?? config.thresholds.resolveAutoScore;
    const frustrationTurns = opts.frustrationTurns ?? config.thresholds.frustrationTurns;

    const empty = input.activeMap.length === 0;
    const signals: string[] = [];
    let score = 0;

    if (empty && input.everTargeted) {
        score += W_CLEARED;
        signals.push('all_misconceptions_cleared');
    } else if (empty && input.understanding) {
        score += W_CLEAN_CLOSE;
        signals.push('clean_close');
    }

    if (input.resolutionEventsThisTurn > 0) {
        score += W_RESOLVED_THIS_TURN;
        signals.push('misconception_resolved_this_turn');
    }
    if (input.understanding) {
        score += W_UNDERSTANDING;
        signals.push('explicit_understanding');
    }
    if (input.articulatedCause) {
        score += W_ARTICULATED;
        signals.push('articulated_cause');
    }
    if (input.highConfidenceStreak >= HIGH_CONF_STREAK) {
        score += W_SUSTAINED_CONF;
        signals.push('sustained_confidence');
    }
    if (!empty && input.activeMap.every(m => m.confidence < WEAK_RESIDUAL)) {
        score += W_LOW_RESIDUAL;
        signals.push('low_residual_confidence');
    }

    // Penalties
    if (input.newMisconceptionThisTurn) {
        score -= P_NEW_MISCONCEPTION;
        signals.push('new_misconception');
    }
    if (input.activeMap.some(m => m.confidence >= STRONG_ACTIVE)) {
        score -= P_STRONG_ACTIVE;
        signals.push('strong_active_misconception');
    }
    if (input.confusion) {
        score -= P_CONFUSION;
        signals.push('confusion');
    }
    if (input.messageIntent === 'solution_request' || input.solutionSeeking) {
        score -= P_SOLUTION_SEEKING;
        signals.push('solution_seeking');
    }

    score = clamp01(score);

    // Auto-resolution is conservative: only when the learner explicitly signalled
    // understanding, nothing is still active, something was actually worked on,
    // and no new gap surfaced this turn.
    const autoEligible =
        input.understanding &&
        empty &&
        input.everTargeted &&
        !input.newMisconceptionThisTurn;

    let status: ResolutionStatus = 'active';
    let action: ResolutionAction = 'continue';
    if (score >= autoScore && autoEligible) {
        status = 'resolved';
        action = 'auto_resolve';
    } else if (score >= confirmScore) {
        status = 'likely_resolved';
        action = 'confirm_resolution';
    }

    const frustration = input.frustrationStreak >= frustrationTurns;

    return { status, score: Math.round(score * 1000) / 1000, signals, action, frustration };
}
