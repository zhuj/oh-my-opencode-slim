import { parseModelReference } from '../utils/session';
import { stripKnownVariant } from './find-model-normalization';

interface ModelQuery {
  readonly providerID: string | undefined;
  readonly modelID: string;
  readonly baseModelID: string;
}

/** Discovery parsing is deliberately separate from executable routing parsing. */
export function parseModelQuery(input: string): ModelQuery | null {
  if (input.includes('$')) return null;
  const slash = input.indexOf('/');
  const providerID = slash < 0 ? undefined : input.slice(0, slash).trim();
  const modelID = (slash < 0 ? input : input.slice(slash + 1)).trim();
  const parsed = parseModelReference(
    providerID === undefined ? modelID : `${providerID}/${modelID}`,
  );
  if (!parsed) return null;
  return {
    providerID: parsed.providerID,
    modelID: parsed.modelID,
    // Qualified references are executable identities, not legacy suffix hints.
    baseModelID:
      parsed.providerID !== undefined || parsed.variant !== undefined
        ? parsed.modelID
        : stripKnownVariant(parsed.modelID),
  };
}

/** Only the bare-name aliases used by the sibling override resolver apply here. */
export function resolveBareModelAlias(modelID: string): string {
  if (/^gemini-3-pro-(high|low)$/.test(modelID)) {
    return 'gemini-3-pro-preview';
  }
  if (/^gemini-3\.1-pro-(high|low)$/.test(modelID)) {
    return 'gemini-3.1-pro';
  }
  return modelID === 'claude-opus-4-7-thinking' ? 'claude-opus-4-7' : modelID;
}
