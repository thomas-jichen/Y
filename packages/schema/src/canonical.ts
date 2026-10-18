/**
 * Canonical JSON serialization used for every hash and signature in Y
 * (setup hashes, patch hashes, signed change payloads, owner-instruction
 * signatures, internal HMAC bodies).
 *
 * This module has **no dependencies** (not even zod) so the plugin bundle can
 * import it as `@y/schema/canonical` without pulling in the rest of the
 * contracts.
 *
 * The output is RFC 8785 (JCS) compatible for the JSON values Y uses:
 * - object keys sorted by UTF-16 code units, no whitespace;
 * - strings and numbers serialized exactly like `JSON.stringify`;
 * - `undefined`-valued object properties are omitted (like `JSON.stringify`).
 *
 * It is stricter than `JSON.stringify` so that two implementations can never
 * disagree silently: non-finite numbers, `undefined` inside arrays, bigint,
 * functions, symbols and objects with a non-plain prototype (Date, Map, class
 * instances) throw a `TypeError`. Convert dates to ISO strings first.
 *
 * @module canonical
 */

/** A JSON value accepted by {@link canonicalJson}. */
export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue | undefined };

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function serialize(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (seen.has(value)) throw new TypeError(`canonicalJson: cycle at ${path}`);
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          const parts = value.map((item: unknown, i) => {
            if (item === undefined) {
              throw new TypeError(`canonicalJson: undefined array element at ${path}[${i}]`);
            }
            return serialize(item, `${path}[${i}]`, seen);
          });
          return `[${parts.join(',')}]`;
        }
        if (!isPlainObject(value)) {
          throw new TypeError(`canonicalJson: non-plain object at ${path}`);
        }
        const record = value as Record<string, unknown>;
        // Default sort compares UTF-16 code units, which is what RFC 8785 requires.
        const keys = Object.keys(record).sort();
        const parts: string[] = [];
        for (const key of keys) {
          const v = record[key];
          if (v === undefined) continue;
          parts.push(`${JSON.stringify(key)}:${serialize(v, `${path}.${key}`, seen)}`);
        }
        return `{${parts.join(',')}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }
}

/**
 * Serialize `value` to canonical JSON (see module docs for the exact rules).
 *
 * @throws TypeError on values that have no canonical JSON form.
 * @example canonicalJson({ b: 1, a: [true, 'x'] }) === '{"a":[true,"x"],"b":1}'
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$', new Set());
}

/**
 * UTF-8 bytes of {@link canonicalJson}. Hash these bytes with SHA-256 to get a
 * Y content hash (`sha256(canonicalJsonBytes(x))`, lowercase hex).
 */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}
