export type LayoutItem = {
  widgetId: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type D3ChartSpec = {
  type: "bar" | "line" | "donut";
  xField: string;
  yField: string;
  seriesField?: string;
};

export type WidgetBase = {
  id: string;
};

export type D3ChartWidget = WidgetBase & {
  kind: "d3_chart";
  title: string;
  dataRef: string;
  transformRef?: string;
  chart: D3ChartSpec;
};

export type PivotTableWidget = WidgetBase & {
  kind: "pivot_table";
  title: string;
  dataRef: string;
  transformRef: string;
};

export type SpreadsheetCell = {
  v?: string | number | boolean | null;
  f?: string; // "=SUM(A1:A3)"
};

export type SpreadsheetSpec = {
  name: string;
  rows: number;
  cols: number;
  cells: Record<string, SpreadsheetCell>; // A1 notation keys
};

export type SpreadsheetWidget = WidgetBase & {
  kind: "spreadsheet";
  title: string;
  sheet: SpreadsheetSpec;
};

export type KpiWidget = WidgetBase & {
  kind: "kpi";
  title: string;
  valueRef: string; // "sheet:main!B3"
};

export type TextWidget = WidgetBase & {
  kind: "text";
  markdown: string;
};

export type Widget = D3ChartWidget | PivotTableWidget | SpreadsheetWidget | KpiWidget | TextWidget;

export type DataRequest = {
  kind: "demo_opps" | "salesforce_soql_guarded";
  query?: unknown;
};

export type DashboardSpec = {
  version: 1;
  title: string;
  themeId: string;
  layout: LayoutItem[];
  widgets: Widget[];
  dataRequests: Record<string, DataRequest>;
  transforms?: Record<string, unknown>;
  meta?: {
    scenarioClass: string;
    generatedFromPrompt: string;
    generatedAt: number;
  };
};

export type GenerationSource = {
  type: "demo" | "salesforce";
  connectorId?: string;
};

export type CreateDashboardResponse = {
  dashboardId: string;
  shareToken: string;
  spec: DashboardSpec;
};

export type GenerateDashboardResponse = {
  dashboardId: string;
  shareToken: string;
  spec: DashboardSpec;
  generationMeta: {
    modelUsed: string;
    fallbackReason?: string;
    repairAttempts: number;
    durationMs: number;
    scenarioClass: string;
  };
};

export type AgentResponse = {
  patch: unknown[];
  dirtyAreas: string[];
  spec: DashboardSpec;
  warnings: string[];
  modelUsed: string;
  fallbackReason?: string;
  repairAttempts: number;
};

export type SalesforceConnectorStartResponse = {
  connectorId: string;
  authorizeUrl: string;
  expiresAt: number;
};

export type SalesforceConnectorStatusResponse = {
  connected: boolean;
  connectorId?: string;
  environment?: "sandbox" | "production";
  status?: "pending" | "connected" | "error" | "revoked";
  instanceUrl?: string;
  orgId?: string;
  userId?: string;
  lastSyncAt?: number;
  error?: string;
};

export type SalesforceConnectorSummary = {
  id: string;
  environment: "sandbox" | "production";
  status: "pending" | "connected" | "error" | "revoked";
  instanceUrl?: string;
  orgId?: string;
  userId?: string;
  updatedAt: number;
};

export type SalesforceConnectorListResponse = {
  connectors: SalesforceConnectorSummary[];
  activeConnectorId?: string;
};

export type SalesforceActivateResponse = {
  ok: true;
  activeConnectorId: string;
  activeEnvironment: "sandbox" | "production";
};
