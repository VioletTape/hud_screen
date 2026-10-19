import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR, getConfig } from '../config.js';
import { ProviderResult } from '../../shared/types.js';
import { IProvider } from './base.js';
import { distance, findJourneys, parseTimetable, runningTrips, warsawCivilTime, warsawDate,
  type RunningTrip, type Timetable } from './transit-timetable.js';

const CATALOGUE = 'https://open-data.cui.wroclaw.pl/hdb/ft/6/';
const POSITIONS = 'https://open-data.cui.wroclaw.pl/hdb/db/14?download=json';
const CACHE_FILE = path.join(CONFIG_DIR, 'transit-gtfs.zip');
const DAY = 86400_000;

async function request(url: string, limit: number): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  if (!response.ok || !response.body) throw new Error(`Transit source returned HTTP ${response.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Transit response exceeded size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// City timestamps without an offset are civil time in Warsaw, not the host TZ.
function positionTime(value: string): number {
  if (/[zZ]$|[+-]\d\d:\d\d$/.test(value)) return Date.parse(value);
  return warsawCivilTime(value);
}

// GPS is an estimate, not an operator prediction. Match brigade + line and
// project onto stop-to-stop segments; ambiguous trips and old fixes stay scheduled.
export function applyGps(running: RunningTrip[], records: Record<string, unknown>[], now: number): number {
  let matched = 0;
  const seen = new Set<string>();
  for (const row of records) {
    const line = String(row.Nazwa_Linii || '');
    const brigadeText = String(row.Brygada || '');
    if (!/^\d{5}$/.test(brigadeText) || Number(brigadeText.slice(0, 3)) !== Number(line)) continue;
    const brigade = Number(brigadeText.slice(3));
    const updated = positionTime(String(row.Data_Aktualizacji || ''));
    if (!Number.isFinite(updated) || now - updated > 90_000 || updated > now + 10_000) continue;
    const point = { lat: Number(row.Ostatnia_Pozycja_Szerokosc), lon: Number(row.Ostatnia_Pozycja_Dlugosc) };
    if (!(point.lat > 51 && point.lat < 51.3 && point.lon > 16.8 && point.lon < 17.3)) continue;
    const key = `${line}:${brigade}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const candidates: { run: RunningTrip; distance: number; delay: number }[] = [];
    for (const run of running) {
      if (run.trip.line !== line || run.trip.brigade !== brigade) continue;
      let best: { run: RunningTrip; distance: number; delay: number } | undefined;
      for (let i = 1; i < run.trip.calls.length; i++) {
        const from = run.trip.calls[i - 1];
        const to = run.trip.calls[i];
        const dx = (to.stop.lon - from.stop.lon) * 69_900;
        const dy = (to.stop.lat - from.stop.lat) * 111_320;
        const lengthSquared = dx * dx + dy * dy;
        if (lengthSquared < 2500) continue;
        const fraction = ((point.lon - from.stop.lon) * 69_900 * dx + (point.lat - from.stop.lat) * 111_320 * dy) / lengthSquared;
        // Dwell time at a stop or terminus cannot be inferred from one fix.
        if (fraction <= 0.05 || fraction >= 0.95) continue;
        const projection = { lat: from.stop.lat + (to.stop.lat - from.stop.lat) * fraction,
          lon: from.stop.lon + (to.stop.lon - from.stop.lon) * fraction };
        const gap = distance(point, projection);
        const scheduled = run.base + (from.departure + (to.arrival - from.departure) * fraction) * 1000;
        const delay = updated - scheduled;
        if (gap > 100 || delay < -120_000 || delay > 20 * 60_000) continue;
        if (!best || gap < best.distance) best = { run, distance: gap, delay };
      }
      if (best) candidates.push(best);
    }
    candidates.sort((a, b) => a.distance - b.distance);
    const best = candidates[0];
    if (!best || (candidates[1] && candidates[1].distance - best.distance < 40)) continue;
    best.run.delay = Math.round(best.delay / 1000) * 1000;
    best.run.live = true;
    matched++;
  }
  return matched;
}

export class TransitProvider implements IProvider {
  name = 'transit';
  displayName = 'Kolista trams';
  private table?: Timetable;
  private tableFetchedAt = 0;
  private tableFlight?: Promise<Timetable>;
  private positionFlight?: Promise<Record<string, unknown>[]>;
  private positions: Record<string, unknown>[] = [];
  private positionsFetchedAt = 0;
  private catalogueCheckedAt = 0;
  private feedUrl = '';
  private timetableWarning = '';

  isEnabled() { return true; }

  private async timetable(): Promise<Timetable> {
    if (this.table && Date.now() - this.catalogueCheckedAt < 3600_000) return this.table;
    if (this.tableFlight) return this.tableFlight;
    this.tableFlight = this.loadTimetable().finally(() => { this.tableFlight = undefined; });
    return this.tableFlight;
  }

  private async loadTimetable(): Promise<Timetable> {
    try {
      const html = new TextDecoder().decode(await request(CATALOGUE, 2_000_000));
      const today = warsawDate(Date.now()).replaceAll('-', '');
      const feeds = [...html.matchAll(/GTFS_(\d{2})(\d{2})(\d{4})[\s\S]*?href="(\/hdb\/download\/\d+\/)"/g)]
        .map(match => ({ date: `${match[3]}${match[2]}${match[1]}`, url: new URL(match[4], CATALOGUE).href }))
        .filter(feed => feed.date <= today).sort((a, b) => b.date.localeCompare(a.date));
      if (!feeds.length) throw new Error('No current timetable found on the city portal');
      if (feeds[0].url !== this.feedUrl || !this.table) {
        const bytes = await request(feeds[0].url, 30_000_000);
        const table = parseTimetable(bytes);
        this.table = table;
        this.feedUrl = feeds[0].url;
        this.tableFetchedAt = Date.now();
        // Cache writes are optional; a read-only installation can still use live data.
        await fs.mkdir(CONFIG_DIR, { recursive: true })
          .then(() => fs.writeFile(`${CACHE_FILE}.tmp`, bytes))
          .then(() => fs.rename(`${CACHE_FILE}.tmp`, CACHE_FILE)).catch(() => {});
      }
      this.catalogueCheckedAt = Date.now();
      this.tableFetchedAt = Date.now();
      this.timetableWarning = '';
      return this.table!;
    } catch (error) {
      if (!this.table) {
        try {
          const stat = await fs.stat(CACHE_FILE);
          if (Date.now() - stat.mtimeMs < DAY) {
            this.table = parseTimetable(await fs.readFile(CACHE_FILE));
            this.tableFetchedAt = stat.mtimeMs;
          }
        } catch { /* Report the source failure below if no usable cache exists. */ }
      }
      if (!this.table || Date.now() - this.tableFetchedAt > DAY) throw error;
      this.timetableWarning = 'City portal unavailable · cached timetable';
      this.catalogueCheckedAt = Date.now() - 3600_000 + 60_000;
      return this.table;
    }
  }

  private async gps(): Promise<Record<string, unknown>[]> {
    if (Date.now() - this.positionsFetchedAt < 20_000) return this.positions;
    if (this.positionFlight) return this.positionFlight;
    this.positionFlight = (async () => {
      try {
        const payload = JSON.parse(new TextDecoder().decode(await request(POSITIONS, 5_000_000)));
        this.positions = Array.isArray(payload.dane) ? payload.dane : [];
      } catch { this.positions = []; }
      this.positionsFetchedAt = Date.now();
      return this.positions;
    })().finally(() => { this.positionFlight = undefined; });
    return this.positionFlight;
  }

  async testConnection() {
    try { await this.timetable(); return { success: true, message: 'Official Wrocław timetable available' }; }
    catch { return { success: false, message: 'Wrocław timetable unavailable' }; }
  }

  async fetchData(destinationId: string = getConfig().transit.destinations[0]?.id): Promise<ProviderResult> {
    const destination = getConfig().transit.destinations.find(item => item.id === destinationId);
    if (!destination) throw new TypeError('Unknown transit destination');
    const [table, records] = await Promise.all([this.timetable(), this.gps()]);
    const now = Date.now();
    const date = warsawDate(now).replaceAll('-', '');
    if (!table.calendar.some(row => row.start_date <= date && row.end_date >= date) &&
        !table.exceptions.some(row => row.date === date && row.exception_type === '1')) {
      throw new Error('The available timetable does not cover today');
    }
    const running = runningTrips(table, now);
    applyGps(running, records, now);
    let journeys = findJourneys(running, destination.name, now, 3, destination.directOnly);
    if (journeys.length < 3) {
      const extended = runningTrips(table, now, 26);
      applyGps(extended, records, now);
      journeys = findJourneys(extended, destination.name, now, 24, destination.directOnly);
    }
    const hasGps = journeys.some(journey => journey.timing === 'gps');
    return {
      source: this.name, displayName: this.displayName, status: this.timetableWarning ? 'warning' : 'healthy',
      statusMessage: this.timetableWarning || (hasGps ? 'GPS estimates · 10 min walk' : 'Timetable only · live estimates unavailable'),
      lastUpdated: new Date(now).toISOString(), metrics: [], notifications: [],
      details: { destination, journeys, walkMinutes: 10, expiresAt: new Date(now + 90_000).toISOString() },
    };
  }
}
