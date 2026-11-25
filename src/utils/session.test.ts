import { describe, expect, mock, test } from 'bun:test';
import {
  abortSessionWithTimeout,
  OperationTimeoutError,
  parseModelReference,
  sessionAbortFailure,
  withTimeout,
} from './session';

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe('model reference parsing', () => {
  test.each([
    [
      'openrouter/openai/gpt-5.6-sol#high',
      {
        providerID: 'openrouter',
        modelID: 'openai/gpt-5.6-sol',
        variant: 'high',
      },
    ],
    [
      'openrouter/openai/gpt-5.6-sol',
      { providerID: 'openrouter', modelID: 'openai/gpt-5.6-sol' },
    ],
    ['gpt-5.6-sol#high', { modelID: 'gpt-5.6-sol', variant: 'high' }],
    ['gpt-5.6-sol', { modelID: 'gpt-5.6-sol' }],
    [
      'omniroute/opencode/bigpickle:free#max',
      {
        providerID: 'omniroute',
        modelID: 'opencode/bigpickle:free',
        variant: 'max',
      },
    ],
    [
      'opencode-omniroute-live/of/Qwen3.8 27b',
      {
        providerID: 'opencode-omniroute-live',
        modelID: 'of/Qwen3.8 27b',
      },
    ],
    [
      'openrouter/openai/gpt-5.6-sol:free#high',
      {
        providerID: 'openrouter',
        modelID: 'openai/gpt-5.6-sol:free',
        variant: 'high',
      },
    ],
    [
      'openrouter/openai/gpt-5.6-sol:free',
      {
        providerID: 'openrouter',
        modelID: 'openai/gpt-5.6-sol:free',
      },
    ],
    [
      'openai/gpt-5.6-sol:free#high',
      { providerID: 'openai', modelID: 'gpt-5.6-sol:free', variant: 'high' },
    ],
    ['gpt-5.6-sol#high', { modelID: 'gpt-5.6-sol', variant: 'high' }],
  ])('parses valid reference %p', (model, expected) => {
    const result = parseModelReference(model);

    expect(result).toEqual(expected);
  });

  test.each([
    '',
    ' ',
    ' openai/gpt-5.6-sol',
    'openai/ gpt-5.6-sol',
    'openai/gpt-5.6-sol ',
    '/gpt-5.6-sol',
    'openai/',
    'openai//gpt-5.6-sol',
    'openai/gpt-5.6-sol#',
    'openai/gpt-5.6-sol#high/extra',
    'open@ai/gpt-5.6-sol',
    'openai/gpt-5.6-sol#hi!',
    '$gpt-5.6-sol',
    'openai$',
    'openai$#high',
    'gpt-5.6-sol#',
    'openai$$gpt-5.6-sol',
    'openai$gpt-5.6-sol##high',
    'gpt-5.6-sol#high$openai',
    'openai$gpt-5.6-sol#high#extra',
    'open@ai$gpt-5.6-sol#high',
    'openai$gpt-5.6-sol#hi!',
    'openai$/gpt-5.6-sol#high',
    'openai$gpt-5.6-sol/#high',
    'openai$gpt-5.6-sol//nested#high',
  ])('rejects malformed reference %p', (model) => {
    const result = parseModelReference(model);

    expect(result).toBeNull();
  });
});

describe('session utilities', () => {
  test('withTimeout resolves without waiting for the timeout', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 50, 'too slow');

    expect(result).toBe('ok');
  });

  test('withTimeout rejects with OperationTimeoutError when operation hangs', async () => {
    await expect(withTimeout(never(), 5, 'too slow')).rejects.toThrow(
      OperationTimeoutError,
    );
  });

  test('abortSessionWithTimeout rejects if abort hangs', async () => {
    const client = {
      session: {
        abort: mock(() => never()),
      },
    } as any;

    await expect(abortSessionWithTimeout(client, 's1', 5)).rejects.toThrow(
      'Session abort timed out after 5ms',
    );
  });

  test('abortSessionWithTimeout rejects resolved error envelopes', async () => {
    const client = {
      session: {
        abort: mock(() => Promise.resolve({ error: 'session busy' })),
      },
    } as any;

    await expect(abortSessionWithTimeout(client, 's1')).rejects.toThrow(
      'session abort rejected: session busy',
    );
  });

  test('sessionAbortFailure reads both SDK envelopes', () => {
    expect(sessionAbortFailure({ error: 'boom' })).toBe(
      'session abort rejected: boom',
    );
    expect(sessionAbortFailure({ error: { message: 'nope' } })).toBe(
      'session abort rejected: {"message":"nope"}',
    );
    expect(sessionAbortFailure(false)).toBe('session abort returned false');
    expect(sessionAbortFailure(undefined)).toBeNull();
    expect(sessionAbortFailure({ data: { ok: true } })).toBeNull();
    expect(sessionAbortFailure(null)).toBeNull();
  });
});
