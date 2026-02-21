import type {
  AgentResponse,
  CreateDashboardResponse,
  DashboardSpec,
  GenerateDashboardResponse,
  GenerationSource,
  SalesforceConnectorStartResponse,
  SalesforceConnectorStatusResponse,
} from "../types/spec";

function baseUrl() {
  const raw = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (!raw) return "";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function apiUrl(path: string) {
  const base = baseUrl();
  if (!base) return path;
  return `${base}${path}`;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), init);
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const msg = (json as any)?.error ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json as T;
}

export async function createDashboard(): Promise<CreateDashboardResponse> {
  return fetchJson<CreateDashboardResponse>("/api/dashboards", { method: "POST" });
}

export async function generateDashboard(prompt: string, source: GenerationSource): Promise<GenerateDashboardResponse> {
  return fetchJson<GenerateDashboardResponse>("/api/generate-dashboard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, source }),
  });
}

export async function getDashboard(dashboardId: string, token: string): Promise<{ spec: DashboardSpec }> {
  return fetchJson<{ spec: DashboardSpec }>(`/api/dashboards/${encodeURIComponent(dashboardId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function runAgent(dashboardId: string, token: string, message: string, currentSpec: DashboardSpec): Promise<AgentResponse> {
  return fetchJson<AgentResponse>("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ dashboardId, token, message, currentSpec }),
  });
}

export async function getDataRows(dashboardId: string, token: string, requestId: string): Promise<{ rows: any[]; schema?: any }> {
  const qs = new URLSearchParams({ requestId });
  return fetchJson<{ rows: any[]; schema?: any }>(`/api/dashboards/${encodeURIComponent(dashboardId)}/data?${qs.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function startSalesforceSandboxConnect(
  dashboardId: string,
  token: string,
): Promise<SalesforceConnectorStartResponse> {
  return fetchJson<SalesforceConnectorStartResponse>("/api/connectors/salesforce/sandbox/start", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ dashboardId, token }),
  });
}

export async function getSalesforceConnectorStatus(
  dashboardId: string,
  token: string,
): Promise<SalesforceConnectorStatusResponse> {
  const qs = new URLSearchParams({ dashboardId });
  return fetchJson<SalesforceConnectorStatusResponse>(`/api/connectors/salesforce/status?${qs.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}
