import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessResolution, ResolutionInput } from '../resolution';

const base: ResolutionInput = {
    activeMap: [],
    everTargeted: false,
    resolutionEventsThisTurn: 0,
    newMisconceptionThisTurn: false,
    messageIntent: 'conceptual',
    understanding: false,
    articulatedCause: false,
    confusion: false,
    solutionSeeking: false,
    highConfidenceStreak: 0,
    frustrationStreak: 0,
};

test('auto-resolves when a tracked misconception clears AND the learner shows understanding', () => {
    const r = assessResolution({
        ...base,
        activeMap: [],
        everTargeted: true,
        resolutionEventsThisTurn: 1,
        messageIntent: 'debugging',
        understanding: true,
        articulatedCause: true,
        highConfidenceStreak: 2,
    });
    assert.equal(r.status, 'resolved');
    assert.equal(r.action, 'auto_resolve');
    assert.ok(r.score >= 0.9);
});

test('asks for confirmation on a clean close without a tracked misconception', () => {
    const r = assessResolution({ ...base, understanding: true });
    assert.equal(r.status, 'likely_resolved');
    assert.equal(r.action, 'confirm_resolution');
    // Not auto: nothing was actually worked through.
    assert.notEqual(r.action, 'auto_resolve');
});

test('stays active when a strong misconception persists and the learner is confused', () => {
    const r = assessResolution({
        ...base,
        activeMap: [{ id: 'off-by-one', confidence: 0.7 }],
        everTargeted: true,
        messageIntent: 'solution_request',
        confusion: true,
        solutionSeeking: true,
        frustrationStreak: 1,
    });
    assert.equal(r.status, 'active');
    assert.equal(r.action, 'continue');
    assert.equal(r.score, 0);
});

test('does not resolve when a new misconception is introduced this turn', () => {
    const r = assessResolution({
        ...base,
        activeMap: [{ id: 'null-checks', confidence: 0.39 }],
        everTargeted: true,
        newMisconceptionThisTurn: true,
        articulatedCause: true,
    });
    assert.equal(r.status, 'active');
    assert.ok(r.signals.includes('new_misconception'));
});

test('keeps probing on partial progress (low residual confidence)', () => {
    const r = assessResolution({
        ...base,
        activeMap: [{ id: 'recursion-base-case', confidence: 0.35 }],
        everTargeted: true,
        articulatedCause: true,
        highConfidenceStreak: 1,
    });
    assert.equal(r.status, 'active');
    assert.ok(r.score > 0 && r.score < 0.7);
    assert.ok(r.signals.includes('low_residual_confidence'));
});

test('raises the frustration flag after enough low-progress turns', () => {
    const r = assessResolution({
        ...base,
        activeMap: [{ id: 'off-by-one', confidence: 0.65 }],
        everTargeted: true,
        solutionSeeking: true,
        confusion: true,
        frustrationStreak: 3,
    });
    assert.equal(r.frustration, true);
});
