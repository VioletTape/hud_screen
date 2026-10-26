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
  const thresholdEnabled = Boolean(data.details?.thresholdEnabled);
  const thresholdHours = Number(data.details?.thresholdHours) || 12;
  const thresholdMs = thresholdHours * 60 * 60 * 1000;

  const meetings = rawMeetings
    .filter(meeting => {
      const startMs = new Date(meeting.startAt).getTime();
      if (!Number.isFinite(startMs)) return false;
      if (startMs >= nowMs) {
        if (thresholdEnabled && startMs > nowMs + thresholdMs) {
          return false;
        }
        return true;
      }
      return !meeting.allDay && meetingExpiryMs(meeting, startMs) > nowMs;
    })
    .slice(0, 2);

  const emptyMessage = thresholdEnabled
    ? `No meetings in ${thresholdHours} hours`
    : 'No upcoming meetings';

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
    : `<div class="meeting-empty">${escapeHtml(emptyMessage)}</div>`;

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

  // Also schedule boundary when a meeting outside the threshold enters the threshold window.
  if (thresholdEnabled) {
    for (const meeting of rawMeetings) {
      const startMs = new Date(meeting.startAt).getTime();
      if (!Number.isFinite(startMs)) continue;
      const enterThresholdMs = startMs - thresholdMs;
      if (enterThresholdMs > nowMs && enterThresholdMs < nextBoundaryMs) {
        nextBoundaryMs = enterThresholdMs;
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
    case 'weather': {
      renderWeatherCard(data);
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

const METEOCON_SVGS = {
  'clear-day': '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512"><defs><linearGradient id="a" x1="150" x2="234" y1="119.2" y2="264.8" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fbbf24"/><stop offset=".5" stop-color="#fbbf24"/><stop offset="1" stop-color="#f59e0b"/></linearGradient><symbol id="b" viewBox="0 0 384 384"><circle cx="192" cy="192" r="84" fill="url(#a)" stroke="#f8af18" stroke-miterlimit="10" stroke-width="6"/><path fill="none" stroke="#fbbf24" stroke-linecap="round" stroke-miterlimit="10" stroke-width="24" d="M192 61.7V12m0 360v-49.7m92.2-222.5 35-35M64.8 319.2l35.1-35.1m0-184.4-35-35m254.5 254.5-35.1-35.1M61.7 192H12m360 0h-49.7"><animateTransform additive="sum" attributeName="transform" dur="6s" repeatCount="indefinite" type="rotate" values="0 192 192; 45 192 192"/></path></symbol></defs><use xlink:href="#b" width="384" height="384" transform="translate(64 64)"/></svg>',
  'clear-night': '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512"><defs><linearGradient id="a" x1="54.3" x2="187.2" y1="29" y2="259.1" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#86c3db"/><stop offset=".5" stop-color="#86c3db"/><stop offset="1" stop-color="#5eafcf"/></linearGradient><symbol id="b" overflow="visible" viewBox="0 0 270 270"><path fill="url(#a)" stroke="#72b9d5" stroke-linecap="round" stroke-linejoin="round" stroke-width="6" d="M252.3 168.6A133.4 133.4 0 01118 36.2 130.5 130.5 0 01122.5 3 133 133 0 003 134.6C3 207.7 63 267 137.2 267c62.5 0 114.8-42.2 129.8-99.2a135.6 135.6 0 01-14.8.8Z"><animateTransform additive="sum" attributeName="transform" dur="6s" repeatCount="indefinite" type="rotate" values="-15 135 135; 9 135 135; -15 135 135"/></path></symbol></defs><use xlink:href="#b" width="270" height="270" transform="translate(121 121)"/></svg>',
  'partly-cloudy-day': '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512"><defs><symbol id="d" viewBox="0 0 196 196"><circle cx="98" cy="98" r="40" fill="url(#b)" stroke="#f8af18" stroke-miterlimit="10" stroke-width="4"/><path fill="none" stroke="#fbbf24" stroke-linecap="round" stroke-miterlimit="10" stroke-width="12" d="M98 31.4V6m0 184v-25.4M145.1 51l18-17.9M33 163l18-17.9M51 51 33 33m130.1 130.1-18-18M6 98h25.4M190 98h-25.4"><animateTransform additive="sum" attributeName="transform" dur="6s" repeatCount="indefinite" type="rotate" values="0 98 98; 45 98 98"/></path></symbol><symbol id="e" viewBox="0 0 350 222"><path fill="url(#a)" stroke="#e6effc" stroke-miterlimit="10" stroke-width="6" d="m291 107-2.5.1A83.9 83.9 0 00135.6 43 56 56 0 0051 91a56.6 56.6 0 00.8 9A60 60 0 0063 219l4-.2v.2h224a56 56 0 000-112Z"/></symbol><symbol id="c" viewBox="0 0 363 258"><use xlink:href="#d" width="196" height="196"/><use xlink:href="#e" width="350" height="222" transform="translate(13 36)"/></symbol><linearGradient id="a" x1="99.5" x2="232.6" y1="30.7" y2="261.4" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f3f7fe"/><stop offset=".5" stop-color="#f3f7fe"/><stop offset="1" stop-color="#deeafb"/></linearGradient><linearGradient id="b" x1="78" x2="118" y1="63.4" y2="132.7" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fbbf24"/><stop offset=".5" stop-color="#fbbf24"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs><use xlink:href="#c" width="363" height="258" transform="translate(68 109)"/></svg>',
  'partly-cloudy-night': '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512"><defs><symbol id="d" viewBox="0 0 172 172"><path fill="url(#b)" stroke="#72b9d5" stroke-linecap="round" stroke-linejoin="round" stroke-width="4" d="M160.6 107.4a84.8 84.8 0 01-85.4-84.3A83.3 83.3 0 0178 2 84.7 84.7 0 002 85.7 84.8 84.8 0 0087.4 170a85.2 85.2 0 0082.6-63.1 88 88 0 01-9.4.5Z"><animateTransform additive="sum" attributeName="transform" dur="6s" repeatCount="indefinite" type="rotate" values="-15 86 86; 9 86 86; -15 86 86"/></path></symbol><symbol id="e" viewBox="0 0 350 222"><path fill="url(#a)" stroke="#e6effc" stroke-miterlimit="10" stroke-width="6" d="m291 107-2.5.1A83.9 83.9 0 00135.6 43 56 56 0 0051 91a56.6 56.6 0 00.8 9A60 60 0 0063 219l4-.2v.2h224a56 56 0 000-112Z"/></symbol><symbol id="c" viewBox="0 0 351 246"><use xlink:href="#d" width="172" height="172"/><use xlink:href="#e" width="350" height="222" transform="translate(1 24)"/></symbol><linearGradient id="a" x1="99.5" x2="232.6" y1="30.7" y2="261.4" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f3f7fe"/><stop offset=".5" stop-color="#f3f7fe"/><stop offset="1" stop-color="#deeafb"/></linearGradient><linearGradient id="b" x1="34.7" x2="119.2" y1="18.6" y2="165" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#86c3db"/><stop offset=".5" stop-color="#86c3db"/><stop offset="1" stop-color="#5eafcf"/></linearGradient></defs><use xlink:href="#c" width="351" height="246" transform="translate(80 121)"/></svg>',
  overcast: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512"><defs><symbol id="d" viewBox="0 0 200.3 126.1"><path fill="url(#b)" stroke="#848b98" stroke-miterlimit="10" d="M.5 93.2a32.4 32.4 0 0032.4 32.4h129.8v-.1l2.3.1a34.8 34.8 0 006.5-68.9 32.4 32.4 0 00-48.5-33 48.6 48.6 0 00-88.6 37.1h-1.5A32.4 32.4 0 00.5 93.1Z"/></symbol><symbol id="e" viewBox="0 0 350 222"><path fill="url(#a)" stroke="#e6effc" stroke-miterlimit="10" stroke-width="6" d="m291 107-2.5.1A83.9 83.9 0 00135.6 43 56 56 0 0051 91a56.6 56.6 0 00.8 9A60 60 0 0063 219l4-.2v.2h224a56 56 0 000-112Z"/></symbol><symbol id="c" overflow="visible" viewBox="0 0 398 222"><use xlink:href="#d" width="200.3" height="126.1" transform="translate(198 27)"/><use xlink:href="#e" width="350" height="222"/></symbol><linearGradient id="a" x1="99.5" x2="232.6" y1="30.7" y2="261.4" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f3f7fe"/><stop offset=".5" stop-color="#f3f7fe"/><stop offset="1" stop-color="#deeafb"/></linearGradient><linearGradient id="b" x1="52.7" x2="133.4" y1="9.6" y2="149.3" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#9ca3af"/><stop offset=".5" stop-color="#9ca3af"/><stop offset="1" stop-color="#6b7280"/></linearGradient></defs><use xlink:href="#c" width="398" height="222" transform="translate(68.84 145)"/></svg>',
  fog: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512"><defs><linearGradient id="a" x1="99.5" x2="232.6" y1="30.7" y2="261.4" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f3f7fe"/><stop offset=".5" stop-color="#f3f7fe"/><stop offset="1" stop-color="#deeafb"/></linearGradient><linearGradient id="b" x1="96" x2="168" y1="-2.4" y2="122.3" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#d4d7dd"/><stop offset=".5" stop-color="#d4d7dd"/><stop offset="1" stop-color="#bec1c6"/></linearGradient><linearGradient xlink:href="#b" id="c" x2="168" y1="-50.4" y2="74.3"/><symbol id="d" viewBox="0 0 350 222"><path fill="url(#a)" stroke="#e6effc" stroke-miterlimit="10" stroke-width="6" d="m291 107-2.5.1A83.9 83.9 0 00135.6 43 56 56 0 0051 91a56.6 56.6 0 00.8 9A60 60 0 0063 219l4-.2v.2h224a56 56 0 000-112Z"/></symbol><symbol id="e" overflow="visible" viewBox="0 0 264 72"><path fill="none" stroke="url(#b)" stroke-linecap="round" stroke-miterlimit="10" stroke-width="24" d="M12 60h240"/><path fill="none" stroke="url(#c)" stroke-linecap="round" stroke-miterlimit="10" stroke-width="24" d="M12 12h240"/></symbol></defs><use xlink:href="#d" width="350" height="222" transform="translate(81 145)"/><use xlink:href="#e" width="264" height="72" transform="translate(124 402)"/></svg>',
  drizzle: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512"><defs><linearGradient id="a" x1="99.5" x2="232.6" y1="30.7" y2="261.4" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f3f7fe"/><stop offset=".5" stop-color="#f3f7fe"/><stop offset="1" stop-color="#deeafb"/></linearGradient><linearGradient id="b" x1="1314.8" x2="1324.2" y1="-739.9" y2="-715.3" gradientTransform="rotate(-9 7682.04 6929.539)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0b65ed"/><stop offset=".5" stop-color="#0a5ad4"/><stop offset="1" stop-color="#0950bc"/></linearGradient><linearGradient xlink:href="#b" id="c" x1="1370.1" x2="1379.5" y1="-731.1" y2="-706.5"/><linearGradient xlink:href="#b" id="d" x1="1425.4" x2="1434.9" y1="-722.4" y2="-697.8"/><symbol id="e" viewBox="0 0 350 222"><path fill="url(#a)" stroke="#e6effc" stroke-miterlimit="10" stroke-width="6" d="m291 107-2.5.1A83.9 83.9 0 00135.6 43 56 56 0 0051 91a56.6 56.6 0 00.8 9A60 60 0 0063 219l4-.2v.2h224a56 56 0 000-112Z"/></symbol></defs><use xlink:href="#e" width="350" height="222" transform="translate(81 145)"/><path fill="url(#b)" stroke="#0a5ad4" stroke-miterlimit="10" d="M200 376a8 8 0 01-8-8v-12a8 8 0 0116 0v12a8 8 0 01-8 8Z"/><path fill="url(#c)" stroke="#0a5ad4" stroke-miterlimit="10" d="M256 376a8 8 0 01-8-8v-12a8 8 0 0116 0v12a8 8 0 01-8 8Z"/><path fill="url(#d)" stroke="#0a5ad4" stroke-miterlimit="10" d="M312 376a8 8 0 01-8-8v-12a8 8 0 0116 0v12a8 8 0 01-8 8Z"/></svg>',
  rain: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512"><defs><linearGradient id="a" x1="99.5" x2="232.6" y1="30.7" y2="261.4" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f3f7fe"/><stop offset=".5" stop-color="#f3f7fe"/><stop offset="1" stop-color="#deeafb"/></linearGradient><linearGradient id="b" x1="1381.3" x2="1399.5" y1="-1144.7" y2="-1097.4" gradientTransform="rotate(-9 8002.567 8233.063)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0b65ed"/><stop offset=".5" stop-color="#0a5ad4"/><stop offset="1" stop-color="#0950bc"/></linearGradient><linearGradient xlink:href="#b" id="c" x1="1436.7" x2="1454.9" y1="-1137" y2="-1089.7" gradientTransform="rotate(-9 8009.537 8233.037)"/><linearGradient xlink:href="#b" id="d" x1="1492.1" x2="1510.3" y1="-1129.3" y2="-1082.1" gradientTransform="rotate(-9 8016.566 8233.078)"/><symbol id="e" viewBox="0 0 350 222"><path fill="url(#a)" stroke="#e6effc" stroke-miterlimit="10" stroke-width="6" d="m291 107-2.5.1A83.9 83.9 0 00135.6 43 56 56 0 0051 91a56.6 56.6 0 00.8 9A60 60 0 0063 219l4-.2v.2h224a56 56 0 000-112Z"/></symbol><symbol id="f" overflow="visible" viewBox="0 0 129 57"><path fill="url(#b)" stroke="#0a5ad4" stroke-miterlimit="10" d="M8.5 56.5a8 8 0 01-8-8v-40a8 8 0 0116 0v40a8 8 0 01-8 8Z"/><path fill="url(#c)" stroke="#0a5ad4" stroke-miterlimit="10" d="M64.5 56.5a8 8 0 01-8-8v-40a8 8 0 0116 0v40a8 8 0 01-8 8Z"/><path fill="url(#d)" stroke="#0a5ad4" stroke-miterlimit="10" d="M120.5 56.5a8 8 0 01-8-8v-40a8 8 0 0116 0v40a8 8 0 01-8 8Z"/></symbol></defs><use xlink:href="#e" width="350" height="222" transform="translate(81 145)"/><use xlink:href="#f" width="129" height="57" transform="translate(191.5 343.5)"/></svg>',
  snow: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512"><defs><linearGradient id="a" x1="99.5" x2="232.6" y1="30.7" y2="261.4" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f3f7fe"/><stop offset=".5" stop-color="#f3f7fe"/><stop offset="1" stop-color="#deeafb"/></linearGradient><linearGradient id="b" x1="11.4" x2="32.8" y1="5.9" y2="43.1" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#86c3db"/><stop offset=".5" stop-color="#86c3db"/><stop offset="1" stop-color="#5eafcf"/></linearGradient><linearGradient xlink:href="#b" id="c" x1="67.4" x2="88.8" y1="5.9" y2="43.1"/><linearGradient xlink:href="#b" id="d" x1="123.4" x2="144.8" y1="5.9" y2="43.1"/><symbol id="e" viewBox="0 0 350 222"><path fill="url(#a)" stroke="#e6effc" stroke-miterlimit="10" stroke-width="6" d="m291 107-2.5.1A83.9 83.9 0 00135.6 43 56 56 0 0051 91a56.6 56.6 0 00.8 9A60 60 0 0063 219l4-.2v.2h224a56 56 0 000-112Z"/></symbol><symbol id="f" overflow="visible" viewBox="0 0 156.2 49"><path fill="url(#b)" stroke="#86c3db" stroke-miterlimit="10" d="m41.7 31-5.8-3.3a13.7 13.7 0 000-6.5l5.8-3.2a4 4 0 001.5-5.5 4 4 0 00-5.6-1.5l-5.8 3.3a13.6 13.6 0 00-2.6-2 13.8 13.8 0 00-3-1.3V4.5a4 4 0 00-8.1 0v6.6a14.3 14.3 0 00-5.7 3.2L6.6 11A4 4 0 001 12.5 4 4 0 002.5 18l5.8 3.3a13.7 13.7 0 000 6.5L2.5 31A4 4 0 001 36.5a4 4 0 003.5 2 4 4 0 002-.5l5.8-3.3a13.6 13.6 0 002.6 2 13.8 13.8 0 003 1.2v6.6a4 4 0 008.2 0v-6.6a14.2 14.2 0 005.6-3.2l6 3.3a4 4 0 002 .5 4 4 0 003.4-2 4 4 0 00-1.4-5.5ZM19 29.7a6 6 0 01-2.3-8.2 6.1 6.1 0 015.3-3 6.2 6.2 0 013 .8 6 6 0 012.2 8.2 6.1 6.1 0 01-8.2 2.2Z"/><path fill="url(#c)" stroke="#86c3db" stroke-miterlimit="10" d="m97.7 31-5.8-3.3a13.7 13.7 0 000-6.5l5.8-3.2a4 4 0 001.5-5.5 4 4 0 00-5.6-1.5l-5.8 3.3a13.6 13.6 0 00-2.6-2 13.8 13.8 0 00-3-1.3V4.5a4 4 0 00-8.1 0v6.6a14.3 14.3 0 00-5.7 3.2L62.6 11a4 4 0 00-5.6 1.5 4 4 0 001.5 5.5l5.8 3.3a13.7 13.7 0 000 6.5L58.5 31a4 4 0 00-1.5 5.5 4 4 0 003.5 2 4 4 0 002-.5l5.8-3.3a13.6 13.6 0 002.7 2 13.8 13.8 0 003 1.2v6.6a4 4 0 008 0v-6.6a14.2 14.2 0 005.7-3.2l6 3.3a4 4 0 002 .5 4 4 0 003.4-2 4 4 0 00-1.4-5.5ZM75 29.7a6 6 0 01-2.3-8.2 6.1 6.1 0 015.3-3 6.2 6.2 0 013 .8 6 6 0 012.2 8.2 6.1 6.1 0 01-8.2 2.2Z"/><path fill="url(#d)" stroke="#86c3db" stroke-miterlimit="10" d="m153.7 31-5.8-3.3a13.7 13.7 0 000-6.5l5.8-3.2a4 4 0 001.5-5.5 4 4 0 00-5.6-1.5l-5.8 3.3a13.6 13.6 0 00-2.6-2 13.8 13.8 0 00-3-1.3V4.5a4 4 0 00-8.1 0v6.6a14.3 14.3 0 00-5.7 3.2l-5.8-3.3a4 4 0 00-5.6 1.5 4 4 0 001.5 5.5l5.8 3.3a13.7 13.7 0 000 6.5l-5.8 3.2a4 4 0 00-1.5 5.5 4 4 0 003.5 2 4 4 0 002-.5l5.8-3.3a13.6 13.6 0 002.7 2 13.8 13.8 0 003 1.2v6.6a4 4 0 008 0v-6.6a14.2 14.2 0 005.7-3.2l5.8 3.3a4 4 0 002 .5 4 4 0 003.5-2 4 4 0 00-1.3-5.5ZM131 29.7a6 6 0 01-2.3-8.2 6.1 6.1 0 015.3-3 6.2 6.2 0 013 .8 6 6 0 012.2 8.2 6.1 6.1 0 01-8.2 2.2Z"/></symbol></defs><use xlink:href="#e" width="350" height="222" transform="translate(81 145)"/><use xlink:href="#f" width="156.2" height="49" transform="translate(177.9 337.5)"/></svg>',
  'thunderstorms-rain': '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512"><defs><linearGradient id="a" x1="99.5" x2="232.6" y1="30.7" y2="261.4" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f3f7fe"/><stop offset=".5" stop-color="#f3f7fe"/><stop offset="1" stop-color="#deeafb"/></linearGradient><linearGradient id="b" x1="8.7" x2="80.9" y1="17.1" y2="142.1" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f7b23b"/><stop offset=".5" stop-color="#f7b23b"/><stop offset="1" stop-color="#f59e0b"/></linearGradient><linearGradient id="c" x1="1381.3" x2="1399.5" y1="-1144.7" y2="-1097.4" gradientTransform="rotate(-9 8002.567 8233.063)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0b65ed"/><stop offset=".5" stop-color="#0a5ad4"/><stop offset="1" stop-color="#0950bc"/></linearGradient><linearGradient xlink:href="#c" id="d" x1="1436.7" x2="1454.9" y1="-1137" y2="-1089.7" gradientTransform="rotate(-9 8009.537 8233.037)"/><linearGradient xlink:href="#c" id="e" x1="1492.1" x2="1510.3" y1="-1129.3" y2="-1082.1" gradientTransform="rotate(-9 8016.566 8233.078)"/><symbol id="f" viewBox="0 0 350 222"><path fill="url(#a)" stroke="#e6effc" stroke-miterlimit="10" stroke-width="6" d="m291 107-2.5.1A83.9 83.9 0 00135.6 43 56 56 0 0051 91a56.6 56.6 0 00.8 9A60 60 0 0063 219l4-.2v.2h224a56 56 0 000-112Z"/></symbol><symbol id="g" overflow="visible" viewBox="0 0 129 57"><path fill="url(#c)" stroke="#0a5ad4" stroke-miterlimit="10" d="M8.5 56.5a8 8 0 01-8-8v-40a8 8 0 0116 0v40a8 8 0 01-8 8Z"/><path fill="url(#d)" stroke="#0a5ad4" stroke-miterlimit="10" d="M64.5 56.5a8 8 0 01-8-8v-40a8 8 0 0116 0v40a8 8 0 01-8 8Z"/><path fill="url(#e)" stroke="#0a5ad4" stroke-miterlimit="10" d="M120.5 56.5a8 8 0 01-8-8v-40a8 8 0 0116 0v40a8 8 0 01-8 8Z"/></symbol><symbol id="h" viewBox="0 0 102.7 186.8"><path fill="url(#b)" stroke="#f6a823" stroke-miterlimit="10" stroke-width="4" d="m34.8 2-32 96h32l-16 80 80-112h-48l32-64h-48z"/></symbol></defs><use xlink:href="#f" width="350" height="222" transform="translate(81 145)"/><use xlink:href="#g" width="129" height="57" transform="translate(191.5 343.5)"/><use xlink:href="#h" width="102.7" height="186.7" transform="translate(205.23 291)"/></svg>',
  raindrop: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="128 112 256 288"><defs><linearGradient id="a" x1="14.8" x2="124.2" y1="42.3" y2="231.7" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#3392d6"/><stop offset=".5" stop-color="#3392d6"/><stop offset="1" stop-color="#2477b2"/></linearGradient><symbol id="b" viewBox="0 0 164 245.6"><path fill="url(#a)" stroke="#2885c7" stroke-miterlimit="10" stroke-width="4" d="M82 3.6c-48.7 72-80 117-80 160.7s35.8 79.3 80 79.3 80-35.5 80-79.3S130.7 75.5 82 3.6Z"/></symbol></defs><use xlink:href="#b" width="164" height="245.6" transform="translate(174 132.43)"/></svg>',
};

const BEAUFORT_DIGIT_PATHS = [
  'M406 334.2q-8.2 9.8-22 9.8t-21.8-9.8q-8.1-9.7-8.1-26.4 0-16.5 8-26.1 8-9.7 22-9.7 13.7 0 21.8 9.7t8 26.1q.1 16.6-8 26.4Zm-22-4.2q12.6 0 12.6-22T384 286q-12.6 0-12.6 22t12.7 22Z',
  'M402.4 344h-19v-45h-17.8v-12.6h3q7.8 0 12.4-3.4 4.2-3.1 5.5-10.2l.2-.8h15.6Z',
  'M411.9 344h-55.7q0-9.4 4-15.7 4-6.1 14.8-13.5l11-7.8a22.4 22.4 0 005.9-5.5 10.2 10.2 0 001.7-5.8 8.7 8.7 0 00-2.6-6.7 9.8 9.8 0 00-7-2.4q-10 0-10 11.8v1.5h-17v-2.2q0-12.1 7.2-19t20-6.8q12.5 0 19.8 6t7.4 16.7a22 22 0 01-3.5 12.2q-3.5 5.5-11.2 10.4l-12.1 7.7c-2.3 1.5-3.6 2.8-3.8 3.9h31Z',
  'M397.5 305.2a17.8 17.8 0 0110.8 5.7 16.4 16.4 0 013.8 11.2 20 20 0 01-7.2 15.7q-7.3 6.2-20.3 6.2-13.6 0-21-6.7t-7.8-18.6h16.5q.6 11.7 11.7 11.7a11.6 11.6 0 007.7-2.4 8.1 8.1 0 002.8-6.5 7.5 7.5 0 00-3-6.5 14 14 0 00-8.4-2.2h-4.9v-12h5.2c3 0 5.3-.6 7-2a7 7 0 002.4-5.7 7.2 7.2 0 00-2.4-5.8c-1.7-1.4-4-2-7-2s-5.2.7-6.8 2.1-2.4 3.9-2.7 7.2H358q1-22.6 26-22.6 11.8 0 18.5 5.2a16.1 16.1 0 016.6 13.3 14.9 14.9 0 01-3 9.3 15.2 15.2 0 01-8.6 5.4Z',
  'M404.2 272v42.5l10.5-.3v14.3l-10.6-.3V344h-17.6v-15.8l-33.2.3V312l32.5-40.1Zm-36.6 42.5h19v-22.8h-.3Z',
  'M383.8 344q-12 0-19.7-5.5t-9-15.7l17.6-1.4a9.9 9.9 0 003.8 6 12 12 0 007.2 2.2 11.6 11.6 0 008.5-3 10.5 10.5 0 003-8 10.4 10.4 0 00-3-7.8 11.6 11.6 0 00-8.5-3 12.6 12.6 0 00-9.7 4.3l-16.6-1.5 6.4-38.6H408v14.7h-30.9l-2.3 12 .3.2q5.6-4 14.2-4 10.7 0 17 6.2t6.6 17.1q0 11.8-7.8 18.8t-21.3 7Z',
  'M388.5 294.8q11 0 17.7 6.5t6.8 17.3q0 11.3-7.7 18.4t-20.2 7q-12.6 0-20.6-7.7-9.5-9-9.5-27.7 0-17.5 7.6-27t22.2-9.6q10.1 0 16.8 4.6a22.3 22.3 0 019 13l-16.6 1q-2.1-5.6-9.3-5.6-6 0-9 4t-3.7 13q5.8-7.2 16.5-7.2Zm-12.7 31.6a11.5 11.5 0 008.8 3.7q5.4 0 8.3-3.2a11.9 11.9 0 002.9-8 10.6 10.6 0 00-3.2-8 11.2 11.2 0 00-8.2-3.1 11 11 0 00-8 3 12 12 0 00-3.4 8.2 12.3 12.3 0 002.8 7.4Z',
  'M387.3 344h-20q0-13.7 6.5-29a88.4 88.4 0 0117.9-26.7h-35.5V272h55.6v14.7q-12.3 13.1-18.2 26.8a81.8 81.8 0 00-6.3 30.5Z',
  'M405.4 338.1q-7.9 5.9-21.4 5.9t-21.4-5.9a19 19 0 01-7.9-16 16.2 16.2 0 013.5-10.7 17.7 17.7 0 019.9-5.9v-.2a14.8 14.8 0 01-7.5-5.6 15.3 15.3 0 01-2.7-9 16 16 0 016.8-13.7q7-5 19.3-5t19.3 5a16 16 0 017 13.7 15.4 15.4 0 01-2.8 9.1 14.3 14.3 0 01-7.4 5.5v.3a18.1 18.1 0 019.8 5.9 16.2 16.2 0 013.5 10.6 19 19 0 01-8 16Zm-21.3-7q5.6 0 9-2.5a8.5 8.5 0 003.2-7.1 8.5 8.5 0 00-3.2-7.1c-2.2-1.7-5.2-2.5-9-2.5s-7 .8-9.2 2.5a8.5 8.5 0 00-3.2 7 8.4 8.4 0 003.3 7.2 15 15 0 009 2.5Zm0-30.3q5 0 7.8-2.3a7.4 7.4 0 002.9-6.1 7 7 0 00-2.8-6 13 13 0 00-8-2q-10.7 0-10.7 8a7.4 7.4 0 002.8 6.2q2.8 2.1 8 2.1Z',
  'M403.4 279.7q9.7 9 9.7 27.6 0 17.5-7.7 27.1t-22.3 9.6q-10.1 0-16.8-4.6a21.9 21.9 0 01-9-12.8l16.6-1.1q2.1 5.5 9.3 5.5 5.9 0 9-4t3.8-13q-6 7.1-16.6 7.1-10.9 0-17.6-6.4t-6.9-17.3q0-11.2 7.8-18.4t20-7q12.7 0 20.7 7.7Zm-20 28.5a11 11 0 008.2-3 12.2 12.2 0 003.3-8.3 11.6 11.6 0 00-2.7-7.3 11.2 11.2 0 00-9-3.7c-3.5 0-6.2 1-8.2 3.1a11.3 11.3 0 00-2.9 8 10.9 10.9 0 003.1 8.2 11.3 11.3 0 008.3 3Z',
  'M366.4 344h-19v-45h-17.7v-12.6h3q7.8 0 12.3-3.4 4.3-3.1 5.6-10.2l.2-.8h15.6Zm63.9-9.8q-8.2 9.8-21.9 9.8t-21.9-9.8q-8.1-9.7-8.1-26.4 0-16.5 8.1-26.1 8-9.7 21.9-9.7 13.7 0 21.9 9.7t8 26.1q0 16.6-8 26.4Zm-21.9-4.2q12.6 0 12.6-22t-12.6-22q-12.7 0-12.7 22t12.7 22Z',
  'M379 344h-18.9v-45h-17.8v-12.6h3q7.8 0 12.3-3.4 4.3-3.1 5.6-10.2l.2-.8H379Zm46.7 0h-19v-45H389v-12.6h3q7.8 0 12.3-3.4 4.3-3.1 5.6-10.2l.2-.8h15.6Z',
  'M367.5 344.4h-19v-45h-17.7v-12.6h3q7.8 0 12.3-3.4 4.3-3.1 5.6-10.2l.2-.8h15.5Zm69.7-.8h-55.7q0-9.4 4-15.7 4-6.1 14.9-13.5l10.9-7.7a22.2 22.2 0 005.8-5.5 10.2 10.2 0 001.8-5.8 8.7 8.7 0 00-2.6-6.7 9.8 9.8 0 00-7-2.4q-10 0-10 11.8v1.4h-16.8v-2.1q0-12.2 7.1-19t20.2-6.8q12.4 0 19.7 6t7.4 16.6a22.2 22.2 0 01-3.5 12.3q-3.5 5.4-11.2 10.4l-12.1 7.7c-2.3 1.5-3.6 2.8-3.8 3.8h31Z',
];

function svgToDataUri(svg) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function meteoconUrl(name) {
  return svgToDataUri(METEOCON_SVGS[name] || METEOCON_SVGS['partly-cloudy-day']);
}

function beaufortIconUrl(bft) {
  const level = Math.max(0, Math.min(12, Math.round(Number(bft) || 0)));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="72 104 376 304"><defs><linearGradient id="a" x1="138.5" x2="224.2" y1="5.1" y2="153.5" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#d4d7dd"/><stop offset=".5" stop-color="#d4d7dd"/><stop offset="1" stop-color="#bec1c6"/></linearGradient><linearGradient xlink:href="#a" id="b" x1="77.7" x2="169" y1="96.2" y2="254.4"/><symbol id="c" viewBox="0 0 348 240"><path fill="none" stroke="url(#a)" stroke-linecap="round" stroke-miterlimit="10" stroke-width="24" d="M267.2 24.3A40 40 0 11296 92H12"/><path fill="none" stroke="url(#b)" stroke-linecap="round" stroke-miterlimit="10" stroke-width="24" d="M151.2 215.7A40 40 0 10180 148H12"/></symbol></defs><use xlink:href="#c" width="348" height="240" transform="translate(82 136)"/><path fill="#f1f5f9" d="${BEAUFORT_DIGIT_PATHS[level]}"/></svg>`;
  return svgToDataUri(svg);
}

let activeWeatherMode = 'dog-walk';
let activeWeatherTempMode = 'real';
try {
  const savedMode = localStorage.getItem('hud-weather-mode');
  if (savedMode === 'dog-walk' || savedMode === 'go-out') activeWeatherMode = savedMode;
  const savedTempMode = localStorage.getItem('hud-weather-temp-mode');
  if (savedTempMode === 'real' || savedTempMode === 'feel') activeWeatherTempMode = savedTempMode;
} catch {
  // Default mode works when browser storage is unavailable.
}

function fmtSigned(n) {
  const val = Number(n) || 0;
  return `${val >= 0 ? '+' : ''}${val.toFixed(1)}`;
}

function fmtMm(n) {
  const val = Number(n) || 0;
  return String(Number(val.toFixed(1)));
}

function renderWeatherCard(data = latestData?.providers?.weather) {
  if (!data) return;
  const cardEl = document.getElementById('card-weather');
  if (cardEl) cardEl.dataset.tempMode = activeWeatherTempMode;
  const statusEl = document.getElementById('weather-status');
  const current = data.details?.current;

  if (statusEl) {
    statusEl.hidden = data.status !== 'warning' && data.status !== 'error';
    statusEl.textContent = statusEl.hidden ? '' : (data.statusMessage || 'Weather unavailable');
  }

  const condIcon = document.getElementById('weather-cond-icon');
  const tempEl = document.getElementById('weather-temp');
  const windIcon = document.getElementById('weather-wind-icon');
  const uvEl = document.getElementById('weather-uv');
  const dropIcon = document.getElementById('weather-drop-icon');
  const precipEl = document.getElementById('weather-precip');
  const precipValEl = document.getElementById('weather-precip-val');
  const mmEl = document.getElementById('weather-mm');
  const mmValEl = document.getElementById('weather-mm-val');
  const pressureEl = document.getElementById('weather-pressure');
  const pressureHintEl = document.getElementById('weather-pressure-hint');

  if (!current) {
    if (condIcon) condIcon.hidden = true;
    if (windIcon) windIcon.hidden = true;
    if (dropIcon) dropIcon.hidden = true;
    if (pressureHintEl) pressureHintEl.textContent = '';
    const forecastEl = document.getElementById('weather-forecast');
    if (forecastEl) forecastEl.innerHTML = '';
    return;
  }

  if (condIcon) {
    condIcon.src = meteoconUrl(current.icon);
    condIcon.title = `${current.weatherLabel || ''}`;
    condIcon.hidden = false;
  }
  if (tempEl) {
    const shownTemp = activeWeatherTempMode === 'feel' ? current.feelsLike : current.temp;
    tempEl.textContent = `${Number(shownTemp).toFixed(1)}°${current.lightning ? '⚡' : ''}`;
    tempEl.title = `${current.weatherLabel} · Real ${Number(current.temp).toFixed(1)}°C · Feels like ${Number(current.feelsLike).toFixed(1)}°C`;
  }
  if (windIcon) {
    windIcon.src = beaufortIconUrl(current.windBft);
    windIcon.title = `Wind ${current.windSpeed} km/h (gusts ${current.windGusts} km/h) · Bft ${current.windBft}: ${current.windLabel}`;
    windIcon.hidden = false;
  }
  if (uvEl) {
    uvEl.textContent = `UV ${current.uv ?? 0}`;
    uvEl.title = `UV index ${current.uv ?? 0}`;
  }
  if (dropIcon) {
    dropIcon.src = meteoconUrl('raindrop');
    dropIcon.hidden = false;
  }
  if (precipValEl) {
    precipValEl.textContent = `${current.precipProb ?? 0}%`;
  }
  if (precipEl) {
    precipEl.title = `Precipitation probability ${current.precipProb ?? 0}% · ${fmtMm(current.precip)} mm`;
  }
  if (mmValEl) {
    mmValEl.textContent = fmtMm(current.precip);
  }
  if (mmEl) {
    mmEl.title = `Expected precipitation ${fmtMm(current.precip)} mm`;
  }
  if (pressureEl && current.pressureTrend) {
    const pt = current.pressureTrend;
    const trendType = pt.arrow.includes('↑') ? 'rising' : pt.arrow.includes('↓') ? 'falling' : 'steady';
    pressureEl.dataset.trend = trendType;
    pressureEl.textContent = `${pt.arrow}${current.pressureMsl}`;
    const fullHint = `${pt.arrow} ${current.pressureMsl} hPa (${pt.label}: 3h ${fmtSigned(pt.delta3h)}, 6h ${fmtSigned(pt.delta6h)} hPa) — ${pt.hint}`;
    pressureEl.removeAttribute('title');
    pressureEl.setAttribute('aria-label', fullHint);
    if (pressureHintEl) {
      pressureHintEl.textContent = fullHint;
    }
  }

  renderWeatherForecast(data);
}

function renderWeatherForecast(data = latestData?.providers?.weather) {
  const forecastEl = document.getElementById('weather-forecast');
  if (!forecastEl || !data?.details) return;

  const slots = activeWeatherMode === 'go-out'
    ? (data.details.goOut || [])
    : (data.details.dogWalk || []);

  const dropUri = meteoconUrl('raindrop');
  forecastEl.innerHTML = slots.map(slot => {
    const shownTemp = activeWeatherTempMode === 'feel' ? slot.feelsLike : slot.temp;
    const mmText = fmtMm(slot.precip);
    const lightningNote = slot.lightning
      ? ` · Lightning risk${slot.cape > 0 ? ` (CAPE ${slot.cape} J/kg)` : ''}`
      : '';
    const rowTitle = `${slot.time} · ${slot.weatherLabel} · ${Number(slot.temp).toFixed(1)}°C (feels ${Number(slot.feelsLike).toFixed(1)}°C) · Wind ${slot.windSpeed} km/h, gusts ${slot.windGusts} km/h (Bft ${slot.windBft}: ${slot.windLabel}) · Rain ${slot.precipProb}% (${mmText} mm)${lightningNote}`;
    return `
      <div class="weather-row" title="${escapeHtml(rowTitle)}">
        <span class="weather-row-time">${escapeHtml(slot.time)}</span>
        <span class="weather-row-temp">${Number(shownTemp).toFixed(1)}°${slot.lightning ? ' ⚡' : ''}</span>
        <img class="weather-row-wind-icon" src="${beaufortIconUrl(slot.windBft)}" alt="Bft ${escapeHtml(slot.windBft)}">
        <span class="weather-row-precip"><img class="weather-drop-icon" src="${dropUri}" alt="" aria-hidden="true"><span>${escapeHtml(slot.precipProb)}%</span></span>
        <span class="weather-row-mm"><span>${escapeHtml(mmText)}</span> <span class="weather-mm-unit">mm</span></span>
      </div>
    `;
  }).join('');
}

(() => {
  const collapseKey = 'hud-weather-collapsed';
  const modeKey = 'hud-weather-mode';
  const tempModeKey = 'hud-weather-temp-mode';
  const toggle = document.getElementById('weather-toggle');
  const content = document.getElementById('weather-content');
  const tempEl = document.getElementById('weather-temp');
  const modeButtons = document.querySelectorAll('[data-weather-mode]');
  if (!toggle || !content) return;

  function setCollapsed(collapsed) {
    content.hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Expand weather forecast' : 'Collapse weather forecast');
  }

  function setMode(mode) {
    activeWeatherMode = mode === 'go-out' ? 'go-out' : 'dog-walk';
    modeButtons.forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.dataset.weatherMode === activeWeatherMode));
    });
    renderWeatherForecast();
  }

  function setTempMode(mode) {
    activeWeatherTempMode = mode === 'feel' ? 'feel' : 'real';
    renderWeatherCard();
  }

  // Intentional UX: #weather-temp stays a plain non-focusable <span> without button
  // semantics or pointer cursor so real/feels-like toggling remains a subtle HUD tap action.
  if (tempEl) {
    tempEl.addEventListener('click', () => {
      setTempMode(activeWeatherTempMode === 'real' ? 'feel' : 'real');
      try {
        localStorage.setItem(tempModeKey, activeWeatherTempMode);
      } catch {
        // Temperature mode toggle still works when browser storage is unavailable.
      }
    });
  }

  toggle.addEventListener('click', () => {
    setCollapsed(!content.hidden);
    try {
      localStorage.setItem(collapseKey, String(content.hidden));
    } catch {
      // Collapsing still works when browser storage is unavailable.
    }
  });

  modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      setMode(btn.dataset.weatherMode);
      try {
        localStorage.setItem(modeKey, activeWeatherMode);
      } catch {
        // Mode switching still works when browser storage is unavailable.
      }
    });
  });

  window.addEventListener('storage', event => {
    if (event.key === collapseKey || event.key === null) {
      setCollapsed(event.newValue !== 'false');
    }
    if (event.key === modeKey || event.key === null) {
      setMode(event.newValue);
    }
    if (event.key === tempModeKey || event.key === null) {
      setTempMode(event.newValue);
    }
  });

  setMode(activeWeatherMode);
  try {
    const stored = localStorage.getItem(collapseKey);
    setCollapsed(stored === null ? true : stored === 'true');
  } catch {
    setCollapsed(true);
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
