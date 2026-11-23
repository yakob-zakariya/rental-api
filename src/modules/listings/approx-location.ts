import { randomInt } from 'node:crypto';

/** How far the public point is from the real one (spec G2). */
export const APPROX_MIN_METRES = 200;
export const APPROX_MAX_METRES = 400;

// randomInt(min, max) allows max - min of at most 2^48 - 1.
const RANDOM_RANGE = 2 ** 48 - 1;

/** A number in [0, 1) from the OS's secure random source, so the offset can't be predicted. */
export const secureRandom = (): number =>
  randomInt(0, RANDOM_RANGE) / RANDOM_RANGE;

/**
 * Where to move the exact point to: 200–400 m in any direction. The move itself is done by
 * PostGIS (ST_Project, on the WGS 84 ellipsoid, the same model ST_Distance measures with). Made
 * once, when the exact point is set or moved, and stored (G2): never per request, or repeated
 * requests could be averaged back to the real point.
 */
export function randomOffset(random: () => number = secureRandom): {
  distanceMetres: number;
  azimuthRadians: number;
} {
  return {
    distanceMetres:
      APPROX_MIN_METRES + random() * (APPROX_MAX_METRES - APPROX_MIN_METRES),
    azimuthRadians: random() * 2 * Math.PI,
  };
}
