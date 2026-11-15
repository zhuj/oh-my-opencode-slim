import { describe, expect, it } from 'bun:test';
import { firstModelId, isDynamicModelRef } from './model-sentinel';
import { AgentOverrideConfigSchema } from './schema';

describe('isDynamicModelRef', () => {
  it('true for { dynamic: "selected" }', () => {
    expect(isDynamicModelRef({ dynamic: 'selected' })).toBe(true);
  });
  it('false for a real provider/model string', () => {
    expect(isDynamicModelRef('openai/gpt-5.6-luna')).toBe(false);
  });
  it('false for a ModelEntry object', () => {
    expect(isDynamicModelRef({ id: 'openai/gpt-5.6-luna' })).toBe(false);
  });
  it('false for an array', () => {
    expect(isDynamicModelRef([{ id: 'openai/gpt-5.6-luna' }])).toBe(false);
  });
  it('false for undefined and null', () => {
    expect(isDynamicModelRef(undefined)).toBe(false);
    expect(isDynamicModelRef(null)).toBe(false);
  });
});

describe('firstModelId', () => {
  it('leaves inheritance and empty arrays unset', () => {
    expect(firstModelId(undefined)).toBeUndefined();
    expect(firstModelId({ dynamic: 'selected' })).toBeUndefined();
    expect(firstModelId([])).toBeUndefined();
  });
  it('preserves concrete strings and the first array entry', () => {
    expect(firstModelId('openai/gpt-5.6-luna')).toBe('openai/gpt-5.6-luna');
    expect(firstModelId(['provider/first', 'provider/fallback'])).toBe(
      'provider/first',
    );
    expect(
      firstModelId([
        { id: 'provider/first', variant: 'high' },
        'provider/fallback',
      ]),
    ).toBe('provider/first');
  });
});

describe('schema accepts the dynamic ref', () => {
  it('parses model: { dynamic: "selected" }', () => {
    expect(
      AgentOverrideConfigSchema.safeParse({ model: { dynamic: 'selected' } })
        .success,
    ).toBe(true);
  });
  it('rejects a dynamic object with an unknown value', () => {
    expect(
      AgentOverrideConfigSchema.safeParse({ model: { dynamic: 'other' } })
        .success,
    ).toBe(false);
  });
});
