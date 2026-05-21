import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import { SkillName, SkillAnalysisResult, Finding, DiagnosticInput } from '../types';
import { getSkillPrompt } from '../skills/prompts';
import { retrieveContext, formatContextForPrompt } from '../rag/retriever';
import { recordLLMCall, recordFindings, recordRagLatency } from '../observability/llm-metrics';
import { logger } from '../utils/logger';
import { v4 as uuid } from 'uuid';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const MAX_CONTENT_CHARS = 15_000;
const RAG_ENABLED = process.env.RAG_ENABLED !== 'false';   // on by default

// ─────────────────────────────────────────────────────────────
// ANALYSIS AGENT
// ─────────────────────────────────────────────────────────────

// Run multiple DiagnosticInputs through ALL their skills in parallel,
// then hand all results to the correlator for a unified timeline.
// This is the "Analyze All" entry point — used when an operator uploads
// multiple files at once and wants a single incident report from all of them.
export async function analyzeAllInputs(
  inputs: DiagnosticInput[],
  skillsPerInput: Map<string, SkillName[]>
): Promise<SkillAnalysisResult[]> {
  logger.info(`analyzeAllInputs: ${inputs.length} inputs across ${[...skillsPerInput.values()].flat().length} total skill calls`);

  // Build all (input, skill) pairs
  const pairs: { input: DiagnosticInput; skill: SkillName }[] = [];
  for (const input of inputs) {
    const skills = skillsPerInput.get(input.id) || [];
    for (const skill of skills) pairs.push({ input, skill });
  }

  // Run all in parallel with concurrency cap
  const CONCURRENCY = Number(process.env.SKILL_CONCURRENCY || 4);
  const results: SkillAnalysisResult[] = [];

  for (let i = 0; i < pairs.length; i += CONCURRENCY) {
    const batch = pairs.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(({ input, skill }) => runSkillAnalysis(skill, input))
    );
    for (const r of settled) {
      if (r.status === 'fulfilled') results.push(r.value);
      else logger.error('Skill failed in analyzeAllInputs batch:', r.reason);
    }
  }

  logger.info(`analyzeAllInputs complete: ${results.length} results from ${pairs.length} pairs`);
  return results;
}

export async function runSkillAnalysis(
  skill: SkillName,
  input: DiagnosticInput
): Promise<SkillAnalysisResult> {
  const startTime = Date.now();
  logger.info(`Running skill ${skill} on input ${input.id}`);

  // Load content
  const content = await loadContent(input);
  if (!content) {
    throw new Error(`No content available for input ${input.id}`);
  }

  const { systemPrompt, userPromptTemplate } = getSkillPrompt(skill);

  // ── RAG: retrieve relevant runbooks/postmortems for this skill ──
  let ragContextStr = '';
  if (RAG_ENABLED) {
    try {
      const ragStart = Date.now();
      const ragQuery = `${skill} ${content.slice(0, 500)}`;
      const ragCtx = await retrieveContext(ragQuery, 3, { category: 'runbook' });
      recordRagLatency(Date.now() - ragStart);
      ragContextStr = formatContextForPrompt(ragCtx);
      if (ragCtx.chunks.length > 0) {
        logger.info(`RAG retrieved ${ragCtx.chunks.length} runbook chunks for ${skill}`);
      }
    } catch (err) {
      logger.warn(`RAG retrieval failed for ${skill}, continuing without context:`, err);
    }
  }

  const userPrompt = userPromptTemplate.replace('{content}', content.slice(0, MAX_CONTENT_CHARS))
                     + ragContextStr;

  let rawText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let parseSuccess = false;
  let parsed: any = {};

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    rawText = response.content.find(b => b.type === 'text')?.text || '';
    inputTokens  = response.usage?.input_tokens || 0;
    outputTokens = response.usage?.output_tokens || 0;
    parsed = parseAnalysisResponse(rawText);
    parseSuccess = !!parsed.overallHealth && Array.isArray(parsed.findings);

    const result: SkillAnalysisResult = {
      skill,
      inputId: input.id,
      completedAt: new Date(),
      durationMs: Date.now() - startTime,
      overallHealth: parsed.overallHealth || 'Fair',
      summary: parsed.summary || 'Analysis complete.',
      findings: (parsed.findings || []).map(normalizeFinding),
      keyMetrics: parsed.keyMetrics || {},
      rawMarkdown: rawText,
    };

    // Record metrics
    recordLLMCall({
      skill,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      latencyMs: result.durationMs,
      parseSuccess,
      findingsCount: result.findings.length,
    });
    recordFindings(skill, result.findings);

    logger.info(
      `Skill ${skill} completed in ${result.durationMs}ms. ` +
      `Findings: ${result.findings.length}, Health: ${result.overallHealth}, ` +
      `Tokens: ${inputTokens}/${outputTokens}`
    );

    return result;

  } catch (err) {
    // Still record the failed call
    recordLLMCall({
      skill, inputTokens, outputTokens,
      totalTokens: inputTokens + outputTokens,
      latencyMs: Date.now() - startTime,
      parseSuccess: false, findingsCount: 0,
    });
    logger.error(`Skill ${skill} failed for input ${input.id}:`, err);
    throw err;
  }
}

// Run multiple skills in parallel (with concurrency limit)
export async function runAllSkills(
  skills: SkillName[],
  input: DiagnosticInput,
  concurrency = 3
): Promise<SkillAnalysisResult[]> {
  const results: SkillAnalysisResult[] = [];
  
  // Process in batches to respect concurrency
  for (let i = 0; i < skills.length; i += concurrency) {
    const batch = skills.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(skill => runSkillAnalysis(skill, input))
    );
    
    for (const r of batchResults) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        logger.error('Skill analysis failed in batch:', r.reason);
      }
    }
  }

  return results;
}

// ── Helpers ───────────────────────────────────────────────────

async function loadContent(input: DiagnosticInput): Promise<string> {
  const parts: string[] = [];

  // Inline text content
  if (input.rawText) {
    parts.push(input.rawText);
  }

  // Read uploaded files
  if (input.filePaths?.length) {
    for (const filePath of input.filePaths) {
      try {
        if (filePath.endsWith('.har')) {
          // HAR files are JSON — extract request/response summaries
          const har = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          parts.push(summarizeHAR(har));
        } else {
          const content = fs.readFileSync(filePath, 'utf8');
          parts.push(`\n--- File: ${filePath.split('/').pop()} ---\n${content}`);
        }
      } catch (e) {
        logger.warn(`Could not read file ${filePath}: ${e}`);
      }
    }
  }

  return parts.join('\n\n');
}

function summarizeHAR(har: any): string {
  const entries = har?.log?.entries || [];
  const lines = [`HAR file: ${entries.length} requests\n`];
  
  // Sort by duration, show slowest 50 + all errors
  const sorted = [...entries].sort((a: any, b: any) => b.time - a.time);
  const errors = entries.filter((e: any) => e.response?.status >= 400);
  const toShow = [...new Set([...sorted.slice(0, 50), ...errors])];

  for (const e of toShow) {
    const status = e.response?.status || '?';
    const duration = Math.round(e.time || 0);
    const url = e.request?.url?.slice(0, 100) || '';
    const method = e.request?.method || 'GET';
    const size = e.response?.bodySize || 0;
    lines.push(`${duration}ms | ${method} ${status} | ${url} | ${size}b`);
  }

  return lines.join('\n');
}

function parseAnalysisResponse(raw: string): any {
  if (!raw) return {};
  const result = extractJSON(raw);
  if (result) return result;
  logger.warn('parseAnalysisResponse: all extraction strategies failed — returning shell');
  return { overallHealth: 'Fair', summary: 'Analysis complete — see raw output.', findings: [], keyMetrics: {} };
}

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

function normalizeFinding(f: any): Finding {
  return {
    id: f.id || uuid(),
    severity: f.severity || 'Medium',
    category: f.category || 'General',
    title: f.title || 'Finding',
    evidence: f.evidence || '',
    rootCause: f.rootCause || '',
    impact: f.impact || '',
    recommendations: Array.isArray(f.recommendations) ? f.recommendations : [],
    affectedObject: f.affectedObject,
  };
}
