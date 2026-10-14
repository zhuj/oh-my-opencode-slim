import { describe, expect, it } from 'bun:test';
import { resolveRuntimePresetModel } from './runtime-preset-model';

describe('resolveRuntimePresetModel', () => {
  it('returns undefined for the dynamic ref (inherit)', () => {
    expect(resolveRuntimePresetModel({ dynamic: 'selected' })).toBeUndefined();
  });
  it('returns undefined for undefined input', () => {
    expect(resolveRuntimePresetModel(undefined)).toBeUndefined();
  });
  it('returns the concrete model string', () => {
    expect(resolveRuntimePresetModel('openai/gpt-5.6-luna')).toBe(
      'openai/gpt-5.6-luna',
    );
  });
  it('returns the primary id of an array-form model', () => {
    expect(
      resolveRuntimePresetModel([
        { id: 'openai/gpt-5.6-luna' },
        { id: 'fallback' },
      ]),
    ).toBe('openai/gpt-5.6-luna');
  });
});
