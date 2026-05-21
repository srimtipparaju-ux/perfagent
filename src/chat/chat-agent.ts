import Anthropic from '@anthropic-ai/sdk';
import { ChatMessage, ChatRequest, ChatResponse, ChatSession, IncidentReport } from '../types';
import { retrieveContext, formatContextForPrompt } from '../rag/retriever';
import { recordLLMCall } from '../observability/llm-metrics';
import { logger } from '../utils/logger';
import { v4 as uuid } from 'uuid';

// ─────────────────────────────────────────────────────────────
// CHAT AGENT
//
// Provides conversational interface over incidents:
//   - Ask follow-up questions about findings
//   - Generate Jira tickets / Slack messages from findings
//   - Query past runbooks via RAG
//   - Summarize incidents for different audiences
//
// Maintains conversation history per session, retrieves
// relevant runbooks via RAG for every message.
// ─────────────────────────────────────────────────────────────

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL  = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

// In-memory session store (replace with PostgreSQL for production)
const sessions = new Map<string, ChatSession>();

// ── System prompt for chat agent ─────────────────────────────

const CHAT_SYSTEM = `You are an expert SRE / Performance Engineering copilot assistant.
You help on-call engineers understand incidents, write reports, and find solutions.

Style:
- Direct and technical — assume the user is a senior engineer
- Cite specific evidence from the incident when relevant
- Recommend concrete next steps with commands or code where useful
- If asked to write a Slack message, Jira ticket, or status update, use proper formatting
- If you don't know something, say so — never invent metrics or stack traces
- Use the provided runbooks/postmortems as ground truth when available

You have access to:
1. The current incident report and its findings
2. Retrieved runbooks and past incident postmortems (via RAG)

Always prefer specific over generic. "Restart the JVM with -Xmx 8g" beats "tune the JVM".`;

// ── Build the incident context summary ───────────────────────

function summarizeIncident(report: IncidentReport): string {
  const findings = report.mergedFindings.slice(0, 10).map(f =>
    `  [${f.severity}] ${f.title}: ${f.evidence}`
  ).join('\n');

  const timeline = report.incidentTimeline ?
    `\n\nROOT CAUSE: ${report.incidentTimeline.rootCause}\nCAUSAL CHAIN: ${
      report.incidentTimeline.causalChain.map(s => `${s.step}. ${s.cause} → ${s.effect}`).join(' | ')
    }` : '';

  return `INCIDENT CONTEXT:
Title: ${report.title}
Severity: ${report.overallSeverity}
Summary: ${report.summary}

TOP FINDINGS:
${findings}${timeline}`;
}

// ── Main chat handler ────────────────────────────────────────

export async function handleChat(
  request: ChatRequest,
  incidentReport?: IncidentReport
): Promise<ChatResponse> {
  const start = Date.now();

  // Get or create session
  let session: ChatSession;
  if (request.sessionId && sessions.has(request.sessionId)) {
    session = sessions.get(request.sessionId)!;
  } else {
    session = {
      id: uuid(),
      incidentId: request.incidentId,
      messages: [],
      createdAt: new Date(),
      lastActiveAt: new Date(),
    };
    sessions.set(session.id, session);
  }

  // Add user message
  const userMsg: ChatMessage = {
    role: 'user',
    content: request.message,
    timestamp: new Date(),
  };
  session.messages.push(userMsg);

  // ── RAG: retrieve relevant runbooks for this question ──
  const ragCtx = await retrieveContext(request.message, 3);
  const ragContent = formatContextForPrompt(ragCtx);

  // ── Build messages for Claude ──
  const messages = session.messages.map(m => ({
    role: m.role,
    content: m.content,
  }));

  // ── Build system prompt with incident + RAG context ──
  let systemPrompt = CHAT_SYSTEM;
  if (incidentReport) {
    systemPrompt += '\n\n' + summarizeIncident(incidentReport);
  }
  if (ragContent) {
    systemPrompt += ragContent;
  }

  // ── Call Claude ──
  let reply = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let parseSuccess = true;

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: messages as any,
    });

    reply = resp.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');

    inputTokens  = resp.usage?.input_tokens || 0;
    outputTokens = resp.usage?.output_tokens || 0;
  } catch (err: any) {
    logger.error('Chat agent failed:', err);
    reply = `I encountered an error processing your message: ${err.message}. Please try rephrasing.`;
    parseSuccess = false;
  }

  // Add assistant message to session
  const assistantMsg: ChatMessage = {
    role: 'assistant',
    content: reply,
    timestamp: new Date(),
  };
  session.messages.push(assistantMsg);
  session.lastActiveAt = new Date();

  // Trim session if too long (keep last 20 messages)
  if (session.messages.length > 20) {
    session.messages = session.messages.slice(-20);
  }

  const durationMs = Date.now() - start;

  // Record metrics
  recordLLMCall({
    skill: 'chat',
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    latencyMs: durationMs,
    parseSuccess,
    findingsCount: 0,
  });

  return {
    sessionId: session.id,
    reply,
    sources: ragCtx.chunks.map(c => c.title),
    durationMs,
  };
}

// ── Session management ───────────────────────────────────────

export function getSession(sessionId: string): ChatSession | undefined {
  return sessions.get(sessionId);
}

export function clearSession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}

export function listSessions(incidentId?: string): ChatSession[] {
  const all = Array.from(sessions.values());
  return incidentId ? all.filter(s => s.incidentId === incidentId) : all;
}
