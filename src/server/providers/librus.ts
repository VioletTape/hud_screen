import { LibrusSession } from 'librus-sdk';
import { LibrusConfig, ProviderResult, SchoolDay } from '../../shared/types.js';
import { getConfig } from '../config.js';
import { IProvider } from './base.js';
import { summarizeWeek, timetableWeeks } from './librus-timetable.js';

async function readTimetable(config: LibrusConfig, weeks: string[]): Promise<SchoolDay[]> {
  if (typeof config.login !== 'string' || !config.login.trim() || typeof config.password !== 'string' || !config.password) {
    throw new TypeError('Enter the school-issued Synergia login and password.');
  }
  const session = LibrusSession.fromGatewayCredentials({ login: config.login.trim(), password: config.password }, { requestTimeoutMs: 15_000 });
  const client = await session.forChild();
  const days: SchoolDay[] = [];
  for (const week of weeks) days.push(...summarizeWeek(week, await client.getTimetableWeek(week)));
  return days;
}

export class LibrusProvider implements IProvider {
  name = 'librus';
  displayName = 'School timetable';
  private cache?: { login: string; password: string; weeks: string; refreshedAt: number; days: SchoolDay[]; refreshFailed?: boolean };
  private pending?: { login: string; password: string; weeks: string; promise: Promise<SchoolDay[]> };

  isEnabled(): boolean {
    return getConfig().librus.enabled;
  }

  async testConnection(customConfig?: Partial<LibrusConfig>): Promise<{ success: boolean; message: string }> {
    const saved = getConfig().librus;
    const config = { ...saved, ...customConfig, password: customConfig?.password || saved.password };
    try {
      await readTimetable(config, timetableWeeks(new Date()).slice(0, 1));
      return { success: true, message: 'Connected to Synergia; timetable available.' };
    } catch (error) {
      return { success: false, message: error instanceof TypeError ? 'Enter the school-issued Synergia login and password.' : 'Could not read the Librus timetable. Check credentials and try again.' };
    }
  }

  async fetchData(forceRefresh = false): Promise<ProviderResult> {
    const config = getConfig().librus;
    const result: ProviderResult = {
      source: this.name, displayName: this.displayName, status: 'disabled',
      lastUpdated: new Date().toISOString(), metrics: [], notifications: [], details: { days: [] },
    };
    if (!config.enabled) {
      this.cache = undefined;
      return result;
    }
    if (!config.login.trim() || !config.password) return { ...result, status: 'warning', statusMessage: 'Add Synergia credentials in Settings' };
    const weeks = timetableWeeks(new Date());
    const cache = this.cache;
    const matchingCache = cache?.login === config.login && cache.password === config.password && cache.weeks === weeks.join(',') ? cache : undefined;
    try {
      if (!matchingCache || forceRefresh || Date.now() - matchingCache.refreshedAt >= 24 * 60 * 60_000) {
        let pending = this.pending;
        if (!pending || pending.login !== config.login || pending.password !== config.password || pending.weeks !== weeks.join(',')) {
          pending = { login: config.login, password: config.password, weeks: weeks.join(','), promise: readTimetable(config, weeks) };
          this.pending = pending;
        }
        let days: SchoolDay[];
        try {
          days = await pending.promise;
        } finally {
          if (this.pending === pending) this.pending = undefined;
        }
        this.cache = { login: config.login, password: config.password, weeks: weeks.join(','), refreshedAt: Date.now(), days };
      }
      return {
        ...result, status: this.cache!.refreshFailed ? 'warning' : 'healthy',
        statusMessage: this.cache!.refreshFailed ? 'Refresh failed · showing last fetched timetable' : undefined,
        lastUpdated: new Date(this.cache!.refreshedAt).toISOString(), details: { days: this.cache!.days },
      };
    } catch {
      if (matchingCache) {
        matchingCache.refreshFailed = true;
        return {
          ...result, status: 'warning', statusMessage: 'Refresh failed · showing last fetched timetable',
          lastUpdated: new Date(matchingCache.refreshedAt).toISOString(), details: { days: matchingCache.days },
        };
      }
      return { ...result, status: 'error', statusMessage: 'Librus timetable unavailable. Check credentials in Settings.' };
    }
  }
}
