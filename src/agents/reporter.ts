import {
  SkillAnalysisResult, IncidentReport, ClassificationResult,
  DiagnosticInput, Finding, Severity
} from '../types';
import { SEVERITY_ORDER, getWorstSeverity, severityEmoji } from '../../config/routing';
import { v4 as uuid } from 'uuid';

// ─────────────────────────────────────────────────────────────
// REPORT COMPILER
// Merges findings from multiple skill analyses into a single
// coherent incident report, deduplicated and severity-ranked.
// ─────────────────────────────────────────────────────────────

export function compileReport(
  input: DiagnosticInput,
  classification: ClassificationResult,
  analyses: SkillAnalysisResult[]
): IncidentReport {
  // Merge all findings across all skills
  const allFindings = analyses.flatMap(a => a.findings);
  
  // Deduplicate findings with same title (can happen with multi-skill on same input)
  const mergedFindings = deduplicateFindings(allFindings);
  
  // Sort by severity
  const sortedFindings = sortBySeverity(mergedFindings);

  // Determine overall severity
  const overallSeverity = getWorstSeverity(
    sortedFindings.map(f => f.severity as Severity)
  ) as Severity;

  // Build title
  const title = buildTitle(input, classification, overallSeverity);

  // Build executive summary
  const summary = buildSummary(input, analyses, sortedFindings, overallSeverity);

  return {
    id: uuid(),
    inputId: input.id,
    classification,
    analyses,
    mergedFindings: sortedFindings,
    overallSeverity,
    title,
    summary,
    generatedAt: new Date(),
    notificationsSent: [],
  };
}

// ── Slack message formatter ───────────────────────────────────

export function formatSlackMessage(report: IncidentReport, input: DiagnosticInput): object {
  const emoji = severityEmoji(report.overallSeverity);
  const criticalFindings = report.mergedFindings.filter(f => f.severity === 'Critical');
  const highFindings = report.mergedFindings.filter(f => f.severity === 'High');

  const blocks: object[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} ${report.title}`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Severity:*\n${report.overallSeverity}` },
        { type: 'mrkdwn', text: `*Environment:*\n${input.environment || 'Unknown'}` },
        { type: 'mrkdwn', text: `*Application:*\n${input.application || 'Unknown'}` },
        { type: 'mrkdwn', text: `*Skills used:*\n${report.classification.skills.join(', ')}` },
        { type: 'mrkdwn', text: `*Findings:*\n${report.mergedFindings.length} total` },
        { type: 'mrkdwn', text: `*Generated:*\n<!date^${Math.floor(report.generatedAt.getTime()/1000)}^{time}|just now>` },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Summary*\n${report.summary}` },
    },
  ];

  // Top findings
  if (criticalFindings.length > 0 || highFindings.length > 0) {
    const topFindings = [...criticalFindings, ...highFindings].slice(0, 5);
    const findingText = topFindings
      .map(f => `${severityEmoji(f.severity)} *${f.title}*\n>${f.evidence.slice(0, 120)}`)
      .join('\n\n');

    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Top Findings*\n${findingText}` },
      }
    );
  }

  // Quick wins — first recommendation from each critical finding
  const quickWins = criticalFindings
    .flatMap(f => f.recommendations.slice(0, 1))
    .slice(0, 3);

  if (quickWins.length > 0) {
    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Immediate Actions*\n${quickWins.map((w, i) => `${i + 1}. ${w}`).join('\n')}`,
        },
      }
    );
  }

  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `Report ID: \`${report.id}\` | Triggered by: ${input.triggeredBy || input.source}` },
    ],
  });

  return { blocks };
}

// ── Jira issue formatter ──────────────────────────────────────

export function formatJiraIssue(report: IncidentReport, input: DiagnosticInput, project: string): object {
  const description = buildJiraDescription(report, input);

  return {
    fields: {
      project: { key: project },
      summary: report.title,
      description: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: description }],
          },
        ],
      },
      issuetype: { name: 'Bug' },
      priority: { name: jiraPriority(report.overallSeverity) },
      labels: [
        'perf-agent',
        report.overallSeverity.toLowerCase(),
        ...(input.application ? [input.application.replace(/\s+/g, '-').toLowerCase()] : []),
        ...(input.environment ? [input.environment] : []),
      ],
    },
  };
}

// ── Email formatter ───────────────────────────────────────────

export function formatEmailHTML(report: IncidentReport, input: DiagnosticInput): string {
  const emoji = severityEmoji(report.overallSeverity);
  const findingsHtml = report.mergedFindings.slice(0, 10).map(f => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee">${severityEmoji(f.severity)} ${f.severity}</td>
      <td style="padding:8px;border-bottom:1px solid #eee"><strong>${f.title}</strong></td>
      <td style="padding:8px;border-bottom:1px solid #eee;color:#666">${f.evidence.slice(0, 100)}</td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:20px">
  <div style="background:#1F3864;color:white;padding:20px;border-radius:8px 8px 0 0">
    <h1 style="margin:0;font-size:20px">${emoji} ${report.title}</h1>
    <p style="margin:4px 0 0;opacity:0.8">${report.generatedAt.toISOString()}</p>
  </div>
  <div style="background:#f8f9fa;padding:16px;border:1px solid #dee2e6">
    <table style="width:100%">
      <tr>
        <td><strong>Severity:</strong> ${report.overallSeverity}</td>
        <td><strong>App:</strong> ${input.application || 'Unknown'}</td>
        <td><strong>Env:</strong> ${input.environment || 'Unknown'}</td>
        <td><strong>Skills:</strong> ${report.classification.skills.join(', ')}</td>
      </tr>
    </table>
  </div>
  <div style="padding:20px;border:1px solid #dee2e6;border-top:none">
    <h2>Summary</h2>
    <p>${report.summary}</p>
    <h2>Findings (${report.mergedFindings.length} total)</h2>
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:#f8f9fa">
          <th style="padding:8px;text-align:left">Severity</th>
          <th style="padding:8px;text-align:left">Title</th>
          <th style="padding:8px;text-align:left">Evidence</th>
        </tr>
      </thead>
      <tbody>${findingsHtml}</tbody>
    </table>
    ${report.mergedFindings.slice(0, 3).map(f => `
    <h3>${severityEmoji(f.severity)} ${f.title}</h3>
    <p><strong>Root Cause:</strong> ${f.rootCause}</p>
    <p><strong>Impact:</strong> ${f.impact}</p>
    <p><strong>Recommendations:</strong></p>
    <ol>${f.recommendations.map(r => `<li>${r}</li>`).join('')}</ol>
    `).join('<hr/>')}
  </div>
  <div style="background:#f8f9fa;padding:12px;border:1px solid #dee2e6;border-top:none;color:#666;font-size:12px">
    Report ID: ${report.id} | Generated by perf-agent
  </div>
</body>
</html>`;
}

// ── Private helpers ───────────────────────────────────────────

function deduplicateFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter(f => {
    const key = f.title.toLowerCase().slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortBySeverity(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    return SEVERITY_ORDER.indexOf(a.severity as Severity) -
           SEVERITY_ORDER.indexOf(b.severity as Severity);
  });
}

function buildTitle(
  input: DiagnosticInput,
  classification: ClassificationResult,
  severity: Severity
): string {
  const app = input.application ? `[${input.application}] ` : '';
  const env = input.environment ? `(${input.environment}) ` : '';
  const skillLabel = classification.skills.length > 1
    ? `Multi-skill Analysis`
    : formatSkillName(classification.skills[0]);
  return `${app}${severity}: ${skillLabel} ${env}— ${new Date().toISOString().split('T')[0]}`;
}

function buildSummary(
  input: DiagnosticInput,
  analyses: SkillAnalysisResult[],
  findings: Finding[],
  severity: Severity
): string {
  const critCount = findings.filter(f => f.severity === 'Critical').length;
  const highCount = findings.filter(f => f.severity === 'High').length;

  const skillSummaries = analyses.map(a => a.summary).join(' ');
  const topIssue = findings[0]?.title || 'No critical issues found';

  return [
    `${severity} severity incident detected.`,
    `Found ${findings.length} issues (${critCount} critical, ${highCount} high).`,
    `Top issue: ${topIssue}.`,
    skillSummaries.slice(0, 200),
  ].join(' ');
}

function buildJiraDescription(report: IncidentReport, input: DiagnosticInput): string {
  const findings = report.mergedFindings.slice(0, 10)
    .map(f => `${severityEmoji(f.severity)} ${f.severity}: ${f.title}\n  Evidence: ${f.evidence}\n  Root Cause: ${f.rootCause}\n  Fix: ${f.recommendations[0] || 'See report'}`)
    .join('\n\n');

  return `
Performance Agent Auto-Generated Report
========================================
App: ${input.application || 'Unknown'}
Environment: ${input.environment || 'Unknown'}
Severity: ${report.overallSeverity}
Skills: ${report.classification.skills.join(', ')}
Generated: ${report.generatedAt.toISOString()}

Summary
-------
${report.summary}

Findings
--------
${findings}

Report ID: ${report.id}
`.trim();
}

function formatSkillName(skill: string): string {
  return skill.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function jiraPriority(severity: Severity): string {
  const map: Record<Severity, string> = {
    Critical: 'Highest', High: 'High', Medium: 'Medium', Low: 'Low', Info: 'Lowest',
  };
  return map[severity];
}

// ── Timeline Slack formatter ──────────────────────────────────
// Posted as a thread reply on the main incident message.

export function formatTimelineSlackMessage(tl: import('../types').IncidentTimeline): object {
  const sevEmoji: Record<string, string> = {
    Critical: '🔴', High: '🟠', Medium: '🟡', Low: '🟢', Info: '⚪',
  };

  const chainText = tl.causalChain.slice(0, 5).map((step, i) =>
    `${i + 1}. *${step.cause}*\n   ↓ _${step.linkType}_ → ${step.effect}\n   \`${step.sourceArtifact}\` → \`${step.targetArtifact}\``
  ).join('\n\n');

  const timelineText = tl.timelineEvents.slice(0, 8).map(e =>
    `${sevEmoji[e.severity] || '⚪'} \`${e.timestamp}\` *[${e.layer}]* ${e.event}` +
    (e.linkedTo.length ? `\n   🔗 _links to: ${e.linkedTo.join(', ')}_` : '')
  ).join('\n');

  const linksText = tl.crossArtifactLinks.slice(0, 4).map(l =>
    `• *${l.entityType}:* \`${l.entityValue.slice(0, 80)}\`\n  Found in: ${l.appearsIn.join(' · ')}\n  ${l.significance}`
  ).join('\n\n');

  const blocks: object[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `⚡ *Incident Timeline* — Cross-artifact analysis\n\n🎯 *Root Cause:* ${tl.rootCause}`,
      },
    },
    { type: 'divider' },
  ];

  if (chainText) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Causal Chain*\n\n${chainText}` },
    });
    blocks.push({ type: 'divider' });
  }

  if (timelineText) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Timeline of Events*\n\n${timelineText}` },
    });
    blocks.push({ type: 'divider' });
  }

  if (linksText) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Cross-Artifact Links*\n\n${linksText}` },
    });
    blocks.push({ type: 'divider' });
  }

  if (tl.immediateActions.length) {
    const actionsText = tl.immediateActions.slice(0, 5)
      .map((a, i) => `${i + 1}. ${a}`)
      .join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Immediate Actions*\n\n${actionsText}` },
    });
  }

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `Artifacts analyzed: ${tl.analyzedArtifacts.join(' · ')} | ` +
            `${tl.timelineEvents.length} events | ${tl.causalChain.length} causal steps | ` +
            `Generated in ${Math.round(tl.durationMs / 1000)}s`,
    }],
  });

  return { blocks };
}
