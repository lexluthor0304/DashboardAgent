import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { runAgent } from "../api/client";
import { useDashboardStore } from "../state/dashboardStore";

type Msg = { role: "user" | "assistant"; content: string };

export default function ChatPanel(props: { dashboardId: string; token: string }) {
  const { dashboardId, token } = props;
  const spec = useDashboardStore((s) => s.spec);
  const pushSpec = useDashboardStore((s) => s.pushSpec);

  const [messages, setMessages] = useState<Msg[]>([
    { role: "assistant", content: "Describe the dashboard you want. Try: “make the chart a line chart”." },
  ]);
  const [draft, setDraft] = useState("");

  const canSend = Boolean(spec && draft.trim().length > 0);

  const mutation = useMutation({
    mutationFn: async (text: string) => {
      if (!spec) throw new Error("Missing spec");
      return runAgent(dashboardId, token, text, spec);
    },
    onMutate: async (text) => {
      setMessages((m) => [...m, { role: "user", content: text }]);
    },
    onSuccess: (res) => {
      pushSpec(res.spec);
      const meta = [`model=${res.modelUsed}`];
      if (res.fallbackReason) meta.push(`fallback=${res.fallbackReason}`);
      if (res.repairAttempts) meta.push(`repairs=${res.repairAttempts}`);
      const header = meta.length ? `(${meta.join(", ")})` : "";
      setMessages((m) => [...m, { role: "assistant", content: `Updated. ${header}` }]);
    },
    onError: (err) => {
      setMessages((m) => [...m, { role: "assistant", content: `Error: ${(err as Error).message}` }]);
    },
  });

  const quick = useMemo(
    () => [
      "Make the chart a line chart.",
      "Change theme to noir.",
      "Rename the dashboard to “Q1 Pipeline Review”.",
      "Make the pivot show total Amount by OwnerName.",
      "Add a donut chart by StageName.",
    ],
    [],
  );

  return (
    <div className="panelInner" style={{ height: "100%", display: "grid", gridTemplateRows: "auto 1fr auto" }}>
      <div className="pill" style={{ justifySelf: "start" }}>
        <div style={{ fontWeight: 750 }}>Agent</div>
        <div className="muted" style={{ fontSize: 12 }}>
          Workers AI
        </div>
      </div>

      <div style={{ marginTop: 12, overflow: "auto", paddingRight: 6 }}>
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              marginBottom: 10,
              padding: "10px 12px",
              borderRadius: 14,
              border: "1px solid var(--card-border)",
              background: m.role === "user" ? "rgba(11, 114, 133, 0.10)" : "rgba(255,255,255,0.04)",
            }}
          >
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              {m.role === "user" ? "You" : "Agent"}
            </div>
            <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.45 }}>{m.content}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {quick.map((q) => (
            <button
              key={q}
              className="btn"
              type="button"
              disabled={!spec || mutation.isPending}
              onClick={() => {
                setDraft(q);
              }}
            >
              {q}
            </button>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={spec ? "Ask for changes…" : "Loading…"}
            style={{
              padding: "12px 14px",
              borderRadius: 999,
              border: "1px solid var(--card-border)",
              background: "var(--card)",
              color: "var(--text)",
              outline: "none",
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!canSend) return;
                const text = draft.trim();
                setDraft("");
                mutation.mutate(text);
              }
            }}
          />
          <button
            className="btn btnPrimary"
            type="button"
            disabled={!canSend || mutation.isPending}
            onClick={() => {
              if (!canSend) return;
              const text = draft.trim();
              setDraft("");
              mutation.mutate(text);
            }}
          >
            {mutation.isPending ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

