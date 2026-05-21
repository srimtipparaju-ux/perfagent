// ─────────────────────────────────────────────────────────────
// Core types for the performance diagnostic agent
// ─────────────────────────────────────────────────────────────

export type Severity = 'Critical' | 'High' | 'Medium' | 'Low' | 'Info';

export type SkillName =
  | 'awr-analysis'
  | 'sql-monitor-analysis'
  | 'sql-tuning'
  | 'thread-dump-analysis'
  | 'heap-dump-analysis'
  | 'jfr-analysis'
  | 'ui-console-analysis'
  | 'stack-trace-analysis'
  | 'jmeter-analysis'
  | 'k8s-analysis';

export type InputSource =
  | 'upload'        // Manual file upload via API
  | 'alert'         // PagerDuty / OpsGenie webhook
  | 'monitoring'    // Grafana / Splunk / Datadog webhook
  | 'scheduled'     // Nightly trend poller
  | 'slack-bot'     // Slack bot inline paste
  | 'ci-gate';      // CI/CD SQL gate hook

export type NotificationChannel = 'slack' | 'jira' | 'email';

// ── Input ─────────────────────────────────────────────────────

export interface DiagnosticInput {
  id: string;                          // UUID for tracking
  source: InputSource;
  receivedAt: Date;
  environment?: string;                // prod / staging / dev
  application?: string;               // app name if known
  triggeredBy?: string;               // user, alert name, scheduler
  rawText?: string;                   // inline pasted content
  filePaths?: string[];               // paths to uploaded files
  metadata?: Record<string, unknown>; // source-specific extras
}

// ── Classification ────────────────────────────────────────────

export interface ClassificationResult {
  inputId: string;
  skills: SkillName[];                // one or more skills to invoke
  overallSeverity: Severity;          // worst-case estimate before analysis
  confidence: number;                 // 0–1
  reasoning: string;
  teams: TeamRoute[];
  correlationGroupId?: string;        // links related simultaneous inputs
}

export interface TeamRoute {
  team: string;                       // 'DBA' | 'BACKEND' | 'FRONTEND' | 'ON_CALL'
  channels: NotificationChannel[];
  slackChannel?: string;
  jiraProject?: string;
  emailList?: string[];
  notifyOnSeverity: Severity[];       // only notify if severity is in this list
}

// ── Analysis ──────────────────────────────────────────────────

export interface Finding {
  id: string;
  severity: Severity;
  category: string;
  title: string;
  evidence: string;
  rootCause: string;
  impact: string;
  recommendations: string[];
  stepId?: string;                    // for SQL monitor / plan findings
  affectedObject?: string;            // table, index, thread, class name
}

export interface SkillAnalysisResult {
  skill: SkillName;
  inputId: string;
  completedAt: Date;
  durationMs: number;
  overallHealth: 'Critical' | 'Degraded' | 'Fair' | 'Good';
  summary: string;                    // 2–3 sentence executive summary
  findings: Finding[];
  keyMetrics: Record<string, string>; // metric name → value string
  rawMarkdown: string;                // full Claude response
  reportPath?: string;                // path to generated .docx if any
}

export interface IncidentReport {
  id: string;
  inputId: string;
  classification: ClassificationResult;
  analyses: SkillAnalysisResult[];
  mergedFindings: Finding[];          // deduped, severity-sorted
  overallSeverity: Severity;
  title: string;
  summary: string;
  generatedAt: Date;
  reportPath?: string;                // merged Word report
  notificationsSent: NotificationRecord[];
  incidentTimeline?: IncidentTimeline; // populated after cross-artifact correlation
}

export interface NotificationRecord {
  channel: NotificationChannel;
  destination: string;                // Slack channel, Jira ticket ID, email
  sentAt: Date;
  success: boolean;
  reference?: string;                 // Slack ts, Jira issue key
  error?: string;
}

// ── Routing config ────────────────────────────────────────────

export interface RoutingRule {
  skill: SkillName;
  team: string;
  slackChannel: string;
  jiraProject: string;
  emailList: string[];
  notifyOnSeverity: Severity[];
}

export interface CorrelationGroup {
  id: string;
  inputIds: string[];
  detectedAt: Date;
  windowMs: number;
  status: 'pending' | 'analyzing' | 'complete';
}

// ── Cross-artifact correlation ────────────────────────────────

export interface TimelineEvent {
  timestamp: string;              // HH:MM:SS or relative (T+45s)
  layer: 'Frontend' | 'API' | 'Application' | 'Database' | 'JVM' | 'Infrastructure';
  artifact: string;               // filename that evidences this event
  skill: SkillName;               // which skill produced it
  event: string;                  // what happened
  evidence: string;               // specific quote or metric
  linkedTo: string[];             // other artifact filenames this connects to
  severity: Severity;
}

export interface CausalStep {
  step: number;
  cause: string;                  // what happened first
  effect: string;                 // what it caused
  sourceArtifact: string;
  targetArtifact: string;
  linkType: 'caused' | 'amplified' | 'masked' | 'triggered' | 'exposed';
}

export interface CrossArtifactLink {
  entityType: 'SQL' | 'RequestID' | 'ErrorClass' | 'ThreadName' | 'Metric' | 'Timestamp' | 'ClassName';
  entityValue: string;            // the shared value linking the artifacts
  appearsIn: string[];            // filenames
  significance: string;           // why this link matters
}

export interface IncidentTimeline {
  incidentId: string;             // links to IncidentReport.id
  rootCause: string;              // single deepest cause across all artifacts
  incidentSummary: string;        // full causal narrative
  overallSeverity: Severity;
  analyzedArtifacts: string[];    // filenames included in correlation
  timelineEvents: TimelineEvent[];
  causalChain: CausalStep[];
  crossArtifactLinks: CrossArtifactLink[];
  immediateActions: string[];
  generatedAt: Date;
  durationMs: number;
}

// ── Webhook payloads ──────────────────────────────────────────

export interface PagerDutyWebhook {
  messages: Array<{
    event: string;
    incident: {
      id: string;
      title: string;
      severity: string;
      service: { name: string };
    };
  }>;
}

export interface GrafanaWebhook {
  title: string;
  message: string;
  state: 'alerting' | 'ok' | 'no_data';
  ruleName: string;
  ruleUrl: string;
  tags?: Record<string, string>;
}

export interface OpsGenieWebhook {
  action: string;
  alert: {
    alertId: string;
    message: string;
    severity: string;
    source: string;
    tags: string[];
  };
}

// ── RAG / Knowledge Base ──────────────────────────────────────

export interface RunbookChunk {
  id: string;
  source: string;           // filename or URL
  title: string;
  content: string;
  category: 'runbook' | 'postmortem' | 'architecture' | 'incident';
  tags: string[];
  embedding?: number[];
  createdAt: Date;
}

export interface RetrievedContext {
  chunks: RunbookChunk[];
  query: string;
  retrievedAt: Date;
  latencyMs: number;
}

// ── Chat / Conversational interface ──────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface ChatSession {
  id: string;
  incidentId?: string;    // links chat to a specific incident report
  messages: ChatMessage[];
  createdAt: Date;
  lastActiveAt: Date;
}

export interface ChatRequest {
  sessionId?: string;
  incidentId?: string;
  message: string;
  history?: ChatMessage[];
}

export interface ChatResponse {
  sessionId: string;
  reply: string;
  sources?: string[];     // runbook titles used as context
  durationMs: number;
}

// ── LLMOps Metrics ────────────────────────────────────────────

export interface SkillMetrics {
  skill: SkillName | 'correlator' | 'classifier' | 'chat' | 'rag';
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  parseSuccess: boolean;
  findingsCount: number;
  timestamp: Date;
}

// ── Kubernetes skill ──────────────────────────────────────────

export type ExtendedSkillName = SkillName | 'k8s-analysis';
