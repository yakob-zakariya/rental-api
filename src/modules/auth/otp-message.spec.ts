import { otpSmsText } from './otp-message.js';

describe('otpSmsText', () => {
  it('uses the agreed wording for the default 5-minute TTL', () => {
    expect(otpSmsText('123456', 300)).toBe(
      'Your rental code is 123456. Valid for 5 minutes. Never share this code with anyone.',
    );
  });

  it.each([
    [60, '1 minute'],
    [600, '10 minutes'],
    [90, '90 seconds'],
    [1, '1 second'],
  ])('describes %i seconds as "%s"', (ttl, duration) => {
    expect(otpSmsText('000042', ttl)).toContain(`Valid for ${duration}.`);
  });

  it('fits in a single 160-character SMS', () => {
    expect(otpSmsText('123456', 300).length).toBeLessThanOrEqual(160);
  });
});
