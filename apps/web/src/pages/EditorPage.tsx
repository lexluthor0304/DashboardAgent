import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { activateSalesforceConnector, getDashboard, listSalesforceConnectors, startSalesforceConnect } from "../api/client";
import { useDashboardStore } from "../state/dashboardStore";
import ChatPanel from "../components/ChatPanel";
import Canvas from "../components/Canvas";

export default function EditorPage() {
  const { dashboardId } = useParams();
  const [search] = useSearchParams();
  const token = search.get("token") ?? "";

  const spec = useDashboardStore((s) => s.spec);
  const setSpec = useDashboardStore((s) => s.setSpec);
  const undo = useDashboardStore((s) => s.undo);
  const redo = useDashboardStore((s) => s.redo);
  const canUndo = useDashboardStore((s) => s.history.length > 0);
  const canRedo = useDashboardStore((s) => s.future.length > 0);
  const [selectedConnectorId, setSelectedConnectorId] = useState("");

  const q = useQuery({
    queryKey: ["dashboard", dashboardId, token],
    queryFn: () => {
      if (!dashboardId) throw new Error("Missing dashboardId");
      if (!token) throw new Error("Missing token");
      return getDashboard(dashboardId, token);
    },
    enabled: Boolean(dashboardId && token),
  });

  useEffect(() => {
    if (q.data?.spec) setSpec(q.data.spec);
  }, [q.data?.spec, setSpec]);

  useEffect(() => {
    if (!spec) return;
    document.documentElement.setAttribute("data-theme", spec.themeId === "noir" ? "noir" : "atelier");
  }, [spec?.themeId]);

  const shareHref = useMemo(() => {
    if (!dashboardId) return "#";
    const qs = new URLSearchParams();
    if (token) qs.set("token", token);
    return `/d/${encodeURIComponent(dashboardId)}?${qs.toString()}`;
  }, [dashboardId, token]);

  const effectiveSpec = spec ?? q.data?.spec;
  const requiresSalesforce = useMemo(() => {
    if (!effectiveSpec) return false;
    return Object.values(effectiveSpec.dataRequests ?? {}).some((r) => r?.kind === "salesforce_soql_guarded");
  }, [effectiveSpec]);

  const sfListQ = useQuery({
    queryKey: ["sf-connectors", dashboardId, token],
    queryFn: async () => {
      if (!dashboardId) throw new Error("Missing dashboardId");
      if (!token) throw new Error("Missing token");
      return listSalesforceConnectors(dashboardId, token);
    },
    enabled: Boolean(dashboardId && token && requiresSalesforce),
    refetchInterval: (query) => {
      const hasPending = (query.state.data?.connectors ?? []).some((c) => c.status === "pending");
      return hasPending ? 5000 : false;
    },
  });

  const sfStart = useMutation({
    mutationFn: async (environment: "sandbox" | "production") => {
      if (!dashboardId) throw new Error("Missing dashboardId");
      return startSalesforceConnect(dashboardId, token, environment);
    },
    onSuccess: (res) => {
      const child = window.open(res.authorizeUrl, "_blank", "noopener,noreferrer");
      if (!child) window.location.assign(res.authorizeUrl);
      window.setTimeout(() => {
        sfListQ.refetch();
      }, 1200);
    },
  });

  const sfActivate = useMutation({
    mutationFn: async (connectorId: string) => {
      if (!dashboardId) throw new Error("Missing dashboardId");
      return activateSalesforceConnector(dashboardId, token, connectorId);
    },
    onSuccess: () => {
      sfListQ.refetch();
    },
  });

  const connectors = sfListQ.data?.connectors ?? [];
  const activeConnectorId = sfListQ.data?.activeConnectorId;
  const activeConnector = connectors.find((c) => c.id === activeConnectorId);

  useEffect(() => {
    if (!requiresSalesforce) return;
    if (connectors.length === 0) {
      setSelectedConnectorId("");
      return;
    }
    const currentExists = connectors.some((c) => c.id === selectedConnectorId);
    if (currentExists) return;
    setSelectedConnectorId(activeConnectorId ?? connectors[0]!.id);
  }, [requiresSalesforce, connectors, selectedConnectorId, activeConnectorId]);

  if (!dashboardId) return <div className="muted">Missing dashboardId</div>;
  if (!token) return <div className="muted">Missing token. Create a dashboard from the home page.</div>;

  return (
    <div className="appShell">
      <div className="topBar">
        <div className="brand">
          <div className="brandTitle">Editor</div>
          <div className="brandSubtitle">{spec?.title ?? "Loading…"}</div>
          {spec?.meta?.scenarioClass && (
            <div className="muted" style={{ fontSize: 12 }}>
              scenario: <code>{spec.meta.scenarioClass}</code>
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {requiresSalesforce && (
            <>
              <div className="pill">
                <div className="muted" style={{ fontSize: 12 }}>
                  Salesforce:
                </div>
                <div style={{ fontSize: 12, fontWeight: 700 }}>
                  {sfListQ.isLoading
                    ? "checking…"
                    : activeConnector
                      ? `${activeConnector.environment} ${activeConnector.status}`
                      : "not connected"}
                </div>
              </div>
              <button className="btn" type="button" onClick={() => sfListQ.refetch()} disabled={sfListQ.isFetching}>
                {sfListQ.isFetching ? "Refreshing…" : "Refresh SF"}
              </button>
              <button className="btn btnPrimary" type="button" onClick={() => sfStart.mutate("sandbox")} disabled={sfStart.isPending}>
                {sfStart.isPending ? "Opening…" : "Connect Sandbox"}
              </button>
              <button className="btn btnPrimary" type="button" onClick={() => sfStart.mutate("production")} disabled={sfStart.isPending}>
                {sfStart.isPending ? "Opening…" : "Connect Production"}
              </button>

              {connectors.length > 0 && (
                <>
                  <select
                    value={selectedConnectorId}
                    onChange={(e) => setSelectedConnectorId(e.target.value)}
                    style={{
                      border: "1px solid var(--card-border)",
                      background: "var(--card)",
                      color: "var(--text)",
                      borderRadius: 10,
                      padding: "6px 8px",
                    }}
                  >
                    {connectors.map((conn) => (
                      <option key={conn.id} value={conn.id}>
                        {conn.environment} | {conn.status} | {(conn.orgId ?? conn.id).slice(0, 10)}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn"
                    type="button"
                    disabled={!selectedConnectorId || selectedConnectorId === activeConnectorId || sfActivate.isPending}
                    onClick={() => {
                      if (!selectedConnectorId) return;
                      sfActivate.mutate(selectedConnectorId);
                    }}
                  >
                    {sfActivate.isPending ? "Activating…" : "Activate"}
                  </button>
                </>
              )}

              {(sfStart.isError || sfListQ.isError || sfActivate.isError) && (
                <div className="pill">
                  <div className="muted" style={{ fontSize: 12 }}>
                    SF error:{" "}
                    {(sfStart.error as Error | undefined)?.message ??
                      (sfActivate.error as Error | undefined)?.message ??
                      (sfListQ.error as Error | undefined)?.message}
                  </div>
                </div>
              )}
            </>
          )}
          <button className="btn" type="button" onClick={undo} disabled={!canUndo}>
            Undo
          </button>
          <button className="btn" type="button" onClick={redo} disabled={!canRedo}>
            Redo
          </button>
          <Link className="btn btnPrimary" to={shareHref} target="_blank" rel="noreferrer">
            Open share link
          </Link>
        </div>
      </div>

      <div className="layoutSplit">
        <div className="panel" style={{ borderRight: "1px solid var(--card-border)" }}>
          <ChatPanel dashboardId={dashboardId} token={token} />
        </div>
        <div className="panel">
          <div className="panelInner" style={{ height: "100%", overflow: "auto" }}>
            {q.isLoading && !spec && <div className="muted">Loading…</div>}
            {q.isError && <div className="muted">Error: {(q.error as Error).message}</div>}
            {spec && <Canvas spec={spec} dashboardId={dashboardId} token={token} />}
          </div>
        </div>
      </div>
    </div>
  );
}
