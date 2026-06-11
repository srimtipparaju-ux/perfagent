import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────
// RUN STORE — the data engineering layer
//
// Pattern: ingestion → append-only event log → aggregation → serving
//
//   - Every completed analysis run is appended as one JSON line
//     to runs.jsonl (immutable event log, the same pattern as a
//     Kafka topic or a data-lake landing zone, file-backed here).
//   - An in-memory index is rebuilt from the log at startup, so
//     restarts lose nothing.
//   - Aggregations (severity distribution, findings by skill,
//     cost/duration trends) are computed over the index and
//     served via /runs/stats for the dashboard.
//   - Swap DATA_DIR to an EFS/S3-synced mount in production, or
//     replace append() with a Kinesis/PostgreSQL writer — the
//     interface stays the same.
// ─────────────────────────────────────────────────────────────

export interface RunRecord {
  id: string;
  startedAt: string;            // ISO timestamp
  durationMs: number;
  fileCount: number;
  files: { name: string; skill: string }[];
  overallSeverity: 'Critical' | 'High' | 'Medium' | 'Low' | 'Info';
  rootCause?: string;
  findingsTotal: number;
  findingsBySeverity: Record<string, number>;     // Critical: 3, High: 5 ...
  findingsBySkill: Record<string, number>;        // 'awr-analysis': 4 ...
  totalTokens: number;
  estimatedCostUsd: number;
  ragChunksRetrieved: number;
}

const DATA_DIR = process.env.DATA_DIR || '/tmp/perf-agent/data';
const LOG_FILE = path.join(DATA_DIR, 'runs.jsonl');

// In-memory index, rebuilt from the log at startup
let runs: RunRecord[] = [];
let loaded = false;

function ensureLoaded() {
  if (loaded) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(LOG_FILE)) {
    const lines = fs.readFileSync(LOG_FILE, 'utf-8').split('\n').filter(Boolean);
    runs = [];
    for (const line of lines) {
      try { runs.push(JSON.parse(line)); }
      catch { logger.warn('run-store: skipped corrupt line in runs.jsonl'); }
    }
    logger.info(`run-store: loaded ${runs.length} runs from event log`);
  }
  loaded = true;
}

// ── Ingestion ────────────────────────────────────────────────

export function recordRun(partial: Omit<RunRecord, 'id' | 'startedAt'> & { startedAt?: string }): RunRecord {
  ensureLoaded();
  const record: RunRecord = {
    id: uuid(),
    startedAt: partial.startedAt || new Date().toISOString(),
    ...partial,
  };
  runs.push(record);
  // Append-only write — never rewrites history
  fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
  logger.info(`run-store: recorded run ${record.id} (${record.fileCount} files, ${record.findingsTotal} findings, $${record.estimatedCostUsd.toFixed(4)})`);
  return record;
}

// ── Serving ──────────────────────────────────────────────────

export function listRuns(limit = 50, offset = 0): { total: number; runs: RunRecord[] } {
  ensureLoaded();
  const sorted = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return { total: runs.length, runs: sorted.slice(offset, offset + limit) };
}

export function getRun(id: string): RunRecord | undefined {
  ensureLoaded();
  return runs.find(r => r.id === id);
}

// ── Aggregation ──────────────────────────────────────────────

export function getRunStats() {
  ensureLoaded();
  if (runs.length === 0) {
    return {
      totalRuns: 0, totalFindings: 0, totalCostUsd: 0, avgDurationMs: 0,
      severityDistribution: {}, findingsBySkill: {}, runsByDay: [], costByDay: [],
    };
  }

  const severityDistribution: Record<string, number> = {};
  const findingsBySkill: Record<string, number> = {};
  const byDay = new Map<string, { runs: number; cost: number; findings: number }>();

  let totalFindings = 0, totalCost = 0, totalDuration = 0;

  for (const r of runs) {
    totalFindings += r.findingsTotal;
    totalCost     += r.estimatedCostUsd;
    totalDuration += r.durationMs;

    for (const [sev, n] of Object.entries(r.findingsBySeverity)) {
      severityDistribution[sev] = (severityDistribution[sev] || 0) + n;
    }
    for (const [skill, n] of Object.entries(r.findingsBySkill)) {
      findingsBySkill[skill] = (findingsBySkill[skill] || 0) + n;
    }
    const day = r.startedAt.slice(0, 10);
    const d = byDay.get(day) || { runs: 0, cost: 0, findings: 0 };
    d.runs++; d.cost += r.estimatedCostUsd; d.findings += r.findingsTotal;
    byDay.set(day, d);
  }

  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return {
    totalRuns:     runs.length,
    totalFindings,
    totalCostUsd:  Number(totalCost.toFixed(4)),
    avgDurationMs: Math.round(totalDuration / runs.length),
    severityDistribution,
    findingsBySkill,
    runsByDay: days.map(([day, d]) => ({ day, runs: d.runs, findings: d.findings })),
    costByDay: days.map(([day, d]) => ({ day, costUsd: Number(d.cost.toFixed(4)) })),
  };
}
