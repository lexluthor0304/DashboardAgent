import { useMemo } from "react";
import Spreadsheet from "react-spreadsheet";
import type { DashboardSpec, SpreadsheetSpec, SpreadsheetWidget as SpreadsheetWidgetType } from "../../types/spec";
import { evaluateSheet, sheetCellKeyFromRowCol } from "../../utils/formula";
import { useDashboardStore } from "../../state/dashboardStore";

type MatrixCell = { value: any };

function buildMatrix(sheet: SpreadsheetSpec) {
  const { get, errors } = evaluateSheet(sheet);
  const matrix: MatrixCell[][] = [];
  for (let r = 0; r < sheet.rows; r += 1) {
    const row: MatrixCell[] = [];
    for (let c = 0; c < sheet.cols; c += 1) {
      const a1 = sheetCellKeyFromRowCol(r, c);
      const cell = sheet.cells[a1];
      const v = cell?.f ? get(a1) : cell?.v;
      const err = errors[a1];
      row.push({ value: err ? `#ERR` : v ?? "" });
    }
    matrix.push(row);
  }
  return matrix;
}

function updateSheetFromMatrix(sheet: SpreadsheetSpec, matrix: MatrixCell[][]): SpreadsheetSpec {
  const cells: SpreadsheetSpec["cells"] = {};
  for (let r = 0; r < sheet.rows; r += 1) {
    for (let c = 0; c < sheet.cols; c += 1) {
      const a1 = sheetCellKeyFromRowCol(r, c);
      const raw = matrix[r]?.[c]?.value;
      if (raw === "" || raw == null) continue;
      if (typeof raw === "string" && raw.trim().startsWith("=")) {
        cells[a1] = { f: raw.trim() };
        continue;
      }
      cells[a1] = { v: raw };
    }
  }
  return { ...sheet, cells };
}

export default function SpreadsheetWidget(props: { widget: SpreadsheetWidgetType; spec: DashboardSpec }) {
  const { widget, spec } = props;
  const replaceSpec = useDashboardStore((s) => s.replaceSpec);

  const data = useMemo(() => buildMatrix(widget.sheet), [widget.sheet]);

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="muted" style={{ fontSize: 12 }}>
        Type values or formulas like <code>=SUM(A1:A3)</code>. Formula cells display computed values.
      </div>
      <div style={{ height: 320 }}>
        <Spreadsheet
          data={data as any}
          onChange={(next: any) => {
            const nextSheet = updateSheetFromMatrix(widget.sheet, next as MatrixCell[][]);
            const nextSpec: DashboardSpec = {
              ...spec,
              widgets: spec.widgets.map((w) => (w.id === widget.id ? { ...widget, sheet: nextSheet } : w)),
            };
            replaceSpec(nextSpec);
          }}
        />
      </div>
    </div>
  );
}

