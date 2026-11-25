import { isRecord } from './guards';

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'function' || isRecord(value);
}

function rewriteDelegationModel(model: unknown): unknown {
  const annotations =
    isSchemaObject(model) && isRecord(model.ast)
      ? model.ast.annotations
      : undefined;
  if (
    isSchemaObject(model) &&
    typeof model.annotate === 'function' &&
    isRecord(annotations) &&
    typeof annotations.description === 'string'
  ) {
    const description = rewriteDelegationDescription(annotations.description);
    return description === annotations.description
      ? model
      : model.annotate({ description });
  }
  if (!isRecord(model) || typeof model.description !== 'string') return model;
  const description = rewriteDelegationDescription(model.description);
  return description === model.description ? model : { ...model, description };
}

function rewriteEffectSchema(schema: Record<string, unknown>): unknown {
  if (!isRecord(schema.fields) || typeof schema.mapFields !== 'function') {
    return schema;
  }
  const fields: Record<string, unknown> = {};
  let changed = false;
  const model = schema.fields.model;
  const rewrittenModel = rewriteDelegationModel(model);
  if (rewrittenModel !== model) {
    fields.model = rewrittenModel;
    changed = true;
  }

  if (!changed) return schema;

  // Use host methods and host fields: separate Effect copies have distinct
  // parser sentinels, so inserting a plugin-created AST breaks host decoding.
  const updated: unknown = schema.mapFields(
    (schemaFields: Record<string, unknown>) => ({ ...schemaFields, ...fields }),
    { unsafePreserveChecks: true },
  );
  if (
    isSchemaObject(updated) &&
    typeof updated.annotate === 'function' &&
    isRecord(schema.ast) &&
    isRecord(schema.ast.annotations)
  ) {
    return updated.annotate(schema.ast.annotations);
  }
  return updated;
}

export function rewriteDelegationDescription(text: string): string {
  return text.replace(
    /(?:NEVER set this unless|Only set it when) the user explicitly asks for (?:a particular|a specific) model or variant[.;]/g,
    'Set this when the user or delegation instructions select a model or variant;',
  );
}

export function rewriteDelegationSchema(
  schema: unknown,
  options: { loosenSessionID?: boolean } = {},
): unknown {
  if (isSchemaObject(schema) && typeof schema.mapFields === 'function') {
    return rewriteEffectSchema(schema);
  }
  if (!isRecord(schema) || !isRecord(schema.properties)) return schema;
  const model = schema.properties.model;
  const rewrittenModel = rewriteDelegationModel(model);
  const modelChanged = rewrittenModel !== model;
  if (!options.loosenSessionID && !modelChanged) return schema;

  const properties = { ...schema.properties };
  if (modelChanged) properties.model = rewrittenModel;
  let required = schema.required;
  if (options.loosenSessionID) {
    const { pattern: _pattern, ...sessionID } = isRecord(
      schema.properties.sessionID,
    )
      ? schema.properties.sessionID
      : {};
    properties.sessionID = {
      ...sessionID,
      type: ['string', 'null'],
      description:
        'Session ID to resume (typically starts with ses_), omit to start a new session.',
    };
    required = Array.isArray(required)
      ? required.filter((key) => key !== 'sessionID')
      : required;
  }
  const result = {
    ...(schema as Record<string, unknown>),
    properties,
  } as Record<string, unknown>;
  if (options.loosenSessionID && Array.isArray(required)) {
    result.required = required;
  }
  return result;
}

export async function delegationDefinitionHook(
  input: { toolID: string },
  output: { description: string; parameters: unknown },
): Promise<void> {
  if (input.toolID !== 'task' && input.toolID !== 'subagent') return;
  output.description = rewriteDelegationDescription(output.description);
  output.parameters = rewriteDelegationSchema(output.parameters);
}
