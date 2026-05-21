import cron from 'node-cron';
import { v4 as uuid } from 'uuid';
import { DiagnosticInput } from '../types';
import { processInput, getAllReports } from '../agents/orchestrator';
import { postSlackMessage } from '../integrations/slack';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────
// SCHEDULER
// Runs periodic jobs:
// 1. Nightly trend report — compares this week vs last week
// 2. Weekly digest — summary of all incidents this week
// ─────────────────────────────────────────────────────────────

export function startScheduler(): void {
  const trendCron = process.env.TREND_REPORT_CRON || '0 6 * * *'; // 6am UTC daily

  // Nightly trend report
  cron.schedule(trendCron, async () => {
    logger.info('Running scheduled nightly trend report...');
    await runTrendReport();
  });

  // Weekly digest — every Monday 8am UTC
  cron.schedule('0 8 * * 1', async () => {
    logger.info('Running weekly incident digest...');
    await runWeeklyDigest();
  });

  logger.info(`Scheduler started. Trend report cron: ${trendCron}`);
}

// ── Nightly trend report ──────────────────────────────────────

async function runTrendReport(): Promise<void> {
  // In a real deployment, pull last 24h of AWR reports from S3 or a shared location.
  // Here we synthesize a summary from recent reports in memory.

  const reports = getAllReports();
  const last24h = reports.filter(r =>
    Date.now() - r.generatedAt.getTime() < 24 * 60 * 60 * 1000
  );

  if (last24h.length === 0) {
    logger.info('No reports in last 24h — skipping trend notification');
    return;
  }

  const criticalCount = last24h.filter(r => r.overallSeverity === 'Critical').length;
  const highCount = last24h.filter(r => r.overallSeverity === 'High').length;

  // Count top finding categories across all reports
  const categoryCounts = new Map<string, number>();
  for (const report of last24h) {
    for (const finding of report.mergedFindings) {
      const cat = finding.category;
      categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
    }
  }
  const topCategories = Array.from(categoryCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cat, count]) => `• ${cat}: ${count} findings`)
    .join('\n');

  const channel = process.env.TREND_REPORT_SLACK_CHANNEL || '#perf-weekly';
  const message = [
    `📊 *Daily Performance Summary — ${new Date().toDateString()}*`,
    `Incidents analyzed: ${last24h.length}`,
    `🔴 Critical: ${criticalCount} | 🟠 High: ${highCount}`,
    '',
    `*Top Finding Categories:*`,
    topCategories || 'No findings recorded',
    '',
    `_Run \`GET /reports\` on the perf-agent server for full details._`,
  ].join('\n');

  await postSlackMessage(channel, message);
  logger.info(`Trend report posted to ${channel}`);
}

// ── Weekly digest ─────────────────────────────────────────────

async function runWeeklyDigest(): Promise<void> {
  const reports = getAllReports();
  const lastWeek = reports.filter(r =>
    Date.now() - r.generatedAt.getTime() < 7 * 24 * 60 * 60 * 1000
  );

  if (lastWeek.length === 0) {
    logger.info('No reports in last 7 days — skipping weekly digest');
    return;
  }

  const byTeam = new Map<string, number>();
  for (const report of lastWeek) {
    for (const route of report.classification.teams) {
      byTeam.set(route.team, (byTeam.get(route.team) || 0) + 1);
    }
  }

  const teamBreakdown = Array.from(byTeam.entries())
    .map(([team, count]) => `• ${team}: ${count} incident(s)`)
    .join('\n');

  const channel = process.env.TREND_REPORT_SLACK_CHANNEL || '#perf-weekly';
  const message = [
    `📅 *Weekly Performance Digest — Week of ${getWeekStart()}*`,
    `Total incidents: ${lastWeek.length}`,
    '',
    `*By Team:*`,
    teamBreakdown,
    '',
    `*This week's top 3 recurring issues:*`,
    getTopRecurringIssues(lastWeek),
  ].join('\n');

  await postSlackMessage(channel, message);
  logger.info(`Weekly digest posted to ${channel}`);
}

function getTopRecurringIssues(reports: any[]): string {
  const titleCounts = new Map<string, number>();
  for (const report of reports) {
    for (const finding of report.mergedFindings) {
      const key = finding.title.slice(0, 60);
      titleCounts.set(key, (titleCounts.get(key) || 0) + 1);
    }
  }
  return Array.from(titleCounts.entries())
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([title, count], i) => `${i + 1}. ${title} (${count}×)`)
    .join('\n') || 'No recurring issues this week 🎉';
}

function getWeekStart(): string {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(now.setDate(diff)).toDateString();
}
