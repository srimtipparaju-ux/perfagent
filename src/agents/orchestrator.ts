import { DiagnosticInput, IncidentReport } from '../types';
import { classifyInput } from './classifier';
import { runAllSkills } from './analyzer';
import { compileReport, formatTimelineSlackMessage } from './reporter';
import { correlateAcrossArtifacts } from './cross-artifact-correlator';
import { sendSlackNotifications, postSlackThread } from '../integrations/slack';
import { createJiraIssue } from '../integrations/jira';
import { sendEmailNotification } from '../integrations/email';
import { submitForCorrelation, shouldWaitForCorrelation, markGroupAnalyzing, markGroupComplete } from './correlator';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────
// ORCHESTRATOR
// Pipeline:
//   intake → classify → analyze (parallel) →
//   cross-correlate (if 2+ skills) → compile → notify
// ─────────────────────────────────────────────────────────────

const reportStore = new Map<string, IncidentReport>();

export async function processInput(input: DiagnosticInput): Promise<IncidentReport> {
  logger.info(`=== Processing input ${input.id} from ${input.source} ===`);

  // Step 1: Alert correlation (groups simultaneous alerts into one incident)
  const groupId = submitForCorrelation(input);
  if (groupId && shouldWaitForCorrelation(groupId)) {
    logger.info(`Waiting 30s for correlated inputs in group ${groupId}...`);
    await sleep(30_000);
  }
  if (groupId) markGroupAnalyzing(groupId);

  try {
    // Step 2: Classify
    const classification = await classifyInput(input);
    logger.info(`Classification: skills=[${classification.skills}], severity=${classification.overallSeverity}`);

    // Step 3: Run all skills in parallel
    logger.info(`Running ${classification.skills.length} skill(s) in parallel...`);
    const analyses = await runAllSkills(classification.skills, input);

    if (analyses.length === 0) {
      throw new Error('All skill analyses failed — cannot produce report');
    }

    // Step 4: Cross-artifact correlation
    // Reads ALL skill findings together and reasons across them:
    // builds causal chain, incident timeline, cross-artifact entity links,
    // and identifies the single deepest root cause.
    // Only runs when 2+ skill results are available.
    let incidentTimeline = null;
    if (analyses.length >= 2) {
      logger.info(`Running cross-artifact correlation across ${analyses.length} skill results...`);
      incidentTimeline = await correlateAcrossArtifacts(analyses, input, 'pending');
    }

    // Step 5: Compile report
    const report = compileReport(input, classification, analyses);

    if (incidentTimeline) {
      incidentTimeline.incidentId = report.id;
      report.incidentTimeline = incidentTimeline;
      logger.info(
        `Timeline attached: ${incidentTimeline.timelineEvents.length} events, ` +
        `${incidentTimeline.causalChain.length} causal steps. ` +
        `Root cause: "${incidentTimeline.rootCause.slice(0, 80)}"`
      );
    }

    reportStore.set(report.id, report);
    logger.info(`Report ${report.id} compiled. Severity=${report.overallSeverity}, findings=${report.mergedFindings.length}`);

    // Step 6: Notify teams
    await sendNotifications(report, input);

    if (groupId) markGroupComplete(groupId);
    logger.info(`=== Input ${input.id} → Report ${report.id} complete ===`);
    return report;

  } catch (err) {
    if (groupId) markGroupComplete(groupId);
    logger.error(`Failed to process input ${input.id}:`, err);
    throw err;
  }
}

async function sendNotifications(report: IncidentReport, input: DiagnosticInput): Promise<void> {
  const teamRoutes = report.classification.teams;

  if (teamRoutes.length === 0) {
    logger.info(`No teams to notify for severity ${report.overallSeverity}`);
    return;
  }

  const promises: Promise<any>[] = [];

  for (const route of teamRoutes) {
    logger.info(`Notifying team ${route.team} via ${route.channels.join(', ')}`);

    if (route.channels.includes('slack') && route.slackChannel) {
      promises.push(
        sendSlackNotifications(report, input, [route.slackChannel])
          .then(async records => {
            report.notificationsSent.push(...records);
            // If we have a timeline, post it as a thread reply on the main message
            if (report.incidentTimeline) {
              const successRecord = records.find(r => r.success && r.reference);
              if (successRecord?.reference) {
                const tlMsg = formatTimelineSlackMessage(report.incidentTimeline);
                await postSlackThread(route.slackChannel!, successRecord.reference, tlMsg)
                  .catch(err => logger.error('Timeline thread post failed:', err));
              }
            }
          })
          .catch(err => logger.error(`Slack failed for ${route.team}:`, err))
      );
    }

    if (route.channels.includes('jira') && route.jiraProject) {
      promises.push(
        createJiraIssue(report, input, route.jiraProject)
          .then(record => report.notificationsSent.push(record))
          .catch(err => logger.error(`Jira failed for ${route.team}:`, err))
      );
    }

    if (route.channels.includes('email') && route.emailList?.length) {
      promises.push(
        sendEmailNotification(report, input, route.emailList)
          .then(records => report.notificationsSent.push(...records))
          .catch(err => logger.error(`Email failed for ${route.team}:`, err))
      );
    }
  }

  await Promise.allSettled(promises);

  const sent   = report.notificationsSent.filter(n => n.success).length;
  const failed = report.notificationsSent.filter(n => !n.success).length;
  logger.info(`Notifications: ${sent} sent, ${failed} failed`);
}

export function getReport(id: string): IncidentReport | undefined {
  return reportStore.get(id);
}

export function getAllReports(): IncidentReport[] {
  return Array.from(reportStore.values())
    .sort((a, b) => b.generatedAt.getTime() - a.generatedAt.getTime());
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
