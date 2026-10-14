import { describe, expect, it } from 'bun:test';
import { isDynamicModelRef, resolveModelOverride } from './model-sentinel';
import type { ModelEntry } from './schema';
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

describe('resolveModelOverride', () => {
  it('inherit when undefined', () => {
    expect(resolveModelOverride(undefined)).toEqual({ type: 'inherit' });
  });
  it('inherit for dynamic ref', () => {
    expect(resolveModelOverride({ dynamic: 'selected' })).toEqual({
      type: 'inherit',
    });
  });
  it('concrete for a real string', () => {
    expect(resolveModelOverride('openai/gpt-5.6-luna')).toEqual({
      type: 'concrete',
      value: 'openai/gpt-5.6-luna',
    });
  });
  it('concrete for a real array', () => {
    const arr: ModelEntry[] = [{ id: 'openai/gpt-5.6-luna' }];
    expect(resolveModelOverride(arr)).toEqual({ type: 'concrete', value: arr });
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
