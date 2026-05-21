import { RoutingRule, Severity } from '../types';

// ─────────────────────────────────────────────────────────────
// ROUTING CONFIGURATION
// Edit this file to match your team structure and channels.
// ─────────────────────────────────────────────────────────────

export const ROUTING_RULES: RoutingRule[] = [
  {
    skill: 'awr-analysis',
    team: 'DBA',
    slackChannel: '#db-team',
    jiraProject: 'DBA',
    emailList: ['dba-team@yourcompany.com'],
    notifyOnSeverity: ['Critical', 'High'],
  },
  {
    skill: 'sql-monitor-analysis',
    team: 'DBA',
    slackChannel: '#db-team',
    jiraProject: 'DBA',
    emailList: ['dba-team@yourcompany.com'],
    notifyOnSeverity: ['Critical', 'High'],
  },
  {
    skill: 'sql-tuning',
    team: 'DBA',
    slackChannel: '#db-team',
    jiraProject: 'DBA',
    emailList: ['dba-team@yourcompany.com'],
    notifyOnSeverity: ['Critical', 'High', 'Medium'],
  },
  {
    skill: 'thread-dump-analysis',
    team: 'BACKEND',
    slackChannel: '#java-team',
    jiraProject: 'BACKEND',
    emailList: ['java-team@yourcompany.com'],
    notifyOnSeverity: ['Critical', 'High'],
  },
  {
    skill: 'heap-dump-analysis',
    team: 'BACKEND',
    slackChannel: '#java-team',
    jiraProject: 'BACKEND',
    emailList: ['java-team@yourcompany.com'],
    notifyOnSeverity: ['Critical', 'High'],
  },
  {
    skill: 'jfr-analysis',
    team: 'BACKEND',
    slackChannel: '#java-team',
    jiraProject: 'BACKEND',
    emailList: ['java-team@yourcompany.com'],
    notifyOnSeverity: ['Critical', 'High', 'Medium'],
  },
  {
    skill: 'ui-console-analysis',
    team: 'FRONTEND',
    slackChannel: '#frontend-team',
    jiraProject: 'FRONTEND',
    emailList: ['frontend-team@yourcompany.com'],
    notifyOnSeverity: ['Critical', 'High'],
  },
  {
    skill: 'stack-trace-analysis',
    team: 'ON_CALL',
    slackChannel: '#on-call',
    jiraProject: 'OPS',
    emailList: ['oncall@yourcompany.com'],
    notifyOnSeverity: ['Critical', 'High'],
  },
  {
    skill: 'jmeter-analysis',
    team: 'PERFORMANCE',
    slackChannel: '#perf-team',
    jiraProject: 'PERF',
    emailList: ['perf-team@yourcompany.com'],
    notifyOnSeverity: ['Critical', 'High', 'Medium'],
  },
];

// Always notify these channels when severity is Critical,
// regardless of which skill fired.
export const CRITICAL_OVERRIDE_CHANNELS = {
  slack: ['#incidents', '#on-call'],
  emailList: ['cto@yourcompany.com', 'oncall@yourcompany.com'],
};

// Severity ordering (index = priority, lower = more severe)
export const SEVERITY_ORDER: Severity[] = ['Critical', 'High', 'Medium', 'Low', 'Info'];

export function getWorstSeverity(severities: Severity[]): Severity {
  for (const s of SEVERITY_ORDER) {
    if (severities.includes(s)) return s;
  }
  return 'Info';
}

export function severityEmoji(severity: Severity): string {
  const map: Record<Severity, string> = {
    Critical: '🔴',
    High:     '🟠',
    Medium:   '🟡',
    Low:      '🟢',
    Info:     '⚪',
  };
  return map[severity];
}

export function getRuleForSkill(skill: string): RoutingRule | undefined {
  return ROUTING_RULES.find(r => r.skill === skill);
}

// Jira priority mapping
export const JIRA_PRIORITY: Record<Severity, string> = {
  Critical: 'Highest',
  High:     'High',
  Medium:   'Medium',
  Low:      'Low',
  Info:     'Lowest',
};
