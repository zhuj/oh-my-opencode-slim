import { describe, expect, test } from 'bun:test';
import { resolveNativeAdmissionModel } from './setup';
import type { V2Context } from './types';

describe('native admission model accounting', () => {
  const context = (
    session: Record<string, unknown>,
    agent: Record<string, unknown>,
  ) =>
    ({
      session: { get: async () => ({ data: session }) },
      agent: { list: async () => ({ data: [agent] }) },
    }) as Pick<V2Context, 'agent' | 'session'>;

  test('counts the finalized native agent model with its literal model ID', async () => {
    const ctx = context(
      { model: { providerID: 'openai', id: 'selected' } },
      {
        id: 'explorer',
        model: {
          providerID: 'proxy',
          id: 'team/model:latest',
          variant: 'high',
        },
      },
    );
    expect(
      await resolveNativeAdmissionModel(
        ctx,
        { agent: 'explorer' },
        'ses_parent',
      ),
    ).toBe('proxy/team/model:latest');
  });

  test('inherits the native parent selection when the agent has no pin', async () => {
    const ctx = context(
      { model: { providerID: 'ollama', id: 'qwen:latest' } },
      { id: 'explorer' },
    );
    expect(
      await resolveNativeAdmissionModel(
        ctx,
        { agent: 'explorer' },
        'ses_parent',
      ),
    ).toBe('ollama/qwen:latest');
  });

  test('uses the resolved parent prompt model when Session.Info has no pin', async () => {
    const ctx = context({}, { id: 'explorer' });
    expect(
      await resolveNativeAdmissionModel(
        ctx,
        { agent: 'explorer' },
        'ses_parent',
        { providerID: 'openai', id: 'selected' },
      ),
    ).toBe('openai/selected');
  });

  test('an unchanged native continuation retains the child selection', async () => {
    const ctx = context(
      {
        agent: 'explorer',
        model: { providerID: 'openai', id: 'manual-child' },
      },
      { id: 'explorer', model: { providerID: 'openai', id: 'configured' } },
    );
    expect(
      await resolveNativeAdmissionModel(
        ctx,
        { agent: 'explorer', sessionID: 'ses_child' },
        'ses_parent',
      ),
    ).toBe('openai/manual-child');
  });

  test('a native agent switch uses its new model, or retains the child model without one', async () => {
    const session = {
      agent: 'fixer',
      model: { providerID: 'openai', id: 'manual-child' },
    };
    const input = { agent: 'explorer', sessionID: 'ses_child' };
    expect(
      await resolveNativeAdmissionModel(
        context(session, {
          id: 'explorer',
          model: { providerID: 'openai', id: 'configured' },
        }),
        input,
        'ses_parent',
      ),
    ).toBe('openai/configured');
    expect(
      await resolveNativeAdmissionModel(
        context(session, { id: 'explorer' }),
        input,
        'ses_parent',
      ),
    ).toBe('openai/manual-child');
  });

  test('does not invent a model when the native selection is unavailable', async () => {
    expect(
      await resolveNativeAdmissionModel(
        context({}, {}),
        { agent: 'unknown' },
        'ses_parent',
      ),
    ).toBeUndefined();
  });
});
