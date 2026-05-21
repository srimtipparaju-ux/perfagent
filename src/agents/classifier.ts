import Anthropic from '@anthropic-ai/sdk';
import { DiagnosticInput, ClassificationResult, SkillName, Severity, TeamRoute } from '../types';
import { ROUTING_RULES, getWorstSeverity } from '../../config/routing';
import { logger } from '../utils/logger';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─────────────────────────────────────────────────────────────
// CLASSIFIER AGENT
// Reads the input (file name, content preview, metadata) and
// decides which skill(s) to invoke and which teams to notify.
// ─────────────────────────────────────────────────────────────

const CLASSIFIER_SYSTEM = `You are a performance diagnostics classifier. 
Given a description of an input (file names, content preview, alert metadata), 
you must decide which diagnostic skills to invoke and estimate severity.

Available skills:
- awr-analysis: Oracle AWR reports (.html, .txt containing "DB Name", "Snap Id", wait events)
- sql-monitor-analysis: Oracle SQL Monitoring reports (.html with execution plan, "A-Rows", "E-Rows")  
- sql-tuning: Raw SQL text (SELECT/INSERT/UPDATE/DELETE/WITH/MERGE statements pasted directly)
- thread-dump-analysis: Java thread dumps (jstack output, "java.lang.Thread.State", "BLOCKED", "WAITING")
- heap-dump-analysis: Heap dump reports from MAT/VisualVM (.html/.txt with "Dominator Tree", "Retained Heap", "OutOfMemoryError")
- jfr-analysis: JFR data exports (jfr print output, JMC reports, ".jfr" references, "CPUSample")
- ui-console-analysis: Browser console logs, HAR files (.har), Lighthouse reports, network logs with "GET/POST", HTTP status codes
- stack-trace-analysis: Any exception/stack trace in any language ("at com.", "Traceback", "Exception", "Error:", "Caused by")
- jmeter-analysis: JMeter results (.csv, .jtl with "elapsed", "label", "90% Line", "Error %", "samples", "throughput")
- k8s-analysis: Kubernetes diagnostics (.yaml, .yml, kubectl output, "CrashLoopBackOff", "OOMKilled", "ImagePullBackOff", "kubectl describe", "apiVersion:", "kind: Pod")

Rules:
- A single input can require multiple skills (e.g. stack trace + thread dump in same file)
- File extensions are strong signals: .csv/.jtl → jmeter-analysis; .yaml/.yml → k8s-analysis; .sql → sql-tuning
- If content is ambiguous, pick the most likely skill with lower confidence
- Estimate severity from keywords: "OutOfMemoryError", "deadlock", "Cartesian", "OOMKilled", "CrashLoopBackOff" = Critical; "BLOCKED", "full scan", "500 error" = High

Return ONLY valid JSON, no markdown:
{
  "skills": ["skill-name"],
  "overallSeverity": "Critical|High|Medium|Low|Info",
  "confidence": 0.95,
  "reasoning": "brief explanation"
}`;

export async function classifyInput(input: DiagnosticInput): Promise<ClassificationResult> {
  logger.info(`Classifying input ${input.id} from source: ${input.source}`);

  // Build a description of the input for the classifier
  const inputDescription = buildInputDescription(input);

  try {
    const response = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
      max_tokens: 500,
      system: CLASSIFIER_SYSTEM,
      messages: [{ role: 'user', content: inputDescription }],
    });

    const text = response.content.find(b => b.type === 'text')?.text || '{}';
    // Robust extraction: find first { to last }
    const start = text.indexOf('{');
    const end   = text.lastIndexOf('}');
    let parsed: any;
    if (start !== -1 && end > start) {
      try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { /**/ }
    }
    if (!parsed) {
      const stripped = text.replace(/`{3,}\w*/g, '').replace(/`{3,}/g, '').trim();
      const s2 = stripped.indexOf('{'), e2 = stripped.lastIndexOf('}');
      if (s2 !== -1 && e2 > s2) try { parsed = JSON.parse(stripped.slice(s2, e2 + 1)); } catch { /**/ }
    }
    if (!parsed) throw new Error('Could not parse classifier response as JSON');

    const skills: SkillName[] = parsed.skills || ['stack-trace-analysis'];
    const severity: Severity = parsed.overallSeverity || 'Medium';

    // Build team routes from routing config
    const teams = buildTeamRoutes(skills, severity);

    const result: ClassificationResult = {
      inputId: input.id,
      skills,
      overallSeverity: severity,
      confidence: parsed.confidence || 0.8,
      reasoning: parsed.reasoning || 'Classified by content analysis',
      teams,
    };

    logger.info(`Classified input ${input.id}: skills=${skills.join(',')}, severity=${severity}`);
    return result;

  } catch (err) {
    logger.error(`Classification failed for ${input.id}:`, err);
    // Fallback: use stack-trace-analysis as a catch-all
    return {
      inputId: input.id,
      skills: ['stack-trace-analysis'],
      overallSeverity: 'Medium',
      confidence: 0.3,
      reasoning: 'Classification failed — defaulting to stack-trace-analysis',
      teams: buildTeamRoutes(['stack-trace-analysis'], 'Medium'),
    };
  }
}

function buildInputDescription(input: DiagnosticInput): string {
  const parts: string[] = [`Input source: ${input.source}`];

  if (input.application) parts.push(`Application: ${input.application}`);
  if (input.environment) parts.push(`Environment: ${input.environment}`);

  if (input.filePaths?.length) {
    parts.push(`Files: ${input.filePaths.map(f => f.split('/').pop()).join(', ')}`);
  }

  if (input.rawText) {
    // Send first 2000 chars as preview — enough to classify without huge token cost
    const preview = input.rawText.slice(0, 2000);
    parts.push(`Content preview:\n${preview}`);
  }

  if (input.metadata && Object.keys(input.metadata).length > 0) {
    parts.push(`Metadata: ${JSON.stringify(input.metadata)}`);
  }

  return parts.join('\n');
}

function buildTeamRoutes(skills: SkillName[], severity: Severity): TeamRoute[] {
  const teamMap = new Map<string, TeamRoute>();

  for (const skill of skills) {
    const rule = ROUTING_RULES.find(r => r.skill === skill);
    if (!rule) continue;

    const existing = teamMap.get(rule.team);
    if (existing) {
      // Merge — team may be notified by multiple skills
      existing.channels = [...new Set([...existing.channels, ...(['slack', 'jira', 'email'] as const)])];
    } else {
      teamMap.set(rule.team, {
        team: rule.team,
        channels: ['slack', 'jira', 'email'],
        slackChannel: rule.slackChannel,
        jiraProject: rule.jiraProject,
        emailList: rule.emailList,
        notifyOnSeverity: rule.notifyOnSeverity,
      });
    }
  }

  // Filter: only include teams that should be notified for this severity
  return Array.from(teamMap.values()).filter(route =>
    route.notifyOnSeverity.includes(severity)
  );
}
