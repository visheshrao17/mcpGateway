import { createHash } from 'node:crypto';

const VALID = /^[A-Za-z0-9_-]{1,64}$/;

function hashSuffix(value: string, length: number) {
  return '_' + createHash('sha256').update(value).digest('hex').slice(0, length);
}

export function exposedName(slug: string, tool: string): string {
  const raw = `${slug}__${tool}`;
  if (VALID.test(raw)) return raw;
  const suffix = hashSuffix(raw, 6);
  return raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64 - suffix.length) + suffix;
}

export function assignExposedNames(entries: { slug: string; tool: string }[]): string[] {
  const taken = new Set<string>();
  return entries.map(({ slug, tool }) => {
    let name = exposedName(slug, tool);
    if (taken.has(name)) {
      const raw = `${slug}__${tool}`;
      const suffix = hashSuffix(raw, 16);
      name = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64 - suffix.length) + suffix;
    }
    taken.add(name);
    return name;
  });
}
