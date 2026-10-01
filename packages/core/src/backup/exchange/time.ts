/** Epoch milliseconds of a Graph ISO 8601 timestamp; 0 when absent or unparseable. */
export function toMillis(iso: string | null | undefined): number {
  if (!iso) {
    return 0;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}
