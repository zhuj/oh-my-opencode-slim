import { z } from 'zod';
import { parseModelReference } from '../utils/session';

/**
 * Shared provider-qualified reference boundary for configuration consumers.
 */
export const ProviderModelIdSchema = z
  .string()
  .refine(
    (value) => parseModelReference(value)?.providerID !== undefined,
    'Expected a provider-qualified model reference',
  )
  .describe(
    'Provider-qualified model reference: provider/model[#variant]. ' +
      'The first slash separates the provider; remaining slashes and all ' +
      'colons belong to the model ID. Only # separates the variant.',
  );
