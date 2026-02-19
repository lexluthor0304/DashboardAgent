import * as aq from "arquero";

type GroupByTransform = {
  kind: "groupBy";
  groupBy: string[];
  aggregates: Array<{ op: "sum" | "count"; field?: string; as: string }>;
  orderBy?: Array<{ field: string; dir: "asc" | "desc" }>;
  limit?: number;
};

type TransformSpec = GroupByTransform;

type TransformRequest = {
  id: string;
  rows: any[];
  transform: TransformSpec;
};

type TransformResponse = {
  id: string;
  rows: any[];
  error?: string;
};

function applyTransform(rows: any[], transform: TransformSpec) {
  if (transform.kind === "groupBy") {
    let t = aq.from(rows);

    const rollup: Record<string, any> = {};
    for (const agg of transform.aggregates) {
      if (agg.op === "sum") {
        rollup[agg.as] = aq.op.sum(agg.field ?? "");
      } else if (agg.op === "count") {
        rollup[agg.as] = aq.op.count();
      }
    }

    t = t.groupby(...transform.groupBy).rollup(rollup);

    if (transform.orderBy && transform.orderBy.length > 0) {
      const [first] = transform.orderBy;
      if (first) {
        t = t.orderby(first.dir === "desc" ? aq.desc(first.field) : first.field);
      }
    }

    if (transform.limit && transform.limit > 0) {
      t = t.slice(0, transform.limit);
    }

    return t.objects();
  }

  return rows;
}

self.onmessage = (ev: MessageEvent<TransformRequest>) => {
  const { id, rows, transform } = ev.data;
  try {
    const out = applyTransform(rows, transform);
    const resp: TransformResponse = { id, rows: out };
    (self as any).postMessage(resp);
  } catch (e) {
    const resp: TransformResponse = { id, rows: [], error: e instanceof Error ? e.message : String(e) };
    (self as any).postMessage(resp);
  }
};
