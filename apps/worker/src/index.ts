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
      kind: z.enum(["demo_opps", "salesforce_soql_guarded"]),
      query: z.any().optional(),
    }),
  ),
  transforms: z.record(z.any()).optional(),
  meta: z
    .object({
      scenarioClass: z.string().min(1).max(80),
      generatedFromPrompt: z.string().min(1).max(2000),
      generatedAt: z.number().int().positive(),
    })
    .optional(),
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

const ScenarioClassSchema = z.enum([
  "sales_funnel_overview",
  "revenue_trend_forecast",
  "win_loss_analysis",
  "regional_performance",
  "top_reps_accounts",
  "pipeline_health",
  "executive_kpi_summary",
  "detail_pivot_companion",
]);

const GenerationSourceSchema = z.object({
  type: z.enum(["demo", "salesforce"]),
  connectorId: z.string().min(1).optional(),
});

const GenerateDashboardRequestSchema = z.object({
  prompt: z.string().min(3).max(2000),
  source: GenerationSourceSchema.default({ type: "demo" }),
  constraints: z
    .object({
      maxWidgets: z.number().int().min(3).max(8).optional(),
      latencyBudgetMs: z.number().int().min(5000).max(60000).optional(),
    })
    .optional(),
});

const GenerationPlanSchema = z.object({
  scenarioClass: ScenarioClassSchema,
  title: z.string().min(3).max(120),
  themeId: z.enum(["atelier", "noir"]),
  kpis: z.array(z.string().min(1).max(80)).min(1).max(6),
  dimensions: z.array(z.string().min(1).max(80)).min(1).max(6),
  chartType: z.enum(["bar", "line", "donut"]),
  primaryGroupBy: z.enum(["StageName", "OwnerName", "Region", "CloseMonth", "CloseQuarter"]),
});

const GenerateDashboardResponseSchema = z.object({
  dashboardId: z.string(),
  shareToken: z.string(),
  spec: DashboardSpecSchema,
  generationMeta: z.object({
    modelUsed: z.string(),
    fallbackReason: z.string().optional(),
    repairAttempts: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    scenarioClass: ScenarioClassSchema,
  }),
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

function classifyScenarioByPrompt(prompt: string): z.infer<typeof ScenarioClassSchema> {
  const p = prompt.toLowerCase();
  if (p.includes("funnel") || p.includes("stage conversion")) return "sales_funnel_overview";
  if (p.includes("forecast") || p.includes("trend")) return "revenue_trend_forecast";
  if (p.includes("win") || p.includes("loss")) return "win_loss_analysis";
  if (p.includes("region") || p.includes("geo")) return "regional_performance";
  if (p.includes("rep") || p.includes("account") || p.includes("top")) return "top_reps_accounts";
  if (p.includes("aging") || p.includes("health")) return "pipeline_health";
  if (p.includes("executive") || p.includes("kpi") || p.includes("summary")) return "executive_kpi_summary";
  return "detail_pivot_companion";
}

function makeTemplatePlan(
  prompt: string,
  maxWidgets: number | undefined,
  source: z.infer<typeof GenerationSourceSchema>,
): z.infer<typeof GenerationPlanSchema> {
  const scenarioClass = classifyScenarioByPrompt(prompt);
  const themeId = prompt.toLowerCase().includes("dark") || prompt.toLowerCase().includes("noir") ? "noir" : "atelier";
  const chartType = prompt.toLowerCase().includes("donut")
    ? "donut"
    : prompt.toLowerCase().includes("line")
      ? "line"
      : "bar";

  const groupByByScenario: Record<z.infer<typeof ScenarioClassSchema>, z.infer<typeof GenerationPlanSchema>["primaryGroupBy"]> = {
    sales_funnel_overview: "StageName",
    revenue_trend_forecast: "CloseMonth",
    win_loss_analysis: "StageName",
    regional_performance: "Region",
    top_reps_accounts: "OwnerName",
    pipeline_health: "StageName",
    executive_kpi_summary: "CloseQuarter",
    detail_pivot_companion: "OwnerName",
  };

  const titleByScenario: Record<z.infer<typeof ScenarioClassSchema>, string> = {
    sales_funnel_overview: "Sales Funnel Overview",
    revenue_trend_forecast: "Revenue Trend & Forecast",
    win_loss_analysis: "Win / Loss Analysis",
    regional_performance: "Regional Performance",
    top_reps_accounts: "Top Reps & Accounts",
    pipeline_health: "Pipeline Health",
    executive_kpi_summary: "Executive KPI Summary",
    detail_pivot_companion: "Detail + Pivot Companion",
  };

  const sourceHint = source.type === "salesforce" ? " (Salesforce)" : " (Demo)";

  return {
    scenarioClass,
    title: `${titleByScenario[scenarioClass]}${sourceHint}`.slice(0, 120),
    themeId,
    kpis: ["Total Amount", "Pipeline Count", "Win Rate"],
    dimensions: ["StageName", "OwnerName", "Region", "CloseMonth"],
    chartType,
    primaryGroupBy: groupByByScenario[scenarioClass],
  };
}

function groupByToField(groupBy: z.infer<typeof GenerationPlanSchema>["primaryGroupBy"]) {
  if (groupBy === "CloseMonth" || groupBy === "CloseQuarter") return "CloseDate";
  return groupBy;
}

function normalizeScenarioSpec(
  dashboardId: string,
  prompt: string,
  source: z.infer<typeof GenerationSourceSchema>,
  plan: z.infer<typeof GenerationPlanSchema>,
  maxWidgets: number | undefined,
): DashboardSpec {
  const requestId = "r_primary";
  const transformId = "t_primary_group";
  const widgetLimit = Math.max(3, Math.min(maxWidgets ?? 6, 8));
  const groupField = groupByToField(plan.primaryGroupBy);

  const layoutBase: DashboardSpec["layout"] = [
    { widgetId: "w_chart", x: 0, y: 0, w: 8, h: 9 },
    { widgetId: "w_pivot", x: 8, y: 0, w: 4, h: 9 },
    { widgetId: "w_sheet", x: 0, y: 9, w: 6, h: 7 },
    { widgetId: "w_kpi", x: 6, y: 9, w: 6, h: 7 },
    { widgetId: "w_text", x: 0, y: 16, w: 12, h: 4 },
  ];
  const layout = layoutBase.slice(0, widgetLimit);

  const sheetCells: Record<string, { v?: string | number | boolean | null; f?: string }> = {
    A1: { v: "Win rate" },
    B1: { v: 0.34 },
    A2: { v: "Pipeline" },
    B2: { v: 1250000 },
    A3: { v: "Forecast" },
    B3: { f: "=B1*B2" },
    A4: { v: "Scenario +5%" },
    B4: { f: "=B3*1.05" },
  };

  const widgets: DashboardSpec["widgets"] = [];
  if (widgetLimit >= 1) {
    widgets.push({
      kind: "d3_chart",
      id: "w_chart",
      title: `${plan.title} Chart`,
      dataRef: requestId,
      transformRef: transformId,
      chart: {
        type: plan.chartType,
        xField: groupField === "CloseDate" ? "StageName" : groupField,
        yField: "TotalAmount",
      },
    });
  }
  if (widgetLimit >= 2) {
    widgets.push({
      kind: "pivot_table",
      id: "w_pivot",
      title: `${plan.title} Pivot`,
      dataRef: requestId,
      transformRef: transformId,
    });
  }
  if (widgetLimit >= 3) {
    widgets.push({
      kind: "spreadsheet",
      id: "w_sheet",
      title: "Planning Sheet",
      sheet: { name: "main", rows: 14, cols: 6, cells: sheetCells },
    });
  }
  if (widgetLimit >= 4) {
    widgets.push({
      kind: "kpi",
      id: "w_kpi",
      title: "Forecast KPI",
      valueRef: "sheet:main!B3",
    });
  }
  if (widgetLimit >= 5) {
    widgets.push({
      kind: "text",
      id: "w_text",
      markdown: `Prompt: "${prompt}"\n\nScenario: ${plan.scenarioClass}\nSource: ${source.type}\nKPIs: ${plan.kpis.join(", ")}`,
    });
  }

  const dataKind = source.type === "salesforce" ? "salesforce_soql_guarded" : "demo_opps";
  return {
    version: 1,
    title: plan.title,
    themeId: plan.themeId,
    layout,
    widgets,
    dataRequests: {
      [requestId]: {
        kind: dataKind,
        query:
          source.type === "salesforce"
            ? {
                object: "Opportunity",
                groupBy: groupField,
                metric: "Amount",
                limit: 2000,
              }
            : undefined,
      },
    },
    transforms: {
      [transformId]: {
        kind: "groupBy",
        groupBy: [groupField],
        aggregates: [{ op: "sum", field: "Amount", as: "TotalAmount" }],
        orderBy: [{ field: "TotalAmount", dir: "desc" }],
        limit: 50,
      },
    },
    meta: {
      scenarioClass: plan.scenarioClass,
      generatedFromPrompt: prompt.slice(0, 2000),
      generatedAt: nowEpochMs(),
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

app.post("/api/generate-dashboard", async (c) => {
  const startedAt = nowEpochMs();
  const body = GenerateDashboardRequestSchema.parse(await c.req.json());
  const latencyBudgetMs = Math.max(5000, body.constraints?.latencyBudgetMs ?? 45000);
  const modelTimeoutMs = Number(c.env.MODEL_TIMEOUT_MS || "25000");
  const perModelTimeoutMs = Math.max(4000, Math.min(12000, modelTimeoutMs, Math.floor(latencyBudgetMs / 3)));

  const dashboardId = randomId("dash");
  const shareToken = randomId("share");
  const ttlDays = Number(c.env.SHARE_TOKEN_TTL_DAYS || "7");
  const expiresAt = nowEpochMs() + ttlDaysToMs(Number.isFinite(ttlDays) ? ttlDays : 7);

  const templatePlan = makeTemplatePlan(body.prompt, body.constraints?.maxWidgets, body.source);
  let plan = templatePlan;
  let spec = normalizeScenarioSpec(dashboardId, body.prompt, body.source, templatePlan, body.constraints?.maxWidgets);
  let modelUsed = "template";
  let fallbackReason: string | undefined;
  let repairAttempts = 0;
  const deadlineAt = startedAt + latencyBudgetMs;
  const remainingBudgetMs = () => Math.max(0, deadlineAt - nowEpochMs());

  if (remainingBudgetMs() >= 5000) {
    try {
      const planRes = await generatePlanFromPromptFast({
        env: c.env,
        prompt: body.prompt,
        source: body.source,
        maxWidgets: body.constraints?.maxWidgets,
        timeoutMs: Math.min(perModelTimeoutMs, remainingBudgetMs()),
      });
      plan = planRes.value;
      modelUsed = planRes.modelUsed;
      fallbackReason = planRes.fallbackReason;
      repairAttempts = planRes.repairAttempts;
    } catch {
      fallbackReason = "plan_generation_failed_template_used";
    }
  } else {
    fallbackReason = "plan_generation_skipped_latency_budget";
  }

  spec = normalizeScenarioSpec(dashboardId, body.prompt, body.source, plan, body.constraints?.maxWidgets);

  if (remainingBudgetMs() >= 7000) {
    try {
      const specRes = await generateSpecFromPlanFast({
        env: c.env,
        prompt: body.prompt,
        source: body.source,
        plan,
        seedSpec: spec,
        timeoutMs: Math.min(perModelTimeoutMs, remainingBudgetMs()),
      });
      spec = specRes.value;
      modelUsed = specRes.modelUsed;
      fallbackReason = specRes.fallbackReason ?? fallbackReason;
      repairAttempts = specRes.repairAttempts;
    } catch {
      fallbackReason = fallbackReason ?? "spec_generation_failed_template_used";
    }
  } else {
    fallbackReason = fallbackReason ?? "spec_generation_skipped_latency_budget";
  }

  await dbUpsertDashboard(c.env, dashboardId, spec);
  await dbCreateShareToken(c.env, dashboardId, shareToken, expiresAt);

  const resp = GenerateDashboardResponseSchema.parse({
    dashboardId,
    shareToken,
    spec,
    generationMeta: {
      modelUsed,
      fallbackReason,
      repairAttempts,
      durationMs: Math.max(0, nowEpochMs() - startedAt),
      scenarioClass: plan.scenarioClass,
    },
  });
  return c.json(resp);
});

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

async function runWorkersAiJson(
  env: Env,
  modelId: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  timeoutOverrideMs?: number,
) {
  // Workers AI supports an OpenAI-like chat interface for many models.
  const configuredTimeoutMs = Number(env.MODEL_TIMEOUT_MS || "25000");
  const timeoutMs = Math.max(1000, Math.floor(timeoutOverrideMs ?? configuredTimeoutMs));
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

async function runModelJsonOneShot<T>(args: {
  env: Env;
  system: string;
  user: string;
  parser: (value: unknown) => T;
  timeoutMs: number;
}) {
  const { env, system, user, parser, timeoutMs } = args;
  const modelUsed = env.PRIMARY_MODEL_ID || "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b";
  const maxTokens = Number(env.MAX_OUTPUT_TOKENS || "1200");
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const raw = await runWorkersAiJson(env, modelUsed, messages, maxTokens, timeoutMs);
  const jsonText = extractJsonObjectText(raw);
  const parsed = JSON.parse(jsonText);
  return {
    value: parser(parsed),
    modelUsed,
    fallbackReason: undefined as string | undefined,
    repairAttempts: 0,
  };
}

async function runModelJsonWithRepair<T>(args: {
  env: Env;
  system: string;
  user: string;
  schemaName: string;
  parser: (value: unknown) => T;
}) {
  const { env, system, user, parser } = args;
  const primaryModelId = env.PRIMARY_MODEL_ID || "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b";
  const fallbackModelId = env.FALLBACK_MODEL_ID || "@cf/qwen/qwq-32b";
  const maxTokens = Number(env.MAX_OUTPUT_TOKENS || "1200");
  const repairMax = Number(env.REPAIR_MAX_ATTEMPTS || "2");

  let modelUsed = primaryModelId;
  let fallbackReason: string | undefined;
  let repairAttempts = 0;

  const baseMessages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  async function attempt(modelId: string, errorHint?: string): Promise<T> {
    const messages = errorHint
      ? [...baseMessages, { role: "user", content: `Your previous response was invalid JSON or failed schema validation: ${errorHint}` }]
      : baseMessages;
    const raw = await runWorkersAiJson(env, modelId, messages, maxTokens);
    const jsonText = extractJsonObjectText(raw);
    const parsed = JSON.parse(jsonText);
    return parser(parsed);
  }

  try {
    return { value: await attempt(primaryModelId), modelUsed, fallbackReason, repairAttempts };
  } catch (e1) {
    let lastErr = e1;
    while (repairAttempts < repairMax) {
      repairAttempts += 1;
      try {
        return {
          value: await attempt(primaryModelId, lastErr instanceof Error ? lastErr.message : String(lastErr)),
          modelUsed,
          fallbackReason,
          repairAttempts,
        };
      } catch (e2) {
        lastErr = e2;
      }
    }

    modelUsed = fallbackModelId;
    fallbackReason = `${args.schemaName}_primary_failed`;
    repairAttempts = 0;
    try {
      return { value: await attempt(fallbackModelId), modelUsed, fallbackReason, repairAttempts };
    } catch (e3) {
      let lastErr2 = e3;
      while (repairAttempts < repairMax) {
        repairAttempts += 1;
        try {
          return {
            value: await attempt(fallbackModelId, lastErr2 instanceof Error ? lastErr2.message : String(lastErr2)),
            modelUsed,
            fallbackReason,
            repairAttempts,
          };
        } catch (e4) {
          lastErr2 = e4;
        }
      }
      throw e3;
    }
  }
}

async function generatePlanFromPrompt(args: {
  env: Env;
  prompt: string;
  source: z.infer<typeof GenerationSourceSchema>;
  maxWidgets?: number;
}) {
  const { env, prompt, source, maxWidgets } = args;
  const scenarioHint = classifyScenarioByPrompt(prompt);
  const system = [
    "You are an analytics planner that turns user intent into a dashboard generation plan.",
    "Return ONLY JSON object. No markdown.",
    "Use one of the scenarioClass values exactly:",
    "sales_funnel_overview, revenue_trend_forecast, win_loss_analysis, regional_performance, top_reps_accounts, pipeline_health, executive_kpi_summary, detail_pivot_companion.",
    "themeId must be atelier or noir.",
    "chartType must be bar, line, or donut.",
    "primaryGroupBy must be one of StageName, OwnerName, Region, CloseMonth, CloseQuarter.",
  ].join("\n");

  const user = [
    `SourceType: ${source.type}`,
    `SuggestedScenario: ${scenarioHint}`,
    `MaxWidgets: ${maxWidgets ?? 6}`,
    `Prompt: ${prompt}`,
  ].join("\n");

  return runModelJsonWithRepair({
    env,
    system,
    user,
    schemaName: "generation_plan",
    parser: (value) => GenerationPlanSchema.parse(value),
  });
}

async function generatePlanFromPromptFast(args: {
  env: Env;
  prompt: string;
  source: z.infer<typeof GenerationSourceSchema>;
  maxWidgets?: number;
  timeoutMs: number;
}) {
  const { env, prompt, source, maxWidgets, timeoutMs } = args;
  const scenarioHint = classifyScenarioByPrompt(prompt);
  const system = [
    "You are an analytics planner that turns user intent into a dashboard generation plan.",
    "Return ONLY JSON object. No markdown.",
    "Use one of the scenarioClass values exactly:",
    "sales_funnel_overview, revenue_trend_forecast, win_loss_analysis, regional_performance, top_reps_accounts, pipeline_health, executive_kpi_summary, detail_pivot_companion.",
    "themeId must be atelier or noir.",
    "chartType must be bar, line, or donut.",
    "primaryGroupBy must be one of StageName, OwnerName, Region, CloseMonth, CloseQuarter.",
  ].join("\n");

  const user = [
    `SourceType: ${source.type}`,
    `SuggestedScenario: ${scenarioHint}`,
    `MaxWidgets: ${maxWidgets ?? 6}`,
    `Prompt: ${prompt}`,
  ].join("\n");

  return runModelJsonOneShot({
    env,
    system,
    user,
    timeoutMs,
    parser: (value) => GenerationPlanSchema.parse(value),
  });
}

async function generateSpecFromPlan(args: {
  env: Env;
  prompt: string;
  source: z.infer<typeof GenerationSourceSchema>;
  plan: z.infer<typeof GenerationPlanSchema>;
  seedSpec: DashboardSpec;
}) {
  const { env, prompt, source, plan, seedSpec } = args;

  const system = [
    "You are an assistant that outputs a full dashboard spec JSON.",
    "Return ONLY valid JSON object, no markdown.",
    "You must keep schema-compatible fields only.",
    "Supported chart type: bar|line|donut.",
    "Supported widget kinds: d3_chart, pivot_table, spreadsheet, kpi, text.",
    "Ensure each widget id appears in layout.widgetId.",
    "Keep dataRequests keys referenced by widgets.dataRef.",
    "Keep rows<=200 and cols<=50 for spreadsheet widget.",
  ].join("\n");

  const user = [
    `Prompt: ${prompt}`,
    `SourceType: ${source.type}`,
    `Plan: ${JSON.stringify(plan)}`,
    `SeedSpec: ${JSON.stringify(seedSpec)}`,
    "Improve SeedSpec to better match prompt while staying in schema and supported fields.",
  ].join("\n");

  return runModelJsonWithRepair({
    env,
    system,
    user,
    schemaName: "generation_spec",
    parser: (value) => DashboardSpecSchema.parse(value),
  });
}

async function generateSpecFromPlanFast(args: {
  env: Env;
  prompt: string;
  source: z.infer<typeof GenerationSourceSchema>;
  plan: z.infer<typeof GenerationPlanSchema>;
  seedSpec: DashboardSpec;
  timeoutMs: number;
}) {
  const { env, prompt, source, plan, seedSpec, timeoutMs } = args;

  const system = [
    "You are an assistant that outputs a full dashboard spec JSON.",
    "Return ONLY valid JSON object, no markdown.",
    "You must keep schema-compatible fields only.",
    "Supported chart type: bar|line|donut.",
    "Supported widget kinds: d3_chart, pivot_table, spreadsheet, kpi, text.",
    "Ensure each widget id appears in layout.widgetId.",
    "Keep dataRequests keys referenced by widgets.dataRef.",
    "Keep rows<=200 and cols<=50 for spreadsheet widget.",
  ].join("\n");

  const user = [
    `Prompt: ${prompt}`,
    `SourceType: ${source.type}`,
    `Plan: ${JSON.stringify(plan)}`,
    `SeedSpec: ${JSON.stringify(seedSpec)}`,
    "Improve SeedSpec to better match prompt while staying in schema and supported fields.",
  ].join("\n");

  return runModelJsonOneShot({
    env,
    system,
    user,
    timeoutMs,
    parser: (value) => DashboardSpecSchema.parse(value),
  });
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
    const nextType: "bar" | "line" | "donut" = wantsDonut ? "donut" : wantsLine ? "line" : "bar";
    const widgets: DashboardSpec["widgets"] = currentSpec.widgets.map((w) =>
      w.kind === "d3_chart" ? { ...w, chart: { ...w.chart, type: nextType } } : w,
    );
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

  if (req.kind === "salesforce_soql_guarded") {
    // MVP fallback: until connector execution is wired, serve demo opportunity-like rows.
    // This keeps generated dashboards renderable for "salesforce" source selection.
    return c.json({
      rows: demoOpportunities(),
      schema: { fields: Object.keys(demoOpportunities()[0] ?? {}) },
      warning: "salesforce_connector_not_wired_using_demo_rows",
    });
  }

  return c.json({ error: "not implemented" }, 501);
});

export default app;
