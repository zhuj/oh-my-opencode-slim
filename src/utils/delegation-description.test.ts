import { expect, test } from 'bun:test';
import { Schema } from 'effect';
import * as HostSchema from '../../node_modules/effect/src/Schema.ts';
import {
  delegationDefinitionHook,
  rewriteDelegationDescription,
  rewriteDelegationSchema,
} from './delegation-description';

test('rewrites native Effect schemas while retaining validation', () => {
  const description =
    'NEVER set this unless the user explicitly asks for a particular model or variant.';
  const original = Schema.Struct({
    prompt: Schema.String,
    model: Schema.optionalKey(Schema.String).annotate({ description }),
  }).check(Schema.makeFilter((value) => value.prompt.length > 0));

  const rewritten = rewriteDelegationSchema(original);

  expect(rewritten).not.toBe(original);
  expect(Schema.isSchema(rewritten)).toBe(true);
  if (!Schema.isSchema(rewritten)) throw new Error('Expected an Effect schema');
  expect(Schema.toJsonSchemaDocument(rewritten).schema).not.toEqual(
    Schema.toJsonSchemaDocument(original).schema,
  );
  expect(Schema.toJsonSchemaDocument(rewritten).schema).toMatchObject({
    properties: {
      model: { description: rewriteDelegationDescription(description) },
    },
  });
  expect(rewriteDelegationSchema(rewritten)).toBe(rewritten);
  const decode = Schema.decodeUnknownSync(rewritten);
  expect(decode({ prompt: 'work' })).toEqual({ prompt: 'work' });
  expect(decode({ prompt: 'work', model: 'provider/model#high' })).toEqual({
    prompt: 'work',
    model: 'provider/model#high',
  });
  expect(() => decode({ prompt: '' })).toThrow();
  expect(() => decode({ prompt: 'work', model: 42 })).toThrow();
  expect(() => decode({ model: 'provider/model' })).toThrow();
  expect(original.fields.model.ast.annotations?.description).toBe(description);
});

test('V2 rewrite preserves host fields across independent Effect copies', () => {
  // Source and dist load independent parser sentinels, like host and bundle.
  expect(HostSchema.String.ast).not.toBe(Schema.String.ast);
  const description =
    'NEVER set this unless the user explicitly asks for a particular model or variant.';
  const original = HostSchema.Struct({
    prompt: HostSchema.String,
    model: HostSchema.optionalKey(HostSchema.String).annotate({ description }),
    sessionID: HostSchema.optionalKey(
      HostSchema.String.check(
        HostSchema.makeFilter((value) => value.startsWith('ses_')),
      ),
    ),
  }).check(HostSchema.makeFilter((value) => value.prompt.length > 0));
  const rewritten = rewriteDelegationSchema(original, {
    loosenSessionID: true,
  });
  if (!HostSchema.isSchema(rewritten))
    throw new Error('Expected a host Effect schema');
  expect(rewritten).not.toBe(original);
  const decode = (input: unknown) =>
    HostSchema.decodeUnknownSync(rewritten)(input, { errors: 'all' });

  expect(decode({ prompt: 'work' })).toEqual({ prompt: 'work' });
  expect(decode({ prompt: 'work', sessionID: 'ses_existing' })).toEqual({
    prompt: 'work',
    sessionID: 'ses_existing',
  });
  expect(() => decode({ prompt: 'work', sessionID: 42 })).toThrow();
  expect(() => decode({ prompt: 'work', sessionID: false })).toThrow();
  expect(() => decode({ prompt: 'work', sessionID: 'invalid' })).toThrow();
  expect(() => decode({ prompt: '', sessionID: 'ses_existing' })).toThrow();
  expect(() => decode({ prompt: 'work', sessionID: undefined })).toThrow();
  expect(() => decode({ prompt: 'work', sessionID: null })).toThrow();
  expect(decode({ prompt: 'work', model: 'provider/model' })).toEqual({
    prompt: 'work',
    model: 'provider/model',
  });
  expect(HostSchema.toJsonSchemaDocument(rewritten).schema).toMatchObject({
    required: ['prompt'],
    properties: {
      model: {
        description: rewriteDelegationDescription(description),
      },
    },
  });
});

test.each(['task', 'subagent'])(
  '%s replaces schema immutably while preserving constraints',
  async (toolID) => {
    const model = Object.freeze({
      type: 'string',
      description:
        'NEVER set this unless the user explicitly asks for a particular model or variant.',
    });
    const parameters = Object.freeze({
      type: 'object',
      required: ['prompt'],
      properties: Object.freeze({
        model,
        prompt: { type: 'string' },
        sessionID: { type: 'string', pattern: '^ses_' },
      }),
    });
    const output = { description: 'Delegate work', parameters };
    await delegationDefinitionHook({ toolID }, output);
    expect(output.parameters).not.toBe(parameters);
    expect(output.parameters.properties.model).not.toBe(model);
    expect(output.parameters.properties.model.description).not.toBe(
      model.description,
    );
    expect(output.parameters.properties.model.type).toBe(model.type);
    expect(output.parameters.required).toEqual(['prompt']);
    expect(output.parameters.properties.prompt).toBe(
      parameters.properties.prompt,
    );
    expect(output.parameters.properties.sessionID).toEqual(
      parameters.properties.sessionID,
    );
    const first = structuredClone(output);
    await delegationDefinitionHook({ toolID }, output);
    expect(output).toEqual(first);
  },
);

test('V2 schema rewrite makes sessionID optional without its pattern', () => {
  const schema = {
    type: 'object',
    required: ['sessionID', 'prompt'],
    properties: {
      sessionID: {
        type: 'string',
        pattern: '^ses_[A-Za-z0-9_-]+$',
      },
      prompt: { type: 'string' },
    },
  };

  const rewritten = rewriteDelegationSchema(schema, { loosenSessionID: true });

  expect(rewritten).toMatchObject({
    required: ['prompt'],
    properties: {
      sessionID: {
        type: ['string', 'null'],
        description:
          'Session ID to resume (typically starts with ses_), omit to start a new session.',
      },
      prompt: { type: 'string' },
    },
  });
  expect((rewritten as typeof schema).properties.sessionID).not.toHaveProperty(
    'pattern',
  );
});

test('leaves unrelated tools and missing model schemas intact', async () => {
  const parameters = { type: 'object', properties: {} };
  const output = { description: 'Other tool', parameters };
  await delegationDefinitionHook({ toolID: 'read' }, output);
  expect(output.parameters).toBe(parameters);
  await delegationDefinitionHook({ toolID: 'task' }, output);
  expect(output.parameters).toBe(parameters);
});
