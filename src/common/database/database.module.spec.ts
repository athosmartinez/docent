import { DatabaseModule, KYSELY } from './database.module';

// Regression test for the unit-test Jest config: kysely ships ESM-only, so
// importing anything from this module (which imports kysely) used to fail
// with a bare "SyntaxError: Unexpected token 'export'" as soon as ts-jest
// handed kysely's source to Jest's CommonJS-only unit-test runner.
describe('DatabaseModule', () => {
  it('exposes KYSELY as a distinct symbol usable as a DI token', () => {
    expect(typeof KYSELY).toBe('symbol');
    expect(KYSELY.description).toBe('KYSELY');
  });

  it('is defined as a NestJS module class', () => {
    expect(DatabaseModule).toBeDefined();
    expect(DatabaseModule.name).toBe('DatabaseModule');
  });
});
