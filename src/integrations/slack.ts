import axios from 'axios';
import { IncidentReport, DiagnosticInput, NotificationRecord } from '../types';
import { formatSlackMessage } from '../agents/reporter';
import { CRITICAL_OVERRIDE_CHANNELS } from '../../config/routing';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────
// SLACK INTEGRATION
// Sends formatted incident reports to team channels.
// ─────────────────────────────────────────────────────────────

const SLACK_API = 'https://slack.com/api/chat.postMessage';

export async function sendSlackNotification(
  report: IncidentReport,
  input: DiagnosticInput,
  channel: string
): Promise<NotificationRecord> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    logger.warn('SLACK_BOT_TOKEN not set — skipping Slack notification');
    return makeRecord('slack', channel, false, undefined, 'SLACK_BOT_TOKEN not configured');
  }

  const message = formatSlackMessage(report, input);

  try {
    const response = await axios.post(
      SLACK_API,
      { channel, ...message },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    if (!response.data.ok) {
      throw new Error(response.data.error || 'Slack API error');
    }

    logger.info(`Slack notification sent to ${channel}, ts=${response.data.ts}`);
    return makeRecord('slack', channel, true, response.data.ts);

  } catch (err: any) {
    logger.error(`Slack notification failed for ${channel}:`, err.message);
    return makeRecord('slack', channel, false, undefined, err.message);
  }
}

export async function sendSlackNotifications(
  report: IncidentReport,
  input: DiagnosticInput,
  channels: string[]
): Promise<NotificationRecord[]> {
  // For Critical severity, also notify override channels
  const allChannels = new Set(channels);
  if (report.overallSeverity === 'Critical') {
    CRITICAL_OVERRIDE_CHANNELS.slack.forEach(c => allChannels.add(c));
  }

  const results = await Promise.allSettled(
    Array.from(allChannels).map(ch => sendSlackNotification(report, input, ch))
  );

  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => (r as PromiseFulfilledResult<NotificationRecord>).value);
}

// Post a simple text message (for bot responses, status updates)
export async function postSlackMessage(channel: string, text: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return;

  try {
    await axios.post(
      SLACK_API,
      { channel, text },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    logger.error(`Failed to post Slack message to ${channel}:`, err.message);
  }
}

function makeRecord(
  channel: string,
  destination: string,
  success: boolean,
  reference?: string,
  error?: string
): NotificationRecord {
  return {
    channel: 'slack',
    destination,
    sentAt: new Date(),
    success,
    reference,
    error,
  };
}

// Post a message as a thread reply (for timeline follow-up)
export async function postSlackThread(
  channel: string,
  threadTs: string,
  message: object
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return;

  try {
    await axios.post(
      SLACK_API,
      { channel, thread_ts: threadTs, ...message },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    logger.info(`Timeline thread reply posted to ${channel}`);
  } catch (err: any) {
    logger.error(`Failed to post Slack thread reply:`, err.message);
  }
}
