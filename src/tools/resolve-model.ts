import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { MODEL_MAPPINGS } from '../cli/providers';
import { isRecord } from '../utils/guards';
import { findModelMatches } from './find-model-search';

export {
  type FindModelMatch,
  findModelMatches,
} from './find-model-search';

const z = tool.schema;

const runtimeID = z.string().min(1);
const connectedProvidersSchema = z.object({
  connected: z.array(runtimeID),
});
const providerCatalogSchema = z.object({
  all: z.array(
    z.object({
      id: runtimeID,
      models: z.record(runtimeID, z.unknown()),
    }),
  ),
  connected: z.array(runtimeID).optional(),
});
const modelListSchema = z.array(
  z.union([
    z.object({ providerID: runtimeID, id: runtimeID }),
    z.object({ provider: runtimeID, id: runtimeID }),
  ]),
);

/** Probe optional SDK surfaces without depending on a particular SDK version. */
async function readRuntimeList(
  client: unknown,
  source: 'provider' | 'model',
): Promise<unknown> {
  try {
    const service = isRecord(client) ? client[source] : undefined;
    if (!isRecord(service) || typeof service.list !== 'function') {
      return undefined;
    }
    const response: unknown = await service.list();
    return isRecord(response) && 'data' in response ? response.data : response;
  } catch {
    // Discovery is optional: SDK rejections, including non-Errors, mean unavailable.
    return undefined;
  }
}

/**
 * Enumerates runtime identities verbatim, using presets only when discovery
 * is unavailable. A successful empty catalog is authoritative.
 */
export async function getAvailableModels(ctx: PluginInput): Promise<string[]> {
  const providerData = await readRuntimeList(ctx.client, 'provider');
  const connectionInfo = connectedProvidersSchema.safeParse(providerData);
  const connected = connectionInfo.success
    ? new Set(connectionInfo.data.connected)
    : undefined;
  if (connected?.size === 0) return [];

  const catalog = providerCatalogSchema.safeParse(providerData);
  if (catalog.success) {
    const refs = new Set<string>();
    for (const provider of catalog.data.all) {
      if (connected && !connected.has(provider.id)) continue;
      // Catalog keys are executable IDs; metadata IDs may be upstream aliases.
      for (const modelID of Object.keys(provider.models)) {
        refs.add(`${provider.id}/${modelID}`);
      }
    }
    return [...refs];
  }

  const models = modelListSchema.safeParse(
    await readRuntimeList(ctx.client, 'model'),
  );
  if (models.success) {
    return [
      ...new Set(
        models.data
          .filter((model) => {
            const providerID =
              'providerID' in model ? model.providerID : model.provider;
            return !connected || connected.has(providerID);
          })
          .map((model) => {
            const providerID =
              'providerID' in model ? model.providerID : model.provider;
            return `${providerID}/${model.id}`;
          }),
      ),
    ];
  }

  const refs = new Set<string>();
  for (const mapping of Object.values(MODEL_MAPPINGS)) {
    for (const agent of Object.values(mapping)) {
      refs.add(agent.model);
    }
  }
  return [...refs];
}

/**
 * Creates the `resolve_model` tool for provider/model discovery.
 *
 * Returns exact references for the native subagent model parameter or presets.
 * Unmatched queries return an empty list.
 */
export function createResolveModelTool(
  ctx: PluginInput,
): Record<string, ToolDefinition> {
  const resolve_model = tool({
    description: `Resolve a free-text query to valid model references available in this OpenCode setup.

Each match emits a canonical ref (provider/model), preserving nested slashes and colons in the model ID. Append #variant for an override. Returns at most 20 matches. When the native model catalog is unavailable, results come from bundled presets.`,
    args: {
      query: z
        .string()
        .describe(
          'Free-text model query or executable reference (provider/model[#variant]). Only # separates an executable variant; colons belong to the model ID. Variants are ignored for ranking and do not assert availability.',
        ),
    },
    async execute(args) {
      const candidates = await getAvailableModels(ctx);
      const result = {
        matches: findModelMatches(candidates, String(args.query ?? '')),
      };
      return JSON.stringify(result);
    },
  });

  return { resolve_model };
}
