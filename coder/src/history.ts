import type { SQLInputValue } from "node:sqlite";
import type { Store } from "./store.ts";
import type { HistorySource, StoredItem } from "./types.ts";
export interface HistoryRow {
  position: number;
  item: StoredItem;
}
export function historyStatement(
  store: Store,
  source: HistorySource,
  options: {
    after?: number;
    itemId?: string;
    startedOnly?: boolean;
    order?: "ASC" | "DESC";
    limit?: number;
  } = {},
) {
  const conditions = [
    "e.thread_id=?",
    "e.kind='item'",
    "e.sequence<=?",
    "r.ordinal<=?",
    "NOT EXISTS (SELECT 1 FROM events newer WHERE newer.thread_id=e.thread_id AND newer.kind='item' AND newer.sequence>e.sequence AND newer.sequence<=? AND json_extract(newer.payload,'$.id')=json_extract(e.payload,'$.id'))",
  ];
  const params: SQLInputValue[] = [
    source.threadId,
    source.throughSequence,
    source.maxOrdinal,
    source.throughSequence,
  ];
  if (options.startedOnly)
    conditions.push("json_extract(r.body,'$.startedAt') IS NOT NULL");
  if (options.after !== undefined) {
    conditions.push("e.sequence>?");
    params.push(options.after);
  }
  if (options.itemId !== undefined) {
    conditions.push("json_extract(e.payload,'$.id')=?");
    params.push(options.itemId);
  }
  const base = `FROM events e JOIN runs r ON r.id=e.run_id WHERE ${conditions.join(" AND ")}`;
  return {
    base,
    params,
    query: store.db.prepare(
      `SELECT e.sequence,e.payload ${base} ORDER BY e.sequence ${options.order === "DESC" ? "DESC" : "ASC"} LIMIT ?`,
    ),
    limit: options.limit ?? 100,
  };
}
export function historyRows(
  store: Store,
  source: HistorySource,
  options: Parameters<typeof historyStatement>[2] = {},
): HistoryRow[] {
  const q = historyStatement(store, source, options);
  return q.query
    .all(...q.params, q.limit)
    .map((row) => ({
      position: Number(row.sequence),
      item: JSON.parse(String(row.payload)) as StoredItem,
    }));
}
/** Bounded memory; immutable source boundaries survive nested forks and later parent work. */
export function collectHistory(
  store: Store,
  sources: readonly HistorySource[],
): { items: StoredItem[]; omitted: number } {
  let total = 0;
  let bytes = 0;
  const groups: StoredItem[][] = [];
  const MAX_BYTES = 2 * 1024 * 1024;
  let selected = 0;
  for (const source of [...sources].reverse()) {
    const q = historyStatement(store, source, {
      startedOnly: true,
      order: "DESC",
      limit: 2001,
    });
    total += Number(
      store.db.prepare(`SELECT COUNT(*) AS count ${q.base}`).get(...q.params)!
        .count,
    );
    const group: StoredItem[] = [];
    for (const row of q.query.iterate(...q.params, q.limit)) {
      const raw = String(row.payload);
      const size = Buffer.byteLength(raw);
      if (selected >= 2000 || bytes + size > MAX_BYTES) continue;
      group.push(JSON.parse(raw) as StoredItem);
      selected++;
      bytes += size;
    }
    groups.unshift(group.reverse());
  }
  let items = groups.flat();
  // The original user constraint gets priority over expendable later context.
  for (const source of sources) {
    const first = historyRows(store, source, { startedOnly: true, limit: 1 })[0]
      ?.item;
    if (!first) continue;
    if (
      !items.some(
        (item) => item.id === first.id && item.threadId === first.threadId,
      )
    ) {
      const size = Buffer.byteLength(JSON.stringify(first));
      if (size <= MAX_BYTES) {
        while (
          items.length &&
          (bytes + size > MAX_BYTES || items.length >= 2000)
        ) {
          const removed = items.shift()!;
          bytes -= Buffer.byteLength(JSON.stringify(removed));
        }
        items.unshift(first);
      }
    }
    break;
  }
  return { items, omitted: Math.max(0, total - items.length) };
}
