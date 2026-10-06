import type { TableRecord } from './model';

/** Build a view index once per data change instead of scanning every record per lane/day. */
export function groupRecordsByValue(
  records: TableRecord[],
  valueForRecord: (record: TableRecord) => unknown,
): ReadonlyMap<string, TableRecord[]> {
  const groups = new Map<string, TableRecord[]>();
  for (const record of records) {
    const value = valueForRecord(record);
    if (typeof value !== 'string' || !value) continue;
    const group = groups.get(value);
    if (group) group.push(record);
    else groups.set(value, [record]);
  }
  return groups;
}
