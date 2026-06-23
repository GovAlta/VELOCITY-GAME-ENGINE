import { describe, it, expect } from 'vitest';

// Replicate the state machine transitions from the velocity service
// This tests the logic independently of the database

// hand_raised + blocked are universally available — player can always flag
// help/impediment regardless of cell state.
const VALID_TRANSITIONS: Record<string, string[]> = {
  'not_started':    ['ready_to_start', 'hand_raised', 'blocked'],
  'ready_to_start': ['ai_working', 'human_working', 'hand_raised', 'blocked'],
  'ai_working':     ['ai_review', 'human_review', 'blocked', 'hand_raised', 'human_working', 'ready_to_start'],
  'human_working':  ['ai_review', 'human_review', 'blocked', 'hand_raised', 'ai_working', 'ready_to_start'],
  'ai_review':      ['ai_working', 'human_working', 'completed', 'hand_raised', 'blocked'],
  'human_review':   ['ai_working', 'human_working', 'completed', 'hand_raised', 'blocked'],
  'blocked':        ['ready_to_start', 'ai_working', 'human_working', 'hand_raised'],
  'hand_raised':    ['ai_working', 'human_working', 'ai_review', 'human_review', 'blocked'],
  'completed':      ['ready_to_start', 'hand_raised', 'blocked'],
};

function isValidTransition(from: string, to: string): boolean {
  return (VALID_TRANSITIONS[from] || []).includes(to);
}

function shouldIncrementLoop(from: string, to: string): boolean {
  const isReject = (from === 'ai_review' || from === 'human_review') &&
    (to === 'ai_working' || to === 'human_working');
  return isReject;
}

function deriveAction(from: string, to: string): string {
  if (from === 'not_started' && to === 'ready_to_start') return 'start';
  if (from === 'ready_to_start' && (to === 'ai_working' || to === 'human_working')) return 'start';
  if ((from === 'ai_working' || from === 'human_working') && (to === 'ai_review' || to === 'human_review')) return 'review';
  if ((from === 'ai_review' || from === 'human_review') && to === 'completed') return 'approve';
  if ((from === 'ai_review' || from === 'human_review') && (to === 'ai_working' || to === 'human_working')) return 'reject';
  if (to === 'blocked') return 'block';
  if (from === 'blocked') return 'unblock';
  return 'pass';
}

describe('Velocity State Machine', () => {
  describe('Valid transitions', () => {
    it('allows not_started → ready_to_start', () => {
      expect(isValidTransition('not_started', 'ready_to_start')).toBe(true);
    });

    it('allows ready_to_start → ai_working', () => {
      expect(isValidTransition('ready_to_start', 'ai_working')).toBe(true);
    });

    it('allows ready_to_start → human_working', () => {
      expect(isValidTransition('ready_to_start', 'human_working')).toBe(true);
    });

    it('allows ai_working → ai_review', () => {
      expect(isValidTransition('ai_working', 'ai_review')).toBe(true);
    });

    it('allows ai_working → human_review', () => {
      expect(isValidTransition('ai_working', 'human_review')).toBe(true);
    });

    it('allows ai_working → blocked', () => {
      expect(isValidTransition('ai_working', 'blocked')).toBe(true);
    });

    it('allows ai_review → completed', () => {
      expect(isValidTransition('ai_review', 'completed')).toBe(true);
    });

    it('allows human_review → completed', () => {
      expect(isValidTransition('human_review', 'completed')).toBe(true);
    });

    it('allows ai_review → ai_working (reject)', () => {
      expect(isValidTransition('ai_review', 'ai_working')).toBe(true);
    });

    it('allows human_review → human_working (reject)', () => {
      expect(isValidTransition('human_review', 'human_working')).toBe(true);
    });

    it('allows blocked → ready_to_start', () => {
      expect(isValidTransition('blocked', 'ready_to_start')).toBe(true);
    });

    it('allows blocked → ai_working', () => {
      expect(isValidTransition('blocked', 'ai_working')).toBe(true);
    });

    // Lateral handoff between human and AI without forcing a review/block turn.
    it('allows ai_working → human_working (lateral handoff)', () => {
      expect(isValidTransition('ai_working', 'human_working')).toBe(true);
    });

    it('allows human_working → ai_working (lateral handoff)', () => {
      expect(isValidTransition('human_working', 'ai_working')).toBe(true);
    });

    // Rewind to ready_to_start when no real work has been done.
    it('allows ai_working → ready_to_start (rewind)', () => {
      expect(isValidTransition('ai_working', 'ready_to_start')).toBe(true);
    });

    it('allows human_working → ready_to_start (rewind)', () => {
      expect(isValidTransition('human_working', 'ready_to_start')).toBe(true);
    });

    it('allows completed → ready_to_start (reopen)', () => {
      expect(isValidTransition('completed', 'ready_to_start')).toBe(true);
    });
  });

  describe('Invalid transitions', () => {
    it('rejects not_started → ai_working (must go through ready_to_start)', () => {
      expect(isValidTransition('not_started', 'ai_working')).toBe(false);
    });

    it('rejects not_started → completed (cannot skip)', () => {
      expect(isValidTransition('not_started', 'completed')).toBe(false);
    });

    it('rejects completed → working / review (must reopen via ready_to_start)', () => {
      expect(isValidTransition('completed', 'ai_working')).toBe(false);
      expect(isValidTransition('completed', 'ai_review')).toBe(false);
      expect(isValidTransition('completed', 'human_working')).toBe(false);
      expect(isValidTransition('completed', 'human_review')).toBe(false);
    });

    it('rejects ai_working → completed (must go through review)', () => {
      expect(isValidTransition('ai_working', 'completed')).toBe(false);
    });

    it('rejects human_working → completed (must go through review)', () => {
      expect(isValidTransition('human_working', 'completed')).toBe(false);
    });

  });

  describe('Universal hand_raised + blocked transitions', () => {
    const otherStates = [
      'not_started', 'ready_to_start',
      'ai_working', 'human_working',
      'ai_review', 'human_review',
      'completed', 'blocked', 'hand_raised',
    ];

    it.each(otherStates.filter(s => s !== 'hand_raised'))(
      'allows %s → hand_raised',
      (from) => {
        expect(isValidTransition(from, 'hand_raised')).toBe(true);
      },
    );

    it.each(otherStates.filter(s => s !== 'blocked'))(
      'allows %s → blocked',
      (from) => {
        expect(isValidTransition(from, 'blocked')).toBe(true);
      },
    );
  });

  describe('Loop count logic', () => {
    it('increments loop when ai_review → ai_working (reject)', () => {
      expect(shouldIncrementLoop('ai_review', 'ai_working')).toBe(true);
    });

    it('increments loop when ai_review → human_working (reject)', () => {
      expect(shouldIncrementLoop('ai_review', 'human_working')).toBe(true);
    });

    it('increments loop when human_review → ai_working (reject)', () => {
      expect(shouldIncrementLoop('human_review', 'ai_working')).toBe(true);
    });

    it('increments loop when human_review → human_working (reject)', () => {
      expect(shouldIncrementLoop('human_review', 'human_working')).toBe(true);
    });

    it('does NOT increment loop when ai_working → ai_review', () => {
      expect(shouldIncrementLoop('ai_working', 'ai_review')).toBe(false);
    });

    it('does NOT increment loop when review → completed (approve)', () => {
      expect(shouldIncrementLoop('ai_review', 'completed')).toBe(false);
      expect(shouldIncrementLoop('human_review', 'completed')).toBe(false);
    });

    it('does NOT increment loop on initial transitions', () => {
      expect(shouldIncrementLoop('not_started', 'ready_to_start')).toBe(false);
      expect(shouldIncrementLoop('ready_to_start', 'ai_working')).toBe(false);
    });
  });

  describe('Action derivation', () => {
    it('derives start for initial transitions', () => {
      expect(deriveAction('not_started', 'ready_to_start')).toBe('start');
      expect(deriveAction('ready_to_start', 'ai_working')).toBe('start');
      expect(deriveAction('ready_to_start', 'human_working')).toBe('start');
    });

    it('derives review for work → review', () => {
      expect(deriveAction('ai_working', 'ai_review')).toBe('review');
      expect(deriveAction('ai_working', 'human_review')).toBe('review');
      expect(deriveAction('human_working', 'ai_review')).toBe('review');
      expect(deriveAction('human_working', 'human_review')).toBe('review');
    });

    it('derives approve for review → completed', () => {
      expect(deriveAction('ai_review', 'completed')).toBe('approve');
      expect(deriveAction('human_review', 'completed')).toBe('approve');
    });

    it('derives reject for review → working', () => {
      expect(deriveAction('ai_review', 'ai_working')).toBe('reject');
      expect(deriveAction('ai_review', 'human_working')).toBe('reject');
      expect(deriveAction('human_review', 'ai_working')).toBe('reject');
      expect(deriveAction('human_review', 'human_working')).toBe('reject');
    });

    it('derives block for any → blocked', () => {
      expect(deriveAction('ai_working', 'blocked')).toBe('block');
      expect(deriveAction('human_working', 'blocked')).toBe('block');
    });

    it('derives unblock for blocked → any', () => {
      expect(deriveAction('blocked', 'ready_to_start')).toBe('unblock');
      expect(deriveAction('blocked', 'ai_working')).toBe('unblock');
    });
  });

  describe('Full workflow scenarios', () => {
    it('happy path: not_started → ready → ai_working → human_review → completed', () => {
      const steps = [
        { from: 'not_started', to: 'ready_to_start' },
        { from: 'ready_to_start', to: 'ai_working' },
        { from: 'ai_working', to: 'human_review' },
        { from: 'human_review', to: 'completed' },
      ];
      let loopCount = 0;
      for (const { from, to } of steps) {
        expect(isValidTransition(from, to)).toBe(true);
        if (shouldIncrementLoop(from, to)) loopCount++;
      }
      expect(loopCount).toBe(0);
    });

    it('reject loop: review → working → review → working → review → completed', () => {
      const steps = [
        { from: 'not_started', to: 'ready_to_start' },
        { from: 'ready_to_start', to: 'ai_working' },
        { from: 'ai_working', to: 'human_review' },
        { from: 'human_review', to: 'ai_working' },     // reject #1
        { from: 'ai_working', to: 'human_review' },
        { from: 'human_review', to: 'ai_working' },     // reject #2
        { from: 'ai_working', to: 'human_review' },
        { from: 'human_review', to: 'completed' },       // approve
      ];
      let loopCount = 0;
      for (const { from, to } of steps) {
        expect(isValidTransition(from, to)).toBe(true);
        if (shouldIncrementLoop(from, to)) loopCount++;
      }
      expect(loopCount).toBe(2);
    });

    it('blocked scenario: working → blocked → unblocked → review → completed', () => {
      const steps = [
        { from: 'not_started', to: 'ready_to_start' },
        { from: 'ready_to_start', to: 'human_working' },
        { from: 'human_working', to: 'blocked' },
        { from: 'blocked', to: 'human_working' },
        { from: 'human_working', to: 'ai_review' },
        { from: 'ai_review', to: 'completed' },
      ];
      let loopCount = 0;
      for (const { from, to } of steps) {
        expect(isValidTransition(from, to)).toBe(true);
        if (shouldIncrementLoop(from, to)) loopCount++;
      }
      expect(loopCount).toBe(0);
    });
  });

  describe('Transition completeness', () => {
    const ALL_STATUSES = [
      'not_started', 'ready_to_start',
      'ai_working', 'human_working',
      'ai_review', 'human_review',
      'completed', 'blocked', 'hand_raised',
    ];

    it('every status has a transition map entry', () => {
      for (const status of ALL_STATUSES) {
        expect(VALID_TRANSITIONS).toHaveProperty(status);
      }
    });

    it('completed loops back via ready_to_start; hand_raised and blocked also flag rework', () => {
      expect(VALID_TRANSITIONS['completed']).toEqual(
        expect.arrayContaining(['ready_to_start', 'hand_raised', 'blocked']),
      );
      expect(VALID_TRANSITIONS['completed']).toHaveLength(3);
    });

    it('all target statuses are valid status names', () => {
      for (const [, targets] of Object.entries(VALID_TRANSITIONS)) {
        for (const target of targets) {
          expect(ALL_STATUSES).toContain(target);
        }
      }
    });

    it('every status has at least one outgoing transition', () => {
      for (const status of ALL_STATUSES) {
        expect(VALID_TRANSITIONS[status].length).toBeGreaterThan(0);
      }
    });
  });
});
