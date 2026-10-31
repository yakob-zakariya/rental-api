import { DiditStatus } from '../didit/didit.types.js';
import {
  classifyDiditStatus,
  DiditStatusClass as C,
} from './status-mapping.js';

describe('classifyDiditStatus', () => {
  it.each([
    [DiditStatus.NotStarted, C.Pending],
    [DiditStatus.InProgress, C.Pending],
    [DiditStatus.InReview, C.Pending],
    [DiditStatus.Resubmitted, C.Pending],
    [DiditStatus.AwaitingUser, C.Pending],
    [DiditStatus.Approved, C.Approved],
    [DiditStatus.Declined, C.Declined],
    [DiditStatus.Abandoned, C.Abandoned],
    [DiditStatus.Expired, C.Expired],
    [DiditStatus.KycExpired, C.KycExpired],
  ])('%s → %s', (status, expected) => {
    expect(classifyDiditStatus(status)).toBe(expected);
  });

  it('covers every documented Didit status', () => {
    for (const status of Object.values(DiditStatus)) {
      expect(classifyDiditStatus(status)).not.toBe(C.Unknown);
    }
  });

  it.each([
    'approved',
    'APPROVED',
    'In review',
    'Kyc expired',
    ' Approved',
    '',
    'Some Future Status',
    'toString',
    '__proto__',
  ])('treats %j as unknown (exact, case-sensitive match only)', (status) => {
    expect(classifyDiditStatus(status)).toBe(C.Unknown);
  });
});
