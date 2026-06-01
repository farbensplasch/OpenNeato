import { useEffect, useState } from "preact/hooks";
import { api, ResponseParseError } from "../api";
import backSvg from "../assets/icons/back.svg?raw";
import { Icon } from "../components/icon";
import { useNavigate } from "../components/router";
import type { HistoryFileInfo } from "../types";
import { normalizeError } from "../utils";
import { formatDuration } from "./history/helpers";

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface StatsData {
    totalCleans: number;
    totalArea: number;
    totalDistance: number;
    totalDuration: number;
    avgBatteryUsed: number | null;
    availableYears: number[];
    monthlyByYear: Record<number, number[]>;
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
    const monthlyByYear: Record<number, number[]> = {};

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

        if (f.session) {
            const d = new Date(f.session.time * 1000);
            const year = d.getUTCFullYear();
            const month = d.getUTCMonth();
            if (!monthlyByYear[year]) monthlyByYear[year] = Array(12).fill(0);
            monthlyByYear[year][month] += s.areaCovered;
        }
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
        const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
        const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
        const cp2y = p2[1] - (p3[1] - p1[1]) / 6;

        line += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)},${cp2x.toFixed(2)} ${cp2y.toFixed(2)},${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
    }

    const first = points[0];
    const last = points[points.length - 1];
    const area = `${line} L ${last[0].toFixed(2)} ${baseline} L ${first[0].toFixed(2)} ${baseline} Z`;

    return { area, line };
}

function MonthlyChart({ data }: { data: number[] }) {
    const maxArea = Math.max(...data, 0.01);
    const slotW = CHART_W / 12;
    const baseline = PT + CHART_H;

    const toY = (area: number) => PT + CHART_H * (1 - area / maxArea);

    const points: [number, number][] = data.map((area, i) => [PL + i * slotW + slotW / 2, toY(area)]);
    const { area, line } = smoothPaths(points, baseline);

    return (
        <svg viewBox={`0 0 ${CW} ${CH}`} width="100%" class="stats-chart" aria-hidden="true">
            <defs>
                <linearGradient id="stats-area-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" class="stats-area-grad-top" />
                    <stop offset="100%" class="stats-area-grad-bottom" />
                </linearGradient>
            </defs>

            {/* Gridlines */}
            <line x1={PL} y1={toY(maxArea * 0.5)} x2={CW - PR} y2={toY(maxArea * 0.5)} class="stats-chart-grid" />
            <line x1={PL} y1={PT} x2={CW - PR} y2={PT} class="stats-chart-grid" />

            {/* Y-axis labels */}
            <text x={PL - 4} y={PT + 4} textAnchor="end" class="stats-chart-label">
                {maxArea.toFixed(1)}
            </text>
            <text x={PL - 4} y={toY(maxArea * 0.5) + 4} textAnchor="end" class="stats-chart-label">
                {(maxArea * 0.5).toFixed(1)}
            </text>

            {/* Area fill + line */}
            {area && <path d={area} class="stats-chart-area" />}
            {line && <path d={line} class="stats-chart-line" />}

            {/* X-axis month labels */}
            {MONTH_LABELS.map((label, i) => (
                <text
                    key={label}
                    x={PL + i * slotW + slotW / 2}
                    y={CH - 4}
                    textAnchor="middle"
                    class="stats-chart-label"
                >
                    {label}
                </text>
            ))}

            {/* Baseline */}
            <line x1={PL} y1={baseline} x2={CW - PR} y2={baseline} class="stats-chart-baseline" />
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
    const monthlyData = stats?.monthlyByYear[selectedYear] ?? Array(12).fill(0);

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
                                <div class="stats-section-title">Area covered · {selectedYear}</div>
                                {stats.availableYears.length > 1 && (
                                    <div class="stats-year-picker">
                                        {stats.availableYears.map((y) => (
                                            <button
                                                key={y}
                                                type="button"
                                                class={`stats-year-btn${y === selectedYear ? " active" : ""}`}
                                                onClick={() => setSelectedYear(y)}
                                            >
                                                {y}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <MonthlyChart data={monthlyData} />
                            <div class="stats-chart-unit">m²</div>
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
