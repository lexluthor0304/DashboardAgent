import { useMemo } from "react";
import * as d3 from "d3";
import type { D3ChartWidget as D3ChartWidgetType, DashboardSpec } from "../../types/spec";
import { useRowsQuery, useTransformedRows } from "../../hooks/useData";

function getCssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function fmtCurrency(v: number) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(v);
  } catch {
    return String(v);
  }
}

export default function D3ChartWidget(props: {
  widget: D3ChartWidgetType;
  spec: DashboardSpec;
  dashboardId: string;
  token: string;
}) {
  const { widget, spec, dashboardId, token } = props;
  const rowsQ = useRowsQuery(dashboardId, token, widget.dataRef);
  const transformSpec = widget.transformRef ? (spec.transforms?.[widget.transformRef] as unknown) : undefined;
  const rows = useTransformedRows(rowsQ.data?.rows, transformSpec) ?? [];

  const xField = widget.chart.xField;
  const yField = widget.chart.yField;
  const data = useMemo(() => rows.filter((r: any) => r && r[xField] != null && r[yField] != null), [rows, xField, yField]);

  if (rowsQ.isLoading) return <div className="muted">Loading data…</div>;
  if (rowsQ.isError) return <div className="muted">Data error: {(rowsQ.error as Error).message}</div>;

  // Lightweight SVG chart: no virtualization needed for MVP.
  const width = 520;
  const height = 280;
  const margin = { top: 18, right: 18, bottom: 44, left: 64 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const accent = getCssVar("--accent") || "#0b7285";
  const accent2 = getCssVar("--accent-2") || "#1c7ed6";
  const grid = getCssVar("--card-border") || "rgba(16, 24, 40, 0.12)";

  const xDomain = data.map((d) => String(d[xField]));
  const yMax = d3.max(data, (d: any) => Number(d[yField])) ?? 0;

  const x = d3.scaleBand().domain(xDomain).range([0, innerW]).padding(0.24);
  const y = d3.scaleLinear().domain([0, yMax]).nice().range([innerH, 0]);

  const ticks = y.ticks(5);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="100%" role="img" aria-label={widget.title}>
      <defs>
        <linearGradient id="barGrad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={accent2} stopOpacity="0.95" />
          <stop offset="100%" stopColor={accent} stopOpacity="0.95" />
        </linearGradient>
      </defs>

      <g transform={`translate(${margin.left},${margin.top})`}>
        {ticks.map((t: number) => (
          <g key={t} transform={`translate(0,${y(t)})`}>
            <line x1={0} x2={innerW} y1={0} y2={0} stroke={grid} />
            <text x={-10} y={4} textAnchor="end" fontSize={11} fill="currentColor" opacity={0.72}>
              {fmtCurrency(t)}
            </text>
          </g>
        ))}

        {widget.chart.type === "bar" &&
          data.map((d: any) => {
            const xKey = String(d[xField]);
            const v = Number(d[yField]);
            const bx = x(xKey) ?? 0;
            const bw = x.bandwidth();
            const by = y(v);
            const bh = innerH - by;
            return (
              <g key={xKey}>
                <rect x={bx} y={by} width={bw} height={bh} rx={10} fill="url(#barGrad)" opacity={0.92} />
              </g>
            );
          })}

        {widget.chart.type === "line" && (
          <>
            <path
              d={
                d3
                  .line<any>()
                  .x((d: any) => (x(String(d[xField])) ?? 0) + x.bandwidth() / 2)
                  .y((d: any) => y(Number(d[yField])))
                  .curve(d3.curveMonotoneX)(data) ?? ""
              }
              fill="none"
              stroke={accent2}
              strokeWidth={3}
              opacity={0.95}
            />
            {data.map((d: any) => {
              const xKey = String(d[xField]);
              const cx = (x(xKey) ?? 0) + x.bandwidth() / 2;
              const cy = y(Number(d[yField]));
              return <circle key={xKey} cx={cx} cy={cy} r={5} fill={accent} opacity={0.95} />;
            })}
          </>
        )}

        {/* X axis */}
        <g transform={`translate(0,${innerH})`}>
          {xDomain.map((v) => (
            <text
              key={v}
              x={(x(v) ?? 0) + x.bandwidth() / 2}
              y={32}
              textAnchor="middle"
              fontSize={11}
              fill="currentColor"
              opacity={0.82}
            >
              {v.length > 14 ? `${v.slice(0, 12)}…` : v}
            </text>
          ))}
        </g>
      </g>
    </svg>
  );
}
