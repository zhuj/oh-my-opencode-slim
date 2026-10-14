/**
 * Shared session utilities for council and background managers.
 */

import type { OpencodeClient } from '@opencode-ai/sdk';

export const SESSION_ABORT_TIMEOUT_MS = 1_000;

export const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9_-]+$/;

export class OperationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationTimeoutError';
  }
}

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  if (timeoutMs <= 0) return operation;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new OperationTimeoutError(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function abortSessionWithTimeout(
  client: OpencodeClient,
  sessionId: string,
  timeoutMs = SESSION_ABORT_TIMEOUT_MS,
): Promise<void> {
  const result = await withTimeout(
    client.session.abort({ path: { id: sessionId } }),
    timeoutMs,
    `Session abort timed out after ${timeoutMs}ms`,
  );
  const failure = sessionAbortFailure(result);
  if (failure) throw new Error(failure);
}

/**
 * Error message when an SDK abort result reports a rejected request
 * (error envelope or explicit false), or null when the abort was
 * accepted. Both SDK generations resolve rather than throw on HTTP
 * errors, so the envelope must be inspected before counting an abort
 * as done.
 */
export function sessionAbortFailure(result: unknown): string | null {
  if (result === false) return 'session abort returned false';
  if (result && typeof result === 'object') {
    const error = (result as { error?: unknown }).error;
    if (error != null) {
      return `session abort rejected: ${
        typeof error === 'string' ? error : JSON.stringify(error)
      }`;
    }
  }
  return null;
}

export interface ParsedModelReference {
  readonly providerID?: string;
  readonly modelID: string;
  readonly variant?: string;
}

const MODEL_REFERENCE_METADATA_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Parse `[provider/]model[#variant]`, preserving model slashes and colons. */
export function parseModelReference(
  model: string,
): ParsedModelReference | null {
  if (model.length === 0 || model.trim() !== model || model.includes('$')) {
    return null;
  }

  const providerDelimiter = model.indexOf('/');
  const variantDelimiter = model.indexOf('#');

  if (
    variantDelimiter !== model.lastIndexOf('#') ||
    (providerDelimiter >= 0 &&
      variantDelimiter >= 0 &&
      providerDelimiter > variantDelimiter)
  ) {
    return null;
  }

  const providerID =
    providerDelimiter >= 0 ? model.slice(0, providerDelimiter) : undefined;
  const modelStart = providerDelimiter >= 0 ? providerDelimiter + 1 : 0;
  const modelEnd = variantDelimiter >= 0 ? variantDelimiter : model.length;
  const modelID = model.slice(modelStart, modelEnd);
  const variant =
    variantDelimiter >= 0 ? model.slice(variantDelimiter + 1) : undefined;

  if (
    (providerID !== undefined &&
      !MODEL_REFERENCE_METADATA_PATTERN.test(providerID)) ||
    (variant !== undefined &&
      !MODEL_REFERENCE_METADATA_PATTERN.test(variant)) ||
    modelID.length === 0 ||
    modelID
      .split('/')
      .some((segment) => segment.length === 0 || segment.trim() !== segment)
  ) {
    return null;
  }

  return {
    ...(providerID ? { providerID } : {}),
    modelID,
    ...(variant ? { variant } : {}),
  };
}
