import nodemailer from 'nodemailer';
import { IncidentReport, DiagnosticInput, NotificationRecord } from '../types';
import { formatEmailHTML } from '../agents/reporter';
import { CRITICAL_OVERRIDE_CHANNELS, severityEmoji } from '../../config/routing';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────
// EMAIL INTEGRATION
// Sends HTML reports via SMTP (works with SendGrid, SES, Gmail)
// ─────────────────────────────────────────────────────────────

function createTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.sendgrid.net',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

export async function sendEmailNotification(
  report: IncidentReport,
  input: DiagnosticInput,
  recipients: string[]
): Promise<NotificationRecord[]> {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    logger.warn('SMTP not configured — skipping email notifications');
    return [];
  }

  // Add critical override recipients
  const allRecipients = new Set(recipients);
  if (report.overallSeverity === 'Critical') {
    CRITICAL_OVERRIDE_CHANNELS.emailList.forEach(e => allRecipients.add(e));
  }

  const transport = createTransport();
  const html = formatEmailHTML(report, input);
  const subject = `${severityEmoji(report.overallSeverity)} [${report.overallSeverity}] ${report.title}`;
  const from = process.env.EMAIL_FROM || 'perf-agent@yourcompany.com';

  const results: NotificationRecord[] = [];

  for (const to of allRecipients) {
    try {
      const info = await transport.sendMail({
        from,
        to,
        subject,
        html,
        // Attach Word report if generated
        attachments: report.reportPath
          ? [{ filename: 'perf-report.docx', path: report.reportPath }]
          : [],
      });

      logger.info(`Email sent to ${to}: ${info.messageId}`);
      results.push({
        channel: 'email',
        destination: to,
        sentAt: new Date(),
        success: true,
        reference: info.messageId,
      });

    } catch (err: any) {
      logger.error(`Email failed to ${to}:`, err.message);
      results.push({
        channel: 'email',
        destination: to,
        sentAt: new Date(),
        success: false,
        error: err.message,
      });
    }
  }

  return results;
}
