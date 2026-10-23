// State updates
let latestData = null;

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMeetingDate(meeting) {
  const date = new Date(meeting.startAt);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const time = meeting.allDay
    ? 'All day'
    : `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${day}.${month}.${date.getFullYear()} ${time}`;
}

// Clamps imminent meetings (< 1 min) to 1m so '0m' or negative offsets never appear before
// the ticker ticks. Uses compact 'Xm' (< 1 hr) or 'H:MM' (>= 1 hr) to fit 8.8" bar display constraints.
function formatTimeUntil(startAt, nowMs = Date.now()) {
  const diffMs = new Date(startAt).getTime() - nowMs;
  if (diffMs <= 0) return 'NOW';
  const minutes = Math.max(1, Math.ceil(diffMs / 60000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

const ACTIVE_MEETING_GRACE_MS = 5 * 60_000;
const CALENDAR_BOUNDARY_BUFFER_MS = 50; // Slight overshoot so Date.now() is past the boundary when the timer fires
const CALENDAR_MIN_RECHECK_MS = 250; // Guard against tight re-render loops on sub-second clock jitter
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647; // 32-bit signed integer limit for browser setTimeout
let calendarRenderTimeout;

function meetingExpiryMs(meeting, startMs) {
  const graceExpireMs = startMs + ACTIVE_MEETING_GRACE_MS;
  const endMs = meeting.endAt ? new Date(meeting.endAt).getTime() : NaN;
  return Number.isFinite(endMs) ? Math.min(graceExpireMs, endMs) : graceExpireMs;
}

function renderCalendarMeetings(data = latestData?.providers?.calendar) {
  clearTimeout(calendarRenderTimeout);
  const list = document.getElementById('calendar-meetings');
  if (!list || !data) return;

  const nowMs = Date.now();
  const rawMeetings = data.details?.meetings || [];
  const meetings = rawMeetings
    .filter(meeting => {
      const startMs = new Date(meeting.startAt).getTime();
      if (!Number.isFinite(startMs)) return false;
      if (startMs >= nowMs) return true;
      return !meeting.allDay && meetingExpiryMs(meeting, startMs) > nowMs;
    })
    .slice(0, 2);

  // Large meetings (>20 attendees) take visual styling precedence over recurring/single indicators.
  list.innerHTML = meetings.length
    ? meetings.map(meeting => {
        const startMs = new Date(meeting.startAt).getTime();
        const isActive = !meeting.allDay && startMs <= nowMs;
        return `
          <div class="meeting-item ${meeting.source === 'personal' ? 'personal' : 'corporate'} ${meeting.participantCount > 20 ? 'large' : meeting.recurring ? 'recurring' : 'single'}${isActive ? ' active' : ''}" aria-label="${isActive ? 'Active meeting; ' : ''}${meeting.participantCount > 20 ? 'Large meeting; ' : ''}${meeting.recurring ? 'Recurring' : 'Single'} ${escapeHtml(meeting.source)} calendar: ${escapeHtml(meeting.title)}">
            <div class="meeting-title">${escapeHtml(meeting.title)}</div>
            <div class="meeting-countdown">${formatTimeUntil(meeting.startAt, nowMs)}</div>
            <div class="meeting-datetime">${formatMeetingDate(meeting)}</div>
          </div>
        `;
      }).join('')
    : '<div class="meeting-empty">No upcoming meetings</div>';

  // Schedule exact boundary re-render when the next meeting starts or an active meeting's end/5m window expires.
  let nextBoundaryMs = Infinity;
  for (const meeting of meetings) {
    if (meeting.allDay) continue;
    const startMs = new Date(meeting.startAt).getTime();
    if (startMs > nowMs && startMs < nextBoundaryMs) {
      nextBoundaryMs = startMs;
    } else if (startMs <= nowMs) {
      const expireMs = meetingExpiryMs(meeting, startMs);
      if (expireMs > nowMs && expireMs < nextBoundaryMs) {
        nextBoundaryMs = expireMs;
      }
    }
  }
  if (Number.isFinite(nextBoundaryMs)) {
    const delayMs = Math.min(MAX_TIMEOUT_DELAY_MS, Math.max(CALENDAR_MIN_RECHECK_MS, nextBoundaryMs - Date.now() + CALENDAR_BOUNDARY_BUFFER_MS));
    calendarRenderTimeout = setTimeout(() => renderCalendarMeetings(), delayMs);
  }
}

function renderProviderCard(providerKey, data) {
  if (!data) return;

  const card = document.getElementById(`card-${providerKey}`);
  const sub = document.getElementById(`${providerKey}-sub`);

  if (card) {
    card.dataset.status = data.status;
    card.setAttribute('aria-label', `${data.displayName} status: ${data.status}`);
  }

  // LiteLLM manages its own custom "$spent / $limit" subtitle in its case block;
  // skip default statusMessage overwrite to prevent UI flicker.
  if (sub && providerKey !== 'litellm') {
    sub.textContent = data.statusMessage || 'Idle';
  }

  // Provider-specific rendering
  switch (providerKey) {
    case 'gitlab':
    case 'system': {
      const container = document.getElementById(`${providerKey}-metrics`);
      if (container && data.metrics) {
        container.innerHTML = data.metrics.map(m => `
          <div class="metric-box ${m.status ? 'metric-' + m.status : ''}">
            <div class="metric-value status-${m.status || 'neutral'}">${m.value}</div>
            <div class="metric-label">${providerKey === 'system' ? ({ cpu: 'CPU', memory: 'MEM' }[m.key] || m.label) : m.label}</div>
          </div>
        `).join('');
      }
      if (providerKey === 'gitlab') {
        const mrList = document.getElementById('gitlab-my-mrs');
        const myMrs = data.details?.myMrs;
        if (mrList) {
          const statusIcons = { approved: '✅', waiting: '❔', comments: '💬', blocked: '⛔' };
          const statusLabels = { approved: 'Has approval', waiting: 'Waiting for approval', comments: 'Needs your response', blocked: 'Potential merge blocker' };
          mrList.innerHTML = data.status === 'error'
            ? '<div class="gitlab-mr-empty">GitLab unavailable</div>'
            : Array.isArray(myMrs) && myMrs.length
            ? myMrs.map(mr => {
              const icon = statusIcons[mr.status] || statusIcons.waiting;
              const label = statusLabels[mr.status] || statusLabels.waiting;
              const detail = mr.blockReason || label;
              return `<div class="gitlab-mr-line" role="img" title="${escapeHtml(detail)}" aria-label="${escapeHtml(detail)}: ${escapeHtml(mr.projectName)} !${escapeHtml(mr.iid)}">${icon} ${escapeHtml(mr.projectName)} !${escapeHtml(mr.iid)}</div>`;
            }).join('')
            : '<div class="gitlab-mr-empty">No open non-draft MRs</div>';
        }
      }
      break;
    }
    case 'litellm': {
      const spendMetric = data.metrics?.find(m => m.key === 'today_spend');
      const tokensMetric = data.metrics?.find(m => m.key === 'max_budget' || m.key === 'tokens_today');
      const budgetPctMetric = data.metrics?.find(m => m.key === 'budget_pct');

      // Update Subtitle: "Spent: $X.XX / $Y.YY"
      const litellmSub = document.getElementById('litellm-sub');
      if (litellmSub) {
        const rawSpend = spendMetric ? spendMetric.value : '$0.00';
        const rawLimit = tokensMetric ? tokensMetric.value : '$150.00';
        const spendFormatted = String(rawSpend).startsWith('$') ? String(rawSpend) : `$${rawSpend}`;
        const limitFormatted = String(rawLimit).startsWith('$') ? String(rawLimit) : `$${rawLimit}`;
        litellmSub.textContent = `${spendFormatted} / ${limitFormatted}`;
      }

      const budgetText = document.getElementById('litellm-budget-text');
      const budgetFill = document.getElementById('litellm-budget-fill');

      if (budgetText && budgetFill) {
        let pct = 0;
        let pctStr = '0%';
        if (budgetPctMetric && budgetPctMetric.value != null) {
          pctStr = String(budgetPctMetric.value);
          pct = parseFloat(pctStr.replace('%', '')) || 0;
        }
        budgetText.textContent = pctStr;
        // Guarantee any non-zero spend renders a visible subpixel sliver (minimum 1.5% width).
        const fillWidth = pct > 0 ? Math.max(pct, 1.5) : 0;
        budgetFill.style.width = `${Math.min(fillWidth, 100)}%`;
        if (pct >= 80) {
          budgetFill.classList.add('warn');
        } else {
          budgetFill.classList.remove('warn');
        }
      }
      break;
    }
    case 'slack': {
      // Render Top 3 DMs: "sender - number of messages" or "0 DMs"
      const dmsListEl = document.getElementById('slack-dms-list');
      if (dmsListEl) {
        const topDMs = data.details?.topDMs;
        if (Array.isArray(topDMs) && topDMs.length > 0) {
          dmsListEl.innerHTML = topDMs.map(dm => `
            <div class="slack-item">
              <span class="slack-dm-row">
                <span class="slack-sender">${escapeHtml(dm.sender)}</span>
                <span class="slack-sep">-</span>
                <span class="slack-count">${dm.count}</span>
              </span>
            </div>
          `).join('');
        } else {
          dmsListEl.innerHTML = '<div class="slack-item-empty">0 DMs</div>';
        }
      }

      // Show only tracked channels with unread messages.
      const channelsSectionEl = document.getElementById('slack-channels-section');
      const channelsListEl = document.getElementById('slack-channels-list');
      if (channelsSectionEl && channelsListEl) {
        const trackedChannels = data.details?.trackedChannelUnreads;
        const unreadChannels = Array.isArray(trackedChannels)
          ? trackedChannels.filter(channel => channel.count > 0)
          : [];
        channelsSectionEl.classList.toggle('hidden', unreadChannels.length === 0);
        channelsListEl.innerHTML = unreadChannels.map(channel => `
            <div class="slack-item channel-item">
              <span class="slack-channel-name">${escapeHtml(channel.channel)}</span>
              <span class="slack-count">${escapeHtml(channel.count)}</span>
            </div>
          `).join('');
      }
      break;
    }
    case 'email': {
      const unreadMetric = data.metrics.find(m => m.key === 'inbox_unread');
      const totalMetric = data.metrics.find(m => m.key === 'total_messages' || m.key === 'flagged_urgent');

      const unreadEl = document.getElementById('email-unread');
      const totalEl = document.getElementById('email-total');

      if (unreadEl && unreadMetric) {
        unreadEl.textContent = unreadMetric.value;
        unreadEl.className = `metric-value status-${unreadMetric.status || 'neutral'}`;
      }
      if (totalEl && totalMetric) totalEl.textContent = totalMetric.value;
      break;
    }
    case 'calendar': {
      renderCalendarMeetings(data);
      break;
    }
    case 'librus': {
      renderLibrusSchedule(data);
      refreshLibrusIfStale(data);
      break;
    }
  }
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function renderLibrusSchedule(data = latestData?.providers?.librus) {
  const dayEl = document.getElementById('librus-day');
  const summary = document.getElementById('librus-summary');
  const statusEl = document.getElementById('librus-status');
  if (!dayEl || !summary || !statusEl || !data) return;

  const now = new Date();
  const isTomorrow = now.getHours() >= 17;
  const date = new Date(now);
  if (isTomorrow) date.setDate(date.getDate() + 1);
  const day = Array.isArray(data.details?.days)
    ? data.details.days.find(item => item.date === localDateKey(date))
    : null;

  dayEl.textContent = isTomorrow ? 'TOMORROW' : 'TODAY';
  statusEl.hidden = data.status !== 'warning' && data.status !== 'error';
  statusEl.textContent = statusEl.hidden ? '' : data.statusMessage || (data.status === 'warning' ? 'Refresh failed · showing last fetched timetable' : 'Timetable unavailable');
  if (data.status === 'error') {
    summary.textContent = 'Timetable unavailable';
  } else if (!day) {
    summary.textContent = 'No timetable data';
  } else if (!day.firstLessonStart && !day.firstLessonTitle && !day.lastLessonEnd) {
    summary.textContent = 'No lessons';
  } else {
    const lines = [];
    if (day.firstLessonStart || day.firstLessonTitle) {
      lines.push([day.firstLessonStart, day.firstLessonTitle].filter(Boolean).join(' '));
    }
    if (day.lastLessonEnd) lines.push(day.lastLessonEnd);
    summary.textContent = lines.join('\n');
  }
}

let librusScheduleTimeout;
const librusRefreshStorageKey = 'hud-librus-refresh-attempt';
let lastLibrusRefreshAttempt = '';

function librusRefreshSlot(now = new Date()) {
  const slot = new Date(now);
  if (now.getHours() >= 21) {
    slot.setHours(21, 0, 0, 0);
  } else if (now.getHours() >= 17) {
    slot.setHours(17, 0, 0, 0);
  } else {
    slot.setDate(slot.getDate() - 1);
    slot.setHours(21, 0, 0, 0);
  }
  return { key: `${localDateKey(slot)}-${slot.getHours()}`, time: slot.getTime() };
}

function hasAttemptedLibrusRefresh(slot) {
  if (lastLibrusRefreshAttempt === slot.key) return true;
  try {
    return localStorage.getItem(librusRefreshStorageKey) === slot.key;
  } catch {
    return false;
  }
}

function markLibrusRefreshAttempt(slot) {
  lastLibrusRefreshAttempt = slot.key;
  try {
    localStorage.setItem(librusRefreshStorageKey, slot.key);
  } catch {
    // Refresh scheduling still works when browser storage is unavailable.
  }
}

async function refreshLibrus(slot) {
  if (!latestData?.providers?.librus || latestData.providers.librus.status === 'disabled' || hasAttemptedLibrusRefresh(slot)) return;
  markLibrusRefreshAttempt(slot);
  try {
    const response = await fetch('/api/librus/refresh', { method: 'POST' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (!latestData?.providers?.librus || latestData.providers.librus.status === 'disabled') return;
    latestData.providers.librus = result;
    renderProviderCard('librus', result);
  } catch {
    const current = latestData?.providers?.librus;
    if (!current || current.status === 'disabled') return;
    const failed = { ...current, status: 'warning', statusMessage: 'Refresh failed · showing last fetched timetable' };
    latestData.providers.librus = failed;
    renderProviderCard('librus', failed);
  }
}

function refreshLibrusIfStale(data = latestData?.providers?.librus) {
  if (!data || data.status === 'disabled') return;
  const slot = librusRefreshSlot();
  const lastUpdated = Date.parse(data.lastUpdated);
  if ((!Number.isFinite(lastUpdated) || lastUpdated < slot.time) && !hasAttemptedLibrusRefresh(slot)) {
    void refreshLibrus(slot);
  }
}

function scheduleLibrusUpdate() {
  clearTimeout(librusScheduleTimeout);
  const now = new Date();
  const next = new Date(now);
  let refreshAtBoundary = true;
  if (now.getHours() < 17) {
    next.setHours(17, 0, 0, 0);
  } else if (now.getHours() < 21) {
    next.setHours(21, 0, 0, 0);
  } else {
    next.setDate(next.getDate() + 1);
    next.setHours(0, 0, 0, 0);
    refreshAtBoundary = false;
  }
  librusScheduleTimeout = setTimeout(() => {
    renderLibrusSchedule();
    if (refreshAtBoundary) refreshLibrus(librusRefreshSlot());
    scheduleLibrusUpdate();
  }, next.getTime() - now.getTime());
}

scheduleLibrusUpdate();
document.addEventListener('visibilitychange', () => {
  renderCalendarMeetings();
  renderLibrusSchedule();
  refreshLibrusIfStale();
  scheduleLibrusUpdate();
});

(() => {
  const storageKey = 'hud-librus-collapsed';
  const toggle = document.getElementById('librus-toggle');
  const content = document.getElementById('librus-content');
  if (!toggle || !content) return;

  function setCollapsed(collapsed) {
    content.hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Expand school timetable' : 'Collapse school timetable');
  }

  toggle.addEventListener('click', () => {
    setCollapsed(!content.hidden);
    try {
      localStorage.setItem(storageKey, String(content.hidden));
    } catch {
      // Collapsing still works when browser storage is unavailable.
    }
  });
  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) setCollapsed(event.newValue === 'true');
  });
  try {
    setCollapsed(localStorage.getItem(storageKey) === 'true');
  } catch {
    setCollapsed(false);
  }
})();

// Latch ID of displayed alert across SSE push intervals to prevent 10s auto-dismiss
// from being repeatedly re-triggered or flickering on every state poll.
let lastUrgentId = '';
function checkUrgentAlerts(alerts) {
  const critical = alerts?.find(a => a.level === 'critical');
  const banner = document.getElementById('urgent-banner');
  const title = document.getElementById('urgent-title');
  const sub = document.getElementById('urgent-sub');

  if (!banner || !title || !sub) return;

  if (critical && critical.id !== lastUrgentId) {
    lastUrgentId = critical.id;
    title.textContent = `[${critical.source.toUpperCase()}] ${critical.title}`;
    sub.textContent = critical.subtitle || 'Critical event detected';
    banner.classList.remove('hidden');

    // Auto dismiss after 10 seconds
    setTimeout(() => {
      banner.classList.add('hidden');
    }, 10000);
  }
}

function renderDashboard(state) {
  latestData = state;
  if (Array.isArray(state.transitDestinations)) {
    window.dispatchEvent(new CustomEvent('hud:transit-destinations', { detail: state.transitDestinations }));
  }

  // Orientation
  const container = document.getElementById('hud-container');
  if (container && state.orientation) {
    container.className = `hud-container ${state.orientation}`;
  }

  // Render providers
  document.querySelectorAll('.hud-card:not(#card-timer):not(#card-transit)').forEach(card => {
    card.classList.toggle('hidden', !state.providers?.[card.id.slice(5)]);
  });
  if (state.providers) {
    for (const [key, val] of Object.entries(state.providers)) {
      renderProviderCard(key, val);
    }
  }

  checkUrgentAlerts(state.recentAlerts);
}

// Server-Sent Events (SSE) stream connection
function connectEventStream() {
  const evtSource = new EventSource('/api/events');

  evtSource.onmessage = (event) => {
    try {
      const state = JSON.parse(event.data);
      renderDashboard(state);
    } catch (err) {
      console.error('Failed to parse SSE data:', err);
    }
  };

  evtSource.onerror = () => {
    // Explicitly terminate failed socket before scheduling reconnect to prevent browser
    // auto-reconnect from creating orphaned duplicate EventSource instances.
    evtSource.close();
    // Auto reconnect after 3 seconds
    setTimeout(connectEventStream, 3000);
  };
}

connectEventStream();
