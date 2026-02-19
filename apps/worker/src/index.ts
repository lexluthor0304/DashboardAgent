import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { compare as jsonPatchCompare, applyPatch } from "fast-json-patch";

type Env = {
  DB: D1Database;
  AI: Ai;
  PRIMARY_MODEL_ID: string;
  FALLBACK_MODEL_ID: string;
  MODEL_TIMEOUT_MS: string;
  MAX_OUTPUT_TOKENS: string;
  REPAIR_MAX_ATTEMPTS: string;
  SHARE_TOKEN_TTL_DAYS: string;
  SF_CLIENT_ID?: string;
  SF_CLIENT_SECRET?: string;
  SF_LOGIN_URL?: string; // https://login.salesforce.com or https://test.salesforce.com
  SF_REDIRECT_URI?: string;
  ENCRYPTION_KEY?: string; // base64 32 bytes for AES-GCM
};

const app = new Hono<{ Bindings: Env }>();

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    maxAge: 86400,
  }),
);

const DashboardSpecSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1).max(120),
  themeId: z.string().min(1).max(40),
  layout: z.array(
    z.object({
      widgetId: z.string().min(1),
      x: z.number().int().nonnegative(),
      y: z.number().int().nonnegative(),
      w: z.number().int().positive(),
      h: z.number().int().positive(),
    }),
  ),
  widgets: z.array(
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("d3_chart"),
        id: z.string().min(1),
        title: z.string().min(1).max(120),
        dataRef: z.string().min(1),
        transformRef: z.string().optional(),
        chart: z.object({
          type: z.enum(["bar", "line", "donut"]),
          xField: z.string().min(1),
          yField: z.string().min(1),
          seriesField: z.string().optional(),
        }),
      }),
      z.object({
        kind: z.literal("pivot_table"),
        id: z.string().min(1),
        title: z.string().min(1).max(120),
        dataRef: z.string().min(1),
        transformRef: z.string().min(1),
      }),
      z.object({
        kind: z.literal("spreadsheet"),
        id: z.string().min(1),
        title: z.string().min(1).max(120),
        sheet: z.object({
          name: z.string().min(1).max(40),
          rows: z.number().int().positive().max(200),
          cols: z.number().int().positive().max(50),
          cells: z.record(
            z.object({
              v: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
              f: z.string().optional(), // e.g. "=SUM(A1:A3)"
            }),
          ),
        }),
      }),
      z.object({
        kind: z.literal("kpi"),
        id: z.string().min(1),
        title: z.string().min(1).max(120),
        valueRef: z.string().min(1), // e.g. "sheet:main!B2"
      }),
      z.object({
        kind: z.literal("text"),
        id: z.string().min(1),
        markdown: z.string().max(4000),
      }),
    ]),
  ),
  dataRequests: z.record(
    z.object({
      kind: z.enum(["demo_opps", "salesforce_soql"]),
      query: z.any().optional(),
    }),
  ),
  transforms: z.record(z.any()).optional(),
});

type DashboardSpec = z.infer<typeof DashboardSpecSchema>;

const CreateDashboardResponseSchema = z.object({
  dashboardId: z.string(),
  shareToken: z.string(),
  spec: DashboardSpecSchema,
});

const AgentRequestSchema = z.object({
  dashboardId: z.string(),
  token: z.string(),
  message: z.string().min(1).max(2000),
  currentSpec: DashboardSpecSchema.optional(),
});

const AgentResponseSchema = z.object({
  patch: z.array(z.any()),
  dirtyAreas: z.array(z.string()),
  spec: DashboardSpecSchema,
  warnings: z.array(z.string()).default([]),
  modelUsed: z.string(),
  fallbackReason: z.string().optional(),
  repairAttempts: z.number().int().nonnegative(),
});

const UpdateSpecRequestSchema = z.object({
  token: z.string(),
  spec: DashboardSpecSchema,
});

function nowEpochMs() {
  return Date.now();
}

function randomId(prefix: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

async function sha256Hex(input: string) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function ttlDaysToMs(days: number) {
  return days * 24 * 60 * 60 * 1000;
}

function defaultDemoSpec(dashboardId: string): DashboardSpec {
  const requestId = "r_demo_opps";
  const transformId = "t_pivot_stage";
  return {
    version: 1,
    title: "Sales Pulse: Pipeline Snapshot",
    themeId: "atelier",
    layout: [
      { widgetId: "w_chart", x: 0, y: 0, w: 8, h: 9 },
      { widgetId: "w_pivot", x: 8, y: 0, w: 4, h: 9 },
      { widgetId: "w_sheet", x: 0, y: 9, w: 6, h: 7 },
      { widgetId: "w_kpi", x: 6, y: 9, w: 6, h: 7 },
    ],
    widgets: [
      {
        kind: "d3_chart",
        id: "w_chart",
        title: "Pipeline by Stage (Demo)",
        dataRef: requestId,
        transformRef: transformId,
        chart: { type: "bar", xField: "StageName", yField: "TotalAmount" },
      },
      { kind: "pivot_table", id: "w_pivot", title: "Stage Pivot (Demo)", dataRef: requestId, transformRef: transformId },
      {
        kind: "spreadsheet",
        id: "w_sheet",
        title: "Quick Model (A1 Formulas)",
        sheet: {
          name: "main",
          rows: 12,
          cols: 6,
          cells: {
            A1: { v: "Win rate" },
            B1: { v: 0.32 },
            A2: { v: "Pipeline" },
            B2: { v: 1250000 },
            A3: { v: "Forecast" },
            B3: { f: "=B1*B2" },
            A5: { v: "Scenario +10%" },
            B5: { f: "=B3*1.1" },
            A7: { v: "Notes" },
            A8: { v: "Edit cells; formulas recalc." },
          },
        },
      },
      { kind: "kpi", id: "w_kpi", title: "Forecast (from sheet B3)", valueRef: "sheet:main!B3" },
      { kind: "text", id: "w_text", markdown: `Dashboard \`${dashboardId}\` (demo data).\n\nTry: "make the chart a line chart" or "change theme to noir".` },
    ],
    dataRequests: {
      [requestId]: { kind: "demo_opps" },
    },
    transforms: {
      [transformId]: {
        kind: "groupBy",
        groupBy: ["StageName"],
        aggregates: [{ op: "sum", field: "Amount", as: "TotalAmount" }],
        orderBy: [{ field: "TotalAmount", dir: "desc" }],
        limit: 50,
      },
    },
  };
}

async function dbGetDashboard(env: Env, dashboardId: string): Promise<DashboardSpec | null> {
  const row = await env.DB.prepare("SELECT spec_json FROM dashboards WHERE id = ?")
    .bind(dashboardId)
    .first<{ spec_json: string }>();
  if (!row) return null;
  return DashboardSpecSchema.parse(JSON.parse(row.spec_json));
}

async function dbUpsertDashboard(env: Env, dashboardId: string, spec: DashboardSpec): Promise<void> {
  const ts = nowEpochMs();
  const specJson = JSON.stringify(spec);
  await env.DB.prepare(
    "INSERT INTO dashboards(id, spec_json, created_at, updated_at) VALUES(?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET spec_json = excluded.spec_json, updated_at = excluded.updated_at",
  )
    .bind(dashboardId, specJson, ts, ts)
    .run();
}

async function dbCreateShareToken(env: Env, dashboardId: string, token: string, expiresAt: number): Promise<void> {
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare("INSERT INTO share_tokens(dashboard_id, token_hash, expires_at, created_at) VALUES(?, ?, ?, ?)")
    .bind(dashboardId, tokenHash, expiresAt, nowEpochMs())
    .run();
}

async function dbVerifyShareToken(env: Env, dashboardId: string, token: string): Promise<boolean> {
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT 1 as ok FROM share_tokens WHERE dashboard_id = ? AND token_hash = ? AND expires_at > ? LIMIT 1",
  )
    .bind(dashboardId, tokenHash, nowEpochMs())
    .first<{ ok: number }>();
  return Boolean(row?.ok);
}

function extractTokenFromRequest(req: Request, fallback?: string): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice("bearer ".length).trim();
  if (fallback) return fallback;
  return null;
}

app.get("/api/health", (c) => c.json({ ok: true, ts: nowEpochMs() }));

app.post("/api/dashboards", async (c) => {
  const dashboardId = randomId("dash");
  const shareToken = randomId("share");
  const ttlDays = Number(c.env.SHARE_TOKEN_TTL_DAYS || "7");
  const expiresAt = nowEpochMs() + ttlDaysToMs(Number.isFinite(ttlDays) ? ttlDays : 7);

  const spec = defaultDemoSpec(dashboardId);
  await dbUpsertDashboard(c.env, dashboardId, spec);
  await dbCreateShareToken(c.env, dashboardId, shareToken, expiresAt);

  const resp = CreateDashboardResponseSchema.parse({ dashboardId, shareToken, spec });
  return c.json(resp);
});

app.get("/api/dashboards/:id", async (c) => {
  const dashboardId = c.req.param("id");
  const token = extractTokenFromRequest(c.req.raw, new URL(c.req.url).searchParams.get("token") ?? undefined);
  if (!token) return c.json({ error: "missing token" }, 401);
  if (!(await dbVerifyShareToken(c.env, dashboardId, token))) return c.json({ error: "invalid token" }, 403);

  const spec = await dbGetDashboard(c.env, dashboardId);
  if (!spec) return c.json({ error: "not found" }, 404);
  return c.json({ spec });
});

app.post("/api/dashboards/:id/spec", async (c) => {
  const dashboardId = c.req.param("id");
  const body = UpdateSpecRequestSchema.parse(await c.req.json());
  const token = extractTokenFromRequest(c.req.raw, body.token);
  if (!token) return c.json({ error: "missing token" }, 401);
  if (!(await dbVerifyShareToken(c.env, dashboardId, token))) return c.json({ error: "invalid token" }, 403);
  await dbUpsertDashboard(c.env, dashboardId, body.spec);
  return c.json({ ok: true, spec: body.spec });
});

async function runWorkersAiJson(env: Env, modelId: string, messages: Array<{ role: string; content: string }>, maxTokens: number) {
  // Workers AI supports an OpenAI-like chat interface for many models.
  const timeoutMs = Number(env.MODEL_TIMEOUT_MS || "25000");
  const p = env.AI.run(modelId as any, {
    messages,
    max_tokens: maxTokens,
  } as any);
  const result = await Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error("model_timeout")), timeoutMs)),
  ]);
  // result shape varies by model; handle common cases.
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const maybeText = (result as any).response ?? (result as any).output_text ?? (result as any).text;
    if (typeof maybeText === "string") return maybeText;
  }
  return JSON.stringify(result);
}

function stripCodeFences(s: string) {
  const trimmed = s.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
}

function extractJsonObjectText(raw: string) {
  const s = stripCodeFences(raw).trim();
  if (s.startsWith("{") && s.endsWith("}")) return s;
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i >= 0 && j > i) return s.slice(i, j + 1);
  return s;
}

function applyHeuristicUpdate(currentSpec: DashboardSpec, message: string): DashboardSpec | null {
  const m = message.toLowerCase();

  // Theme
  if (m.includes("theme") || m.includes("color") || m.includes("palette")) {
    if (m.includes("noir") || m.includes("dark")) return { ...currentSpec, themeId: "noir" };
    if (m.includes("atelier") || m.includes("light")) return { ...currentSpec, themeId: "atelier" };
  }

  // Chart type
  const wantsLine = m.includes("line chart") || m.includes("line");
  const wantsBar = m.includes("bar chart") || m.includes("bar");
  const wantsDonut = m.includes("donut") || m.includes("pie");
  if (wantsLine || wantsBar || wantsDonut) {
    const nextType = wantsDonut ? "donut" : wantsLine ? "line" : "bar";
    const widgets = currentSpec.widgets.map((w) => (w.kind === "d3_chart" ? { ...w, chart: { ...w.chart, type: nextType } } : w));
    return { ...currentSpec, widgets };
  }

  // Title rename: "rename ... to X"
  const rename = /rename.*dashboard.*to\s+["“]([^"”]+)["”]/i.exec(message);
  if (rename?.[1]) return { ...currentSpec, title: rename[1].trim().slice(0, 120) };

  // Pivot: by OwnerName
  if (m.includes("pivot") && (m.includes("owner") || m.includes("ownername"))) {
    const transforms = { ...(currentSpec.transforms ?? {}) };
    for (const [k, v] of Object.entries(transforms)) {
      if ((v as any)?.kind === "groupBy") (v as any).groupBy = ["OwnerName"];
      transforms[k] = v;
    }
    return { ...currentSpec, transforms };
  }

  return null;
}

async function generateNextSpecWithRepair(env: Env, currentSpec: DashboardSpec, message: string) {
  const primaryModelId = env.PRIMARY_MODEL_ID || "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b";
  const fallbackModelId = env.FALLBACK_MODEL_ID || "@cf/qwen/qwq-32b";
  const maxTokens = Number(env.MAX_OUTPUT_TOKENS || "1200");
  const repairMax = Number(env.REPAIR_MAX_ATTEMPTS || "2");

  const system = [
    "You are an assistant that updates a dashboard specification.",
    "Return ONLY valid JSON for the next DashboardSpec. No markdown, no code fences.",
    "Do not include any fields not in the schema. Keep ids stable when possible.",
    "If the user asks to change theme, set themeId to one of: atelier, noir.",
    "If the user asks to change chart type, update widgets[].chart.type (bar|line|donut).",
    "Schema (informal): { version:1, title, themeId, layout[], widgets[], dataRequests{}, transforms{} }",
  ].join("\n");

  let modelUsed = primaryModelId;
  let fallbackReason: string | undefined;
  let repairAttempts = 0;

  const messagesBase = [
    { role: "system", content: system },
    { role: "user", content: `CurrentSpec: ${JSON.stringify(currentSpec)}\n\nUserRequest: ${message}` },
  ];

  async function attempt(modelId: string, extraInstruction?: string) {
    const messages = extraInstruction
      ? [...messagesBase, { role: "user", content: `Fix the JSON to satisfy the schema errors: ${extraInstruction}` }]
      : messagesBase;
    const raw = await runWorkersAiJson(env, modelId, messages, maxTokens);
    const jsonText = extractJsonObjectText(raw);
    const parsed = JSON.parse(jsonText);
    return DashboardSpecSchema.parse(parsed);
  }

  try {
    return { nextSpec: await attempt(primaryModelId), modelUsed, fallbackReason, repairAttempts };
  } catch (e1) {
    // Repair loop on primary
    let lastErr = e1;
    while (repairAttempts < repairMax) {
      repairAttempts += 1;
      try {
        const errText = lastErr instanceof Error ? lastErr.message : String(lastErr);
        return { nextSpec: await attempt(primaryModelId, errText), modelUsed, fallbackReason, repairAttempts };
      } catch (e2) {
        lastErr = e2;
      }
    }

    // Fallback
    modelUsed = fallbackModelId;
    fallbackReason = "primary_failed_or_invalid_json";
    repairAttempts = 0;
    try {
      return { nextSpec: await attempt(fallbackModelId), modelUsed, fallbackReason, repairAttempts };
    } catch (e3) {
      let lastErr2 = e3;
      while (repairAttempts < repairMax) {
        repairAttempts += 1;
        try {
          const errText = lastErr2 instanceof Error ? lastErr2.message : String(lastErr2);
          return { nextSpec: await attempt(fallbackModelId, errText), modelUsed, fallbackReason, repairAttempts };
        } catch (e4) {
          lastErr2 = e4;
        }
      }
      const heuristic = applyHeuristicUpdate(currentSpec, message);
      if (heuristic) {
        modelUsed = "heuristic";
        fallbackReason = "llm_invalid_json";
        return { nextSpec: heuristic, modelUsed, fallbackReason, repairAttempts };
      }
      throw e3;
    }
  }
}

app.post("/api/agent", async (c) => {
  const body = AgentRequestSchema.parse(await c.req.json());
  const token = extractTokenFromRequest(c.req.raw, body.token);
  if (!token) return c.json({ error: "missing token" }, 401);
  if (!(await dbVerifyShareToken(c.env, body.dashboardId, token))) return c.json({ error: "invalid token" }, 403);

  const currentSpec = body.currentSpec ?? (await dbGetDashboard(c.env, body.dashboardId)) ?? defaultDemoSpec(body.dashboardId);
  const { nextSpec, modelUsed, fallbackReason, repairAttempts } = await generateNextSpecWithRepair(c.env, currentSpec, body.message);
  const patch = jsonPatchCompare(currentSpec as any, nextSpec as any);

  // Apply patch server-side to ensure consistent stored spec.
  const applied = applyPatch(JSON.parse(JSON.stringify(currentSpec)), patch, true, false).newDocument;
  const stored = DashboardSpecSchema.parse(applied);
  await dbUpsertDashboard(c.env, body.dashboardId, stored);

  const resp = AgentResponseSchema.parse({
    patch,
    dirtyAreas: ["all"],
    spec: stored,
    warnings: [],
    modelUsed,
    fallbackReason,
    repairAttempts,
  });
  return c.json(resp);
});

function demoOpportunities() {
  return [
    { Id: "0061", StageName: "Prospecting", Amount: 120000, CloseDate: "2026-02-05", OwnerName: "Avery", Region: "NA" },
    { Id: "0062", StageName: "Qualification", Amount: 85000, CloseDate: "2026-02-12", OwnerName: "Kai", Region: "EMEA" },
    { Id: "0063", StageName: "Proposal", Amount: 240000, CloseDate: "2026-02-18", OwnerName: "Avery", Region: "NA" },
    { Id: "0064", StageName: "Negotiation", Amount: 310000, CloseDate: "2026-03-02", OwnerName: "Mina", Region: "APAC" },
    { Id: "0065", StageName: "Closed Won", Amount: 175000, CloseDate: "2026-02-08", OwnerName: "Kai", Region: "EMEA" },
    { Id: "0066", StageName: "Closed Won", Amount: 95000, CloseDate: "2026-02-15", OwnerName: "Avery", Region: "NA" },
    { Id: "0067", StageName: "Proposal", Amount: 110000, CloseDate: "2026-03-10", OwnerName: "Mina", Region: "APAC" },
    { Id: "0068", StageName: "Qualification", Amount: 60000, CloseDate: "2026-02-22", OwnerName: "Avery", Region: "NA" },
  ];
}

app.get("/api/dashboards/:id/data", async (c) => {
  const dashboardId = c.req.param("id");
  const url = new URL(c.req.url);
  const requestId = url.searchParams.get("requestId");
  const token = extractTokenFromRequest(c.req.raw, url.searchParams.get("token") ?? undefined);
  if (!token) return c.json({ error: "missing token" }, 401);
  if (!(await dbVerifyShareToken(c.env, dashboardId, token))) return c.json({ error: "invalid token" }, 403);
  if (!requestId) return c.json({ error: "missing requestId" }, 400);

  const spec = await dbGetDashboard(c.env, dashboardId);
  if (!spec) return c.json({ error: "not found" }, 404);
  const req = spec.dataRequests[requestId];
  if (!req) return c.json({ error: "unknown requestId" }, 404);

  if (req.kind === "demo_opps") {
    return c.json({ rows: demoOpportunities(), schema: { fields: Object.keys(demoOpportunities()[0] ?? {}) } });
  }

  return c.json({ error: "not implemented" }, 501);
});

export default app;
