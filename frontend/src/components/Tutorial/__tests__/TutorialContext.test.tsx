import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { TutorialProvider, useTutorialContext } from '../TutorialContext';
import type { TutorialStep } from '../TutorialOverlay';

// ---------------------------------------------------------------------------
// Mock tutorialAnalytics so we can spy on every emitted event
// ---------------------------------------------------------------------------
vi.mock('../tutorialAnalytics', () => ({
    tutorialAnalytics: {
        start: vi.fn(),
        viewStep: vi.fn(),
        completeStep: vi.fn(),
        skip: vi.fn(),
        complete: vi.fn(),
        getStats: vi.fn(() => ({ events: [], totalTime: 0 })),
    },
}));

import { tutorialAnalytics } from '../tutorialAnalytics';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const steps: TutorialStep[] = [
    { id: 'step-1', title: 'Step 1', content: 'Content 1' },
    { id: 'step-2', title: 'Step 2', content: 'Content 2' },
    { id: 'step-3', title: 'Step 3', content: 'Content 3' },
];

const wrapper = ({ children }: { children: React.ReactNode }) => (
    <TutorialProvider initialSteps={steps}>{children}</TutorialProvider>
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function useTutorial() {
    return useTutorialContext();
}

describe('TutorialContext – behavioral tests', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
    });

    afterEach(() => {
        localStorage.clear();
    });

    // -------------------------------------------------------------------------
    // Scenario 1 – Step Advance
    // Advancing a step must increment the internal step counter and trigger
    // `completeStep` with the exact step ID that was active before the advance.
    // -------------------------------------------------------------------------
    it('1. step advance: increments currentStep and calls completeStep with correct step ID', () => {
        const { result } = renderHook(useTutorial, { wrapper });

        act(() => { result.current.start(); });
        expect(result.current.currentStep).toBe(0);

        act(() => { result.current.next(); });

        expect(result.current.currentStep).toBe(1);
        expect(tutorialAnalytics.completeStep).toHaveBeenCalledTimes(1);
        expect(tutorialAnalytics.completeStep).toHaveBeenCalledWith('step-1', 0);
    });

    // -------------------------------------------------------------------------
    // Scenario 2 – Step Skip
    // Skipping marks the current step as 'skipped' (the tutorial deactivates and
    // `tutorialAnalytics.skip` is called) rather than recording it as completed.
    // -------------------------------------------------------------------------
    it('2. step skip: calls analytics.skip (not completeStep) and marks tutorial inactive', () => {
        const { result } = renderHook(useTutorial, { wrapper });

        act(() => { result.current.start(); });
        act(() => { result.current.skip(); });

        // isActive must be false – step is skipped, not completed
        expect(result.current.isActive).toBe(false);

        // skip event emitted
        expect(tutorialAnalytics.skip).toHaveBeenCalledTimes(1);

        // completeStep must NOT have been called – this is a skip, not a completion
        expect(tutorialAnalytics.completeStep).not.toHaveBeenCalled();

        // hasCompletedBefore is true (localStorage written) but via skip path
        expect(result.current.hasCompletedBefore).toBe(true);
        expect(localStorage.getItem('stellar_tutorial_completed')).toBe('true');
    });

    // -------------------------------------------------------------------------
    // Scenario 3 – Tutorial Completion
    // Clearing the final step via complete() must call `tutorialAnalytics.complete`
    // exactly once and deactivate the tutorial.
    // -------------------------------------------------------------------------
    it('3. tutorial completion: calls analytics.complete and deactivates tutorial', () => {
        const { result } = renderHook(useTutorial, { wrapper });

        act(() => { result.current.start(); });
        act(() => { result.current.complete(); });

        expect(result.current.isActive).toBe(false);
        expect(result.current.hasCompletedBefore).toBe(true);
        expect(tutorialAnalytics.complete).toHaveBeenCalledTimes(1);

        // complete path must NOT have called skip
        expect(tutorialAnalytics.skip).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------------
    // Scenario 4 – Tutorial Reset
    // Reset must return currentStep to 0, clear localStorage, and flush the
    // TutorialProgressManager storage key.
    // -------------------------------------------------------------------------
    it('4. tutorial reset: returns step to 0 and clears all progress storage', () => {
        const { result } = renderHook(useTutorial, { wrapper });

        // Reach step 2 and complete
        act(() => { result.current.start(); });
        act(() => { result.current.next(); });
        act(() => { result.current.next(); });
        act(() => { result.current.complete(); });

        expect(result.current.hasCompletedBefore).toBe(true);
        expect(localStorage.getItem('stellar_tutorial_completed')).toBe('true');

        act(() => { result.current.reset(); });

        expect(result.current.currentStep).toBe(0);
        expect(result.current.hasCompletedBefore).toBe(false);
        // Both completion flag and progress key must be removed
        expect(localStorage.getItem('stellar_tutorial_completed')).toBeNull();
        expect(localStorage.getItem('stellar_tutorial_progress')).toBeNull();
    });

    // -------------------------------------------------------------------------
    // Scenario 5 – Analytics Event Shape
    // The payloads passed to tracking methods must match the expected runtime
    // type shapes: (stepId: string, stepIndex: number) for completeStep, and
    // () for start / complete / skip.
    // -------------------------------------------------------------------------
    it('5. analytics event shape: payloads match expected runtime type signatures', () => {
        const { result } = renderHook(useTutorial, { wrapper });

        act(() => { result.current.start(); });

        // start() – no arguments
        expect(tutorialAnalytics.start).toHaveBeenCalledWith();

        act(() => { result.current.next(); });

        // completeStep(stepId: string, stepIndex: number)
        const [stepId, stepIndex] = (tutorialAnalytics.completeStep as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(typeof stepId).toBe('string');
        expect(typeof stepIndex).toBe('number');
        expect(stepId).toBe('step-1');
        expect(stepIndex).toBe(0);

        act(() => { result.current.complete(); });

        // complete() – no arguments
        expect(tutorialAnalytics.complete).toHaveBeenCalledWith();
    });
});
