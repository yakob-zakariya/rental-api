import { BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsString, ValidateNested } from 'class-validator';
import { createValidationPipe } from './validation.js';

class Address {
  @IsString()
  city: string;
}

class Body {
  @IsString()
  name: string;

  @Type(() => Number)
  @IsInt()
  age: number;

  @ValidateNested()
  @Type(() => Address)
  address: Address;
}

const run = (value: unknown) =>
  createValidationPipe().transform(value, { type: 'body', metatype: Body });

const failureOf = async (value: unknown) => {
  try {
    await run(value);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse() as {
      code: string;
      errors: unknown[];
    };
  }
  throw new Error('expected validation to fail');
};

const valid = { name: 'Abebe', age: '30', address: { city: 'Addis Ababa' } };

describe('createValidationPipe', () => {
  it('accepts a valid body and transforms it into the DTO', async () => {
    const result = (await run(valid)) as Body;

    expect(result).toBeInstanceOf(Body);
    expect(result.age).toBe(30);
  });

  it('rejects unknown fields instead of dropping them', async () => {
    const response = await failureOf({ ...valid, isAdmin: true });

    expect(response.code).toBe('VALIDATION_FAILED');
    expect(response.errors).toEqual([
      { field: 'isAdmin', messages: ['property isAdmin should not exist'] },
    ]);
  });

  it('reports nested fields by dotted path', async () => {
    const response = await failureOf({ ...valid, address: { city: 42 } });

    expect(response.errors).toEqual([
      { field: 'address.city', messages: ['city must be a string'] },
    ]);
  });

  it('never echoes submitted values back', async () => {
    const response = await failureOf({
      ...valid,
      name: 12345678,
      secret: 'hunter2',
    });

    expect(JSON.stringify(response)).not.toContain('hunter2');
    expect(JSON.stringify(response)).not.toContain('12345678');
  });
});
