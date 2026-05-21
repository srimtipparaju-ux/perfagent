import 'dotenv/config';
import express from 'express';
import routes from './routes';
import { startScheduler } from './utils/scheduler';
import { logger } from './utils/logger';

// ─────────────────────────────────────────────────────────────
// PERF-AGENT SERVER
// ─────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Routes
app.use('/', routes);

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Start
app.listen(PORT, () => {
  logger.info(`🚀 perf-agent running on port ${PORT}`);
  logger.info(`   Anthropic: ${process.env.ANTHROPIC_API_KEY ? '✓' : '✗ MISSING'}`);
  logger.info(`   Slack:     ${process.env.SLACK_BOT_TOKEN ? '✓' : '○ not configured'}`);
  logger.info(`   Jira:      ${process.env.JIRA_BASE_URL ? '✓' : '○ not configured'}`);
  logger.info(`   Email:     ${process.env.SMTP_HOST ? '✓' : '○ not configured'}`);

  // Start scheduled jobs
  startScheduler();
});

export default app;
