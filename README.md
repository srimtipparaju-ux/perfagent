# perf-agent

An AI-powered performance diagnostic agent. Analyzes Oracle AWR reports, SQL execution plans, Java thread/heap dumps, JFR recordings, browser console logs, and stack traces. Routes findings with severity-ranked reports to the right teams via Slack, Jira, and email — automatically.

---

## Architecture

```
Inputs                    Agent Pipeline                  Outputs
──────                    ──────────────                  ───────
File Upload  ──┐          ┌──────────────┐               Slack #db-team
Alert Hook   ──┤──────▶  │  Classifier  │──┐            Slack #java-team
Monitoring   ──┤          └──────────────┘  │            Slack #on-call
Scheduled    ──┘               │             │            Jira DBA project
                               ▼             │            Jira BACKEND project
                     ┌─────────────────┐    │            Email team DLs
                     │ Skill Analyzers  │    │            Word Report (.docx)
                     │ (run in parallel)│    │
                     └─────────────────┘    │
                               │             │
                               ▼             │
                     ┌─────────────────┐     │
                     │ Report Compiler │◀────┘
                     └─────────────────┘
                               │
                    ┌──────────┼──────────┐
                    ▼          ▼          ▼
                  Slack      Jira      Email
```

### Agents
| Agent | File | Role |
|---|---|---|
| Classifier | `src/agents/classifier.ts` | Reads input, picks skills, estimates severity |
| Analyzer | `src/agents/analyzer.ts` | Runs Claude with skill prompts, parses JSON |
| Correlator | `src/agents/correlator.ts` | Groups related alerts into one incident |
| Reporter | `src/agents/reporter.ts` | Merges findings, formats Slack/Jira/email |
| Orchestrator | `src/agents/orchestrator.ts` | Ties the pipeline together |
| Scheduler | `src/utils/scheduler.ts` | Nightly trends + weekly digest |

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/perf-agent.git
cd perf-agent
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — at minimum, set ANTHROPIC_API_KEY
```

Only `ANTHROPIC_API_KEY` is required. Slack, Jira, and email are optional — the agent works without them (reports are returned via API and logged).

### 3. Run locally

```bash
npm run dev       # TypeScript watch mode
# or
npm run build && npm start
```

### 4. Deploy with Docker

```bash
# Local / VPS
docker-compose up -d

# AWS ECS
npm run deploy:aws
```

---

## API Reference

### POST `/analyze` — Manual upload

```bash
# Upload a file
curl -X POST http://localhost:3000/analyze \
  -F "files=@awr_report.html" \
  -F "application=OrderService" \
  -F "environment=production"

# Paste SQL text
curl -X POST http://localhost:3000/analyze \
  -F "text=SELECT * FROM orders o, customers c WHERE o.amount > 1000" \
  -F "application=OrderService"
```

Response (202 — analysis runs in background):
```json
{ "inputId": "uuid", "message": "Analysis started" }
```

### POST `/ci/sql-gate` — CI/CD SQL review

```bash
curl -X POST http://localhost:3000/ci/sql-gate \
  -H "Content-Type: application/json" \
  -d '{ "sql": "SELECT * FROM orders o, customers c", "pullRequest": "123", "repo": "my-app" }'
```

Response:
```json
{
  "passed": false,
  "gate": "FAIL",
  "severity": "Critical",
  "criticalCount": 1,
  "findings": [...],
  "message": "SQL gate FAILED. 1 critical issue(s) must be fixed before merge."
}
```

### Webhook endpoints

| Endpoint | Source |
|---|---|
| `POST /webhooks/pagerduty` | PagerDuty alert webhook |
| `POST /webhooks/opsgenie` | OpsGenie alert webhook |
| `POST /webhooks/grafana` | Grafana alerting webhook |

### GET `/reports` — List recent reports

```bash
curl http://localhost:3000/reports
```

### GET `/reports/:id` — Get full report

```bash
curl http://localhost:3000/reports/uuid-here
```

### GET `/health` — Health check

```bash
curl http://localhost:3000/health
```

---

## Skills

The agent uses 8 diagnostic skills from the `claudeSkills` library:

| Skill | Triggered by |
|---|---|
| `awr-analysis` | `.html`/`.txt` files containing "Snap Id", "DB Name", wait events |
| `sql-monitor-analysis` | SQL Monitoring reports with "A-Rows", "E-Rows", execution plans |
| `sql-tuning` | Raw SQL text (SELECT/INSERT/UPDATE/DELETE/MERGE) |
| `thread-dump-analysis` | jstack output, `java.lang.Thread.State`, BLOCKED threads |
| `heap-dump-analysis` | MAT/VisualVM reports, "Dominator Tree", "Retained Heap", OOM |
| `jfr-analysis` | `jfr print` output, JMC reports, CPUSample events |
| `ui-console-analysis` | Browser console logs, `.har` files, Lighthouse reports |
| `stack-trace-analysis` | Any exception in any language |

---

## Team Routing

Edit `config/routing.ts` to match your team structure:

```typescript
export const ROUTING_RULES: RoutingRule[] = [
  {
    skill: 'awr-analysis',
    team: 'DBA',
    slackChannel: '#db-team',          // your Slack channel
    jiraProject: 'DBA',                // your Jira project key
    emailList: ['dba@yourcompany.com'],
    notifyOnSeverity: ['Critical', 'High'],
  },
  // ... one entry per skill
];
```

---

## Connecting Integrations

### Slack
1. Create a Slack App at api.slack.com/apps
2. Add Bot Token Scopes: `chat:write`, `files:write`
3. Install to workspace, copy Bot Token
4. Set `SLACK_BOT_TOKEN=xoxb-...` in `.env`
5. Invite the bot to each channel: `/invite @perf-agent`

### Jira
1. Go to id.atlassian.com/manage-profile/security/api-tokens
2. Create an API token
3. Set `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` in `.env`

### Email (SendGrid)
1. Create account at sendgrid.com
2. Create an API key with Mail Send permission
3. Set `SMTP_HOST=smtp.sendgrid.net`, `SMTP_USER=apikey`, `SMTP_PASS=your-key`

### PagerDuty Webhook
1. In PagerDuty: Integrations → Generic Webhooks (V3)
2. Set URL to: `https://your-server.com/webhooks/pagerduty`
3. Subscribe to: `incident.trigger`

### Grafana Webhook
1. In Grafana: Alerting → Contact Points → New → Webhook
2. URL: `https://your-server.com/webhooks/grafana`

### CI/CD SQL Gate (GitHub Actions example)
```yaml
- name: SQL Performance Gate
  run: |
    RESULT=$(curl -s -X POST $PERF_AGENT_URL/ci/sql-gate \
      -H "Content-Type: application/json" \
      -d "{\"sql\": \"$(cat migrations/latest.sql | jq -Rs .)\", \"pullRequest\": \"$PR_NUMBER\"}")
    PASSED=$(echo $RESULT | jq -r '.passed')
    echo $RESULT | jq .
    [ "$PASSED" = "true" ] || exit 1
```

---

## Future Ideas to Build Next

1. **Feedback Loop** — when a Jira ticket is resolved, read the resolution notes and build a knowledge base of "what fixed this pattern." Surface suggestions for similar future incidents.

2. **Multi-input Synthesis** — when an incident is declared, auto-pull AWR snapshot + thread dump + last 100 error log lines simultaneously, run all skills in parallel, produce a single incident briefing in 60 seconds.

3. **Slack Bot Mode** — let developers post a stack trace or SQL directly in any channel and get an analysis in-thread. No form or upload needed.

4. **Trend Regression Detection** — compare this week's AWR metrics to last week's. Automatically flag if wait event % has increased > 20% week-over-week.

5. **Knowledge Base** — store anonymized findings and their resolutions. Query it to say "last time we saw db file sequential read at 40%+ on ORDERS, the fix was index X."

---

## Project Structure

```
perf-agent/
├── src/
│   ├── index.ts                 Main Express server
│   ├── types.ts                 All TypeScript interfaces
│   ├── agents/
│   │   ├── classifier.ts        Input → skills + teams
│   │   ├── analyzer.ts          Skill execution via Claude API
│   │   ├── correlator.ts        Groups related alerts
│   │   ├── reporter.ts          Merges findings, formats output
│   │   └── orchestrator.ts      Main pipeline
│   ├── integrations/
│   │   ├── slack.ts             Slack Block Kit messages
│   │   ├── jira.ts              Jira REST API v3
│   │   └── email.ts             Nodemailer / SMTP
│   ├── skills/
│   │   └── prompts.ts           Claude prompts per skill
│   ├── routes/
│   │   └── index.ts             All HTTP endpoints
│   └── utils/
│       ├── logger.ts            Winston logger
│       └── scheduler.ts         Cron jobs
├── config/
│   └── routing.ts               Team routing rules
├── deploy/
│   └── aws-deploy.sh            ECS deployment script
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── package.json
└── tsconfig.json
```
