import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { createDashboard, generateDashboard } from "../api/client";
import { useDashboardStore } from "../state/dashboardStore";

export default function HomePage() {
  const navigate = useNavigate();
  const setSpec = useDashboardStore((s) => s.setSpec);
  const [prompt, setPrompt] = useState("Build an executive sales dashboard with pipeline by stage, regional performance, top reps, and a planning KPI.");
  const [sourceType, setSourceType] = useState<"demo" | "salesforce">("demo");

  const nlGenerateEnabled = useMemo(() => {
    const v = String(import.meta.env.VITE_FEATURE_NL_GENERATE ?? "true").toLowerCase();
    return !(v === "false" || v === "0" || v === "off");
  }, []);

  useEffect(() => {
    document.documentElement.removeAttribute("data-theme");
  }, []);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!nlGenerateEnabled) return createDashboard();
      return generateDashboard(prompt, { type: sourceType });
    },
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
              Describe the business question in natural language. The generator produces a full dashboard spec with chart, pivot,
              spreadsheet, and KPI widgets.
            </div>
          </div>

          <div style={{ display: "grid", gap: 12 }}>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="Describe the dashboard you want..."
              style={{
                width: "100%",
                borderRadius: 14,
                border: "1px solid var(--card-border)",
                background: "var(--card)",
                color: "var(--text)",
                padding: "12px 14px",
                resize: "vertical",
                fontSize: 15,
              }}
            />

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <label className="pill" style={{ gap: 10 }}>
                <span className="muted" style={{ fontSize: 12 }}>
                  Data source
                </span>
                <select
                  value={sourceType}
                  onChange={(e) => setSourceType(e.target.value as "demo" | "salesforce")}
                  style={{
                    border: "1px solid var(--card-border)",
                    background: "var(--card)",
                    color: "var(--text)",
                    borderRadius: 10,
                    padding: "6px 8px",
                  }}
                >
                  <option value="demo">Demo dataset</option>
                  <option value="salesforce">Salesforce (MVP guarded)</option>
                </select>
              </label>

              <button
                className="btn btnPrimary"
                type="button"
                disabled={mutation.isPending || prompt.trim().length < 3}
                onClick={() => mutation.mutate()}
              >
                {mutation.isPending ? "Generating…" : nlGenerateEnabled ? "Generate dashboard" : "Create demo dashboard"}
              </button>
            </div>

            <div className="pill">
              <div className="muted" style={{ fontSize: 12 }}>
                Try: “Build a regional pipeline dashboard with trend, top reps, and forecast KPI. Use noir theme.”
              </div>
            </div>
          </div>

          {mutation.isError && <div className="muted">Error: {(mutation.error as Error).message}</div>}
        </div>
      </div>
    </div>
  );
}
