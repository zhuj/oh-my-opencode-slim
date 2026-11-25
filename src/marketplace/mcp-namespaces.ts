export function ambiguousMcpNamespaces(
  required: readonly string[],
  available: ReadonlySet<string>,
  normalized?: ReadonlyMap<string, string>,
): string[] {
  const namespace = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const namespaces =
    normalized ??
    new Map([...available].map((name) => [name, namespace(name)]));
  const conflicts = new Set<string>();
  const names = [...available].sort();
  for (const name of required) {
    const own = namespaces.get(name) ?? namespace(name);
    for (const other of names) {
      const otherNamespace = namespaces.get(other);
      if (otherNamespace === undefined) continue;
      if (
        name !== other &&
        (own === otherNamespace ||
          own.startsWith(`${otherNamespace}_`) ||
          otherNamespace.startsWith(`${own}_`))
      ) {
        conflicts.add([name, other].sort().join(' and '));
      }
    }
  }
  return [...conflicts].sort();
}
