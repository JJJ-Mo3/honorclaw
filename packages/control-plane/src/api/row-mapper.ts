/**
 * Convert a snake_case database row to camelCase for JSON API responses.
 * Postgres returns column names in snake_case; JS/TS consumers expect camelCase.
 */
export function toCamelCase<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    result[camelKey] = value;
  }
  return result;
}

/** Map an array of database rows to camelCase */
export function mapRows<T extends Record<string, unknown>>(rows: T[]): Record<string, unknown>[] {
  return rows.map(toCamelCase);
}
