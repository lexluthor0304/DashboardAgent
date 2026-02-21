import { useEffect, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { getDashboard, getSalesforceConnectorStatus, startSalesforceSandboxConnect } from "../api/client";
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

  const sfStatusQ = useQuery({
    queryKey: ["sf-status", dashboardId, token],
    queryFn: async () => {
      if (!dashboardId) throw new Error("Missing dashboardId");
      if (!token) throw new Error("Missing token");
      return getSalesforceConnectorStatus(dashboardId, token);
    },
    enabled: Boolean(dashboardId && token && requiresSalesforce),
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 5000 : false),
  });

  const sfStart = useMutation({
    mutationFn: async () => {
      if (!dashboardId) throw new Error("Missing dashboardId");
      return startSalesforceSandboxConnect(dashboardId, token);
    },
    onSuccess: (res) => {
      const child = window.open(res.authorizeUrl, "_blank", "noopener,noreferrer");
      if (!child) window.location.assign(res.authorizeUrl);
      window.setTimeout(() => {
        sfStatusQ.refetch();
      }, 1200);
    },
  });

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
                  {sfStatusQ.isLoading
                    ? "checking…"
                    : sfStatusQ.data?.connected
                      ? "connected"
                      : sfStatusQ.data?.status === "pending"
                        ? "auth pending"
                        : "not connected"}
                </div>
              </div>
              <button className="btn" type="button" onClick={() => sfStatusQ.refetch()} disabled={sfStatusQ.isFetching}>
                {sfStatusQ.isFetching ? "Refreshing…" : "Refresh SF status"}
              </button>
              <button className="btn btnPrimary" type="button" onClick={() => sfStart.mutate()} disabled={sfStart.isPending}>
                {sfStart.isPending ? "Opening…" : "Connect Sandbox"}
              </button>
              {(sfStart.isError || sfStatusQ.isError) && (
                <div className="pill">
                  <div className="muted" style={{ fontSize: 12 }}>
                    SF error: {(sfStart.error as Error | undefined)?.message ?? (sfStatusQ.error as Error | undefined)?.message}
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
