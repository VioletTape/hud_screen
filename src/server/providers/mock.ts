import { ProviderResult, MetricItem, NotificationItem } from '../../shared/types.js';

export function getMockProvidersData(): Record<string, ProviderResult> {
  const now = new Date().toISOString();

  const gitlab: ProviderResult = {
    source: 'gitlab',
    displayName: 'GitLab (Demo)',
    status: 'healthy',
    statusMessage: 'Connected',
    lastUpdated: now,
    metrics: [
      { key: 'review_requests', label: 'Review Req', value: 2, status: 'neutral' },
      { key: 'todos', label: 'To-Dos', value: 5, status: 'neutral' },
    ],
    notifications: [
      {
        id: 'mock-gl-2',
        source: 'gitlab',
        title: 'Review requested: MR !142 "Optimize cache layer"',
        subtitle: 'Requested by alex_dev • 4 files changed',
        timestamp: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
        level: 'info',
      },
    ],
    details: {
      myMrs: [
        { projectName: 'organizations', iid: 41, status: 'approved' },
        { projectName: 'marketplace-backend', iid: 142, status: 'comments' },
        { projectName: 'platform', iid: 205, status: 'waiting' },
      ],
    },
  };

  const litellm: ProviderResult = {
    source: 'litellm',
    displayName: 'LiteLLM Proxy (Demo)',
    status: 'healthy',
    statusMessage: 'All 14 model endpoints healthy',
    lastUpdated: now,
    metrics: [
      { key: 'today_spend', label: "Today's Spend", value: '$4.82', unit: '/ $20', status: 'good' },
      { key: 'tokens_today', label: 'Tokens Today', value: '1.24M', status: 'good', change: '+18% vs avg' },
      { key: 'rpm', label: 'Req / min', value: 42, status: 'good' },
      { key: 'active_models', label: 'Models Active', value: 14, status: 'good' },
    ],
    notifications: [
      {
        id: 'mock-llm-1',
        source: 'litellm',
        title: 'LiteLLM Daily Budget at 24%',
        subtitle: '$4.82 / $20.00 allocated limit',
        timestamp: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
        level: 'info',
      },
    ],
  };

  const slack: ProviderResult = {
    source: 'slack',
    displayName: 'Slack (Demo)',
    status: 'warning',
    statusMessage: '2 unread direct mentions',
    lastUpdated: now,
    metrics: [
      { key: 'unread_dms', label: 'Direct Messages', value: 2, status: 'warning' },
      { key: 'mentions', label: 'Mentions', value: 4, status: 'warning' },
      { key: 'unread_channels', label: 'Unread Channels', value: 7, status: 'neutral' },
    ],
    notifications: [
      {
        id: 'mock-slack-1',
        source: 'slack',
        title: '@sarah in #incident-response',
        subtitle: '"Can someone check the auth service latency spike?"',
        timestamp: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
        level: 'warning',
      },
      {
        id: 'mock-slack-2',
        source: 'slack',
        title: 'DM from Michael Ross',
        subtitle: '"Do you have 5 mins for a quick sync before standup?"',
        timestamp: new Date(Date.now() - 1000 * 60 * 18).toISOString(),
        level: 'info',
      },
    ],
    details: {
      topDMs: [
        { sender: 'Michael Ross', count: 2, text: 'Michael Ross - 2' },
        { sender: 'Elena Rostova', count: 1, text: 'Elena Rostova - 1' },
      ],
      topMentions: [
        { channel: '#incident-response' },
        { channel: '#architecture-review' },
        { channel: '#dev-announcements' },
      ],
      missingScopes: [],
    },
  };

  const email: ProviderResult = {
    source: 'email',
    displayName: 'Work Mail (Demo)',
    status: 'healthy',
    statusMessage: '3 unread inbox messages',
    lastUpdated: now,
    metrics: [
      { key: 'inbox_unread', label: 'Unread Inbox', value: 3, status: 'good' },
      { key: 'flagged_urgent', label: 'Flagged / Urgent', value: 1, status: 'warning' },
    ],
    notifications: [
      {
        id: 'mock-mail-1',
        source: 'email',
        title: 'Security Alert: New OAuth token generated',
        subtitle: 'From: security@company.internal',
        timestamp: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
        level: 'warning',
      },
    ],
  };

  const calendar: ProviderResult = {
    source: 'calendar',
    displayName: 'Upcoming Meetings (Demo)',
    status: 'healthy',
    statusMessage: '2 upcoming meetings',
    lastUpdated: now,
    metrics: [],
    notifications: [],
    details: {
      meetings: [
        { id: 'mock-meeting-1', title: 'Platform planning and roadmap', startAt: new Date(Date.now() + 5 * 60 * 60 * 1000 + 24 * 60 * 1000).toISOString(), allDay: false, source: 'corporate' },
        { id: 'mock-meeting-2', title: 'Dinner with friends', startAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), allDay: false, source: 'personal' },
      ],
    },
  };

  return { gitlab, litellm, slack, email, calendar };
}
