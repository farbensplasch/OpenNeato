import { useEffect, useState } from "preact/hooks";
import { api, ResponseParseError } from "../api";
import backSvg from "../assets/icons/back.svg?raw";
import { Icon } from "../components/icon";
import { useNavigate } from "../components/router";
import type { HistoryFileInfo } from "../types";
import { normalizeError } from "../utils";
import { formatDuration } from "./history/helpers";

const NUM_WEEKS = 10;
const MS_WEEK = 7 * 86400 * 1000;

function weekStartMs(epochMs: number): number {
    const d = new Date(epochMs);
    const dow = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
    return (
        epochMs -
        dow * 86400000 -
        (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()) * 1000 -
        d.getUTCMilliseconds()
    );
}

interface WeekBucket {
    startMs: number;
    label: string;
    area: number;
}

interface StatsData {
    totalCleans: number;
    totalArea: number;
    totalDistance: number;
    totalDuration: number;
    avgBatteryUsed: number | null;
    weekly: WeekBucket[];
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
    }

    const thisWeek = weekStartMs(Date.now());
    const weekly: WeekBucket[] = Array.from({ length: NUM_WEEKS }, (_, i) => {
        const startMs = thisWeek - (NUM_WEEKS - 1 - i) * MS_WEEK;
        const d = new Date(startMs);
        return { startMs, label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, area: 0 };
    });

    for (const f of finished) {
        if (!f.session || !f.summary) continue;
        const ws = weekStartMs(f.session.time * 1000);
        const b = weekly.find((w) => w.startMs === ws);
        if (b) b.area += f.summary.areaCovered;
    }

    return {
        totalCleans: finished.length,
        totalArea,
        totalDistance,
        totalDuration,
        avgBatteryUsed: batteryCount > 0 ? batterySum / batteryCount : null,
        weekly,
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
const PL = 32; // left (y-axis labels)
const PR = 6;
const PT = 8;
const PB = 26; // bottom (x-axis labels)
const CHART_W = CW - PL - PR;
const CHART_H = CH - PT - PB;

function WeeklyChart({ data }: { data: WeekBucket[] }) {
    const maxArea = Math.max(...data.map((d) => d.area), 0.01);
    const slotW = CHART_W / data.length;
    const barW = Math.max(slotW * 0.62, 4);

    const toY = (area: number) => PT + CHART_H * (1 - area / maxArea);

    return (
        <svg viewBox={`0 0 ${CW} ${CH}`} width="100%" class="stats-chart" aria-hidden="true">
            {/* 50% gridline */}
            <line x1={PL} y1={toY(maxArea * 0.5)} x2={CW - PR} y2={toY(maxArea * 0.5)} class="stats-chart-grid" />
            {/* 100% gridline */}
            <line x1={PL} y1={PT} x2={CW - PR} y2={PT} class="stats-chart-grid" />

            {/* Y-axis labels */}
            <text x={PL - 4} y={PT + 4} textAnchor="end" class="stats-chart-label">
                {maxArea.toFixed(1)}
            </text>
            <text x={PL - 4} y={toY(maxArea * 0.5) + 4} textAnchor="end" class="stats-chart-label">
                {(maxArea * 0.5).toFixed(1)}
            </text>

            {/* Bars + x labels */}
            {data.map((d, i) => {
                const bh = (d.area / maxArea) * CHART_H;
                const bx = PL + i * slotW + (slotW - barW) / 2;
                const by = PT + CHART_H - bh;
                const lx = PL + i * slotW + slotW / 2;
                return (
                    <g key={d.startMs}>
                        {bh > 0 && <rect x={bx} y={by} width={barW} height={bh} class="stats-chart-bar" rx="2" />}
                        {i % 2 === 0 && (
                            <text x={lx} y={CH - 4} textAnchor="middle" class="stats-chart-label">
                                {d.label}
                            </text>
                        )}
                    </g>
                );
            })}

            {/* Baseline */}
            <line x1={PL} y1={PT + CHART_H} x2={CW - PR} y2={PT + CHART_H} class="stats-chart-baseline" />
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

    useEffect(() => {
        api.getHistoryList()
            .then((files) => setStats(computeStats(files)))
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
                            <div class="stats-section-title">Area covered · last 10 weeks</div>
                            <WeeklyChart data={stats.weekly} />
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
