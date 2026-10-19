(() => {
  const card = document.getElementById('card-transit');
  const panel = document.getElementById('transit-online');
  const status = document.getElementById('transit-status');
  const list = document.getElementById('transit-departures');
  const destinations = card.querySelector('.transit-destinations');
  let destinationConfig = null;
  const clock = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' });
  let selected = null;
  let requestController;
  let refreshTimer;
  let tickTimer;
  let data;
  let requestFailed = false;
  let generation = 0;

  const time = value => clock.format(new Date(value));
  const day = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date(value));
  const departureTime = value => `${day(value) !== day(Date.now()) ? 'Tomorrow ' : ''}${time(value)}`;
  const countdown = value => {
    const seconds = Math.max(0, Math.floor((Date.parse(value) - Date.now()) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };

  function render() {
    if (!selected || !data) return;
    if (Date.now() >= Date.parse(data.details.expiresAt)) {
      list.replaceChildren();
      status.textContent = 'Data out of date · refreshing…';
      card.dataset.status = 'warning';
      return;
    }
    const journeys = data.details.journeys.filter(journey => Date.parse(journey.leaveAt) >= Date.now());
    status.textContent = `${requestFailed ? 'Refresh failed · ' : ''}${data.statusMessage}`;
    card.dataset.status = requestFailed ? 'warning' : data.status;
    list.innerHTML = journeys.length ? journeys.map(journey => `
      <div class="transit-journey">
        <span class="transit-line">${escapeHtml(journey.line)}</span>
        <div class="transit-route">
          <div>${departureTime(journey.departureAt)} <span class="transit-timing">${journey.timing === 'gps' ? '≈ GPS' : 'scheduled'}</span></div>
          <div class="transit-arrival" aria-label="Arrival ${time(journey.arrivalAt)}">${time(journey.arrivalAt)}</div>
        </div>
        <div class="transit-leave"><span>${Date.parse(journey.leaveAt) - Date.now() < 60_000 ? 'Leave now' : 'Leave in'}</span><strong role="timer" aria-live="off">${countdown(journey.leaveAt)}</strong></div>
      </div>`).join('') : '<div class="transit-empty">No reachable trams in the next 24 hours.</div>';
    // After the walk deadline passes, immediately replace that tram with the next
    // reachable departure, without overlapping an in-flight refresh.
    if (journeys.length < data.details.journeys.length && !requestController) {
      data.details.journeys = journeys;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 0);
    }
  }

  async function refresh() {
    if (!selected || requestController) return;
    const version = generation;
    const controller = new AbortController();
    requestController = controller;
    const timeout = setTimeout(() => controller.abort(), 65_000);
    try {
      const response = await fetch(`/api/transit/${encodeURIComponent(selected)}`, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('Transit unavailable');
      const result = await response.json();
      if (generation !== version) return;
      data = result;
      requestFailed = false;
      render();
    } catch {
      if (generation !== version) return;
      requestFailed = true;
      if (data) render();
      else { status.textContent = 'Transit unavailable · retrying…'; card.dataset.status = 'error'; }
    } finally {
      clearTimeout(timeout);
      if (generation === version) {
        requestController = undefined;
        refreshTimer = setTimeout(refresh, 30_000);
      }
    }
  }

  function select(destination) {
    generation++;
    requestController?.abort();
    requestController = undefined;
    clearTimeout(refreshTimer);
    clearInterval(tickTimer);
    selected = destination;
    data = null;
    requestFailed = false;
    panel.hidden = !destination;
    card.dataset.mode = destination ? 'online' : 'offline';
    delete card.dataset.status;
    list.replaceChildren();
    destinations.querySelectorAll('[data-destination]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.destination === destination)));
    if (destination) {
      status.textContent = 'Loading Kolista departures…';
      tickTimer = setInterval(render, 1000);
      void refresh();
    }
  }

  function updateDestinations(items) {
    if (JSON.stringify(items) === JSON.stringify(destinationConfig)) return;
    const previousSelection = destinationConfig?.find(item => item.id === selected);
    destinationConfig = items;
    destinations.replaceChildren(...items.map(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.destination = item.id;
      button.title = item.name;
      button.setAttribute('aria-label', item.name);
      button.setAttribute('aria-pressed', String(item.id === selected));
      const icon = document.createElement('span');
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = item.glyph;
      button.append(icon);
      return button;
    }));
    card.classList.toggle('hidden', items.length === 0);
    if (selected) {
      const updatedSelection = items.find(item => item.id === selected);
      if (!updatedSelection) select(null);
      else if (JSON.stringify(previousSelection) !== JSON.stringify(updatedSelection)) select(selected);
    }
  }

  window.addEventListener('hud:transit-destinations', event => updateDestinations(event.detail));
  destinations.addEventListener('click', event => {
    const button = event.target.closest('[data-destination]');
    if (button) select(button.dataset.destination);
  });
  document.getElementById('transit-offline').addEventListener('click', () => select(null));
  window.addEventListener('pagehide', () => select(null));
})();
