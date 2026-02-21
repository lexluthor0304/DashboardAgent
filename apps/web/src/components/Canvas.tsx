import { useMemo } from "react";
import GridLayout, { type Layout } from "react-grid-layout";
import { WidthProvider } from "react-grid-layout";
import type { DashboardSpec, Widget } from "../types/spec";
import { useDashboardStore } from "../state/dashboardStore";
import D3ChartWidget from "./widgets/D3ChartWidget";
import PivotTableWidget from "./widgets/PivotTableWidget";
import SpreadsheetWidget from "./widgets/SpreadsheetWidget";
import KpiWidget from "./widgets/KpiWidget";
import TextWidget from "./widgets/TextWidget";

const RGL = WidthProvider(GridLayout);

function WidgetCard(props: {
  widget: Widget;
  spec: DashboardSpec;
  dashboardId: string;
  token: string;
}) {
  const { widget, spec, dashboardId, token } = props;

  return (
    <div className="card" style={{ height: "100%", display: "grid", gridTemplateRows: "auto 1fr" }}>
      <div className="cardHeader">
        <div className="cardTitle">{(widget as any).title ?? "Widget"}</div>
        <div className="muted" style={{ fontSize: 12 }}>
          {widget.kind}
        </div>
      </div>
      <div className="cardBody" style={{ minHeight: 0 }}>
        {widget.kind === "d3_chart" && <D3ChartWidget widget={widget} spec={spec} dashboardId={dashboardId} token={token} />}
        {widget.kind === "pivot_table" && <PivotTableWidget widget={widget} spec={spec} dashboardId={dashboardId} token={token} />}
        {widget.kind === "spreadsheet" && <SpreadsheetWidget widget={widget} spec={spec} />}
        {widget.kind === "kpi" && <KpiWidget widget={widget} spec={spec} />}
        {widget.kind === "text" && <TextWidget widget={widget} />}
      </div>
    </div>
  );
}

export default function Canvas(props: {
  spec: DashboardSpec;
  dashboardId: string;
  token: string;
  readOnly?: boolean;
}) {
  const { spec, dashboardId, token, readOnly } = props;
  const replaceSpec = useDashboardStore((s) => s.replaceSpec);

  const widgetById = useMemo(() => {
    const map = new Map<string, Widget>();
    for (const w of spec.widgets) map.set(w.id, w);
    return map;
  }, [spec.widgets]);

  const layout = useMemo<Layout[]>(
    () =>
      spec.layout.map((l) => ({
        i: l.widgetId,
        x: l.x,
        y: l.y,
        w: l.w,
        h: l.h,
        isDraggable: !readOnly,
        isResizable: !readOnly,
      })),
    [spec.layout, readOnly],
  );

  return (
    <RGL
      className="layout"
      layout={layout}
      cols={12}
      rowHeight={34}
      margin={[14, 14]}
      containerPadding={[14, 14]}
      isResizable={!readOnly}
      isDraggable={!readOnly}
      onLayoutChange={(next: Layout[]) => {
        if (readOnly) return;
        const nextLayout = next.map((l: Layout) => ({ widgetId: l.i, x: l.x, y: l.y, w: l.w, h: l.h }));
        replaceSpec({ ...spec, layout: nextLayout });
      }}
    >
      {layout.map((l) => {
        const widget = widgetById.get(l.i);
        if (!widget) return <div key={l.i} className="card" />;
        return (
          <div key={l.i}>
            <WidgetCard widget={widget} spec={spec} dashboardId={dashboardId} token={token} />
          </div>
        );
      })}
    </RGL>
  );
}
