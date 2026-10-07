/** Compare parsed collection values independently of YAML/object key order.
 * Array order is business data (records, fields, views) and remains significant.
 */
export function collectionValuesEqual(previous: unknown, next: unknown): boolean {
  if (previous === next) return true;
  if (Array.isArray(previous)) {
    return Array.isArray(next) && previous.length === next.length
      && previous.every((value, index) => collectionValuesEqual(value, next[index]));
  }
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object' || Array.isArray(next)) return false;
  const previousObject = previous as Record<string, unknown>;
  const nextObject = next as Record<string, unknown>;
  const keys = Object.keys(previousObject);
  return keys.length === Object.keys(nextObject).length && keys.every((key) =>
    Object.prototype.hasOwnProperty.call(nextObject, key) && collectionValuesEqual(previousObject[key], nextObject[key]));
}

/** Keep list dependencies stable when only collection metadata or key order changed. */
export function reuseCollectionValue<T>(previous: T, next: T): T {
  return collectionValuesEqual(previous, next) ? previous : next;
}
