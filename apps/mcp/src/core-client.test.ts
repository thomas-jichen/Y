import { describe, expect, it } from 'vitest';
import { assertCoreEnv, missingCoreEnv } from './core-client.js';

describe('core env startup check', () => {
  it('names each missing or blank variable', () => {
    expect(missingCoreEnv({})).toEqual(['Y_CORE_URL', 'Y_INTERNAL_SECRET']);
    expect(missingCoreEnv({ Y_CORE_URL: 'http://core', Y_INTERNAL_SECRET: '  ' })).toEqual(['Y_INTERNAL_SECRET']);
    expect(missingCoreEnv({ Y_CORE_URL: 'http://core', Y_INTERNAL_SECRET: 's' })).toEqual([]);
  });

  it('throws at startup instead of failing every tool call later', () => {
    expect(() => assertCoreEnv({ Y_INTERNAL_SECRET: 's' })).toThrow(/Y_CORE_URL must be set/);
    expect(() => assertCoreEnv({ Y_CORE_URL: 'http://core', Y_INTERNAL_SECRET: 's' })).not.toThrow();
  });
});
