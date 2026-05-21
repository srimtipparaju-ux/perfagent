import * as promClient from 'prom-client';
import { SkillMetrics } from '../types';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────
// LLM OBSERVABILITY
//
// Tracks every Claude API call:
//   - Token usage (input/output)
//   - Latency (P50, P90, P99 via histogram)
//   - Cost in USD
//   - Parse success / failure rate
//   - Findings count
//
// Exposes Prometheus /metrics endpoint for Grafana scraping.
// ─────────────────────────────────────────────────────────────

const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// ── Counters ──────────────────────────────────────────────────

const totalCalls = new promClient.Counter({
  name: 'perfagent_llm_calls_total',
  help: 'Total LLM API calls made',
  labelNames: ['skill', 'parse_success'],
  registers: [register],
});

const tokensCounter = new promClient.Counter({
  name: 'perfagent_llm_tokens_total',
  help: 'Total tokens consumed',
  labelNames: ['skill', 'direction'],   // direction = input | output
  registers: [register],
});

const costCounter = new promClient.Counter({
  name: 'perfagent_llm_cost_usd_total',
  help: 'Total estimated cost in USD',
  labelNames: ['skill'],
  registers: [register],
});

const findingsCounter = new promClient.Counter({
  name: 'perfagent_findings_total',
  help: 'Total findings produced',
  labelNames: ['skill', 'severity'],
  registers: [register],
});

// ── Histograms ────────────────────────────────────────────────

const latencyHistogram = new promClient.Histogram({
  name: 'perfagent_llm_latency_ms',
  help: 'LLM call latency in milliseconds',
  labelNames: ['skill'],
  buckets: [500, 1000, 2000, 5000, 10000, 20000, 30000, 60000],
  registers: [register],
});

const ragLatencyHistogram = new promClient.Histogram({
  name: 'perfagent_rag_latency_ms',
  help: 'RAG retrieval latency in milliseconds',
  buckets: [10, 50, 100, 250, 500, 1000, 2500],
  registers: [register],
});

// ── Gauges ────────────────────────────────────────────────────

const activeIncidents = new promClient.Gauge({
  name: 'perfagent_active_incidents',
  help: 'Number of active incidents being analyzed',
  registers: [register],
});

// ── In-memory metrics log (for /metrics/recent endpoint) ─────

const recentMetrics: SkillMetrics[] = [];
const MAX_RECENT = 1000;

// ── Cost model (per million tokens) ──────────────────────────

const COST_PER_M_TOKENS = {
  // Claude Sonnet 4.5
  'claude': { input: 3.00, output: 15.00 },
  // OpenAI embeddings
  'embedding': { input: 0.02, output: 0 },
};

function estimateCost(skill: string, inputTokens: number, outputTokens: number): number {
  const isEmbed = skill === 'rag-embed';
  const rates = isEmbed ? COST_PER_M_TOKENS.embedding : COST_PER_M_TOKENS.claude;
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
}

// ── Recording functions ──────────────────────────────────────

export function recordLLMCall(metrics: Omit<SkillMetrics, 'estimatedCostUsd' | 'timestamp'>): SkillMetrics {
  const fullMetrics: SkillMetrics = {
    ...metrics,
    estimatedCostUsd: estimateCost(metrics.skill, metrics.inputTokens, metrics.outputTokens),
    timestamp: new Date(),
  };

  // Update Prometheus metrics
  totalCalls.inc({ skill: metrics.skill, parse_success: String(metrics.parseSuccess) });
  tokensCounter.inc({ skill: metrics.skill, direction: 'input' }, metrics.inputTokens);
  tokensCounter.inc({ skill: metrics.skill, direction: 'output' }, metrics.outputTokens);
  costCounter.inc({ skill: metrics.skill }, fullMetrics.estimatedCostUsd);
  latencyHistogram.observe({ skill: metrics.skill }, metrics.latencyMs);

  // Track recent for /metrics/recent
  recentMetrics.push(fullMetrics);
  if (recentMetrics.length > MAX_RECENT) recentMetrics.shift();

  logger.info(
    `LLM call recorded — skill=${metrics.skill} ` +
    `tokens=${metrics.totalTokens} latency=${metrics.latencyMs}ms ` +
    `cost=$${fullMetrics.estimatedCostUsd.toFixed(4)} ` +
    `findings=${metrics.findingsCount} parsed=${metrics.parseSuccess}`
  );

  return fullMetrics;
}

export function recordFindings(skill: string, findings: Array<{ severity: string }>) {
  for (const f of findings) {
    findingsCounter.inc({ skill, severity: f.severity });
  }
}

export function recordRagLatency(ms: number) {
  ragLatencyHistogram.observe(ms);
}

export function setActiveIncidents(count: number) {
  activeIncidents.set(count);
}

// ── Exposition ───────────────────────────────────────────────

export async function getPrometheusMetrics(): Promise<string> {
  return await register.metrics();
}

export function getRecentMetrics(limit: number = 100): SkillMetrics[] {
  return recentMetrics.slice(-limit);
}

export function getSummaryStats() {
  const last = recentMetrics.slice(-100);
  if (last.length === 0) {
    return {
      callCount: 0,
      avgLatencyMs: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      parseSuccessRate: 1,
    };
  }
  return {
    callCount:        last.length,
    avgLatencyMs:     Math.round(last.reduce((s, m) => s + m.latencyMs, 0) / last.length),
    totalTokens:      last.reduce((s, m) => s + m.totalTokens, 0),
    totalCostUsd:     last.reduce((s, m) => s + m.estimatedCostUsd, 0),
    parseSuccessRate: last.filter(m => m.parseSuccess).length / last.length,
    bySkill:          aggregateBySkill(last),
  };
}

function aggregateBySkill(metrics: SkillMetrics[]) {
  const bySkill: Record<string, any> = {};
  for (const m of metrics) {
    if (!bySkill[m.skill]) {
      bySkill[m.skill] = {
        calls: 0, tokens: 0, costUsd: 0, avgLatencyMs: 0, parseSuccessRate: 1,
      };
    }
    const b = bySkill[m.skill];
    b.calls++;
    b.tokens += m.totalTokens;
    b.costUsd += m.estimatedCostUsd;
    b.avgLatencyMs += m.latencyMs;
  }
  for (const s of Object.keys(bySkill)) {
    bySkill[s].avgLatencyMs = Math.round(bySkill[s].avgLatencyMs / bySkill[s].calls);
    bySkill[s].costUsd = Number(bySkill[s].costUsd.toFixed(4));
  }
  return bySkill;
}

export { register };
