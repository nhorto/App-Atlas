/** Counts the rows and measures the widest one. The whole of the business logic. */
export function summarise(rows) {
  return {
    rows: rows.length,
    widest: rows.reduce((max, row) => Math.max(max, row.length), 0),
  };
}
