import { unzipSync } from 'fflate';

type Row = Record<string, string>;
export type Stop = { id: string; code: string; name: string; lat: number; lon: number };
export type Call = { stop: Stop; arrival: number; departure: number; sequence: number; pickup: boolean; dropoff: boolean };
export type Trip = { id: string; line: string; service: string; headsign: string; brigade: number; calls: Call[] };
export type Timetable = { trips: Trip[]; calendar: Row[]; exceptions: Row[] };
export type RunningTrip = { trip: Trip; base: number; delay: number; live: boolean };
export type Journey = {
  id: string; line: string; headsign: string; platform: string;
  departureAt: string; leaveAt: string; arrivalAt: string; timing: 'gps' | 'scheduled';
  transfer?: { stop: string; line: string; headsign: string; departureAt: string };
};

// CSV fields can contain commas, escaped quotes, and newlines (RFC 4180).
export function* csvRows(text: string): Generator<Row> {
  let headers: string[] | undefined;
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (ch === ',' || ch === '\n' || ch === undefined)) {
      fields.push(field.replace(/\r$/, ''));
      field = '';
      if (ch !== ',') {
        if (!headers) headers = fields;
        else if (fields.some(Boolean)) yield Object.fromEntries(headers.map((key, index) => [key, fields[index] || '']));
        fields = [];
      }
    } else field += ch;
  }
}

const seconds = (value: string) => value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
const iso = (value: number) => new Date(value).toISOString();
export const stopName = (name: string) => name.toLocaleLowerCase('pl').trim();

export function parseTimetable(bytes: Uint8Array): Timetable {
  const wanted = new Set(['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt', 'calendar.txt', 'calendar_dates.txt']);
  const files = unzipSync(bytes, { filter: file => wanted.has(file.name) && file.originalSize < 200_000_000 });
  const rows = (name: string) => {
    if (!files[name]) throw new Error(`Timetable is missing ${name}`);
    return csvRows(new TextDecoder().decode(files[name]));
  };
  const stops = new Map<string, Stop>();
  for (const row of rows('stops.txt')) stops.set(row.stop_id, {
    id: row.stop_id, code: row.stop_code, name: row.stop_name, lat: Number(row.stop_lat), lon: Number(row.stop_lon),
  });
  const routes = new Map<string, string>();
  for (const row of rows('routes.txt')) if (row.route_type === '0') routes.set(row.route_id, row.route_short_name);
  const trips = new Map<string, Trip>();
  for (const row of rows('trips.txt')) {
    const line = routes.get(row.route_id);
    if (line) trips.set(row.trip_id, { id: row.trip_id, line, service: row.service_id,
      headsign: row.trip_headsign, brigade: Number(row.brigade_id), calls: [] });
  }
  for (const row of rows('stop_times.txt')) {
    const trip = trips.get(row.trip_id);
    const stop = stops.get(row.stop_id);
    if (trip && stop && row.arrival_time && row.departure_time) trip.calls.push({
      stop, arrival: seconds(row.arrival_time), departure: seconds(row.departure_time), sequence: Number(row.stop_sequence),
      pickup: row.pickup_type !== '1', dropoff: row.drop_off_type !== '1',
    });
  }
  for (const trip of trips.values()) trip.calls.sort((a, b) => a.sequence - b.sequence);
  return { trips: [...trips.values()].filter(trip => trip.calls.length > 1),
    calendar: [...rows('calendar.txt')], exceptions: files['calendar_dates.txt'] ? [...rows('calendar_dates.txt')] : [] };
}

const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' });
export function warsawDate(now: number): string { return dateFormat.format(new Date(now)); }

// Interpret an offsetless city timestamp independently of the host timezone.
export function warsawCivilTime(value: string): number {
  const target = Math.floor(Date.parse(`${value}Z`) / 1000) * 1000;
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  if (!Number.isFinite(target)) return NaN;
  let guess = Math.floor(target / 1000) * 1000;
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(guess).map(part => [part.type, part.value]));
    const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    guess += target - local;
  }
  return guess;
}

export function serviceMidnight(day: string): number {
  // GTFS defines service time relative to noon minus 12h, to remain monotonic on DST days.
  return warsawCivilTime(`${day}T12:00:00`) - 12 * 3600_000;
}

export function runningTrips(table: Timetable, now: number, lookaheadHours = 4): RunningTrip[] {
  const today = Date.parse(`${warsawDate(now)}T12:00:00Z`);
  const result: RunningTrip[] = [];
  for (const offset of [-1, 0, 1]) {
    const day = new Date(today + offset * 86400_000).toISOString().slice(0, 10);
    const key = day.replaceAll('-', '');
    const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date(`${day}T12:00:00Z`).getUTCDay()];
    const active = new Set(table.calendar.filter(row => row.start_date <= key && row.end_date >= key && row[weekday] === '1').map(row => row.service_id));
    for (const row of table.exceptions) if (row.date === key) {
      if (row.exception_type === '1') active.add(row.service_id);
      else active.delete(row.service_id);
    }
    const base = serviceMidnight(day);
    for (const trip of table.trips) if (active.has(trip.service) &&
      base + trip.calls.at(-1)!.arrival * 1000 >= now - 20 * 60_000 &&
      base + trip.calls[0].departure * 1000 <= now + lookaheadHours * 3600_000) {
      result.push({ trip, base, delay: 0, live: false });
    }
  }
  return result;
}

export function distance(a: Pick<Stop, 'lat' | 'lon'>, b: Pick<Stop, 'lat' | 'lon'>): number {
  return Math.hypot((a.lat - b.lat) * 111_320, (a.lon - b.lon) * 69_900);
}

export function findJourneys(running: RunningTrip[], destination: string, now: number, horizonHours = 3, directOnly = false): Journey[] {
  const walk = 10 * 60_000;
  const horizon = now + horizonHours * 3600_000;
  const preferred = new Set(['12', '21', '18', '19']);
  const arrival = (run: RunningTrip, call: Call) => run.base + call.arrival * 1000 + run.delay;
  const departure = (run: RunningTrip, call: Call) => run.base + call.departure * 1000 + run.delay;
  // Index every tram that reaches the destination, allowing one transfer at the
  // same named stop. Require 3 minutes or the platform walk time, whichever is longer.
  const connections = new Map<string, { run: RunningTrip; board: Call; target: Call }[]>();
  for (const run of directOnly ? [] : running) {
    const targetIndex = run.trip.calls.findIndex(call => stopName(call.stop.name) === stopName(destination) && call.dropoff);
    if (targetIndex < 0) continue;
    const target = run.trip.calls[targetIndex];
    for (const board of run.trip.calls.slice(0, targetIndex)) {
      if (!board.pickup || departure(run, board) < now + walk || departure(run, board) > horizon) continue;
      const key = stopName(board.stop.name);
      const entries = connections.get(key) || [];
      entries.push({ run, board, target });
      connections.set(key, entries);
    }
  }
  const journeys: Journey[] = [];
  for (const run of running) {
    if (!preferred.has(run.trip.line)) continue;
    // Verified city-bound tram platform. Other Kolista platforms include buses
    // and outbound trams; never infer direction solely from the stop name.
    const originIndex = run.trip.calls.findIndex(call => call.stop.code === '12602' && call.pickup);
    if (originIndex < 0) continue;
    const origin = run.trip.calls[originIndex];
    const leaveAt = departure(run, origin) - walk;
    if (leaveAt < now || departure(run, origin) > horizon) continue;
    const onward = run.trip.calls.slice(originIndex + 1).filter(call => call.dropoff);
    const direct = onward.find(call => stopName(call.stop.name) === stopName(destination));
    const journey: Journey = {
      id: `${run.base}:${run.trip.id}`, line: run.trip.line, headsign: run.trip.headsign, platform: origin.stop.code,
      departureAt: iso(departure(run, origin)), leaveAt: iso(leaveAt),
      arrivalAt: '', timing: run.live ? 'gps' : 'scheduled',
    };
    if (direct) journey.arrivalAt = iso(arrival(run, direct));
    // Compare direct and connecting journeys, keeping the earliest arrival for
    // each first tram; a slow transfer must never displace a faster direct ride.
    for (const alight of directOnly ? [] : onward) {
      for (const connection of connections.get(stopName(alight.stop.name)) || []) {
        if (connection.run.trip.id === run.trip.id || connection.run.trip.line === run.trip.line) continue;
        const platformWalk = Math.max(180_000, distance(alight.stop, connection.board.stop) / 1.2 * 1000);
        const gap = departure(connection.run, connection.board) - arrival(run, alight);
        if (gap < platformWalk || gap > 30 * 60_000) continue;
        const end = arrival(connection.run, connection.target);
        if (journey.arrivalAt && end >= Date.parse(journey.arrivalAt)) continue;
        journey.arrivalAt = iso(end);
        journey.transfer = { stop: alight.stop.name, line: connection.run.trip.line,
          headsign: connection.run.trip.headsign, departureAt: iso(departure(connection.run, connection.board)) };
      }
    }
    if (journey.arrivalAt) journeys.push(journey);
  }
  return journeys.sort((a, b) => Date.parse(a.departureAt) - Date.parse(b.departureAt)).slice(0, 3);
}
