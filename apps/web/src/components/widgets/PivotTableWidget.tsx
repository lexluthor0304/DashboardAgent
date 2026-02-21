import { useMemo } from "react";
import { DataEditor, GridCellKind, type GridCell, type GridColumn } from "@glideapps/glide-data-grid";
import type { DashboardSpec, PivotTableWidget as PivotTableWidgetType } from "../../types/spec";
import { useRowsQuery, useTransformedRows } from "../../hooks/useData";

function formatValue(v: unknown) {
  if (typeof v === "number") {
    if (Number.isFinite(v) && Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return v.toString();
  }
  if (v == null) return "";
  return String(v);
}

export default function PivotTableWidget(props: {
  widget: PivotTableWidgetType;
  spec: DashboardSpec;
  dashboardId: string;
  token: string;
}) {
  const { widget, spec, dashboardId, token } = props;
  const rowsQ = useRowsQuery(dashboardId, token, widget.dataRef);
  const transformSpec = spec.transforms?.[widget.transformRef] as unknown;
  const rows = useTransformedRows(rowsQ.data?.rows, transformSpec) ?? [];

  const columns = useMemo<GridColumn[]>(() => {
    const keys = rows[0] ? Object.keys(rows[0]) : [];
    return keys.map((k) => ({ id: k, title: k, width: Math.min(260, Math.max(120, k.length * 9)) }));
  }, [rows]);

  const getCellContent = ([col, row]: readonly [number, number]): GridCell => {
    const colId = columns[col]?.id;
    const r = rows[row] ?? {};
    const v = colId ? r[colId] : "";
    const displayData = formatValue(v);
    return {
      kind: GridCellKind.Text,
      data: displayData,
      displayData,
      allowOverlay: true,
    };
  };

  if (rowsQ.isLoading) return <div className="muted">Loading data…</div>;
  if (rowsQ.isError) return <div className="muted">Data error: {(rowsQ.error as Error).message}</div>;

  if (columns.length === 0) return <div className="muted">No rows.</div>;

  return (
    <div style={{ height: 320 }}>
      <DataEditor
        columns={columns}
        getCellContent={getCellContent}
        rows={rows.length}
        rowMarkers="both"
        smoothScrollX
        smoothScrollY
      />
    </div>
  );
}

