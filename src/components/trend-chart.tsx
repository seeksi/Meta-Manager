// Minimal SVG line chart — no charting dependency (ponytail: hand-rolled; upgrade to a
// chart lib only if interactivity/tooltips are needed). Server-renderable (no client JS).
interface Props {
  title: string;
  values: number[];
  labels: string[];
  format: (n: number) => string;
}

export function TrendChart({ title, values, labels, format }: Props) {
  const W = 320, H = 80, P = 4;
  if (values.length < 2) {
    return (
      <div>
        <div className="mb-1 text-xs uppercase tracking-wide text-black/50 dark:text-white/50">{title}</div>
        <div className="text-sm text-black/40 dark:text-white/40">Not enough data to chart.</div>
      </div>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => P + (i * (W - 2 * P)) / (values.length - 1);
  const y = (v: number) => H - P - ((v - min) / span) * (H - 2 * P);
  const line = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = values[values.length - 1];

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs uppercase tracking-wide text-black/50 dark:text-white/50">{title}</span>
        <span className="text-sm font-semibold tabular-nums">{format(last)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" role="img" aria-label={`${title} trend`}>
        <polyline points={line} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-blue-500" />
        <circle cx={x(values.length - 1)} cy={y(last)} r="2.5" className="fill-blue-500" />
      </svg>
      <div className="flex justify-between text-[10px] text-black/40 dark:text-white/40">
        <span>{labels[0]}</span>
        <span>{labels[labels.length - 1]}</span>
      </div>
    </div>
  );
}
