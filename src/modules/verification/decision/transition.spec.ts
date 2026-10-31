import { VerificationOutcome as O } from '../verification.enums.js';
import { DiditStatusClass as C } from './status-mapping.js';
import { decideTransition, type Transition } from './transition.js';

const recordOnly = (reason: string): Transition =>
  ({ kind: 'record_only', reason }) as Transition;
const evaluate: Transition = { kind: 'evaluate_approval' };
const set = (outcome: O): Transition =>
  ({ kind: 'set_outcome', outcome }) as Transition;

const decide = (outcome: O, status: C, decidedByStaff = false) =>
  decideTransition({ outcome, status, decidedByStaff });

describe('decideTransition', () => {
  describe('V15: never changed by Didit', () => {
    it.each(Object.values(C))(
      'a staff-decided attempt only records %s',
      (status) => {
        for (const outcome of [O.Approved, O.Declined]) {
          expect(decide(outcome, status, true)).toEqual(
            recordOnly('staff_decided'),
          );
        }
      },
    );

    it.each(Object.values(C))('a blocked attempt only records %s', (status) => {
      expect(decide(O.Blocked, status)).toEqual(recordOnly('blocked'));
    });

    it.each(Object.values(C))(
      'a manual_review attempt only records %s',
      (status) => {
        expect(decide(O.ManualReview, status)).toEqual(
          recordOnly('manual_review'),
        );
      },
    );

    it.each([O.Pending, O.Approved, O.Declined, O.Abandoned, O.Expired])(
      'Kyc Expired only records provider_status on a %s attempt',
      (outcome) => {
        expect(decide(outcome, C.KycExpired)).toEqual(
          recordOnly('kyc_expired'),
        );
      },
    );

    it.each([O.Pending, O.Approved, O.Declined])(
      'an unknown status only records (%s)',
      (outcome) => {
        expect(decide(outcome, C.Unknown)).toEqual(
          recordOnly('unknown_status'),
        );
      },
    );
  });

  describe('V12: non-final statuses', () => {
    it('leave a pending attempt pending', () => {
      expect(decide(O.Pending, C.Pending)).toEqual(recordOnly('unchanged'));
    });

    it.each([O.Approved, O.Declined, O.Abandoned, O.Expired])(
      'never overwrite a %s attempt',
      (outcome) => {
        expect(decide(outcome, C.Pending)).toEqual(
          recordOnly('late_non_final'),
        );
      },
    );
  });

  describe('Didit Approved', () => {
    it.each([O.Pending, O.Abandoned, O.Expired, O.Declined])(
      'runs our checks on a %s attempt',
      (outcome) => {
        expect(decide(outcome, C.Approved)).toEqual(evaluate);
      },
    );

    it('is a no-op on an already approved attempt', () => {
      expect(decide(O.Approved, C.Approved)).toEqual(recordOnly('unchanged'));
    });
  });

  describe('Didit Declined', () => {
    it.each([O.Pending, O.Abandoned, O.Expired, O.Approved])(
      'declines a %s attempt (from approved: a reversal)',
      (outcome) => {
        expect(decide(outcome, C.Declined)).toEqual(set(O.Declined));
      },
    );

    it('is a no-op on an already declined attempt (keeps our reason, e.g. UNDERAGE)', () => {
      expect(decide(O.Declined, C.Declined)).toEqual(recordOnly('unchanged'));
    });
  });

  describe('Didit Abandoned / Expired', () => {
    it('apply to a pending attempt', () => {
      expect(decide(O.Pending, C.Abandoned)).toEqual(set(O.Abandoned));
      expect(decide(O.Pending, C.Expired)).toEqual(set(O.Expired));
    });

    it.each([O.Approved, O.Declined, O.Abandoned, O.Expired])(
      'do not change a %s attempt',
      (outcome) => {
        expect(decide(outcome, C.Abandoned)).toEqual(recordOnly('not_pending'));
        expect(decide(outcome, C.Expired)).toEqual(recordOnly('not_pending'));
      },
    );
  });

  it('returns a decision for every outcome × status combination', () => {
    for (const outcome of Object.values(O)) {
      for (const status of Object.values(C)) {
        for (const staff of [false, true]) {
          expect(decide(outcome, status, staff).kind).toMatch(
            /^(record_only|evaluate_approval|set_outcome)$/,
          );
        }
      }
    }
  });
});
