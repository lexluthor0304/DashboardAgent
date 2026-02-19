import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { createDashboard } from "../api/client";
import { useDashboardStore } from "../state/dashboardStore";

export default function HomePage() {
  const navigate = useNavigate();
  const setSpec = useDashboardStore((s) => s.setSpec);

  useEffect(() => {
    document.documentElement.removeAttribute("data-theme");
  }, []);

  const mutation = useMutation({
    mutationFn: createDashboard,
    onSuccess: (res) => {
      setSpec(res.spec);
      navigate(`/edit/${encodeURIComponent(res.dashboardId)}?token=${encodeURIComponent(res.shareToken)}`);
    },
  });

  return (
    <div className="appShell">
      <div className="topBar">
        <div className="brand">
          <div className="brandTitle">DashboardAgent</div>
          <div className="brandSubtitle">D3 reports + Excel-like pivot + formulas</div>
        </div>
        <div className="pill">
          <div className="muted" style={{ fontSize: 12 }}>
            API: <code>{import.meta.env.VITE_API_BASE_URL ? "external" : "same-origin"}</code>
          </div>
        </div>
      </div>

      <div style={{ padding: 18, display: "grid", placeItems: "center" }}>
        <div
          className="card"
          style={{
            width: "min(980px, 100%)",
            padding: 18,
            display: "grid",
            gap: 14,
          }}
        >
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ fontSize: 44, fontWeight: 860, letterSpacing: "-0.03em", lineHeight: 1.06 }}>
              Generate a dashboard from a sentence.
            </div>
            <div className="muted" style={{ fontSize: 15, lineHeight: 1.5 }}>
              This MVP uses Cloudflare Workers AI (DeepSeek R1 distill) to modify a strict JSON dashboard spec. The UI renders
              D3 charts, a pivot-style table, and a small spreadsheet widget with A1 formulas.
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button className="btn btnPrimary" type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
              {mutation.isPending ? "Creating…" : "Create demo dashboard"}
            </button>
            <div className="pill">
              <div className="muted" style={{ fontSize: 12 }}>
                Tip: after creation, try “change theme to noir” or “make the chart a line chart”.
              </div>
            </div>
          </div>

          {mutation.isError && <div className="muted">Error: {(mutation.error as Error).message}</div>}
        </div>
      </div>
    </div>
  );
}

