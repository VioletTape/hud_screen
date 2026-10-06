import ical, { type VEvent } from 'node-ical';
import { AppConfig, ProviderResult } from '../../shared/types.js';
import { getConfig } from '../config.js';
import { IProvider } from './base.js';

type CalendarSource = 'corporate' | 'personal';
type Meeting = { id: string; title: string; startAt: string; allDay: boolean; source: CalendarSource };
type CachedFeed = { url: string; refreshedAt: number; events: VEvent[] };

const MAX_FEED_BYTES = 5_000_000;
// ponytail: fixed 15-minute fetch cache; expose it in Settings if observed feed latency warrants tuning.
const FEED_CACHE_MS = 15 * 60_000;
const feedCache = new Map<CalendarSource, CachedFeed>();

function text(value: VEvent['summary'] | undefined): string {
  if (typeof value === 'string') return value;
  return value?.val || '';
}

function eventMeetings(event: VEvent, now: Date, source: CalendarSource): Meeting[] {
  if (event.status === 'CANCELLED' || !event.start) return [];

  const makeMeeting = (start: Date, title: string, allDay: boolean, uid: string) => ({
    id: `${source}:${uid}:${start.toISOString()}`,
    title: title || 'Untitled meeting',
    startAt: start.toISOString(),
    allDay,
    source,
  });

  if (!event.rrule) {
    return event.start >= now
      ? [makeMeeting(event.start, text(event.summary), event.datetype === 'date', event.uid)]
      : [];
  }

  const meetings: Meeting[] = [];
  const exceptionCount = Object.keys(event.exdate || {}).length + Object.keys(event.recurrences || {}).length;
  // ponytail: node-ical 0.25's after() calls a removed rrule-temporal method; use its next() until the wrapper is fixed.
  const rule = event.rrule as unknown as {
    _rrule: { next(after: Date, inclusive: boolean): { epochMilliseconds: number } | null };
  };
  let cursor = new Date(now.getTime() - 1);
  let attempts = 0;

  while (meetings.length < 2 && attempts <= exceptionCount + 2) {
    const next = rule._rrule.next(cursor, false);
    if (!next) break;
    const occurrence = new Date(next.epochMilliseconds);
    cursor = occurrence;
    attempts++;
    const instances = ical.expandRecurringEvent(event, {
      from: new Date(occurrence.getTime() - 1),
      to: new Date(occurrence.getTime() + 1),
    });
    for (const instance of instances) {
      if (instance.start >= now) {
        meetings.push(makeMeeting(instance.start, text(instance.summary), instance.isFullDay, event.uid));
      }
    }
  }

  for (const override of Object.values(event.recurrences || {}) as VEvent[]) {
    if (override.status !== 'CANCELLED' && override.start && override.start >= now) {
      meetings.push(makeMeeting(override.start, text(override.summary), override.datetype === 'date', event.uid));
    }
  }

  return meetings;
}

async function readFeed(url: string): Promise<VEvent[]> {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password || !parsedUrl.pathname.toLowerCase().endsWith('.ics')) {
    throw new Error('Use the HTTPS calendar.ics link from Outlook.');
  }

  const response = await fetch(parsedUrl, { headers: { Accept: 'text/calendar' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Outlook returned HTTP ${response.status}.`);
  if (Number(response.headers.get('content-length')) > MAX_FEED_BYTES) throw new Error('Calendar feed exceeds 5 MB.');
  const body = await response.text();
  if (body.length > MAX_FEED_BYTES) throw new Error('Calendar feed exceeds 5 MB.');
  if (!body.includes('BEGIN:VCALENDAR')) throw new Error('The link did not return an iCalendar feed.');

  const parsed = await ical.async.parseICS(body);
  return Object.values(parsed)
    .filter((event): event is VEvent => event?.type === 'VEVENT');
}

export class CalendarProvider implements IProvider {
  name = 'calendar';
  displayName = 'Upcoming Meetings';

  isEnabled(): boolean {
    return getConfig().calendar.enabled;
  }

  private sources(config: AppConfig['calendar']) {
    return ([
      ['corporate', config.corporateUrl],
      ['personal', config.personalUrl],
    ] as const).filter((entry): entry is readonly [CalendarSource, string] => Boolean(entry[1]));
  }

  async testConnection(customConfig?: Partial<AppConfig['calendar']>): Promise<{ success: boolean; message: string }> {
    const saved = getConfig().calendar;
    const config = {
      ...saved,
      ...customConfig,
      corporateUrl: customConfig?.corporateUrl || saved.corporateUrl,
      personalUrl: customConfig?.personalUrl || saved.personalUrl,
    };
    const sources = this.sources(config);
    if (!sources.length) return { success: false, message: 'Add at least one Outlook ICS link.' };

    const results = await Promise.all(sources.map(async ([source, url]) => {
      try {
        await readFeed(url);
        return `${source === 'corporate' ? 'Corporate' : 'Personal'}: connected`;
      } catch (err) {
        const message = err instanceof Error && err.message.startsWith('Use the HTTPS')
          ? err.message
          : `${source === 'corporate' ? 'Corporate' : 'Personal'}: could not read feed`;
        return message;
      }
    }));

    return { success: results.every(result => result.endsWith('connected')), message: results.join('; ') };
  }

  async fetchData(): Promise<ProviderResult> {
    const config = getConfig().calendar;
    const fetchedAt = new Date().toISOString();
    const empty = (status: ProviderResult['status'], statusMessage: string): ProviderResult => ({
      source: this.name,
      displayName: this.displayName,
      status,
      statusMessage,
      lastUpdated: fetchedAt,
      metrics: [],
      notifications: [],
      details: { meetings: [] },
    });

    if (!config.enabled) return empty('disabled', 'Disabled');
    const sources = this.sources(config);
    if (!sources.length) return empty('disabled', 'Add Outlook ICS links in Settings');

    const nowMs = Date.now();
    const results = await Promise.all(sources.map(async ([source, url]) => {
      const cached = feedCache.get(source);
      if (cached?.url === url && nowMs - cached.refreshedAt < FEED_CACHE_MS) {
        return { events: cached.events, source };
      }
      try {
        const events = await readFeed(url);
        feedCache.set(source, { url, refreshedAt: nowMs, events });
        return { events, source };
      } catch {
        return {
          events: cached?.url === url ? cached.events : [],
          source,
          error: source === 'corporate' ? 'Corporate feed unavailable' : 'Personal feed unavailable',
        };
      }
    }));

    const now = new Date(nowMs);
    let eventErrors = 0;
    const meetings = results.flatMap(result => result.events.flatMap(event => {
      try {
        return eventMeetings(event, now, result.source);
      } catch {
        eventErrors++;
        return [];
      }
    }))
      .filter((meeting, index, all) => index === all.findIndex(other => other.id === meeting.id))
      .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))
      .slice(0, 2);
    const errors: string[] = results.flatMap(result => 'error' in result ? [result.error] : [])
      .filter((error): error is string => Boolean(error));
    const failedCount = errors.length;
    if (eventErrors) errors.push('Some events could not be expanded');
    const status = failedCount === sources.length ? 'error' : errors.length ? 'warning' : 'healthy';
    const statusMessage = errors.join('; ') || (meetings.length ? `${meetings.length} upcoming meetings` : 'No upcoming meetings');

    return {
      source: this.name,
      displayName: this.displayName,
      status,
      statusMessage,
      lastUpdated: fetchedAt,
      metrics: [],
      notifications: [],
      details: { meetings },
    };
  }
}
