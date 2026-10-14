import { z } from 'zod';
import {
  type CouncillorModelEntry,
  normalizeCouncillorModels,
} from '../utils/councillor-models';
import { ProviderModelIdSchema } from './model-id-schema';

export type { CouncillorModelEntry };

const ModelIdSchema = ProviderModelIdSchema;
const CouncillorModelEntrySchema = z.object({
  id: ModelIdSchema,
  variant: z.string().optional(),
});

/**
 * A councillor's model: either one provider-qualified reference,
 * or an ordered fallback chain of strings and/or
 * { id, variant } entries tried until one responds.
 */
const CouncillorModelSchema = z
  .union([
    ModelIdSchema,
    z.array(z.union([ModelIdSchema, CouncillorModelEntrySchema])).min(1),
  ])
  .describe(
    `${ProviderModelIdSchema.description} May be an ordered fallback chain ` +
      '(an array of model references or { id, variant } entries) tried in ' +
      'order until one responds.',
  );

/**
 * Configuration for a single councillor within a preset.
 * Each councillor is an independent LLM that processes the same prompt.
 *
 * Councillors run as agent sessions with read-only codebase access
 * (read, glob, grep, lsp, list). They can examine the codebase but
 * cannot modify files or spawn subagents.
 *
 * `model` accepts a single ID or an ordered fallback chain. The parsed config
 * exposes `models` (the normalized chain) plus `model` (the primary, for
 * backward compatibility).
 */
export const CouncillorConfigSchema = z
  .object({
    model: CouncillorModelSchema,
    variant: z.string().optional(),
    prompt: z
      .string()
      .optional()
      .describe(
        'Optional role/guidance appended to the councillor system prompt',
      ),
  })
  .transform((c) => {
    const models = normalizeCouncillorModels(c.model, c.variant);
    return {
      model: models[0].id,
      variant: c.variant,
      prompt: c.prompt,
      models,
    };
  });

export type CouncillorConfig = z.infer<typeof CouncillorConfigSchema>;

/**
 * A named preset grouping several councillors.
 *
 * All keys are treated as councillor names mapping to councillor configs.
 * The legacy `master` key is rejected at the key level, so the restriction
 * is visible in the published JSON schema (propertyNames.pattern) too.
 */
export const CouncilPresetSchema = z
  .record(
    z
      .string()
      .regex(/^(?!master$)/)
      .describe('Councillor name; the legacy "master" key was removed'),
    z.record(z.string(), z.unknown()),
    {
      error: (iss) =>
        iss.code === 'invalid_key'
          ? 'the legacy "master" preset key was removed'
          : undefined,
    },
  )
  .transform((entries, ctx) => {
    const councillors: Record<string, CouncillorConfig> = {};

    for (const [key, raw] of Object.entries(entries)) {
      const parsed = CouncillorConfigSchema.safeParse(raw);
      if (!parsed.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid councillor "${key}": ${parsed.error.issues
            .map((i) => i.message)
            .join(', ')}`,
        });
        return z.NEVER;
      }
      councillors[key] = parsed.data;
    }

    return councillors;
  });

/**
 * Top-level council configuration.
 *
 * Example JSONC:
 * ```jsonc
 * {
 *   "council": {
 *     "presets": {
 *       "default": {
 *         "alpha": { "model": "openai/gpt-6-luna" },
 *         "beta":  { "model": "openai/gpt-5.3-codex" },
 *         "gamma": { "model": "google/gemini-3-pro" }
 *       }
 *     }
 *   }
 * }
 * ```
 */
export const CouncilConfigSchema = z
  .object({
    presets: z.record(z.string(), CouncilPresetSchema),
    default_preset: z.string().default('default'),
    master: z.never({ error: 'council.master was removed' }).optional(),
    master_timeout: z
      .never({ error: 'council.master_timeout was removed' })
      .optional(),
    master_fallback: z
      .never({ error: 'council.master_fallback was removed' })
      .optional(),
  })
  .passthrough()
  .transform((data) => ({
    presets: data.presets,
    default_preset: data.default_preset,
  }));

export type CouncilConfig = z.infer<typeof CouncilConfigSchema>;
