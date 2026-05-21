import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import {
  SkillAnalysisResult, IncidentTimeline, TimelineEvent,
  CausalStep, CrossArtifactLink, Severity, DiagnosticInput
} from '../types';
import { logger } from '../utils/logger';
import { v4 as uuid } from 'uuid';

// Robust JSON extractor — handles fences, unescaped newlines, smart quotes, trailing commas
// Robust JSON extractor — balanced brace matching, repair, fallback
function extractJSON(raw: string): any {
  if (!raw || typeof raw !== 'string') return null;

  function extractBalanced(str: string): string | null {
    const start = str.indexOf('{');
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < str.length; i++) {
      const c = str[i];
      if (esc)       { esc = false; continue; }
      if (c === '\\') { esc = true;  continue; }
      if (c === '"')  { inStr = !inStr; continue; }
      if (inStr)     { continue; }
      if (c === '{') { depth++; }
      if (c === '}') { depth--; if (depth === 0) return str.slice(start, i + 1); }
    }
    return null;
  }

  const jsonStr = extractBalanced(raw);
  if (!jsonStr) return null;
  try { return JSON.parse(jsonStr); } catch { /* continue */ }

  const r1 = jsonStr
    .replace(/[\u2018\u2019]/g, "\'").replace(/[\u201C\u201D]/g, '"')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/\r\n/g, '\\n')
    .replace(/([^\\])\n/g, '$1\\n')
    .replace(/([^\\])\t/g, '$1\\t');
  try { return JSON.parse(r1); } catch { /* continue */ }

  try {
    const r2 = jsonStr.replace(/"((?:[^"\\]|\\[\s\S])*)"/g, (_, inner) =>
      '"' + inner.replace(/[\n\r\t]/g, ' ') + '"'
    );
    const j2 = extractBalanced(r2);
    if (j2) return JSON.parse(j2);
  } catch { /* continue */ }

  const health  = raw.match(/"overallHealth"\s*:\s*"([^"]+)"/)?.[1];
  const summary = raw.match(/"summary"\s*:\s*"([^"\n]+)"/)?.[1];
  const findings: any[] = [];
  for (const m of raw.matchAll(/"severity"\s*:\s*"([^"]+)"[\s\S]*?"title"\s*:\s*"([^"]+)"/g)) {
    findings.push({ id: 'F' + findings.length, severity: m[1], title: m[2], category: '', evidence: '', rootCause: '', impact: '', recommendations: [] });
  }
  if (health) return { overallHealth: health, summary: summary || 'See raw output for details.', keyMetrics: {}, findings };
  return null;
}

export async function correlateAcrossArtifacts(
  analyses: SkillAnalysisResult[],
  input: DiagnosticInput,
  incidentId: string
): Promise<IncidentTimeline | null> {

  if (analyses.length < 2) {
    logger.info(`Only ${analyses.length} analysis — skipping cross-artifact correlation (need 2+)`);
    return null;
  }

  const startTime = Date.now();
  logger.info(`Starting cross-artifact correlation across ${analyses.length} skill results`);

  // Build compact payload — enough for reasoning without flooding context
  const artifactSummaries = analyses.map(a => {
    const contentPreview = loadContentPreview(input, a.skill);
    return {
      fileName:       deriveFileName(input, a.skill),
      skill:          a.skill,
      overallHealth:  a.overallHealth,
      summary:        a.summary,
      keyMetrics:     a.keyMetrics,
      // Top 8 findings — title + evidence + rootCause (compact)
      findings: a.findings.slice(0, 8).map(f => ({
        severity:   f.severity,
        category:   f.category,
        title:      f.title,
        evidence:   f.evidence,
        rootCause:  f.rootCause,
      })),
      // First 3KB of content for entity extraction
      contentPreview,
    };
  });

  const userPrompt = `Correlate these ${analyses.length} diagnostic artifacts from the same system/incident and build a unified incident timeline.

System: ${input.application || 'Unknown application'}
Environment: ${input.environment || 'Unknown'}

Artifacts:
${JSON.stringify(artifactSummaries, null, 2)}`;

  try {
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: 8192,
      system:     CORRELATOR_SYSTEM,
      messages:   [{ role: 'user', content: userPrompt }],
    });

    const raw    = response.content.find((b: any) => b.type === 'text')?.text || '';
    const parsed = extractJSON(raw);
    if (!parsed) throw new Error('Failed to parse correlation JSON from Claude response');

    const timeline: IncidentTimeline = {
      incidentId,
      rootCause:          parsed.rootCause          || 'See findings for details',
      incidentSummary:    parsed.incidentSummary    || analyses.map(a => a.summary).join(' '),
      overallSeverity:    (parsed.overallSeverity   || 'High') as Severity,
      analyzedArtifacts:  analyses.map(a => deriveFileName(input, a.skill)),
      timelineEvents:     (parsed.timelineEvents    || []).map(normalizeEvent),
      causalChain:        (parsed.causalChain       || []).map(normalizeStep),
      crossArtifactLinks: (parsed.crossArtifactLinks|| []).map(normalizeLink),
      immediateActions:    parsed.immediateActions  || [],
      generatedAt:        new Date(),
      durationMs:         Date.now() - startTime,
    };

    logger.info(
      `Cross-artifact correlation complete in ${timeline.durationMs}ms. ` +
      `Events: ${timeline.timelineEvents.length}, ` +
      `Causal steps: ${timeline.causalChain.length}, ` +
      `Links: ${timeline.crossArtifactLinks.length}`
    );

    return timeline;

  } catch (err) {
    logger.error('Cross-artifact correlation failed:', err);
    return null;
  }
}

// ── POST-INCIDENT: correlate a set of existing reports ────────
// Used by the /correlate-reports endpoint when an operator
// manually links multiple separate incident reports.

export async function correlateReports(
  reportAnalyses: Array<{ reportId: string; analysis: SkillAnalysisResult; fileName: string }>,
  context: { application?: string; environment?: string }
): Promise<IncidentTimeline | null> {

  if (reportAnalyses.length < 2) return null;

  const startTime = Date.now();
  logger.info(`Correlating ${reportAnalyses.length} separate reports`);

  const artifactSummaries = reportAnalyses.map(r => ({
    fileName:      r.fileName,
    skill:         r.analysis.skill,
    overallHealth: r.analysis.overallHealth,
    summary:       r.analysis.summary,
    keyMetrics:    r.analysis.keyMetrics,
    findings:      r.analysis.findings.slice(0, 8).map(f => ({
      severity:  f.severity,
      category:  f.category,
      title:     f.title,
      evidence:  f.evidence,
      rootCause: f.rootCause,
    })),
  }));

  const userPrompt = `Correlate these ${reportAnalyses.length} diagnostic artifacts from the same system and build a unified incident timeline.

System: ${context.application || 'Unknown'}
Environment: ${context.environment || 'Unknown'}
Source: Multiple separate incident reports linked by operator

Artifacts:
${JSON.stringify(artifactSummaries, null, 2)}`;

  try {
    const response = await client.messages.create({
      model: MODEL, max_tokens: 8192,
      system: CORRELATOR_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const raw    = response.content.find((b: any) => b.type === 'text')?.text || '';
    const parsed = extractJSON(raw);
    if (!parsed) throw new Error('Failed to parse correlation JSON');

    const timeline: IncidentTimeline = {
      incidentId:         uuid(),
      rootCause:          parsed.rootCause          || '',
      incidentSummary:    parsed.incidentSummary    || '',
      overallSeverity:    (parsed.overallSeverity   || 'High') as Severity,
      analyzedArtifacts:  reportAnalyses.map(r => r.fileName),
      timelineEvents:     (parsed.timelineEvents    || []).map(normalizeEvent),
      causalChain:        (parsed.causalChain       || []).map(normalizeStep),
      crossArtifactLinks: (parsed.crossArtifactLinks|| []).map(normalizeLink),
      immediateActions:    parsed.immediateActions  || [],
      generatedAt:        new Date(),
      durationMs:         Date.now() - startTime,
    };

    logger.info(`Report correlation complete in ${timeline.durationMs}ms`);
    return timeline;

  } catch (err) {
    logger.error('Report correlation failed:', err);
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────

function loadContentPreview(input: DiagnosticInput, skill: string): string {
  try {
    if (input.rawText) return input.rawText.slice(0, 3000);
    if (input.filePaths?.length) {
      // Find the file most likely matching this skill
      const fp = input.filePaths[0];
      return fs.readFileSync(fp, 'utf8').slice(0, 3000);
    }
  } catch { /* ignore */ }
  return '';
}

function deriveFileName(input: DiagnosticInput, skill: string): string {
  if (input.filePaths?.length) {
    // Return the base filename
    const path = require('path');
    return input.filePaths.map((f: string) => path.basename(f)).join(', ');
  }
  // Synthesize a name from skill + application
  const app = input.application ? `${input.application}-` : '';
  return `${app}${skill}.txt`;
}

function normalizeEvent(e: any): TimelineEvent {
  return {
    timestamp:  e.timestamp  || 'T+?',
    layer:      e.layer      || 'Application',
    artifact:   e.artifact   || '',
    skill:      e.skill      || 'stack-trace-analysis',
    event:      e.event      || '',
    evidence:   e.evidence   || '',
    linkedTo:   Array.isArray(e.linkedTo) ? e.linkedTo : [],
    severity:   e.severity   || 'Info',
  };
}

function normalizeStep(s: any): CausalStep {
  return {
    step:           s.step           || 0,
    cause:          s.cause          || '',
    effect:         s.effect         || '',
    sourceArtifact: s.sourceArtifact || '',
    targetArtifact: s.targetArtifact || '',
    linkType:       s.linkType       || 'caused',
  };
}

function normalizeLink(l: any): CrossArtifactLink {
  return {
    entityType:   l.entityType   || 'ClassName',
    entityValue:  l.entityValue  || '',
    appearsIn:    Array.isArray(l.appearsIn) ? l.appearsIn : [],
    significance: l.significance || '',
  };
}
