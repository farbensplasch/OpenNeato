import { useEffect, useState } from "preact/hooks";
import { api, ResponseParseError } from "../api";
import backSvg from "../assets/icons/back.svg?raw";
import { Icon } from "../components/icon";
import { useNavigate } from "../components/router";
import type { HistoryFileInfo } from "../types";
import { normalizeError } from "../utils";
import { formatDuration } from "./history/helpers";

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type ChartMetric = "area" | "distance" | "duration" | "cleans";

const METRICS: { key: ChartMetric; label: string }[] = [
    { key: "area", label: "Area" },
    { key: "distance", label: "Distance" },
    { key: "duration", label: "Runtime" },
    { key: "cleans", label: "Cleans" },
];

const METRIC_TITLES: Record<ChartMetric, string> = {
    area: "Area covered",
    distance: "Distance",
    duration: "Runtime",
    cleans: "Cleans",
};

const METRIC_UNITS: Record<ChartMetric, string> = {
    area: "m²",
    distance: "m",
    duration: "",
    cleans: "",
};

interface MonthlyData {
    area: number[];
    distance: number[];
    duration: number[];
    cleans: number[];
}

const EMPTY_MONTHLY: MonthlyData = {
    area: Array(12).fill(0),
    distance: Array(12).fill(0),
    duration: Array(12).fill(0),
    cleans: Array(12).fill(0),
};

interface StatsData {
    totalCleans: number;
    totalArea: number;
    totalDistance: number;
    totalDuration: number;
    avgBatteryUsed: number | null;
    availableYears: number[];
    monthlyByYear: Record<number, MonthlyData>;
    modeCounts: { house: number; spot: number; manual: number };
}

function computeStats(files: HistoryFileInfo[]): StatsData {
    const finished = files.filter((f) => f.summary && !f.recording);

    let totalArea = 0;
    let totalDistance = 0;
    let totalDuration = 0;
    let batterySum = 0;
    let batteryCount = 0;
    const modeCounts = { house: 0, spot: 0, manual: 0 };
    const monthlyByYear: Record<number, MonthlyData> = {};

    for (const f of finished) {
        if (!f.summary) continue;
        const s = f.summary;
        totalArea += s.areaCovered;
        totalDistance += s.distanceTraveled;
        totalDuration += s.duration;
        const battStart = s.batteryStart ?? f.session?.battery;
        if (battStart != null && s.batteryEnd != null && battStart > s.batteryEnd) {
            batterySum += battStart - s.batteryEnd;
            batteryCount++;
        }
        const mode = (f.session?.mode ?? s.mode).toLowerCase();
        if (mode === "house") modeCounts.house++;
        else if (mode === "spot") modeCounts.spot++;
        else modeCounts.manual++;

        const sessionTime = f.session?.time ?? s.time;
        const d = new Date(sessionTime * 1000);
        const year = d.getFullYear();
        const month = d.getMonth();
        if (!monthlyByYear[year])
            monthlyByYear[year] = {
                area: Array(12).fill(0),
                distance: Array(12).fill(0),
                duration: Array(12).fill(0),
                cleans: Array(12).fill(0),
            };
        monthlyByYear[year].area[month] += s.areaCovered;
        monthlyByYear[year].distance[month] += s.distanceTraveled;
        monthlyByYear[year].duration[month] += s.duration;
        monthlyByYear[year].cleans[month]++;
    }

    const availableYears = Object.keys(monthlyByYear)
        .map(Number)
        .sort((a, b) => b - a);

    return {
        totalCleans: finished.length,
        totalArea,
        totalDistance,
        totalDuration,
        avgBatteryUsed: batteryCount > 0 ? batterySum / batteryCount : null,
        availableYears,
        monthlyByYear,
        modeCounts,
    };
}

function formatDistance(m: number): { value: string; unit: string } {
    if (m >= 1000) return { value: (m / 1000).toFixed(1), unit: "km" };
    return { value: m.toFixed(0), unit: "m" };
}

function metricAxisLabel(val: number, metric: ChartMetric): string {
    switch (metric) {
        case "area":
            return val.toFixed(1);
        case "distance":
            return val >= 1000 ? `${(val / 1000).toFixed(1)}k` : val.toFixed(0);
        case "duration": {
            const h = Math.floor(val / 3600);
            const m = Math.floor((val % 3600) / 60);
            return h > 0 ? `${h}h${m}m` : `${m}m`;
        }
        case "cleans":
            return String(Math.round(val));
    }
}

function formatMetricVal(val: number, metric: ChartMetric): string {
    switch (metric) {
        case "area":
            return `${val.toFixed(1)} m²`;
        case "distance":
            return val >= 1000 ? `${(val / 1000).toFixed(1)} km` : `${val.toFixed(0)} m`;
        case "duration":
            return formatDuration(Math.round(val));
        case "cleans":
            return `${Math.round(val)}`;
    }
}

// -- Chart ---------------------------------------------------------------

const CW = 360;
const CH = 150;
const PL = 32;
const PR = 6;
const PT = 8;
const PB = 26;
const CHART_W = CW - PL - PR;
const CHART_H = CH - PT - PB;

function smoothPaths(points: [number, number][], baseline: number): { area: string; line: string } {
    if (points.length === 0) return { area: "", line: "" };

    let line = `M ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`;

    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(points.length - 1, i + 2)];

        const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
        const cp1y = Math.max(PT, Math.min(baseline, p1[1] + (p2[1] - p0[1]) / 6));
        const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
        const cp2y = Math.max(PT, Math.min(baseline, p2[1] - (p3[1] - p1[1]) / 6));

        line += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)},${cp2x.toFixed(2)} ${cp2y.toFixed(2)},${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
    }

    const first = points[0];
    const last = points[points.length - 1];
    const area = `${line} L ${last[0].toFixed(2)} ${baseline} L ${first[0].toFixed(2)} ${baseline} Z`;

    return { area, line };
}

function MonthlyChart({
    data,
    metric,
    selectedMonth,
    onSelectMonth,
}: {
    data: number[];
    metric: ChartMetric;
    selectedMonth: number | null;
    onSelectMonth: (m: number | null) => void;
}) {
    const maxVal = Math.max(...data, 0.01);
    const slotW = CHART_W / 12;
    const baseline = PT + CHART_H;
    const toY = (v: number) => PT + CHART_H * (1 - v / maxVal);
    const points: [number, number][] = data.map((v, i) => [PL + i * slotW + slotW / 2, toY(v)]);
    const { area, line } = smoothPaths(points, baseline);

    const tooltip =
        selectedMonth !== null
            ? (() => {
                  const x = points[selectedMonth][0];
                  const y = points[selectedMonth][1];
                  const label = `${MONTH_LABELS[selectedMonth]}: ${formatMetricVal(data[selectedMonth], metric)}`;
                  const tw = label.length * 5.2 + 10;
                  const tx = Math.max(PL + 2, Math.min(CW - PR - tw - 2, x - tw / 2));
                  const ty = Math.max(PT + 12, y - 10);
                  return { x, y, label, tw, tx, ty };
              })()
            : null;

    return (
        <svg viewBox={`0 0 ${CW} ${CH}`} width="100%" class="stats-chart" aria-hidden="true">
            <defs>
                <linearGradient id="stats-area-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" class="stats-area-grad-top" />
                    <stop offset="100%" class="stats-area-grad-bottom" />
                </linearGradient>
            </defs>

            {/* Gridlines */}
            <line x1={PL} y1={toY(maxVal * 0.5)} x2={CW - PR} y2={toY(maxVal * 0.5)} class="stats-chart-grid" />
            <line x1={PL} y1={PT} x2={CW - PR} y2={PT} class="stats-chart-grid" />

            {/* Y-axis labels */}
            <text x={PL - 4} y={PT + 4} textAnchor="end" class="stats-chart-label">
                {metricAxisLabel(maxVal, metric)}
            </text>
            <text x={PL - 4} y={toY(maxVal * 0.5) + 4} textAnchor="end" class="stats-chart-label">
                {metricAxisLabel(maxVal * 0.5, metric)}
            </text>

            {/* Area fill + line */}
            {area && <path d={area} class="stats-chart-area" />}
            {line && <path d={line} class="stats-chart-line" />}

            {/* Selected month vertical line */}
            {tooltip && (
                <line x1={tooltip.x} y1={PT} x2={tooltip.x} y2={baseline} class="stats-chart-selector" />
            )}

            {/* X-axis month labels */}
            {MONTH_LABELS.map((label, i) => (
                <text
                    key={label}
                    x={PL + i * slotW + slotW / 2}
                    y={CH - 4}
                    textAnchor="middle"
                    class={`stats-chart-label${i === selectedMonth ? " stats-chart-label-sel" : ""}`}
                >
                    {label}
                </text>
            ))}

            {/* Baseline */}
            <line x1={PL} y1={baseline} x2={CW - PR} y2={baseline} class="stats-chart-baseline" />

            {/* Click zones */}
            {MONTH_LABELS.map((_, i) => (
                <rect
                    key={i}
                    x={PL + i * slotW}
                    y={PT}
                    width={slotW}
                    height={CHART_H + PB}
                    fill="transparent"
                    style="cursor:pointer"
                    onClick={() => onSelectMonth(i === selectedMonth ? null : i)}
                />
            ))}

            {/* Tooltip (rendered last so it sits on top) */}
            {tooltip && (
                <g style="pointer-events:none">
                    <circle cx={tooltip.x} cy={tooltip.y} r={3} class="stats-chart-dot" />
                    <rect
                        x={tooltip.tx - 2}
                        y={tooltip.ty - 10}
                        width={tooltip.tw}
                        height={14}
                        rx={3}
                        class="stats-chart-tooltip-bg"
                    />
                    <text
                        x={tooltip.tx + tooltip.tw / 2}
                        y={tooltip.ty}
                        textAnchor="middle"
                        class="stats-chart-tooltip-text"
                    >
                        {tooltip.label}
                    </text>
                </g>
            )}
        </svg>
    );
}

// -- Stat card -----------------------------------------------------------

function StatCard({ label, value, unit }: { label: string; value: string; unit?: string }) {
    return (
        <div class="stats-card">
            <div class="stats-card-label">{label}</div>
            <div class="stats-card-value">
                {value}
                {unit && <span class="stats-card-unit"> {unit}</span>}
            </div>
        </div>
    );
}

// -- View ----------------------------------------------------------------

export function StatsView() {
    const navigate = useNavigate();
    const [stats, setStats] = useState<StatsData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
    const [selectedMetric, setSelectedMetric] = useState<ChartMetric>("area");
    const [selectedMonth, setSelectedMonth] = useState<number | null>(null);

    useEffect(() => {
        api.getHistoryList()
            .then((files) => {
                const s = computeStats(files);
                setStats(s);
                if (s.availableYears.length > 0) setSelectedYear(s.availableYears[0]);
            })
            .catch((e: unknown) => {
                const msg =
                    e instanceof ResponseParseError
                        ? "History data is corrupted — use the Cleaning History page to recover."
                        : normalizeError(e, "Failed to load history");
                setError(msg);
            })
            .finally(() => setLoading(false));
    }, []);

    const dist = stats ? formatDistance(stats.totalDistance) : { value: "0", unit: "m" };
    const monthlyData = stats?.monthlyByYear[selectedYear] ?? EMPTY_MONTHLY;
    const unit = METRIC_UNITS[selectedMetric];

    return (
        <>
            <div class="header">
                <button type="button" class="header-back-btn" onClick={() => navigate("/history")} aria-label="Back">
                    <Icon svg={backSvg} />
                </button>
                <h1>Statistics</h1>
                <div class="header-right-spacer" />
            </div>

            <div class="stats-page">
                {loading && <div class="stats-empty">Loading...</div>}
                {error && <div class="stats-empty">{error}</div>}

                {stats && stats.totalCleans === 0 && <div class="stats-empty">No completed cleans yet</div>}

                {stats && stats.totalCleans > 0 && (
                    <>
                        <div class="stats-totals">
                            <StatCard label="Total cleans" value={String(stats.totalCleans)} />
                            <StatCard label="Area covered" value={stats.totalArea.toFixed(1)} unit="m²" />
                            <StatCard label="Distance" value={dist.value} unit={dist.unit} />
                            <StatCard label="Runtime" value={formatDuration(stats.totalDuration)} />
                        </div>

                        <div class="stats-section">
                            <div class="stats-section-header">
                                <div class="stats-section-title">
                                    {METRIC_TITLES[selectedMetric]} · {selectedYear}
                                </div>
                                {stats.availableYears.length > 1 && (() => {
                                    const idx = stats.availableYears.indexOf(selectedYear);
                                    return (
                                        <div class="stats-year-nav">
                                            <button
                                                type="button"
                                                class="stats-year-nav-btn"
                                                disabled={idx >= stats.availableYears.length - 1}
                                                onClick={() => setSelectedYear(stats.availableYears[idx + 1])}
                                                aria-label="Previous year"
                                            >
                                                ‹
                                            </button>
                                            <button
                                                type="button"
                                                class="stats-year-nav-btn"
                                                disabled={idx <= 0}
                                                onClick={() => setSelectedYear(stats.availableYears[idx - 1])}
                                                aria-label="Next year"
                                            >
                                                ›
                                            </button>
                                        </div>
                                    );
                                })()}
                            </div>
                            <div class="stats-metric-picker">
                                {METRICS.map(({ key, label }) => (
                                    <button
                                        key={key}
                                        type="button"
                                        class={`stats-metric-btn${key === selectedMetric ? " active" : ""}`}
                                        onClick={() => setSelectedMetric(key)}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                            <MonthlyChart
                                data={monthlyData[selectedMetric]}
                                metric={selectedMetric}
                                selectedMonth={selectedMonth}
                                onSelectMonth={setSelectedMonth}
                            />
                            {unit && <div class="stats-chart-unit">{unit}</div>}
                        </div>

                        <div class="stats-section">
                            <div class="stats-section-title">Cleaning mode</div>
                            <div class="stats-modes">
                                <div class="stats-mode-pill">
                                    <div class="stats-mode-count">{stats.modeCounts.house}</div>
                                    <div class="stats-mode-label">House</div>
                                </div>
                                <div class="stats-mode-pill">
                                    <div class="stats-mode-count">{stats.modeCounts.spot}</div>
                                    <div class="stats-mode-label">Spot</div>
                                </div>
                                {stats.modeCounts.manual > 0 && (
                                    <div class="stats-mode-pill">
                                        <div class="stats-mode-count">{stats.modeCounts.manual}</div>
                                        <div class="stats-mode-label">Manual</div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {stats.avgBatteryUsed !== null && (
                            <div class="stats-section stats-battery-row">
                                <span class="stats-section-title">Avg battery per clean</span>
                                <span class="stats-battery-value">{Math.round(stats.avgBatteryUsed)}%</span>
                            </div>
                        )}
                    </>
                )}
            </div>
        </>
    );
}
