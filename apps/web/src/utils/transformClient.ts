type TransformResponse = { id: string; rows: any[]; error?: string };

type Pending = {
  resolve: (rows: any[]) => void;
  reject: (err: Error) => void;
};

let worker: Worker | null = null;
const pending = new Map<string, Pending>();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("../workers/transform.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev: MessageEvent<TransformResponse>) => {
    const msg = ev.data;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.rows);
  };
  worker.onerror = (e) => {
    for (const [, p] of pending) p.reject(new Error(`Transform worker error: ${String((e as any)?.message ?? e)}`));
    pending.clear();
  };
  return worker;
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function transformRows(rows: any[], transform: unknown): Promise<any[]> {
  const id = `t_${randomId()}`;
  const w = ensureWorker();
  const p = new Promise<any[]>((resolve, reject) => pending.set(id, { resolve, reject }));
  w.postMessage({ id, rows, transform });
  return p;
}

