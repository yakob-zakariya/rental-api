import { VerificationStatus } from '../users/user.enums.js';
import { VerificationOutcome as O } from './verification.enums.js';
import { deriveVerificationStatus } from './verification-status.js';

const S = VerificationStatus;

describe('deriveVerificationStatus (outcomes newest first)', () => {
  it.each<[string, O[], VerificationStatus]>([
    ['no attempts', [], S.NotVerified],
    [
      'only abandoned/expired attempts',
      [O.Abandoned, O.Expired, O.Abandoned],
      S.NotVerified,
    ],
    [
      '1. blocked anywhere wins, even over approved',
      [O.Approved, O.Pending, O.Blocked],
      S.Blocked,
    ],
    [
      '1. blocked wins when it is the newest',
      [O.Blocked, O.Approved],
      S.Blocked,
    ],
    [
      '2. approved anywhere wins over a newer decline',
      [O.Declined, O.Pending, O.Approved],
      S.Approved,
    ],
    [
      '2. approved wins over newer manual_review',
      [O.ManualReview, O.Approved],
      S.Approved,
    ],
    ['3. newest pending', [O.Pending, O.Declined], S.Pending],
    ['3. newest declined', [O.Declined, O.Pending], S.Declined],
    ['3. newest manual_review', [O.ManualReview, O.Declined], S.ManualReview],
    [
      '3. skips newer abandoned/expired attempts',
      [O.Abandoned, O.Expired, O.Declined, O.Pending],
      S.Declined,
    ],
    [
      '3. a superseded attempt does not hide an older manual_review',
      [O.Abandoned, O.ManualReview],
      S.ManualReview,
    ],
  ])('%s', (_label, outcomes, expected) => {
    expect(deriveVerificationStatus(outcomes)).toBe(expected);
  });
});
