import axios from 'axios';
import { IncidentReport, DiagnosticInput, NotificationRecord } from '../types';
import { formatJiraIssue } from '../agents/reporter';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────
// JIRA INTEGRATION
// Creates issues automatically in the correct project.
// ─────────────────────────────────────────────────────────────

export async function createJiraIssue(
  report: IncidentReport,
  input: DiagnosticInput,
  project: string
): Promise<NotificationRecord> {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;

  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    logger.warn('Jira credentials not configured — skipping Jira issue creation');
    return makeRecord(project, false, undefined, 'Jira credentials not configured');
  }

  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
  const issueData = formatJiraIssue(report, input, project);

  try {
    const response = await axios.post(
      `${JIRA_BASE_URL}/rest/api/3/issue`,
      issueData,
      {
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      }
    );

    const issueKey = response.data.key;
    const issueUrl = `${JIRA_BASE_URL}/browse/${issueKey}`;
    logger.info(`Jira issue created: ${issueKey} in project ${project}`);

    return makeRecord(project, true, issueKey, undefined, issueUrl);

  } catch (err: any) {
    const detail = err.response?.data?.errors || err.message;
    logger.error(`Jira issue creation failed for project ${project}:`, detail);
    return makeRecord(project, false, undefined, JSON.stringify(detail));
  }
}

export async function addJiraComment(
  issueKey: string,
  comment: string
): Promise<void> {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) return;

  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');

  try {
    await axios.post(
      `${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/comment`,
      {
        body: {
          type: 'doc', version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }],
        },
      },
      {
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err: any) {
    logger.error(`Failed to add Jira comment to ${issueKey}:`, err.message);
  }
}

function makeRecord(
  destination: string,
  success: boolean,
  reference?: string,
  error?: string,
  url?: string
): NotificationRecord {
  return {
    channel: 'jira',
    destination,
    sentAt: new Date(),
    success,
    reference,
    error,
  };
}
