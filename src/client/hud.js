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

function formatTimeUntil(startAt) {
  const minutes = Math.max(1, Math.ceil((new Date(startAt).getTime() - Date.now()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

function renderProviderCard(providerKey, data) {
  if (!data) return;

  const card = document.getElementById(`card-${providerKey}`);
  const sub = document.getElementById(`${providerKey}-sub`);

  if (card) {
    card.dataset.status = data.status;
    card.setAttribute('aria-label', `${data.displayName} status: ${data.status}`);
  }

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

      // Render Top 3 Channel Mentions: "name of channel"
      const mentionsListEl = document.getElementById('slack-mentions-list');
      if (mentionsListEl) {
        const topMentions = data.details?.topMentions;
        if (Array.isArray(topMentions) && topMentions.length > 0) {
          mentionsListEl.innerHTML = topMentions.map(m => `
            <div class="slack-item channel-item">
              <span class="slack-channel-name">${escapeHtml(m.channel)}</span>
            </div>
          `).join('');
        } else {
          const hint = data.details?.missingScopes?.includes('search:read')
            ? ' <span class="scope-hint">(scope req.)</span>'
            : '';
          mentionsListEl.innerHTML = `<div class="slack-item-empty">0 unread mentions${hint}</div>`;
        }
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
      const list = document.getElementById('calendar-meetings');
      const meetings = data.details?.meetings || [];
      if (list) {
        list.innerHTML = meetings.length
          ? meetings.map(meeting => `
              <div class="meeting-item ${meeting.source === 'personal' ? 'personal' : 'corporate'}" aria-label="${escapeHtml(meeting.source)} calendar: ${escapeHtml(meeting.title)}">
                <div class="meeting-title">${escapeHtml(meeting.title)}</div>
                <div class="meeting-countdown">${formatTimeUntil(meeting.startAt)}</div>
                <div class="meeting-datetime">${formatMeetingDate(meeting)}</div>
              </div>
            `).join('')
          : '<div class="meeting-empty">No upcoming meetings</div>';
      }
      break;
    }
  }
}

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

  // Orientation
  const container = document.getElementById('hud-container');
  if (container && state.orientation) {
    container.className = `hud-container ${state.orientation}`;
  }

  // Render providers
  document.querySelectorAll('.hud-card').forEach(card => {
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
    evtSource.close();
    // Auto reconnect after 3 seconds
    setTimeout(connectEventStream, 3000);
  };
}

connectEventStream();
