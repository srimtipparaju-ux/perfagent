import { Router, Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import path from 'path';
import fs from 'fs';
import { DiagnosticInput } from '../types';
import { processInput, getReport, getAllReports } from '../agents/orchestrator';
import { handleChat, getSession, clearSession } from '../chat/chat-agent';
import { ingestDocument, getRagStats } from '../rag/retriever';
import { getPrometheusMetrics, getRecentMetrics, getSummaryStats, register } from '../observability/llm-metrics';
import { recordRun, listRuns, getRun, getRunStats } from '../data/run-store';
import { logger } from '../utils/logger';

const router = Router();

// Configure multer for file uploads
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/perf-agent/uploads';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_, file, cb) => cb(null, `${uuid()}-${file.originalname}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (_, file, cb) => {
    const allowed = ['.html', '.txt', '.log', '.har', '.json', '.hprof'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext) || file.mimetype.startsWith('text/'));
  },
});

// ─────────────────────────────────────────────────────────────
// ROUTE 1: Manual file upload
// POST /analyze
// Body: multipart/form-data with files + optional metadata
// ─────────────────────────────────────────────────────────────
router.post('/analyze', upload.array('files', 10), async (req: Request, res: Response) => {
  try {
    const files = req.files as Express.Multer.File[];
    const rawText = req.body.text || '';

    if (!files?.length && !rawText) {
      return res.status(400).json({ error: 'Provide at least one file or text content' });
    }

    const input: DiagnosticInput = {
      id: uuid(),
      source: 'upload',
      receivedAt: new Date(),
      application: req.body.application,
      environment: req.body.environment || 'production',
      triggeredBy: req.body.triggeredBy || 'manual-upload',
      rawText: rawText || undefined,
      filePaths: files?.map(f => f.path) || [],
    };

    logger.info(`Upload received: ${files?.length || 0} files, input=${input.id}`);

    // Return immediately, process async
    res.status(202).json({ inputId: input.id, message: 'Analysis started' });

    // Process in background
    processInput(input).catch(err =>
      logger.error(`Background processing failed for ${input.id}:`, err)
    );

  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// ROUTE 2: PagerDuty webhook
// POST /webhooks/pagerduty
// ─────────────────────────────────────────────────────────────
router.post('/webhooks/pagerduty', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const messages = body.messages || [];

    res.status(200).json({ received: true });

    for (const msg of messages) {
      if (msg.event !== 'incident.trigger') continue;

      const incident = msg.incident || {};
      const input: DiagnosticInput = {
        id: uuid(),
        source: 'alert',
        receivedAt: new Date(),
        application: incident.service?.name,
        environment: 'production',
        triggeredBy: `PagerDuty: ${incident.title}`,
        rawText: `PagerDuty Alert\nTitle: ${incident.title}\nSeverity: ${incident.severity}\nService: ${incident.service?.name}\nID: ${incident.id}`,
        metadata: { pagerduty_incident_id: incident.id },
      };

      processInput(input).catch(err =>
        logger.error(`PagerDuty processing failed for ${input.id}:`, err)
      );
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// ROUTE 3: OpsGenie webhook
// POST /webhooks/opsgenie
// ─────────────────────────────────────────────────────────────
router.post('/webhooks/opsgenie', async (req: Request, res: Response) => {
  try {
    const alert = req.body.alert || {};
    res.status(200).json({ received: true });

    if (req.body.action !== 'Create') return;

    const input: DiagnosticInput = {
      id: uuid(),
      source: 'alert',
      receivedAt: new Date(),
      application: alert.source,
      environment: 'production',
      triggeredBy: `OpsGenie: ${alert.message}`,
      rawText: `OpsGenie Alert\nMessage: ${alert.message}\nSeverity: ${alert.severity}\nSource: ${alert.source}\nTags: ${(alert.tags || []).join(', ')}`,
      metadata: { opsgenie_alert_id: alert.alertId },
    };

    processInput(input).catch(err =>
      logger.error(`OpsGenie processing failed for ${input.id}:`, err)
    );
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// ROUTE 4: Grafana webhook
// POST /webhooks/grafana
// ─────────────────────────────────────────────────────────────
router.post('/webhooks/grafana', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    res.status(200).json({ received: true });

    if (body.state !== 'alerting') return;

    const input: DiagnosticInput = {
      id: uuid(),
      source: 'monitoring',
      receivedAt: new Date(),
      application: body.tags?.application,
      environment: body.tags?.environment || 'production',
      triggeredBy: `Grafana: ${body.ruleName}`,
      rawText: `Grafana Alert\nRule: ${body.ruleName}\nState: ${body.state}\nMessage: ${body.message}\nURL: ${body.ruleUrl}`,
      metadata: { grafana_rule: body.ruleName },
    };

    processInput(input).catch(err =>
      logger.error(`Grafana processing failed for ${input.id}:`, err)
    );
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// ROUTE 5: CI/CD SQL Gate
// POST /ci/sql-gate
// Body: { sql: "SELECT ...", pullRequest: "123", repo: "myapp" }
// Returns: pass/fail with findings
// ─────────────────────────────────────────────────────────────
router.post('/ci/sql-gate', async (req: Request, res: Response) => {
  try {
    const { sql, pullRequest, repo, branch } = req.body;

    if (!sql) {
      return res.status(400).json({ error: 'sql field is required' });
    }

    const input: DiagnosticInput = {
      id: uuid(),
      source: 'ci-gate',
      receivedAt: new Date(),
      application: repo,
      environment: 'ci',
      triggeredBy: `PR #${pullRequest} on ${branch}`,
      rawText: sql,
    };

    const report = await processInput(input);

    const criticalFindings = report.mergedFindings.filter(f => f.severity === 'Critical');
    const highFindings = report.mergedFindings.filter(f => f.severity === 'High');
    const passed = criticalFindings.length === 0;

    res.status(200).json({
      passed,
      gate: passed ? 'PASS' : 'FAIL',
      severity: report.overallSeverity,
      criticalCount: criticalFindings.length,
      highCount: highFindings.length,
      findings: report.mergedFindings.slice(0, 10),
      reportId: report.id,
      message: passed
        ? `SQL gate passed. ${highFindings.length} high-severity issues found — review recommended.`
        : `SQL gate FAILED. ${criticalFindings.length} critical issue(s) must be fixed before merge.`,
    });

  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// STATUS ROUTES
// ─────────────────────────────────────────────────────────────

router.get('/reports', (_req: Request, res: Response) => {
  const reports = getAllReports().slice(0, 50);
  res.json({
    total: reports.length,
    reports: reports.map(r => ({
      id: r.id,
      title: r.title,
      severity: r.overallSeverity,
      skills: r.classification.skills,
      findings: r.mergedFindings.length,
      generatedAt: r.generatedAt,
    })),
  });
});

router.get('/reports/:id', (req: Request, res: Response) => {
  const report = getReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  res.json(report);
});

// ─────────────────────────────────────────────────────────────
// ROUTE: POST /analyze-all
// Upload multiple files at once. All are classified and analyzed
// in parallel, then cross-artifact correlation runs automatically
// to produce a single unified IncidentReport with a timeline.
//
// Body: multipart/form-data with multiple "files" fields
//   OR: { inputs: [{text, fileName, application}], application, environment }
// ─────────────────────────────────────────────────────────────
router.post('/analyze-all', upload.array('files', 20), async (req: Request, res: Response) => {
  try {
    const files     = (req.files as Express.Multer.File[]) || [];
    const app       = req.body.application || 'Unknown';
    const env       = req.body.environment || 'production';

    if (files.length < 2 && !req.body.inputs) {
      return res.status(400).json({ error: 'Upload at least 2 files for multi-artifact analysis' });
    }

    res.status(202).json({ message: 'Multi-artifact analysis started', fileCount: files.length });

    // Build one DiagnosticInput per file
    const { classifyInput } = await import('./agents/classifier');
    const { analyzeAllInputs } = await import('./agents/analyzer');
    const { correlateAcrossArtifacts } = await import('./agents/cross-artifact-correlator');
    const { compileReport } = await import('./agents/reporter');
    const { v4: uuid } = await import('uuid');

    const inputs: any[] = files.map(f => ({
      id:          uuid(),
      source:      'upload' as const,
      application: app,
      environment: env,
      filePaths:   [f.path],
      rawText:     undefined,
      receivedAt:  new Date(),
    }));

    // Classify each input
    logger.info(`Classifying ${inputs.length} inputs...`);
    const classifications = await Promise.all(inputs.map(i => classifyInput(i)));
    const skillMap = new Map<string, any[]>();
    inputs.forEach((inp, idx) => skillMap.set(inp.id, classifications[idx].skills));

    // Run all skills across all inputs in parallel
    logger.info('Running all skills in parallel...');
    const allAnalyses = await analyzeAllInputs(inputs, skillMap);

    // Always run cross-artifact correlation when multiple files
    const primaryInput = inputs[0];
    primaryInput.application = app;
    const timeline = allAnalyses.length >= 2
      ? await correlateAcrossArtifacts(allAnalyses, primaryInput, 'pending')
      : null;

    // Compile merged report using primary classification
    const report = compileReport(primaryInput, classifications[0], allAnalyses);
    if (timeline) {
      timeline.incidentId = report.id;
      report.incidentTimeline = timeline;
    }
    reportStore.set(report.id, report);

    // Send notifications
    const { sendSlackNotifications, postSlackThread } = await import('./integrations/slack');
    const { createJiraIssue } = await import('./integrations/jira');
    const { sendEmailNotification } = await import('./integrations/email');
    const { formatTimelineSlackMessage } = await import('./agents/reporter');

    for (const route of report.classification.teams) {
      if (route.channels.includes('slack') && route.slackChannel) {
        const records = await sendSlackNotifications(report, primaryInput, [route.slackChannel]).catch(() => []);
        report.notificationsSent.push(...records);
        if (timeline && records.find((r: any) => r.success)?.reference) {
          const ts = records.find((r: any) => r.success).reference;
          await postSlackThread(route.slackChannel, ts, formatTimelineSlackMessage(timeline)).catch(() => {});
        }
      }
      if (route.channels.includes('jira') && route.jiraProject) {
        const record = await createJiraIssue(report, primaryInput, route.jiraProject).catch(() => null);
        if (record) report.notificationsSent.push(record);
      }
    }

    logger.info(`/analyze-all complete → report ${report.id}, timeline events: ${timeline?.timelineEvents?.length ?? 0}`);

  } catch (err: any) {
    logger.error('/analyze-all error:', err);
  }
});


// Returns the cross-artifact incident timeline for a report.
// ─────────────────────────────────────────────────────────────
router.get('/reports/:id/timeline', (req: Request, res: Response) => {
  const report = getReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  if (!report.incidentTimeline) {
    return res.status(404).json({
      error: 'No incident timeline for this report',
      reason: 'Timeline is generated when 2+ skills are analyzed. This report had only one skill.',
    });
  }
  res.json(report.incidentTimeline);
});

// ─────────────────────────────────────────────────────────────
// ROUTE: POST /correlate-reports
// Manually links multiple existing reports into a unified
// incident timeline. Useful when separate incidents are
// later discovered to share a root cause.
//
// Body: { reportIds: ["id1", "id2", ...], application?: string }
// ─────────────────────────────────────────────────────────────
router.post('/correlate-reports', async (req: Request, res: Response) => {
  try {
    const { reportIds, application, environment } = req.body;

    if (!Array.isArray(reportIds) || reportIds.length < 2) {
      return res.status(400).json({ error: 'Provide at least 2 reportIds' });
    }

    const reports = reportIds.map((id: string) => getReport(id)).filter(Boolean);
    if (reports.length < 2) {
      return res.status(400).json({ error: 'Could not find at least 2 of the specified reports' });
    }

    // Build the analysis payload
    const { correlateReports } = await import('../agents/cross-artifact-correlator');
    const reportAnalyses = reports.flatMap((r: any) =>
      r.analyses.map((a: any) => ({
        reportId: r.id,
        analysis: a,
        fileName: `${r.title.slice(0, 30)}-${a.skill}`,
      }))
    );

    res.status(202).json({ message: 'Correlation started', reportIds });

    // Run async
    correlateReports(reportAnalyses, { application, environment })
      .then(timeline => {
        if (timeline) {
          logger.info(`Manual correlation complete: ${timeline.timelineEvents.length} events`);
          // Attach to first report for retrieval
          const firstReport = reports[0] as any;
          firstReport.incidentTimeline = timeline;
        }
      })
      .catch(err => logger.error('Manual correlation failed:', err));

  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    anthropic: process.env.ANTHROPIC_API_KEY ? 'configured' : 'missing',
    slack: process.env.SLACK_BOT_TOKEN ? 'configured' : 'not configured',
    jira: process.env.JIRA_BASE_URL ? 'configured' : 'not configured',
    email: process.env.SMTP_HOST ? 'configured' : 'not configured',
    crossArtifactCorrelation: 'enabled (2+ skills triggers automatically)',
  });
});



// ═════════════════════════════════════════════════════════════
// PHASE 2 ROUTES: Chat, RAG, Observability
// ═════════════════════════════════════════════════════════════

// ── POST /chat ────────────────────────────────────────────────
// Conversational follow-up over an incident report.
// Maintains session history, retrieves runbooks via RAG.
router.post('/chat', async (req: Request, res: Response) => {
  try {
    const { sessionId, incidentId, message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'message field is required' });
    }

    const incident = incidentId ? getReport(incidentId) : undefined;
    const response = await handleChat({ sessionId, incidentId, message }, incident);
    res.json(response);
  } catch (err: any) {
    logger.error('/chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /chat/:sessionId ──────────────────────────────────────
// Retrieve chat history for a session.
router.get('/chat/:sessionId', (req: Request, res: Response) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'session not found' });
  res.json(session);
});

// ── DELETE /chat/:sessionId ──────────────────────────────────
router.delete('/chat/:sessionId', (req: Request, res: Response) => {
  const ok = clearSession(req.params.sessionId);
  res.json({ deleted: ok });
});

// ── POST /rag/ingest ──────────────────────────────────────────
// Upload runbooks, postmortems, architecture docs to the
// vector store. Used at setup time to populate the KB.
router.post('/rag/ingest', async (req: Request, res: Response) => {
  try {
    const { source, title, content, category, tags } = req.body;
    if (!content || !title) {
      return res.status(400).json({ error: 'title and content are required' });
    }
    const chunks = await ingestDocument(source || title, title, content, category, tags || []);
    res.json({ chunks: chunks.length, ids: chunks.map(c => c.id) });
  } catch (err: any) {
    logger.error('/rag/ingest error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /rag/stats ────────────────────────────────────────────
router.get('/rag/stats', (_req: Request, res: Response) => {
  res.json(getRagStats());
});

// ── GET /metrics ──────────────────────────────────────────────
// Prometheus scrape endpoint
router.get('/metrics', async (_req: Request, res: Response) => {
  res.set('Content-Type', register.contentType);
  res.end(await getPrometheusMetrics());
});

// ── GET /metrics/recent ──────────────────────────────────────
// Last 100 LLM calls in JSON (for live dashboard)
router.get('/metrics/recent', (req: Request, res: Response) => {
  const limit = Number(req.query.limit || 100);
  res.json(getRecentMetrics(limit));
});

// ── GET /metrics/summary ──────────────────────────────────────
// Aggregated stats for dashboard top cards
router.get('/metrics/summary', (_req: Request, res: Response) => {
  res.json(getSummaryStats());
});


// ═════════════════════════════════════════════════════════════
// RUN HISTORY — data engineering layer (append-only event log)
// ═════════════════════════════════════════════════════════════

// ── POST /runs ────────────────────────────────────────────────
// Record a completed analysis run (called by orchestrator or clients).
router.post('/runs', (req: Request, res: Response) => {
  try {
    const record = recordRun(req.body);
    res.status(201).json(record);
  } catch (err: any) {
    logger.error('/runs POST error:', err);
    res.status(400).json({ error: err.message });
  }
});

// ── GET /runs ─────────────────────────────────────────────────
router.get('/runs', (req: Request, res: Response) => {
  const limit  = Math.min(200, Number(req.query.limit  || 50));
  const offset = Number(req.query.offset || 0);
  res.json(listRuns(limit, offset));
});

// ── GET /runs/stats ───────────────────────────────────────────
// Aggregations for the dashboard: severity distribution, findings
// by skill, runs/cost by day, totals.
router.get('/runs/stats', (_req: Request, res: Response) => {
  res.json(getRunStats());
});

// ── GET /runs/:id ─────────────────────────────────────────────
router.get('/runs/:id', (req: Request, res: Response) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });
  res.json(run);
});

export default router;