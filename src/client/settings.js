let activeConfig = null;
let detectedMonitors = [];
let isMouseLocked = false;

// Toast notification helper
function showToast(msg, duration = 3000) {
  const toast = document.getElementById('toast-message');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => {
    toast.classList.add('hidden');
  }, duration);
}

// Password toggle helper
document.querySelectorAll('.btn-toggle-pw').forEach(btn => {
  btn.addEventListener('click', () => {
    const wrapper = btn.closest('.input-password-wrapper');
    const input = wrapper?.querySelector('input');
    if (input) {
      if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = '🔒';
      } else {
        input.type = 'password';
        btn.textContent = '👁️';
      }
    }
  });
});

// Load config from backend
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    activeConfig = cfg;

    // Populate toggles
    document.getElementById('mock-mode-toggle').checked = Boolean(cfg.mockMode);

    // Secret inputs (tokens, passwords) are intentionally kept empty on load to avoid
    // persisting masked placeholder characters; status badges indicate if credentials exist.
    // GitLab
    document.getElementById('gl-enabled').checked = Boolean(cfg.gitlab?.enabled);
    document.getElementById('gl-url').value = cfg.gitlab?.baseUrl || '';
    if (cfg.gitlab?.hasToken) {
      document.getElementById('gl-token-status').textContent = `Configured (${cfg.gitlab.token})`;
    }

    // LiteLLM
    document.getElementById('llm-enabled').checked = Boolean(cfg.litellm?.enabled);
    document.getElementById('llm-url').value = cfg.litellm?.baseUrl || '';
    document.getElementById('llm-budget').value = cfg.litellm?.dailyBudgetLimit || 20;
    document.getElementById('llm-user-id').value = cfg.litellm?.userId || '';
    if (cfg.litellm?.hasMasterKey) {
      document.getElementById('llm-key-status').textContent = `Configured (${cfg.litellm.masterKey})`;
    }

    // Slack
    document.getElementById('slack-enabled').checked = Boolean(cfg.slack?.enabled);
    document.getElementById('slack-tracked-channels').value = (cfg.slack?.trackedChannels || []).join(', ');
    if (cfg.slack?.hasToken) {
      document.getElementById('slack-token-status').textContent = `Configured (${cfg.slack.botToken || cfg.slack.userToken})`;
    }

    // Email
    document.getElementById('email-enabled').checked = Boolean(cfg.email?.enabled);
    document.getElementById('email-host').value = cfg.email?.host || '';
    document.getElementById('email-port').value = cfg.email?.port || 993;
    document.getElementById('email-user').value = cfg.email?.user || '';
    if (cfg.email?.hasPassword) {
      document.getElementById('email-pw-status').textContent = 'Password stored';
    }

    // Published calendar feeds (may contain embedded private tokens in their URL query strings;
    // inputs are blanked on load with separate status indicators to protect confidentiality)
    document.getElementById('calendar-enabled').checked = Boolean(cfg.calendar?.enabled);
    for (const [urlId, statusId, clearId, isStored] of [
      ['calendar-corporate-url', 'calendar-corporate-status', 'calendar-clear-corporate', cfg.calendar?.hasCorporateUrl],
      ['calendar-personal-url', 'calendar-personal-status', 'calendar-clear-personal', cfg.calendar?.hasPersonalUrl],
    ]) {
      document.getElementById(urlId).value = '';
      document.getElementById(statusId).textContent = isStored ? 'Link stored; leave blank to keep it' : '';
      document.getElementById(clearId).checked = false;
    }

    // Orientation
    setOrientationUI(cfg.display?.orientation || 'horizontal');
  } catch (err) {
    showToast(`Failed to load config: ${err.message}`);
  }
}

// Orientation controls
function setOrientationUI(orient) {
  const btnHoriz = document.getElementById('btn-orient-horiz');
  const btnVert = document.getElementById('btn-orient-vert');
  const preview = document.getElementById('preview-container');

  if (orient === 'vertical') {
    btnVert.classList.add('active');
    btnHoriz.classList.remove('active');
    preview.classList.add('vertical-mode');
  } else {
    btnHoriz.classList.add('active');
    btnVert.classList.remove('active');
    preview.classList.remove('vertical-mode');
  }
}

document.getElementById('btn-orient-horiz').addEventListener('click', () => {
  setOrientationUI('horizontal');
  saveOrientation('horizontal');
});

document.getElementById('btn-orient-vert').addEventListener('click', () => {
  setOrientationUI('vertical');
  saveOrientation('vertical');
});

async function saveOrientation(orient) {
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display: { orientation: orient } }),
    });
    // Reload preview iframe
    const iframe = document.getElementById('preview-iframe');
    if (iframe) iframe.src = '/index.html?t=' + Date.now();
  } catch (err) {
    console.error('Failed to update orientation:', err);
  }
}

// Monitor Detection
async function loadMonitors() {
  const select = document.getElementById('monitor-select');
  select.innerHTML = '<option value="">Scanning displays...</option>';

  try {
    const res = await fetch('/api/monitors');
    detectedMonitors = await res.json();

    select.innerHTML = '';
    let defaultIndex = 0;

    detectedMonitors.forEach((m, idx) => {
      const opt = document.createElement('option');
      opt.value = m.index;
      opt.textContent = m.label;
      // Auto-select the 8.8" ultrawide bar display (1920x480 / 480x1920) if detected.
      if (m.isLikely88Inch) {
        opt.selected = true;
        defaultIndex = m.index;
      }
      select.appendChild(opt);
    });

    if (detectedMonitors.length === 0) {
      select.innerHTML = '<option value="0">No external monitors detected</option>';
    }
  } catch (err) {
    select.innerHTML = '<option value="0">Default Primary Display</option>';
  }
}

document.getElementById('btn-refresh-monitors').addEventListener('click', loadMonitors);

// Launch HUD on Display
document.getElementById('btn-launch-hud').addEventListener('click', async () => {
  const select = document.getElementById('monitor-select');
  const monitorIndex = select.value || 0;

  showToast('Launching borderless HUD on selected screen...');
  try {
    const res = await fetch('/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitorIndex }),
    });
    const result = await res.json();
    showToast(result.message);
  } catch (err) {
    showToast(`Launch failed: ${err.message}`);
  }
});

// Mouse Lock Toggle
document.getElementById('btn-toggle-mouse-lock').addEventListener('click', async () => {
  const btn = document.getElementById('btn-toggle-mouse-lock');
  try {
    if (!isMouseLocked) {
      const res = await fetch('/api/mouse/lock', { method: 'POST' });
      const result = await res.json();
      if (result.success) {
        isMouseLocked = true;
        btn.textContent = '🔓 Release Mouse Lock';
        btn.classList.add('active');
        showToast(result.message);
      } else {
        showToast(`Failed: ${result.message}`);
      }
    } else {
      const res = await fetch('/api/mouse/unlock', { method: 'POST' });
      const result = await res.json();
      if (result.success) {
        isMouseLocked = false;
        btn.textContent = '🔒 Lock Mouse to Main Screen';
        btn.classList.remove('active');
        showToast(result.message);
      } else {
        showToast(`Failed: ${result.message}`);
      }
    }
  } catch (err) {
    showToast(`Error: ${err.message}`);
  }
});

// Test Connection Helper
async function testService(provider, payload, feedbackEl, btnEl) {
  feedbackEl.textContent = 'Testing connection...';
  feedbackEl.className = 'test-feedback loading';
  btnEl.disabled = true;

  try {
    const res = await fetch(`/api/test/${provider}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await res.json();

    if (result.success) {
      feedbackEl.textContent = `✓ ${result.message}`;
      feedbackEl.className = 'test-feedback success';
    } else {
      feedbackEl.textContent = `✗ ${result.message}`;
      feedbackEl.className = 'test-feedback error';
    }
  } catch (err) {
    feedbackEl.textContent = `✗ Network error: ${err.message}`;
    feedbackEl.className = 'test-feedback error';
  } finally {
    btnEl.disabled = false;
  }
}

// Service Test Buttons
document.getElementById('btn-test-gitlab').addEventListener('click', () => {
  const baseUrl = document.getElementById('gl-url').value.trim();
  const token = document.getElementById('gl-token').value.trim();
  testService('gitlab', { baseUrl, token }, document.getElementById('gl-test-feedback'), document.getElementById('btn-test-gitlab'));
});

document.getElementById('btn-test-litellm').addEventListener('click', () => {
  const baseUrl = document.getElementById('llm-url').value.trim();
  const masterKey = document.getElementById('llm-key').value.trim();
  const userId = document.getElementById('llm-user-id').value.trim();
  testService('litellm', { baseUrl, masterKey, userId }, document.getElementById('llm-test-feedback'), document.getElementById('btn-test-litellm'));
});

document.getElementById('btn-test-slack').addEventListener('click', () => {
  const token = document.getElementById('slack-token').value.trim();
  testService('slack', { botToken: token }, document.getElementById('slack-test-feedback'), document.getElementById('btn-test-slack'));
});

document.getElementById('btn-test-email').addEventListener('click', () => {
  const host = document.getElementById('email-host').value.trim();
  const port = parseInt(document.getElementById('email-port').value, 10);
  const user = document.getElementById('email-user').value.trim();
  const password = document.getElementById('email-password').value;
  testService('email', { host, port, user, password }, document.getElementById('email-test-feedback'), document.getElementById('btn-test-email'));
});

document.getElementById('btn-test-calendar').addEventListener('click', () => {
  const corporateUrl = document.getElementById('calendar-corporate-url').value.trim();
  const personalUrl = document.getElementById('calendar-personal-url').value.trim();
  testService('calendar', { corporateUrl, personalUrl }, document.getElementById('calendar-test-feedback'), document.getElementById('btn-test-calendar'));
});

// Demo Mode Toggle
document.getElementById('mock-mode-toggle').addEventListener('change', async (e) => {
  const mockMode = e.target.checked;
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mockMode }),
    });
    showToast(mockMode ? 'Switched to Demo Mock Mode' : 'Switched to Live API Mode');
  } catch (err) {
    showToast(`Error: ${err.message}`);
  }
});

// Save All Changes
document.getElementById('btn-save-all').addEventListener('click', async () => {
  const btn = document.getElementById('btn-save-all');
  btn.disabled = true;

  const payload = {
    mockMode: document.getElementById('mock-mode-toggle').checked,
    gitlab: {
      enabled: document.getElementById('gl-enabled').checked,
      baseUrl: document.getElementById('gl-url').value.trim(),
    },
    litellm: {
      enabled: document.getElementById('llm-enabled').checked,
      baseUrl: document.getElementById('llm-url').value.trim(),
      dailyBudgetLimit: parseFloat(document.getElementById('llm-budget').value) || 20,
      userId: document.getElementById('llm-user-id').value.trim(),
    },
    slack: {
      enabled: document.getElementById('slack-enabled').checked,
      trackedChannels: document.getElementById('slack-tracked-channels').value.split(',').map(name => name.trim()).filter(Boolean),
    },
    email: {
      enabled: document.getElementById('email-enabled').checked,
      host: document.getElementById('email-host').value.trim(),
      port: parseInt(document.getElementById('email-port').value, 10) || 993,
      user: document.getElementById('email-user').value.trim(),
    },
    calendar: {
      enabled: document.getElementById('calendar-enabled').checked,
    },
  };

  // Sparse patch: only send password/tokens if user typed something new so existing
  // credentials are retained by the server rather than overwritten with blank values.
  const glToken = document.getElementById('gl-token').value.trim();
  if (glToken) payload.gitlab.token = glToken;

  const llmKey = document.getElementById('llm-key').value.trim();
  if (llmKey) payload.litellm.masterKey = llmKey;

  const slackToken = document.getElementById('slack-token').value.trim();
  if (slackToken) payload.slack.botToken = slackToken;

  const emailPw = document.getElementById('email-password').value;
  if (emailPw) payload.email.password = emailPw;

  // Tri-state calendar feed updates: blank input preserves existing stored URL,
  // new text updates it, and checking the explicit 'clear' box deletes it.
  for (const [field, inputId, clearId] of [
    ['corporateUrl', 'calendar-corporate-url', 'calendar-clear-corporate'],
    ['personalUrl', 'calendar-personal-url', 'calendar-clear-personal'],
  ]) {
    const url = document.getElementById(inputId).value.trim();
    if (url || document.getElementById(clearId).checked) payload.calendar[field] = url;
  }

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.success) {
      showToast('✓ Configuration saved and applied successfully!');
      loadConfig(); // Refresh statuses
    } else {
      showToast('Error saving configuration');
    }
  } catch (err) {
    showToast(`Save error: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

// Initialize
loadConfig();
loadMonitors();
