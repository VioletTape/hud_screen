(() => {
  const storageKey = 'hud-timer-deadline';
  const collapsedStorageKey = 'hud-timer-collapsed';
  const card = document.getElementById('card-timer');
  const toggle = document.getElementById('timer-toggle');
  const content = document.getElementById('timer-content');
  const controls = document.getElementById('timer-controls');
  const countdown = document.getElementById('timer-countdown');
  const time = document.getElementById('timer-time');
  const announcement = document.getElementById('timer-announcement');
  const form = document.getElementById('timer-custom');
  const input = document.getElementById('timer-minutes');
  let deadline = null;
  let interval = null;

  function setCollapsed(collapsed) {
    content.hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Expand timer' : 'Collapse timer');
  }

  toggle.addEventListener('click', () => {
    setCollapsed(!content.hidden);
    try {
      localStorage.setItem(collapsedStorageKey, String(content.hidden));
    } catch {
      // Collapsing still works when browser storage is unavailable.
    }
  });

  function render() {
    const active = deadline !== null;
    controls.hidden = active;
    countdown.hidden = !active;
    if (!active) {
      delete card.dataset.status;
      announcement.textContent = '';
      return;
    }

    // Use a deadline so background throttling or sleep cannot slow the countdown.
    const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    time.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    card.dataset.status = seconds === 0 ? 'warning' : 'healthy';
    if (seconds === 0) {
      clearInterval(interval);
      interval = null;
      announcement.textContent = 'Timer finished.';
    }
  }

  function setDeadline(value) {
    clearInterval(interval);
    interval = null;
    deadline = value;
    announcement.textContent = '';
    render();
    if (deadline !== null && deadline > Date.now()) {
      interval = setInterval(render, 250);
    }
  }

  function saveDeadline(value) {
    setDeadline(value);
    try {
      if (value === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, String(value));
    } catch {
      // The timer still works when browser storage is unavailable.
    }
  }

  function parseDeadline(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }

  card.querySelectorAll('[data-minutes]').forEach(button => {
    button.addEventListener('click', () => {
      saveDeadline(Date.now() + Number(button.dataset.minutes) * 60000);
      countdown.focus();
    });
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const minutes = Number(input.value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 999) return;
    saveDeadline(Date.now() + minutes * 60000);
    countdown.focus();
  });

  countdown.addEventListener('click', () => {
    saveDeadline(null);
    card.querySelector('[data-minutes]').focus();
  });

  // Keep same-origin previews/tabs in sync and restore after a page reload.
  window.addEventListener('storage', event => {
    if (event.key === collapsedStorageKey || event.key === null) {
      setCollapsed(event.newValue === 'true');
    }
    if (event.key === storageKey || event.key === null) {
      setDeadline(parseDeadline(event.newValue));
    }
  });
  document.addEventListener('visibilitychange', render);
  try {
    setCollapsed(localStorage.getItem(collapsedStorageKey) === 'true');
    setDeadline(parseDeadline(localStorage.getItem(storageKey)));
  } catch {
    render();
  }
})();
