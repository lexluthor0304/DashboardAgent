import { useMemo } from "react";
import type { DashboardSpec, KpiWidget as KpiWidgetType, SpreadsheetWidget } from "../../types/spec";
import { evaluateSheet } from "../../utils/formula";

function parseValueRef(ref: string) {
  // sheet:main!B3
  const m = /^sheet:([^!]+)!([A-Za-z]+\d+)$/.exec(ref.trim());
  if (!m) return null;
  return { sheetName: m[1]!, cell: m[2]!.toUpperCase() };
}

function fmt(v: unknown) {
  if (typeof v === "number") {
    if (Math.abs(v) >= 1000) {
      try {
        return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(v);
      } catch {
        return v.toFixed(0);
      }
    }
    return v.toLocaleString(undefined, { maximumFractionDigits: 3 });
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v == null) return "";
  return String(v);
}

export default function KpiWidget(props: { widget: KpiWidgetType; spec: DashboardSpec }) {
  const { widget, spec } = props;

  const value = useMemo(() => {
    const parsed = parseValueRef(widget.valueRef);
    if (!parsed) return null;
    const sheetWidget = spec.widgets.find(
      (w): w is SpreadsheetWidget => w.kind === "spreadsheet" && w.sheet.name === parsed.sheetName,
    );
    if (!sheetWidget) return null;
    const { get } = evaluateSheet(sheetWidget.sheet);
    return get(parsed.cell);
  }, [spec.widgets, widget.valueRef]);

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="muted" style={{ fontSize: 12 }}>
        Ref: <code>{widget.valueRef}</code>
      </div>
      <div style={{ fontSize: 48, fontWeight: 820, letterSpacing: "-0.02em" }}>{fmt(value)}</div>
    </div>
  );
}

