import { ProviderResult, MetricItem, NotificationItem } from '../../shared/types.js';
import { getConfig } from '../config.js';
import { timetableWeeks } from './librus-timetable.js';

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
      trackedChannelUnreads: [
        { channel: '#incident-response', count: 4 },
        { channel: '#architecture-review', count: 2 },
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
      thresholdEnabled: getConfig().calendar.thresholdEnabled,
      thresholdHours: getConfig().calendar.thresholdHours,
    },
  };

  const librus: ProviderResult = {
    source: 'librus', displayName: 'School timetable (Demo)', status: 'healthy',
    lastUpdated: now, metrics: [], notifications: [],
    details: {
      days: timetableWeeks(new Date()).flatMap(week => {
        const monday = new Date(`${week}T00:00:00Z`);
        return Array.from({ length: 7 }, (_, index) => {
          const day = new Date(monday);
          day.setUTCDate(day.getUTCDate() + index);
          return { date: day.toISOString().slice(0, 10), ...(index < 5 ? {
            firstLessonStart: '08:00', firstLessonTitle: 'Mathematics', lastLessonEnd: '14:25',
          } : {}) };
        });
      }),
    },
  };

  const weather: ProviderResult = {
    source: 'weather',
    displayName: 'Weather (Kozanów)',
    status: 'healthy',
    statusMessage: 'Partly cloudy',
    lastUpdated: now,
    metrics: [],
    notifications: [],
    details: {
      location: 'Wrocław, Kozanów',
      current: {
        time: '13:00',
        temp: 7.3,
        feelsLike: 5.8,
        precip: 0,
        precipProb: 0,
        weatherCode: 2,
        weatherLabel: 'Partly cloudy',
        icon: 'partly-cloudy-day',
        isDay: true,
        uv: 3,
        windSpeed: 14.2,
        windGusts: 24.5,
        windDir: 250,
        windBft: 3,
        windLabel: 'Gentle breeze',
        gustBft: 4,
        pressureMsl: 1018,
        surfacePressure: 1004,
        pressureTrend: {
          arrow: '↑',
          delta3h: 1.6,
          delta6h: 2.9,
          label: 'Rising',
          hint: 'High pressure building — drier air, clearing skies, lower rain risk.',
        },
        lightning: false,
      },
      dogWalk: [
        { time: '13:00', isoTime: '2026-10-26T13:00', temp: 7.3, feelsLike: 5.8, precip: 0, precipProb: 0, weatherCode: 2, weatherLabel: 'Partly cloudy', icon: 'partly-cloudy-day', isDay: true, windSpeed: 14.2, windGusts: 24.5, windDir: 250, windBft: 3, windLabel: 'Gentle breeze', gustBft: 4, lightning: false, lpi: 0, cape: 20 },
        { time: '13:15', isoTime: '2026-10-26T13:15', temp: 7.5, feelsLike: 6.0, precip: 0, precipProb: 0, weatherCode: 2, weatherLabel: 'Partly cloudy', icon: 'partly-cloudy-day', isDay: true, windSpeed: 15.0, windGusts: 25.2, windDir: 252, windBft: 3, windLabel: 'Gentle breeze', gustBft: 4, lightning: false, lpi: 0, cape: 20 },
        { time: '13:30', isoTime: '2026-10-26T13:30', temp: 7.8, feelsLike: 6.2, precip: 0, precipProb: 5, weatherCode: 2, weatherLabel: 'Partly cloudy', icon: 'partly-cloudy-day', isDay: true, windSpeed: 16.4, windGusts: 27.0, windDir: 255, windBft: 3, windLabel: 'Gentle breeze', gustBft: 4, lightning: false, lpi: 0, cape: 30 },
        { time: '13:45', isoTime: '2026-10-26T13:45', temp: 8.0, feelsLike: 6.4, precip: 0, precipProb: 5, weatherCode: 3, weatherLabel: 'Overcast', icon: 'overcast', isDay: true, windSpeed: 18.1, windGusts: 29.5, windDir: 258, windBft: 3, windLabel: 'Gentle breeze', gustBft: 5, lightning: false, lpi: 0, cape: 40 },
        { time: '14:00', isoTime: '2026-10-26T14:00', temp: 7.9, feelsLike: 6.1, precip: 0, precipProb: 10, weatherCode: 3, weatherLabel: 'Overcast', icon: 'overcast', isDay: true, windSpeed: 19.8, windGusts: 31.0, windDir: 260, windBft: 4, windLabel: 'Moderate breeze', gustBft: 5, lightning: false, lpi: 0, cape: 40 },
        { time: '14:15', isoTime: '2026-10-26T14:15', temp: 7.7, feelsLike: 5.9, precip: 0, precipProb: 10, weatherCode: 3, weatherLabel: 'Overcast', icon: 'overcast', isDay: true, windSpeed: 20.5, windGusts: 32.4, windDir: 260, windBft: 4, windLabel: 'Moderate breeze', gustBft: 5, lightning: false, lpi: 0, cape: 50 },
      ],
      goOut: [
        { time: '13:00', isoTime: '2026-10-26T13:00', temp: 7.3, feelsLike: 5.8, precip: 0, precipProb: 0, weatherCode: 2, weatherLabel: 'Partly cloudy', icon: 'partly-cloudy-day', isDay: true, windSpeed: 14.2, windGusts: 24.5, windDir: 250, windBft: 3, windLabel: 'Gentle breeze', gustBft: 4, lightning: false, lpi: null, cape: 20 },
        { time: '14:00', isoTime: '2026-10-26T14:00', temp: 7.9, feelsLike: 6.1, precip: 0, precipProb: 10, weatherCode: 3, weatherLabel: 'Overcast', icon: 'overcast', isDay: true, windSpeed: 19.8, windGusts: 31.0, windDir: 260, windBft: 4, windLabel: 'Moderate breeze', gustBft: 5, lightning: false, lpi: null, cape: 40 },
        { time: '15:00', isoTime: '2026-10-26T15:00', temp: 7.4, feelsLike: 5.3, precip: 0.2, precipProb: 35, weatherCode: 61, weatherLabel: 'Slight rain', icon: 'rain', isDay: true, windSpeed: 22.0, windGusts: 35.0, windDir: 265, windBft: 4, windLabel: 'Moderate breeze', gustBft: 5, lightning: false, lpi: null, cape: 80 },
        { time: '16:00', isoTime: '2026-10-26T16:00', temp: 6.8, feelsLike: 4.5, precip: 0.6, precipProb: 60, weatherCode: 61, weatherLabel: 'Slight rain', icon: 'rain', isDay: true, windSpeed: 24.5, windGusts: 38.0, windDir: 270, windBft: 4, windLabel: 'Moderate breeze', gustBft: 5, lightning: false, lpi: null, cape: 110 },
        { time: '17:00', isoTime: '2026-10-26T17:00', temp: 6.1, feelsLike: 3.9, precip: 0, precipProb: 20, weatherCode: 2, weatherLabel: 'Partly cloudy', icon: 'partly-cloudy-night', isDay: false, windSpeed: 16.0, windGusts: 26.0, windDir: 275, windBft: 3, windLabel: 'Gentle breeze', gustBft: 4, lightning: false, lpi: null, cape: 30 },
        { time: '18:00', isoTime: '2026-10-26T18:00', temp: 5.4, feelsLike: 3.4, precip: 0, precipProb: 5, weatherCode: 1, weatherLabel: 'Mainly clear', icon: 'partly-cloudy-night', isDay: false, windSpeed: 12.0, windGusts: 20.0, windDir: 280, windBft: 3, windLabel: 'Gentle breeze', gustBft: 4, lightning: false, lpi: null, cape: 10 },
      ],
    },
  };

  return { gitlab, litellm, slack, email, calendar, librus, weather };
}
