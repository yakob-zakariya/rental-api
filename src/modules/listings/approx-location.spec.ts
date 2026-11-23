import {
  APPROX_MAX_METRES,
  APPROX_MIN_METRES,
  randomOffset,
  secureRandom,
} from './approx-location.js';

describe('randomOffset (G2: 200–400 m in any direction)', () => {
  it('covers the whole range: 0 gives 200 m due north, just under 1 gives just under 400 m', () => {
    expect(randomOffset(() => 0)).toEqual({
      distanceMetres: APPROX_MIN_METRES,
      azimuthRadians: 0,
    });
    const top = randomOffset(() => 0.999999);
    expect(top.distanceMetres).toBeCloseTo(APPROX_MAX_METRES, 2);
    expect(top.azimuthRadians).toBeCloseTo(2 * Math.PI, 4);
  });

  it('with the real random source, always stays within 200–400 m and one full turn', () => {
    for (let i = 0; i < 10_000; i++) {
      const { distanceMetres, azimuthRadians } = randomOffset();
      expect(distanceMetres).toBeGreaterThanOrEqual(APPROX_MIN_METRES);
      expect(distanceMetres).toBeLessThan(APPROX_MAX_METRES);
      expect(azimuthRadians).toBeGreaterThanOrEqual(0);
      expect(azimuthRadians).toBeLessThan(2 * Math.PI);
    }
  });

  it('secureRandom gives [0, 1) and is not stuck on one value', () => {
    const values = Array.from({ length: 1000 }, secureRandom);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    expect(new Set(values).size).toBeGreaterThan(990);
  });
});
