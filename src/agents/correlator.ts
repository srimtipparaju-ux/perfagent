import { DiagnosticInput, CorrelationGroup } from '../types';
import { logger } from '../utils/logger';
import { v4 as uuid } from 'uuid';

// ─────────────────────────────────────────────────────────────
// CORRELATION AGENT
// When multiple inputs arrive within a time window, groups them
// into a single incident to avoid duplicate tickets and noise.
//
// Example: high CPU alert + thread dump + stack traces all
// arriving within 2 minutes = one incident, not three.
// ─────────────────────────────────────────────────────────────

const CORRELATION_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

// In-memory store — replace with Redis for multi-instance deploys
const pendingInputs: Map<string, DiagnosticInput & { arrivedAt: number }> = new Map();
const groups: Map<string, CorrelationGroup> = new Map();

export function submitForCorrelation(input: DiagnosticInput): string | null {
  const now = Date.now();
  const key = buildCorrelationKey(input);

  // Clean up expired pending inputs
  for (const [id, pending] of pendingInputs.entries()) {
    if (now - pending.arrivedAt > CORRELATION_WINDOW_MS) {
      pendingInputs.delete(id);
    }
  }

  // Check if this input matches an existing group
  for (const [groupId, group] of groups.entries()) {
    if (group.status === 'pending' && now - group.detectedAt.getTime() < CORRELATION_WINDOW_MS) {
      const representative = pendingInputs.get(group.inputIds[0]);
      if (representative && isSameIncident(input, representative)) {
        group.inputIds.push(input.id);
        pendingInputs.set(input.id, { ...input, arrivedAt: now });
        logger.info(`Correlated input ${input.id} into group ${groupId} (${group.inputIds.length} inputs)`);
        return groupId;
      }
    }
  }

  // No matching group — create a new one
  const groupId = uuid();
  const group: CorrelationGroup = {
    id: groupId,
    inputIds: [input.id],
    detectedAt: new Date(),
    windowMs: CORRELATION_WINDOW_MS,
    status: 'pending',
  };

  groups.set(groupId, group);
  pendingInputs.set(input.id, { ...input, arrivedAt: now });

  logger.info(`Created new correlation group ${groupId} for input ${input.id}`);
  return groupId;
}

export function getGroup(groupId: string): CorrelationGroup | undefined {
  return groups.get(groupId);
}

export function markGroupAnalyzing(groupId: string): void {
  const group = groups.get(groupId);
  if (group) group.status = 'analyzing';
}

export function markGroupComplete(groupId: string): void {
  const group = groups.get(groupId);
  if (group) group.status = 'complete';
}

// ── Correlation logic ─────────────────────────────────────────

function buildCorrelationKey(input: DiagnosticInput): string {
  // Group by application + environment — same app having multiple issues = one incident
  return [
    input.application || 'unknown',
    input.environment || 'unknown',
  ].join('::');
}

function isSameIncident(a: DiagnosticInput, b: DiagnosticInput): boolean {
  // Same application + environment = likely same incident
  const sameApp = (a.application || '') === (b.application || '');
  const sameEnv = (a.environment || '') === (b.environment || '');

  if (sameApp && sameEnv) return true;

  // Even without app name — multiple alerts from same source within window = correlated
  if (a.source === b.source && a.source === 'alert') return true;

  return false;
}

// Returns whether the caller should wait for more inputs before analyzing
// (i.e. is this the first input in a new group — wait briefly for correlated ones)
export function shouldWaitForCorrelation(groupId: string): boolean {
  const group = groups.get(groupId);
  if (!group) return false;

  const age = Date.now() - group.detectedAt.getTime();
  // Wait up to 30s for correlated inputs to arrive before starting analysis
  return age < 30_000 && group.inputIds.length === 1;
}
