---
name: delegation
description: Use when selecting models or variants for delegated agent and host calls.
---

# Delegation Model References

Preserve model identity exactly. Parse a reference once, apply precedence, and
send qualified fields to the host without rewriting or substituting the model.

## Reference Format: `provider/model[#variant]`

- The first slash separates the provider.
- Only `#` separates the variant.
- Remaining slashes and all colons belong to the model ID.

Example: `omniroute/opencode/bigpickle:free#max` becomes provider
`omniroute`, model `opencode/bigpickle:free`, variant `max`.

Providerless references are parseable, but qualify them before any host call
that requires a provider. Never infer the missing provider.

## Delegation Procedure

1. Use the canonical `ref` field from each `resolve_model` match.
2. Append `#variant` when needed without normalizing the model text.
3. Resolve variant precedence: explicit field or override, then inline
   reference variant, then shared or default variant.
4. Confirm every provider-required host call has a provider before dispatch.

Use only the override fields advertised by the active host tool schema.
OpenCode v1 native `task` has no model override field. Where the host exposes
separate `provider`, `model`, and `variant` fields, treat the separate `model`
as the exact model identifier, so catalog IDs such as `inkling-small:free`
remain intact. The task-session admission hook uses that provider/model pair
for routing and concurrency without rewriting the host arguments.

In a shell, single-quote references, for example
`'omniroute/opencode/bigpickle:free#max'`.

Legacy colon-delimited variants are not executable variant syntax. Migrate
`provider/model:high` to `provider/model#high` when `high` is a variant;
leave `provider/model:free` unchanged when `model:free` is the catalog ID.

## Stop and Validate

- Never guess a provider.
- Never silently substitute a model.
- Reject dollar-separated references, empty required segments, or repeated
  `#`; ask for a corrected reference.
