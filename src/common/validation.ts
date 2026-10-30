import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

export interface FieldError {
  /** Dotted path to the field, e.g. `address.city` or `items.0.name`. */
  field: string;
  messages: string[];
}

/**
 * The global pipe for request bodies, params and queries. Unknown fields are rejected, not
 * silently dropped. Failures return `{ code: 'VALIDATION_FAILED', errors }`; submitted values are
 * never echoed back.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new BadRequestException({
        code: 'VALIDATION_FAILED',
        errors: flatten(errors),
      }),
  });
}

function flatten(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own: FieldError[] = error.constraints
      ? [{ field, messages: Object.values(error.constraints) }]
      : [];
    return [...own, ...flatten(error.children ?? [], field)];
  });
}
