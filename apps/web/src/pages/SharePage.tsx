import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { getDashboard } from "../api/client";
import { useDashboardStore } from "../state/dashboardStore";
import Canvas from "../components/Canvas";

export default function SharePage() {
  const { dashboardId } = useParams();
  const [search] = useSearchParams();
  const token = search.get("token") ?? "";

  const spec = useDashboardStore((s) => s.spec);
  const setSpec = useDashboardStore((s) => s.setSpec);

  const q = useQuery({
    queryKey: ["share", dashboardId, token],
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

  if (!dashboardId) return <div className="muted">Missing dashboardId</div>;
  if (!token) return <div className="muted">Missing token.</div>;

  return (
    <div className="appShell">
      <div className="topBar">
        <div className="brand">
          <div className="brandTitle">Share</div>
          <div className="brandSubtitle">{spec?.title ?? "Loading…"}</div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Link className="btn" to={`/edit/${encodeURIComponent(dashboardId)}?token=${encodeURIComponent(token)}`}>
            Open editor
          </Link>
        </div>
      </div>

      <div className="panel">
        <div className="panelInner" style={{ height: "100%", overflow: "auto" }}>
          {q.isLoading && !spec && <div className="muted">Loading…</div>}
          {q.isError && <div className="muted">Error: {(q.error as Error).message}</div>}
          {spec && <Canvas spec={spec} dashboardId={dashboardId} token={token} readOnly />}
        </div>
      </div>
    </div>
  );
}

