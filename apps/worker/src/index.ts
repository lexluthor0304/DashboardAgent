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
  SF_LOGIN_URL_SANDBOX?: string;
  SF_LOGIN_URL_PRODUCTION?: string;
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

const SalesforceStartRequestSchema = z.object({
  dashboardId: z.string().min(1),
  token: z.string().min(1),
  environment: z.enum(["sandbox", "production"]).default("sandbox"),
});

const SalesforceStartResponseSchema = z.object({
  connectorId: z.string(),
  authorizeUrl: z.string().url(),
  expiresAt: z.number().int().positive(),
});

const SalesforceStatusResponseSchema = z.object({
  connected: z.boolean(),
  connectorId: z.string().optional(),
  environment: z.enum(["sandbox", "production"]).optional(),
  status: z.enum(["pending", "connected", "error", "revoked"]).optional(),
  instanceUrl: z.string().url().optional(),
  orgId: z.string().optional(),
  userId: z.string().optional(),
  lastSyncAt: z.number().int().positive().optional(),
  error: z.string().optional(),
});

const SalesforceConnectorSummarySchema = z.object({
  id: z.string(),
  environment: z.enum(["sandbox", "production"]),
  status: z.enum(["pending", "connected", "error", "revoked"]),
  instanceUrl: z.string().url().optional(),
  orgId: z.string().optional(),
  userId: z.string().optional(),
  updatedAt: z.number().int().positive(),
});

const SalesforceConnectorListResponseSchema = z.object({
  connectors: z.array(SalesforceConnectorSummarySchema),
  activeConnectorId: z.string().optional(),
});

const SalesforceActivateRequestSchema = z.object({
  dashboardId: z.string().min(1),
  token: z.string().min(1),
  connectorId: z.string().min(1),
});

const SalesforceActivateResponseSchema = z.object({
  ok: z.literal(true),
  activeConnectorId: z.string(),
  activeEnvironment: z.enum(["sandbox", "production"]),
});

const SalesforceQueryRequestSchema = z.object({
  dashboardId: z.string().min(1),
  token: z.string().min(1),
  soql: z.string().min(1).max(10000),
  maxRows: z.number().int().min(1).max(5000).optional(),
});

const SalesforceQueryResponseSchema = z.object({
  rows: z.array(z.record(z.any())),
  totalSize: z.number().int().nonnegative(),
  done: z.boolean(),
  nextRecordsUrl: z.string().optional(),
  connectorId: z.string().optional(),
  environment: z.enum(["sandbox", "production"]).optional(),
  requestId: z.string().optional(),
});

type SfConnectorStatus = "pending" | "connected" | "error" | "revoked";
type SfEnvironment = "sandbox" | "production";

type SfConnectorRow = {
  id: string;
  dashboard_id: string;
  environment: "sandbox" | "production";
  status: SfConnectorStatus;
  instance_url: string | null;
  org_id: string | null;
  user_id: string | null;
  refresh_token_enc: string | null;
  access_token_enc: string | null;
  token_expires_at: number | null;
  scopes: string | null;
  created_at: number;
  updated_at: number;
};

type SfActiveEnvRow = {
  dashboard_id: string;
  active_connector_id: string;
  active_environment: SfEnvironment;
  updated_at: number;
};

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

const SALESFORCE_API_VERSION = "v62.0";

function loginHostForEnvironment(env: Env, environment: SfEnvironment) {
  const raw =
    environment === "production"
      ? (env.SF_LOGIN_URL_PRODUCTION || "https://login.salesforce.com").trim()
      : (env.SF_LOGIN_URL_SANDBOX || env.SF_LOGIN_URL || "https://test.salesforce.com").trim();
  return raw.replace(/\/+$/, "");
}

function requireSfConfig(env: Env) {
  if (!env.SF_CLIENT_ID || !env.SF_CLIENT_SECRET || !env.SF_REDIRECT_URI) {
    throw new Error("missing_salesforce_oauth_config");
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(s: string) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function getEncryptionKeyRaw(env: Env) {
  const key = env.ENCRYPTION_KEY?.trim();
  if (!key) throw new Error("missing_encryption_key");
  return key;
}

async function importAesGcmKey(env: Env) {
  const raw = getEncryptionKeyRaw(env);
  const keyBytes = base64ToBytes(raw);
  if (keyBytes.length !== 32) throw new Error("invalid_encryption_key_length");
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptSecret(env: Env, plaintext: string) {
  const key = await importAesGcmKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  return `${bytesToBase64(iv)}.${bytesToBase64(encrypted)}`;
}

async function decryptSecret(env: Env, encoded: string) {
  const parts = encoded.split(".");
  if (parts.length !== 2) throw new Error("invalid_secret_encoding");
  const iv = base64ToBytes(parts[0]!);
  const cipher = base64ToBytes(parts[1]!);
  const key = await importAesGcmKey(env);
  const out = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new TextDecoder().decode(out);
}

function extractOrgUserFromIdentityUrl(identityUrl: string | null | undefined) {
  if (!identityUrl) return { orgId: null as string | null, userId: null as string | null };
  const m = /\/id\/([^/]+)\/([^/]+)$/.exec(identityUrl);
  return { orgId: m?.[1] ?? null, userId: m?.[2] ?? null };
}

function sanitizeSoqlSelect(input: string, maxRows: number) {
  const trimmed = input.trim().replace(/\s+/g, " ");
  if (!/^select\b/i.test(trimmed)) throw new Error("invalid_soql_only_select_allowed");
  if (trimmed.includes(";")) throw new Error("invalid_soql_multistatement_not_allowed");
  if (/\b(insert|update|delete|upsert|merge|truncate|drop|alter|create)\b/i.test(trimmed)) {
    throw new Error("invalid_soql_contains_mutation_keywords");
  }
  const limitMatch = /\blimit\s+(\d+)\b/i.exec(trimmed);
  if (!limitMatch) return `${trimmed} LIMIT ${maxRows}`;
  const requested = Number(limitMatch[1]);
  if (!Number.isFinite(requested) || requested <= 0) throw new Error("invalid_soql_limit");
  if (requested <= maxRows) return trimmed;
  return trimmed.replace(/\blimit\s+\d+\b/i, `LIMIT ${maxRows}`);
}

function buildOpportunitySoqlFromRequest(requestQuery: unknown) {
  const q = (requestQuery && typeof requestQuery === "object" ? requestQuery : {}) as Record<string, unknown>;
  if (typeof q.soql === "string" && q.soql.trim().length > 0) return q.soql;
  const maxRows = Math.min(5000, Math.max(1, Number(q.limit ?? 2000) || 2000));
  return [
    "SELECT Id, Name, StageName, Amount, CloseDate, IsWon,",
    "Owner.Name, Account.Name, Account.BillingCountry",
    "FROM Opportunity",
    "ORDER BY CloseDate DESC",
    `LIMIT ${maxRows}`,
  ].join(" ");
}

function soqlPreview(soql: string) {
  return soql.replace(/\s+/g, " ").trim().slice(0, 200);
}

async function dbResolveActiveSfConnector(env: Env, dashboardId: string): Promise<SfConnectorRow | null> {
  const active = await dbGetActiveSfEnvRow(env, dashboardId);
  if (!active) return null;
  const connector = await dbGetSfConnectorById(env, active.active_connector_id);
  if (!connector) return null;
  if (connector.dashboard_id !== dashboardId) return null;
  return connector;
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

async function dbCleanupExpiredOauthStates(env: Env) {
  await env.DB.prepare("DELETE FROM connector_oauth_states WHERE expires_at <= ?").bind(nowEpochMs()).run();
}

async function dbUpsertSfConnector(
  env: Env,
  row: {
    id: string;
    dashboardId: string;
    environment: "sandbox" | "production";
    status: SfConnectorStatus;
    instanceUrl?: string | null;
    orgId?: string | null;
    userId?: string | null;
    refreshTokenEnc?: string | null;
    accessTokenEnc?: string | null;
    tokenExpiresAt?: number | null;
    scopes?: string | null;
  },
) {
  const ts = nowEpochMs();
  await env.DB.prepare(
    "INSERT INTO sf_connectors(" +
      "id, dashboard_id, environment, status, instance_url, org_id, user_id, refresh_token_enc, access_token_enc, token_expires_at, scopes, created_at, updated_at" +
      ") VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET " +
      "dashboard_id=excluded.dashboard_id, environment=excluded.environment, status=excluded.status, instance_url=excluded.instance_url, " +
      "org_id=excluded.org_id, user_id=excluded.user_id, refresh_token_enc=excluded.refresh_token_enc, access_token_enc=excluded.access_token_enc, " +
      "token_expires_at=excluded.token_expires_at, scopes=excluded.scopes, updated_at=excluded.updated_at",
  )
    .bind(
      row.id,
      row.dashboardId,
      row.environment,
      row.status,
      row.instanceUrl ?? null,
      row.orgId ?? null,
      row.userId ?? null,
      row.refreshTokenEnc ?? null,
      row.accessTokenEnc ?? null,
      row.tokenExpiresAt ?? null,
      row.scopes ?? null,
      ts,
      ts,
    )
    .run();
}

async function dbGetSfConnectorById(env: Env, connectorId: string): Promise<SfConnectorRow | null> {
  const row = await env.DB.prepare(
    "SELECT id, dashboard_id, environment, status, instance_url, org_id, user_id, refresh_token_enc, access_token_enc, token_expires_at, scopes, created_at, updated_at " +
      "FROM sf_connectors WHERE id = ? LIMIT 1",
  )
    .bind(connectorId)
    .first<SfConnectorRow>();
  return row ?? null;
}

async function dbGetLatestSfConnectorByDashboard(env: Env, dashboardId: string): Promise<SfConnectorRow | null> {
  const row = await env.DB.prepare(
    "SELECT id, dashboard_id, environment, status, instance_url, org_id, user_id, refresh_token_enc, access_token_enc, token_expires_at, scopes, created_at, updated_at " +
      "FROM sf_connectors WHERE dashboard_id = ? ORDER BY updated_at DESC LIMIT 1",
  )
    .bind(dashboardId)
    .first<SfConnectorRow>();
  return row ?? null;
}

async function dbListSfConnectorsByDashboard(env: Env, dashboardId: string): Promise<SfConnectorRow[]> {
  const result = await env.DB.prepare(
    "SELECT id, dashboard_id, environment, status, instance_url, org_id, user_id, refresh_token_enc, access_token_enc, token_expires_at, scopes, created_at, updated_at " +
      "FROM sf_connectors WHERE dashboard_id = ? ORDER BY updated_at DESC",
  )
    .bind(dashboardId)
    .all<SfConnectorRow>();
  return (result.results ?? []) as SfConnectorRow[];
}

async function dbGetActiveSfEnvRow(env: Env, dashboardId: string): Promise<SfActiveEnvRow | null> {
  const row = await env.DB.prepare(
    "SELECT dashboard_id, active_connector_id, active_environment, updated_at FROM dashboard_sf_active_env WHERE dashboard_id = ? LIMIT 1",
  )
    .bind(dashboardId)
    .first<SfActiveEnvRow>();
  return row ?? null;
}

async function dbSetActiveSfConnector(env: Env, args: { dashboardId: string; connectorId: string; environment: SfEnvironment }) {
  const ts = nowEpochMs();
  await env.DB.prepare(
    "INSERT INTO dashboard_sf_active_env(dashboard_id, active_connector_id, active_environment, updated_at) VALUES(?, ?, ?, ?) " +
      "ON CONFLICT(dashboard_id) DO UPDATE SET active_connector_id = excluded.active_connector_id, active_environment = excluded.active_environment, updated_at = excluded.updated_at",
  )
    .bind(args.dashboardId, args.connectorId, args.environment, ts)
    .run();
}

async function dbInsertSfQueryAuditLog(
  env: Env,
  args: {
    id: string;
    dashboardId: string;
    connectorId?: string | null;
    environment?: SfEnvironment | null;
    orgId?: string | null;
    userId?: string | null;
    requestId: string;
    soqlHash?: string | null;
    soqlPreview?: string | null;
    rowCount?: number | null;
    durationMs?: number | null;
    status: "success" | "blocked" | "upstream_error";
    errorCode?: string | null;
  },
) {
  await env.DB.prepare(
    "INSERT INTO sf_query_audit_logs(" +
      "id, dashboard_id, connector_id, environment, org_id, user_id, request_id, soql_hash, soql_preview, row_count, duration_ms, status, error_code, created_at" +
      ") VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      args.id,
      args.dashboardId,
      args.connectorId ?? null,
      args.environment ?? null,
      args.orgId ?? null,
      args.userId ?? null,
      args.requestId,
      args.soqlHash ?? null,
      args.soqlPreview ?? null,
      args.rowCount ?? null,
      args.durationMs ?? null,
      args.status,
      args.errorCode ?? null,
      nowEpochMs(),
    )
    .run();
}

async function dbInsertOauthState(
  env: Env,
  args: { state: string; dashboardId: string; connectorId: string; expiresAt: number },
) {
  await env.DB.prepare(
    "INSERT INTO connector_oauth_states(state, dashboard_id, connector_id, expires_at, created_at) VALUES(?, ?, ?, ?, ?)",
  )
    .bind(args.state, args.dashboardId, args.connectorId, args.expiresAt, nowEpochMs())
    .run();
}

async function dbTakeOauthState(env: Env, state: string) {
  const row = await env.DB.prepare(
    "SELECT state, dashboard_id, connector_id, expires_at FROM connector_oauth_states WHERE state = ? LIMIT 1",
  )
    .bind(state)
    .first<{ state: string; dashboard_id: string; connector_id: string; expires_at: number }>();
  if (!row) return null;
  await env.DB.prepare("DELETE FROM connector_oauth_states WHERE state = ?").bind(state).run();
  if (row.expires_at <= nowEpochMs()) return null;
  return row;
}

async function dbRequireDashboardAccess(env: Env, dashboardId: string, token: string) {
  if (!(await dbVerifyShareToken(env, dashboardId, token))) throw new Error("invalid_dashboard_token");
}

function extractTokenFromRequest(req: Request, fallback?: string): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice("bearer ".length).trim();
  if (fallback) return fallback;
  return null;
}

async function salesforceTokenRequest(env: Env, environment: SfEnvironment, form: URLSearchParams) {
  const res = await fetch(`${loginHostForEnvironment(env, environment)}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = typeof json.error_description === "string" ? json.error_description : typeof json.error === "string" ? json.error : "oauth_failed";
    throw new Error(`salesforce_oauth_failed:${err}`);
  }
  return json;
}

async function exchangeAuthCodeForTokens(env: Env, environment: SfEnvironment, code: string) {
  requireSfConfig(env);
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("client_id", env.SF_CLIENT_ID!);
  form.set("client_secret", env.SF_CLIENT_SECRET!);
  form.set("redirect_uri", env.SF_REDIRECT_URI!);
  form.set("code", code);
  return salesforceTokenRequest(env, environment, form);
}

async function refreshSfAccessToken(env: Env, connector: SfConnectorRow) {
  requireSfConfig(env);
  if (!connector.refresh_token_enc) throw new Error("salesforce_refresh_token_missing");
  const refreshToken = await decryptSecret(env, connector.refresh_token_enc);
  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("client_id", env.SF_CLIENT_ID!);
  form.set("client_secret", env.SF_CLIENT_SECRET!);
  form.set("refresh_token", refreshToken);
  const refreshed = await salesforceTokenRequest(env, connector.environment, form);
  const accessToken = String(refreshed.access_token ?? "");
  if (!accessToken) throw new Error("salesforce_access_token_missing");
  const accessTokenEnc = await encryptSecret(env, accessToken);
  const instanceUrl = typeof refreshed.instance_url === "string" ? refreshed.instance_url : connector.instance_url;
  await dbUpsertSfConnector(env, {
    id: connector.id,
    dashboardId: connector.dashboard_id,
    environment: connector.environment,
    status: "connected",
    instanceUrl,
    orgId: connector.org_id,
    userId: connector.user_id,
    refreshTokenEnc: connector.refresh_token_enc,
    accessTokenEnc,
    tokenExpiresAt: nowEpochMs() + 55 * 60 * 1000,
    scopes: connector.scopes,
  });
  const latest = await dbGetSfConnectorById(env, connector.id);
  if (!latest) throw new Error("connector_not_found_after_refresh");
  return latest;
}

async function runSalesforceSoql(env: Env, connector: SfConnectorRow, soql: string) {
  let active = connector;
  if (!active.instance_url) throw new Error("salesforce_instance_url_missing");
  if (!active.access_token_enc || !active.token_expires_at || active.token_expires_at <= nowEpochMs() + 15_000) {
    active = await refreshSfAccessToken(env, active);
  }

  async function queryOnce(withConnector: SfConnectorRow) {
    if (!withConnector.access_token_enc) throw new Error("salesforce_access_token_missing");
    if (!withConnector.instance_url) throw new Error("salesforce_instance_url_missing");
    const accessToken = await decryptSecret(env, withConnector.access_token_enc);
    const queryUrl = `${withConnector.instance_url}/services/data/${SALESFORCE_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
    const res = await fetch(queryUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const firstErr = Array.isArray(json) ? (json[0] as any) : null;
      const code = firstErr?.errorCode ?? (json as any)?.errorCode;
      const message = firstErr?.message ?? (json as any)?.message ?? "salesforce_query_failed";
      const err = new Error(`salesforce_query_failed:${message}`);
      (err as any).sfErrorCode = code;
      throw err;
    }
    return json;
  }

  try {
    return await queryOnce(active);
  } catch (e) {
    const code = (e as any)?.sfErrorCode;
    if (code === "INVALID_SESSION_ID") {
      const refreshed = await refreshSfAccessToken(env, active);
      return queryOnce(refreshed);
    }
    throw e;
  }
}

function toDashboardRowsFromSf(records: unknown[]) {
  return records.map((r) => {
    const rec = (r && typeof r === "object" ? r : {}) as Record<string, any>;
    const account = (rec.Account && typeof rec.Account === "object" ? rec.Account : {}) as Record<string, any>;
    const owner = (rec.Owner && typeof rec.Owner === "object" ? rec.Owner : {}) as Record<string, any>;
    return {
      Id: rec.Id ?? null,
      Name: rec.Name ?? null,
      StageName: rec.StageName ?? null,
      Amount: typeof rec.Amount === "number" ? rec.Amount : Number(rec.Amount ?? 0) || 0,
      CloseDate: rec.CloseDate ?? null,
      OwnerName: owner.Name ?? rec.OwnerName ?? null,
      Region: account.BillingCountry ?? rec.Region ?? null,
      AccountName: account.Name ?? null,
      IsWon: rec.IsWon ?? null,
    };
  });
}

async function startSalesforceConnector(
  c: { env: Env; req: { raw: Request }; json: (body: unknown, status?: number) => Response },
  body: z.infer<typeof SalesforceStartRequestSchema>,
) {
  const token = extractTokenFromRequest(c.req.raw, body.token);
  if (!token) return c.json({ error: "missing token" }, 401);
  try {
    await dbRequireDashboardAccess(c.env, body.dashboardId, token);
    requireSfConfig(c.env);
    getEncryptionKeyRaw(c.env);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "invalid_request";
    if (msg === "invalid_dashboard_token") return c.json({ error: "invalid token" }, 403);
    if (msg === "missing_salesforce_oauth_config") return c.json({ error: "missing_salesforce_oauth_config" }, 500);
    if (msg === "missing_encryption_key") return c.json({ error: "missing_encryption_key" }, 500);
    return c.json({ error: "connector_start_failed" }, 400);
  }

  await dbCleanupExpiredOauthStates(c.env);
  const connectorId = randomId("sfconn");
  const state = randomId("sfoauth");
  const expiresAt = nowEpochMs() + 10 * 60 * 1000;
  await dbUpsertSfConnector(c.env, {
    id: connectorId,
    dashboardId: body.dashboardId,
    environment: body.environment,
    status: "pending",
  });
  await dbInsertOauthState(c.env, { state, dashboardId: body.dashboardId, connectorId, expiresAt });

  const authUrl = new URL(`${loginHostForEnvironment(c.env, body.environment)}/services/oauth2/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", c.env.SF_CLIENT_ID!);
  authUrl.searchParams.set("redirect_uri", c.env.SF_REDIRECT_URI!);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", "api refresh_token");
  authUrl.searchParams.set("prompt", "consent");

  const resp = SalesforceStartResponseSchema.parse({
    connectorId,
    authorizeUrl: authUrl.toString(),
    expiresAt,
  });
  return c.json(resp);
}

async function executeConnectorSoqlWithAudit(args: {
  env: Env;
  dashboardId: string;
  connector: SfConnectorRow;
  rawSoql: string;
  maxRows: number;
  requestId: string;
}) {
  const { env, dashboardId, connector, rawSoql, maxRows, requestId } = args;
  const startedAt = nowEpochMs();
  const preview = soqlPreview(rawSoql);
  const previewHash = await sha256Hex(rawSoql);

  let guardedSoql = "";
  try {
    guardedSoql = sanitizeSoqlSelect(rawSoql, maxRows);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "invalid_soql";
    await dbInsertSfQueryAuditLog(env, {
      id: randomId("audit"),
      dashboardId,
      connectorId: connector.id,
      environment: connector.environment,
      orgId: connector.org_id,
      userId: connector.user_id,
      requestId,
      soqlHash: previewHash,
      soqlPreview: preview,
      status: "blocked",
      errorCode: msg,
      durationMs: Math.max(0, nowEpochMs() - startedAt),
    });
    return {
      status: 400 as const,
      body: { error: msg, requestId },
    };
  }

  try {
    const data = await runSalesforceSoql(env, connector, guardedSoql);
    const records = Array.isArray((data as any).records) ? ((data as any).records as unknown[]) : [];
    const rows = toDashboardRowsFromSf(records);
    await dbInsertSfQueryAuditLog(env, {
      id: randomId("audit"),
      dashboardId,
      connectorId: connector.id,
      environment: connector.environment,
      orgId: connector.org_id,
      userId: connector.user_id,
      requestId,
      soqlHash: await sha256Hex(guardedSoql),
      soqlPreview: soqlPreview(guardedSoql),
      rowCount: rows.length,
      durationMs: Math.max(0, nowEpochMs() - startedAt),
      status: "success",
    });
    const body = SalesforceQueryResponseSchema.parse({
      rows,
      totalSize: Number((data as any).totalSize ?? rows.length),
      done: Boolean((data as any).done ?? true),
      nextRecordsUrl: typeof (data as any).nextRecordsUrl === "string" ? (data as any).nextRecordsUrl : undefined,
      connectorId: connector.id,
      environment: connector.environment,
      requestId,
    });
    return { status: 200 as const, body };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "salesforce_query_failed";
    await dbInsertSfQueryAuditLog(env, {
      id: randomId("audit"),
      dashboardId,
      connectorId: connector.id,
      environment: connector.environment,
      orgId: connector.org_id,
      userId: connector.user_id,
      requestId,
      soqlHash: await sha256Hex(guardedSoql || rawSoql),
      soqlPreview: soqlPreview(guardedSoql || rawSoql),
      durationMs: Math.max(0, nowEpochMs() - startedAt),
      status: "upstream_error",
      errorCode: msg,
    });
    return {
      status: 502 as const,
      body: { error: msg, requestId },
    };
  }
}

app.get("/api/health", (c) => c.json({ ok: true, ts: nowEpochMs() }));

app.post("/api/connectors/salesforce/start", async (c) => {
  const body = SalesforceStartRequestSchema.parse(await c.req.json());
  return startSalesforceConnector(c, body);
});

app.post("/api/connectors/salesforce/sandbox/start", async (c) => {
  const raw = (await c.req.json()) as Record<string, unknown>;
  const body = SalesforceStartRequestSchema.parse({ ...raw, environment: "sandbox" });
  return startSalesforceConnector(c, body);
});

app.get("/api/connectors/salesforce/callback", async (c) => {
  const url = new URL(c.req.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const sfError = url.searchParams.get("error");
  const sfErrorDesc = url.searchParams.get("error_description");

  if (sfError) {
    return c.html(
      `<html><body><h3>Salesforce connection failed</h3><pre>${sfError}${sfErrorDesc ? `: ${sfErrorDesc}` : ""}</pre></body></html>`,
      400,
    );
  }
  if (!state || !code) return c.html("<html><body><h3>Missing code/state</h3></body></html>", 400);

  const stateRow = await dbTakeOauthState(c.env, state);
  if (!stateRow) return c.html("<html><body><h3>State expired or invalid</h3></body></html>", 400);

  const connector = await dbGetSfConnectorById(c.env, stateRow.connector_id);
  if (!connector) return c.html("<html><body><h3>Connector not found</h3></body></html>", 404);

  try {
    const tokens = await exchangeAuthCodeForTokens(c.env, connector.environment, code);
    const accessToken = String(tokens.access_token ?? "");
    const refreshTokenRaw = typeof tokens.refresh_token === "string" ? tokens.refresh_token : null;
    const instanceUrl = typeof tokens.instance_url === "string" ? tokens.instance_url : connector.instance_url;
    if (!accessToken || !instanceUrl) throw new Error("salesforce_token_exchange_missing_values");
    const refreshToken = refreshTokenRaw ?? (connector.refresh_token_enc ? await decryptSecret(c.env, connector.refresh_token_enc) : null);
    if (!refreshToken) throw new Error("salesforce_refresh_token_missing");

    const accessTokenEnc = await encryptSecret(c.env, accessToken);
    const refreshTokenEnc = await encryptSecret(c.env, refreshToken);
    const idUrl = typeof tokens.id === "string" ? tokens.id : null;
    const ids = extractOrgUserFromIdentityUrl(idUrl);
    const scopes = typeof tokens.scope === "string" ? tokens.scope : connector.scopes;
    await dbUpsertSfConnector(c.env, {
      id: connector.id,
      dashboardId: connector.dashboard_id,
      environment: connector.environment,
      status: "connected",
      instanceUrl,
      orgId: ids.orgId,
      userId: ids.userId,
      refreshTokenEnc,
      accessTokenEnc,
      tokenExpiresAt: nowEpochMs() + 55 * 60 * 1000,
      scopes,
    });
    await dbSetActiveSfConnector(c.env, {
      dashboardId: connector.dashboard_id,
      connectorId: connector.id,
      environment: connector.environment,
    });
    return c.html(
      `<html><body><h3>Salesforce ${connector.environment} connected.</h3><p>You can return to the dashboard editor.</p><script>setTimeout(()=>window.close(),900);</script></body></html>`,
      200,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "oauth_exchange_failed";
    await dbUpsertSfConnector(c.env, {
      id: connector.id,
      dashboardId: connector.dashboard_id,
      environment: connector.environment,
      status: "error",
      instanceUrl: connector.instance_url,
      orgId: connector.org_id,
      userId: connector.user_id,
      refreshTokenEnc: connector.refresh_token_enc,
      accessTokenEnc: connector.access_token_enc,
      tokenExpiresAt: connector.token_expires_at,
      scopes: connector.scopes,
    });
    return c.html(`<html><body><h3>Connection failed</h3><pre>${msg}</pre></body></html>`, 500);
  }
});

app.get("/api/connectors/salesforce/status", async (c) => {
  const url = new URL(c.req.url);
  const dashboardId = url.searchParams.get("dashboardId") ?? "";
  const token = extractTokenFromRequest(c.req.raw, url.searchParams.get("token") ?? undefined);
  if (!dashboardId) return c.json({ error: "missing dashboardId" }, 400);
  if (!token) return c.json({ error: "missing token" }, 401);
  if (!(await dbVerifyShareToken(c.env, dashboardId, token))) return c.json({ error: "invalid token" }, 403);
  const active = await dbResolveActiveSfConnector(c.env, dashboardId);
  const connector = active ?? (await dbGetLatestSfConnectorByDashboard(c.env, dashboardId));
  if (!connector) {
    const resp = SalesforceStatusResponseSchema.parse({ connected: false });
    return c.json(resp);
  }
  const resp = SalesforceStatusResponseSchema.parse({
    connected: connector.status === "connected",
    connectorId: connector.id,
    environment: connector.environment,
    status: connector.status,
    instanceUrl: connector.instance_url ?? undefined,
    orgId: connector.org_id ?? undefined,
    userId: connector.user_id ?? undefined,
    lastSyncAt: connector.updated_at,
  });
  return c.json(resp);
});

app.get("/api/connectors/salesforce/list", async (c) => {
  const url = new URL(c.req.url);
  const dashboardId = url.searchParams.get("dashboardId") ?? "";
  const token = extractTokenFromRequest(c.req.raw, url.searchParams.get("token") ?? undefined);
  if (!dashboardId) return c.json({ error: "missing dashboardId" }, 400);
  if (!token) return c.json({ error: "missing token" }, 401);
  if (!(await dbVerifyShareToken(c.env, dashboardId, token))) return c.json({ error: "invalid token" }, 403);
  const connectors = await dbListSfConnectorsByDashboard(c.env, dashboardId);
  const active = await dbGetActiveSfEnvRow(c.env, dashboardId);
  const resp = SalesforceConnectorListResponseSchema.parse({
    connectors: connectors.map((conn) => ({
      id: conn.id,
      environment: conn.environment,
      status: conn.status,
      instanceUrl: conn.instance_url ?? undefined,
      orgId: conn.org_id ?? undefined,
      userId: conn.user_id ?? undefined,
      updatedAt: conn.updated_at,
    })),
    activeConnectorId: active?.active_connector_id ?? undefined,
  });
  return c.json(resp);
});

app.post("/api/connectors/salesforce/activate", async (c) => {
  const body = SalesforceActivateRequestSchema.parse(await c.req.json());
  const token = extractTokenFromRequest(c.req.raw, body.token);
  if (!token) return c.json({ error: "missing token" }, 401);
  if (!(await dbVerifyShareToken(c.env, body.dashboardId, token))) return c.json({ error: "invalid token" }, 403);
  const connector = await dbGetSfConnectorById(c.env, body.connectorId);
  if (!connector || connector.dashboard_id !== body.dashboardId) return c.json({ error: "connector_not_found" }, 404);
  if (connector.status !== "connected") return c.json({ error: "connector_not_connected" }, 409);
  await dbSetActiveSfConnector(c.env, {
    dashboardId: body.dashboardId,
    connectorId: connector.id,
    environment: connector.environment,
  });
  const resp = SalesforceActivateResponseSchema.parse({
    ok: true,
    activeConnectorId: connector.id,
    activeEnvironment: connector.environment,
  });
  return c.json(resp);
});

app.post("/api/connectors/:connectorId/query", async (c) => {
  const connectorId = c.req.param("connectorId");
  const body = SalesforceQueryRequestSchema.parse(await c.req.json());
  const token = extractTokenFromRequest(c.req.raw, body.token);
  if (!token) return c.json({ error: "missing token" }, 401);
  if (!(await dbVerifyShareToken(c.env, body.dashboardId, token))) return c.json({ error: "invalid token" }, 403);
  const connector = await dbGetSfConnectorById(c.env, connectorId);
  if (!connector || connector.dashboard_id !== body.dashboardId) return c.json({ error: "connector_not_found" }, 404);
  if (connector.status !== "connected") return c.json({ error: "connector_not_connected" }, 409);
  const requestId = randomId("req");
  const result = await executeConnectorSoqlWithAudit({
    env: c.env,
    dashboardId: body.dashboardId,
    connector,
    rawSoql: body.soql,
    maxRows: Math.min(5000, body.maxRows ?? 2000),
    requestId,
  });
  return c.json(result.body, result.status);
});

app.post("/api/connectors/salesforce/query-active", async (c) => {
  const body = SalesforceQueryRequestSchema.parse(await c.req.json());
  const token = extractTokenFromRequest(c.req.raw, body.token);
  if (!token) return c.json({ error: "missing token" }, 401);
  if (!(await dbVerifyShareToken(c.env, body.dashboardId, token))) return c.json({ error: "invalid token" }, 403);

  const connector = await dbResolveActiveSfConnector(c.env, body.dashboardId);
  if (!connector || connector.status !== "connected") {
    return c.json({ error: "salesforce_active_connector_missing", action: "connect_or_activate" }, 409);
  }
  const requestId = randomId("req");
  const result = await executeConnectorSoqlWithAudit({
    env: c.env,
    dashboardId: body.dashboardId,
    connector,
    rawSoql: body.soql,
    maxRows: Math.min(5000, body.maxRows ?? 2000),
    requestId,
  });
  return c.json(result.body, result.status);
});

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

  if (modelUsed !== "template" && remainingBudgetMs() >= 7000) {
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
  } else if (modelUsed === "template") {
    fallbackReason = fallbackReason ?? "spec_generation_skipped_no_model_plan";
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
  schemaName: string;
  parser: (value: unknown) => T;
  timeoutMs: number;
}) {
  const { env, system, user, schemaName, parser, timeoutMs } = args;
  const primaryModelId = env.PRIMARY_MODEL_ID || "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b";
  const fallbackModelId = env.FALLBACK_MODEL_ID || "@cf/qwen/qwq-32b";
  const maxTokens = Number(env.MAX_OUTPUT_TOKENS || "1200");
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  async function attempt(modelId: string) {
    const raw = await runWorkersAiJson(env, modelId, messages, maxTokens, timeoutMs);
    const jsonText = extractJsonObjectText(raw);
    const parsed = JSON.parse(jsonText);
    return parser(parsed);
  }

  try {
    return {
      value: await attempt(primaryModelId),
      modelUsed: primaryModelId,
      fallbackReason: undefined as string | undefined,
      repairAttempts: 0,
    };
  } catch {
    return {
      value: await attempt(fallbackModelId),
      modelUsed: fallbackModelId,
      fallbackReason: `${schemaName}_primary_failed`,
      repairAttempts: 0,
    };
  }
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
    schemaName: "generation_plan",
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
    schemaName: "generation_spec",
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
    const connector = await dbResolveActiveSfConnector(c.env, dashboardId);
    if (!connector || connector.status !== "connected") {
      return c.json({ error: "salesforce_connector_missing", action: "connect_or_activate" }, 409);
    }
    const soqlRaw = buildOpportunitySoqlFromRequest(req.query);
    const maxRows = Math.min(5000, Math.max(1, Number((req.query as any)?.limit ?? 2000) || 2000));
    const requestId = randomId("req");
    const result = await executeConnectorSoqlWithAudit({
      env: c.env,
      dashboardId,
      connector,
      rawSoql: soqlRaw,
      maxRows,
      requestId,
    });
    if (result.status !== 200) return c.json(result.body, result.status);
    const rows = (result.body as any).rows as any[];
    return c.json({
      rows,
      schema: { fields: Object.keys(rows[0] ?? {}) },
      totalSize: (result.body as any).totalSize,
      done: (result.body as any).done,
      requestId,
      dataSourceMeta: {
        connectorId: connector.id,
        environment: connector.environment,
      },
    });
  }

  return c.json({ error: "not implemented" }, 501);
});

export default app;
