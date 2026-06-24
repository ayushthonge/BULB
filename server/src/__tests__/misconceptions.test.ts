import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    applyVerdicts,
    createSessionState,
    detectLearnerSignals,
    pickTopMisconception,
    NEUTRAL_CONFIDENCE,
} from '../misconceptions';

// ---------------------------------------------------------------------------
// Learner-signal detection
// ---------------------------------------------------------------------------

test('detectLearnerSignals recognizes explicit understanding', () => {
    assert.equal(detectLearnerSignals('Oh I see now, that makes sense, thanks!').understanding, true);
    assert.equal(detectLearnerSignals('got it').understanding, true);
});

test('detectLearnerSignals does NOT treat "I don\'t understand" as understanding', () => {
    const s = detectLearnerSignals("I still don't understand why");
    assert.equal(s.understanding, false);
    assert.equal(s.confusion, true);
});

test('detectLearnerSignals recognizes articulated cause', () => {
    assert.equal(detectLearnerSignals('I think the problem is the loop bound').articulatedCause, true);
    assert.equal(detectLearnerSignals("it's because the index goes past the end").articulatedCause, true);
});

test('detectLearnerSignals recognizes solution seeking', () => {
    assert.equal(detectLearnerSignals('just tell me the answer').solutionSeeking, true);
    assert.equal(detectLearnerSignals('give me the code').solutionSeeking, true);
});

// ---------------------------------------------------------------------------
// Confidence model (bounded deltas + decay + resolution threshold)
// ---------------------------------------------------------------------------

test('a "new" verdict seeds confidence above neutral and tracks the misconception', () => {
    const state = createSessionState();
    applyVerdicts(state, [{ id: 'off-by-one', status: 'new', certainty: 0.8 }]);
    const top = pickTopMisconception(state);
    assert.equal(top?.id, 'off-by-one');
    assert.ok((top?.confidence ?? 0) > NEUTRAL_CONFIDENCE);
});

test('"reinforced" raises and "weakened" lowers confidence (bounded)', () => {
    const state = createSessionState();
    applyVerdicts(state, [{ id: 'null-checks', status: 'new', certainty: 0.7 }]);
    const afterNew = state.map.get('null-checks')!;

    applyVerdicts(state, [{ id: 'null-checks', status: 'reinforced', certainty: 0.9 }]);
    const afterReinforced = state.map.get('null-checks')!;
    assert.ok(afterReinforced > afterNew, 'reinforced should increase confidence');

    applyVerdicts(state, [{ id: 'null-checks', status: 'weakened', certainty: 0.9 }]);
    const afterWeakened = state.map.get('null-checks')!;
    assert.ok(afterWeakened < afterReinforced, 'weakened should decrease confidence');
});

test('sustained weakening drives a misconception below threshold and emits a resolution event', () => {
    const state = createSessionState();
    applyVerdicts(state, [{ id: 'return-vs-print', status: 'new', certainty: 0.7 }]);

    let resolved = false;
    for (let i = 0; i < 6 && !resolved; i++) {
        const update = applyVerdicts(state, [{ id: 'return-vs-print', status: 'weakened', certainty: 0.9 }]);
        if (update.resolutionEvents.includes('return-vs-print')) resolved = true;
    }
    assert.equal(resolved, true);
    assert.equal(state.map.has('return-vs-print'), false, 'resolved misconception is removed from state');
});

test('unmentioned misconceptions decay over turns', () => {
    const state = createSessionState();
    applyVerdicts(state, [{ id: 'scope-shadowing', status: 'reinforced', certainty: 0.9 }]);
    applyVerdicts(state, [{ id: 'scope-shadowing', status: 'reinforced', certainty: 0.9 }]);
    const before = state.map.get('scope-shadowing')!;

    // A turn that mentions a different misconception -> scope-shadowing decays.
    applyVerdicts(state, [{ id: 'type-coercion', status: 'new', certainty: 0.6 }]);
    const after = state.map.get('scope-shadowing')!;
    assert.ok(after < before, 'unmentioned misconception should decay');
});
