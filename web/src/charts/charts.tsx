// Gráficos con D3: d3 calcula escalas, ejes y formas; React dibuja el SVG.
// Todos son responsivos (se adaptan al ancho del contenedor).
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as d3 from 'd3';
import { compact } from '@/lib/utils';

export const PALETTE = ['#60a5fa', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#22d3ee', '#fb923c', '#f87171', '#94a3b8', '#4ade80'];

export interface Series { name: string; values: number[] }
export interface ChartData { labels: string[]; series: Series[] }

/** Primera columna = etiqueta; columnas numéricas restantes = series. null si no hay nada graficable. */
export function toChartData(columns: string[], rows: (string | null)[][]): ChartData | null {
  const numeric = columns.map((_, c) => c).filter((c) => c > 0 && rows.length > 0 &&
    rows.every((r) => r[c] != null && r[c] !== '' && Number.isFinite(Number(r[c]))));
  if (!rows.length || !numeric.length) return null;
  return { labels: rows.map((r) => String(r[0] ?? '')), series: numeric.map((c) => ({ name: columns[c], values: rows.map((r) => Number(r[c])) })) };
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function Tip({ children }: { children: ReactNode }) { return <title>{children}</title>; }

function Legend({ series, colors }: { series: { name: string }[]; colors: string[] }) {
  if (series.length < 2) return null;
  return (
    <div className="mb-1 flex flex-wrap gap-3 text-xs text-muted">
      {series.map((s, i) => (
        <span key={s.name} className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: colors[i % colors.length] }} />{s.name}</span>
      ))}
    </div>
  );
}

const fmtFull = (v: number) => v.toLocaleString('es');

/* ------------------------------------------------------------------- barras */
export function BarChart({ data, horizontal = false, height = 280, format = compact }: { data: ChartData; horizontal?: boolean; height?: number; format?: (n: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { labels, series } = data;
  const max = d3.max(series.flatMap((s) => s.values)) ?? 0;

  if (horizontal) {
    const m = { top: 8, right: 56, bottom: 24, left: Math.min(220, width * 0.38) };
    const h = Math.max(height, labels.length * 28 + m.top + m.bottom);
    const y = d3.scaleBand(labels, [m.top, h - m.bottom]).padding(0.25);
    const ySub = d3.scaleBand(series.map((s) => s.name), [0, y.bandwidth()]).padding(0.1);
    const x = d3.scaleLinear([0, max], [m.left, width - m.right]).nice();
    return (
      <div ref={ref}>
        <Legend series={series} colors={PALETTE} />
        <svg width={width} height={h} role="img">
          {x.ticks(5).map((t) => (
            <g key={t}><line x1={x(t)} x2={x(t)} y1={m.top} y2={h - m.bottom} className="stroke-border" />
              <text x={x(t)} y={h - 6} textAnchor="middle" className="fill-muted text-[11px]">{format(t)}</text></g>
          ))}
          {labels.map((l, i) => (
            <g key={l + i}>
              <text x={m.left - 8} y={(y(l) ?? 0) + y.bandwidth() / 2} dy="0.35em" textAnchor="end" className="fill-foreground text-[12px]">{l.length > 32 ? `${l.slice(0, 31)}…` : l}</text>
              {series.map((s, k) => (
                <g key={s.name}>
                  <rect x={m.left} y={(y(l) ?? 0) + (ySub(s.name) ?? 0)} width={Math.max(1, x(s.values[i]) - m.left)} height={ySub.bandwidth()} rx={3} fill={PALETTE[k % PALETTE.length]}>
                    <Tip>{`${l} · ${s.name}: ${fmtFull(s.values[i])}`}</Tip>
                  </rect>
                  {series.length === 1 && <text x={x(s.values[i]) + 6} y={(y(l) ?? 0) + y.bandwidth() / 2} dy="0.35em" className="fill-muted text-[11px]">{format(s.values[i])}</text>}
                </g>
              ))}
            </g>
          ))}
        </svg>
      </div>
    );
  }

  const rotate = labels.length > 8 || labels.some((l) => l.length > 10);
  const m = { top: 12, right: 12, bottom: rotate ? 70 : 28, left: 52 };
  const x = d3.scaleBand(labels, [m.left, width - m.right]).padding(0.25);
  const xSub = d3.scaleBand(series.map((s) => s.name), [0, x.bandwidth()]).padding(0.08);
  const y = d3.scaleLinear([0, max], [height - m.bottom, m.top]).nice();
  return (
    <div ref={ref}>
      <Legend series={series} colors={PALETTE} />
      <svg width={width} height={height} role="img">
        {y.ticks(5).map((t) => (
          <g key={t}><line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} className="stroke-border" />
            <text x={m.left - 6} y={y(t)} dy="0.35em" textAnchor="end" className="fill-muted text-[11px]">{format(t)}</text></g>
        ))}
        {labels.map((l, i) => {
          const cx = (x(l) ?? 0) + x.bandwidth() / 2;
          return (
            <g key={l + i}>
              {series.map((s, k) => (
                <rect key={s.name} x={(x(l) ?? 0) + (xSub(s.name) ?? 0)} y={y(s.values[i])} width={xSub.bandwidth()} height={Math.max(1, y(0) - y(s.values[i]))} rx={3} fill={PALETTE[k % PALETTE.length]}>
                  <Tip>{`${l} · ${s.name}: ${fmtFull(s.values[i])}`}</Tip>
                </rect>
              ))}
              <text x={cx} y={height - m.bottom + 14} textAnchor={rotate ? 'end' : 'middle'} transform={rotate ? `rotate(-35 ${cx} ${height - m.bottom + 14})` : undefined}
                className="fill-muted text-[11px]">{l.length > 18 ? `${l.slice(0, 17)}…` : l}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------- líneas */
export function LineChart({ data, height = 280, format = compact }: { data: ChartData; height?: number; format?: (n: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const { labels, series } = data;
  const m = { top: 12, right: 16, bottom: 28, left: 56 };
  const x = d3.scalePoint(labels, [m.left, width - m.right]);
  const y = d3.scaleLinear([0, d3.max(series.flatMap((s) => s.values)) ?? 0], [height - m.bottom, m.top]).nice();
  const every = Math.ceil(labels.length / Math.max(2, Math.floor(width / 80)));
  return (
    <div ref={ref} className="relative">
      <Legend series={series} colors={PALETTE} />
      <svg width={width} height={height} role="img" onMouseLeave={() => setHover(null)}>
        {y.ticks(5).map((t) => (
          <g key={t}><line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} className="stroke-border" />
            <text x={m.left - 6} y={y(t)} dy="0.35em" textAnchor="end" className="fill-muted text-[11px]">{format(t)}</text></g>
        ))}
        {labels.map((l, i) => i % every === 0 && <text key={l} x={x(l)} y={height - 8} textAnchor="middle" className="fill-muted text-[11px]">{l}</text>)}
        {series.map((s, k) => {
          const pts = s.values.map((v, i) => [x(labels[i]) ?? 0, y(v)] as [number, number]);
          const area = d3.area<[number, number]>().x((p) => p[0]).y0(y(0)).y1((p) => p[1]).curve(d3.curveMonotoneX)(pts) ?? '';
          const line = d3.line().curve(d3.curveMonotoneX)(pts) ?? '';
          return (
            <g key={s.name}>
              <path d={area} fill={PALETTE[k % PALETTE.length]} opacity={0.12} />
              <path d={line} fill="none" stroke={PALETTE[k % PALETTE.length]} strokeWidth={2.2} />
            </g>
          );
        })}
        {labels.map((l, i) => (
          <rect key={`h${l}`} x={(x(l) ?? 0) - x.step() / 2} y={m.top} width={x.step()} height={height - m.top - m.bottom} fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
        {hover != null && (
          <g pointerEvents="none">
            <line x1={x(labels[hover])} x2={x(labels[hover])} y1={m.top} y2={height - m.bottom} className="stroke-muted" strokeDasharray="3 3" />
            {series.map((s, k) => <circle key={s.name} cx={x(labels[hover])} cy={y(s.values[hover])} r={4} fill={PALETTE[k % PALETTE.length]} />)}
          </g>
        )}
      </svg>
      {hover != null && (
        <div className="pointer-events-none absolute top-6 rounded-lg border border-border bg-overlay px-3 py-2 text-xs shadow-lg"
          style={{ left: Math.min((x(labels[hover]) ?? 0) + 12, width - 180) }}>
          <p className="font-medium">{labels[hover]}</p>
          {series.map((s, k) => <p key={s.name}><span style={{ color: PALETTE[k % PALETTE.length] }}>●</span> {s.name}: {fmtFull(s.values[hover])}</p>)}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------- dona */
export function DonutChart({ data, height = 260, format = compact }: { data: ChartData; height?: number; format?: (n: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const values = data.series[0].values.map((v) => Math.max(0, v));
  const total = d3.sum(values) || 1;
  const r = Math.min(height, width * 0.5) / 2 - 6;
  const arcs = useMemo(() => d3.pie<number>().sort(null).value((v) => v)(values), [values]);
  const arc = d3.arc<d3.PieArcDatum<number>>().innerRadius(r * 0.6).outerRadius(r).padAngle(0.012).cornerRadius(3);
  return (
    <div ref={ref} className="flex flex-wrap items-center gap-6">
      <svg width={r * 2 + 12} height={r * 2 + 12} role="img">
        <g transform={`translate(${r + 6},${r + 6})`}>
          {arcs.map((a, i) => (
            <path key={i} d={arc(a) ?? ''} fill={PALETTE[i % PALETTE.length]}>
              <Tip>{`${data.labels[i]}: ${fmtFull(values[i])} (${((values[i] / total) * 100).toFixed(1)}%)`}</Tip>
            </path>
          ))}
          <text textAnchor="middle" dy="-0.1em" className="fill-foreground text-xl font-semibold">{format(total)}</text>
          <text textAnchor="middle" dy="1.4em" className="fill-muted text-[11px]">{data.series[0].name}</text>
        </g>
      </svg>
      <ul className="min-w-40 flex-1 space-y-1.5 text-sm">
        {data.labels.map((l, i) => (
          <li key={l} className="flex items-center gap-2">
            <span className="size-3 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="flex-1 truncate">{l}</span>
            <span className="tabular-nums text-muted">{((values[i] / total) * 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------ área apilada (costos) */
export function StackedArea({ times, keys, rows, labels, height = 300, format }: {
  times: Date[]; keys: string[]; rows: Record<string, number>[]; labels: Record<string, string>; height?: number; format: (n: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const m = { top: 12, right: 16, bottom: 28, left: 64 };
  const stack = d3.stack<Record<string, number>>().keys(keys)(rows);
  const x = d3.scaleTime(d3.extent(times) as [Date, Date], [m.left, width - m.right]);
  const y = d3.scaleLinear([0, d3.max(stack.at(-1) ?? [], (d) => d[1]) || 1e-6], [height - m.bottom, m.top]).nice();
  const area = d3.area<d3.SeriesPoint<Record<string, number>>>()
    .x((_, i) => x(times[i])).y0((d) => y(d[0])).y1((d) => y(d[1])).curve(d3.curveMonotoneX);
  const step = times.length > 1 ? x(times[1]) - x(times[0]) : width;
  const tf = times.length > 2 && +times[1] - +times[0] >= 86_400_000 ? d3.timeFormat('%d/%m') : d3.timeFormat('%d/%m %H:%M');
  return (
    <div ref={ref} className="relative">
      <svg width={width} height={height} role="img" onMouseLeave={() => setHover(null)}>
        {y.ticks(5).map((t) => (
          <g key={t}><line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} className="stroke-border" />
            <text x={m.left - 6} y={y(t)} dy="0.35em" textAnchor="end" className="fill-muted text-[11px]">{format(t)}</text></g>
        ))}
        {x.ticks(Math.max(2, Math.floor(width / 110))).map((t) => (
          <text key={+t} x={x(t)} y={height - 8} textAnchor="middle" className="fill-muted text-[11px]">{tf(t)}</text>
        ))}
        {stack.map((s, k) => <path key={s.key} d={area(s) ?? ''} fill={PALETTE[k % PALETTE.length]} opacity={0.85} />)}
        {times.map((t, i) => <rect key={+t} x={x(t) - step / 2} y={m.top} width={step} height={height - m.top - m.bottom} fill="transparent" onMouseEnter={() => setHover(i)} />)}
        {hover != null && <line x1={x(times[hover])} x2={x(times[hover])} y1={m.top} y2={height - m.bottom} className="stroke-foreground" strokeDasharray="3 3" pointerEvents="none" />}
      </svg>
      {hover != null && (
        <div className="pointer-events-none absolute top-2 z-10 min-w-56 rounded-lg border border-border bg-overlay px-3 py-2 text-xs shadow-lg"
          style={{ left: Math.min(x(times[hover]) + 14, width - 240) }}>
          <p className="mb-1 font-medium">{times[hover].toLocaleString('es')}</p>
          {keys.map((k, i) => rows[hover][k] > 0 && (
            <p key={k} className="flex justify-between gap-4"><span><span style={{ color: PALETTE[i % PALETTE.length] }}>●</span> {labels[k]}</span><span className="tabular-nums">{format(rows[hover][k])}</span></p>
          ))}
          <p className="mt-1 flex justify-between border-t border-border pt-1 font-medium"><span>Total</span><span>{format(d3.sum(keys, (k) => rows[hover][k]))}</span></p>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted">
        {keys.map((k, i) => <span key={k} className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />{labels[k]}</span>)}
      </div>
    </div>
  );
}
