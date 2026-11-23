import {
  buildMessage,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';
import { isIsoDate } from './dates.js';

/** How Postgres counts the characters of text and varchar(n): by code point, so an emoji is 1. */
// Code points are wanted here (to match Postgres), not the user-perceived characters the rule
// suggests counting with Intl.Segmenter.
// oxlint-disable-next-line typescript/no-misused-spread
export const charCount = (value: string): number => [...value].length;

/**
 * Like class-validator's @Length, but counts characters as Postgres does. @Length uses
 * String.length, which counts an emoji as 2, so the API and the database could disagree.
 */
export function CharLength(
  min: number,
  max: number,
  options?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'charLength',
      constraints: [min, max],
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' &&
          charCount(value) >= min &&
          charCount(value) <= max,
        defaultMessage: buildMessage(
          (each) =>
            `${each}$property must be between $constraint1 and $constraint2 characters`,
          options,
        ),
      },
    },
    options,
  );
}

/** A real calendar date written as YYYY-MM-DD (rejects 2027-02-30). */
export function IsCalendarDate(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isCalendarDate',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && isIsoDate(value),
        defaultMessage: buildMessage(
          (each) => `${each}$property must be a date as YYYY-MM-DD`,
          options,
        ),
      },
    },
    options,
  );
}
