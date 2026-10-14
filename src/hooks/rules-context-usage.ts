type ModelIdentity = { readonly providerID: string; readonly modelID: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function parseModelIdentity(
  info: Record<string, unknown>,
): ModelIdentity | undefined {
  if (typeof info.providerID === 'string' && typeof info.modelID === 'string') {
    return { providerID: info.providerID, modelID: info.modelID };
  }
  const nested = info.model;
  if (isRecord(nested)) {
    if (
      typeof nested.providerID === 'string' &&
      typeof nested.modelID === 'string'
    ) {
      return {
        providerID: nested.providerID,
        modelID: nested.modelID,
      };
    }
  }
  return undefined;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object'
    ? (value as RecordValue)
    : undefined;
}

function absoluteStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.startsWith('/'),
      ),
    ),
  ];
}

/** Read only V1 assistant input usage and its matching provider model limit.
 * Confirmed against installed @opencode-ai/sdk 1.18.32 (types.gen.d.ts):
 * AssistantMessage carries providerID/modelID top-level, not nested under `model`;
 * the code supports both shapes for fail-closed compatibility. */
export function createV1RemainingContextTokensReader(
  readMessages: (sessionID: string) => Promise<unknown>,
  readProviderCatalog: () => Promise<unknown>,
): (sessionID: string) => Promise<number | null> {
  return async (sessionID) => {
    try {
      const [messagesValue, catalogValue] = await Promise.all([
        readMessages(sessionID),
        readProviderCatalog(),
      ]);
      const messages = record(messagesValue);
      const rows = messages?.data;
      if (!Array.isArray(rows)) return null;
      const assistant = [...rows]
        .reverse()
        .map((row) => record(record(row)?.info))
        .find(
          (info) =>
            info?.role === 'assistant' &&
            typeof record(info.tokens)?.input === 'number' &&
            Number.isFinite(record(info.tokens)?.input) &&
            ((typeof info?.providerID === 'string' &&
              typeof info?.modelID === 'string') ||
              (typeof record(info.model)?.providerID === 'string' &&
                typeof record(info.model)?.modelID === 'string')),
        );
      if (!assistant) return null;
      const identity = parseModelIdentity(assistant);
      if (!identity) return null;
      const providerID = identity.providerID;
      const modelID = identity.modelID;
      const catalog = record(record(catalogValue)?.data);
      const providers = catalog?.all;
      if (!Array.isArray(providers)) return null;
      const provider = providers
        .map(record)
        .find((item) => item?.id === providerID);
      const model = record(record(provider?.models)?.[modelID]);
      const limit = record(model?.limit)?.context;
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0)
        return null;
      const inputTokens = record(assistant.tokens)?.input;
      if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens))
        return null;
      return Math.max(0, limit - inputTokens);
    } catch {
      return null;
    }
  };
}

/** Adapt structured resolved host results; tool args and titles are not evidence. */
export function resolveV1TouchedFilePaths(
  input: unknown,
  output: unknown,
): readonly string[] {
  const result = record(output);
  if (Array.isArray(result?.resolvedFilePaths)) {
    return absoluteStrings(result.resolvedFilePaths);
  }
  const metadata = record(result?.metadata);
  const tool = record(input)?.tool;
  let paths: unknown[] = [];
  if (tool === 'read') {
    const display = record(metadata?.display);
    if (display?.type === 'file') paths = [display.path];
  } else if (tool === 'write') paths = [metadata?.filepath];
  else if (tool === 'edit') paths = [record(metadata?.filediff)?.file];
  else if (tool === 'apply_patch' && Array.isArray(metadata?.files)) {
    paths = metadata.files.flatMap((entry) => {
      const file = record(entry);
      return [file?.filePath, file?.movePath];
    });
  }
  return absoluteStrings(paths);
}
