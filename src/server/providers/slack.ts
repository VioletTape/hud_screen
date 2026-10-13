import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { IProvider } from './base.js';
import { ProviderResult, MetricItem, NotificationItem } from '../../shared/types.js';
import { CONFIG_DIR, getConfig } from '../config.js';

interface IMState {
  unread: number;
  updated: number;
  user: string;
  isGroup: boolean;
}

const CHANNEL_DISCOVERY_CACHE_MS = 5 * 60 * 1000;
const DM_DISCOVERY_CACHE_MS = 90 * 1000;
const MAX_DMS_PER_POLL = 10;
const HISTORY_RECONCILE_MS = 15 * 60 * 1000;
const DISCOVERY_SNAPSHOT_FILE = path.join(CONFIG_DIR, 'slack-discovery.json');

interface SlackDiscoverySnapshot {
  version: 1;
  teamId: string;
  userId: string;
  dmDiscoveryExpiresAt: number;
  mpimMissingScopeUntil: number;
  imScanCursor: number;
  imListCursor: string;
  mpimListCursor: string;
  imChannels: Array<{ id: string; updated: number; user: string; is_mpim: boolean }>;
  historyCounts: Array<{ channelId: string; lastRead: string; latestMessageTs: string; unread: number; reconciledAt: number }>;
  channelDiscoveryCache: {
    key: string;
    channels: Array<{ id: string; name: string; is_private?: boolean }>;
    expiresAt: number;
    missingGroupsScope: boolean;
  } | null;
}

interface HistoryCountSnapshot {
  lastRead: string;
  latestMessageTs: string;
  unread: number;
  reconciledAt: number;
}

export class SlackProvider implements IProvider {
  name = 'slack';
  displayName = 'Slack';

  private userCache: Map<string, string> = new Map();
  private imStates: Map<string, IMState> = new Map();
  private imChannels: Map<string, any> = new Map();
  private historyCounts: Map<string, HistoryCountSnapshot> = new Map();
  private channelDiscoveryCache: { key: string; channels: any[]; expiresAt: number; missingGroupsScope: boolean } | null = null;
  private imListCursor = '';
  private mpimListCursor = '';
  private imScanCursor = 0;
  private dmDiscoveryExpiresAt = 0;
  private mpimMissingScopeUntil = 0;
  private snapshotLoadedFor = '';
  private snapshotDirty = false;
  private rateLimitedUntil = 0;
  private currentTeamId = '';
  private currentUserId = '';
  private currentUserName = '';

  isEnabled(): boolean {
    const cfg = getConfig().slack;
    return Boolean(cfg.enabled && (cfg.botToken || cfg.userToken));
  }

  private getToken(): string {
    const cfg = getConfig().slack;
    return cfg.userToken || cfg.botToken || '';
  }

  private getHeaders(token: string) {
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    };
  }

  private loadDiscoverySnapshot(): void {
    const accountKey = `${this.currentTeamId}:${this.currentUserId}`;
    if (!this.currentUserId || this.snapshotLoadedFor === accountKey) return;
    this.snapshotLoadedFor = accountKey;
    this.snapshotDirty = false;
    this.userCache.clear();
    this.imStates.clear();
    this.imChannels.clear();
    this.historyCounts.clear();
    this.imListCursor = '';
    this.mpimListCursor = '';
    this.imScanCursor = 0;
    this.dmDiscoveryExpiresAt = 0;
    this.mpimMissingScopeUntil = 0;
    this.channelDiscoveryCache = null;

    try {
      const snapshot = JSON.parse(fs.readFileSync(DISCOVERY_SNAPSHOT_FILE, 'utf8')) as SlackDiscoverySnapshot;
      if (snapshot.version !== 1 || snapshot.teamId !== this.currentTeamId || snapshot.userId !== this.currentUserId) return;

      for (const channel of snapshot.imChannels || []) {
        if (typeof channel.id === 'string' && channel.id) {
          this.imChannels.set(channel.id, {
            id: channel.id,
            updated: Number(channel.updated) || 0,
            user: typeof channel.user === 'string' ? channel.user : '',
            is_mpim: Boolean(channel.is_mpim),
          });
        }
      }
      for (const item of snapshot.historyCounts || []) {
        if (typeof item.channelId === 'string' && typeof item.lastRead === 'string' && typeof item.latestMessageTs === 'string') {
          this.historyCounts.set(item.channelId, {
            lastRead: item.lastRead,
            latestMessageTs: item.latestMessageTs,
            unread: Math.max(0, Number(item.unread) || 0),
            reconciledAt: Number(item.reconciledAt) || 0,
          });
        }
      }
      this.imListCursor = typeof snapshot.imListCursor === 'string' ? snapshot.imListCursor : '';
      this.mpimListCursor = typeof snapshot.mpimListCursor === 'string' ? snapshot.mpimListCursor : '';
      this.imScanCursor = Number(snapshot.imScanCursor) || 0;
      this.dmDiscoveryExpiresAt = Number(snapshot.dmDiscoveryExpiresAt) || 0;
      this.mpimMissingScopeUntil = Number(snapshot.mpimMissingScopeUntil) || 0;

      const cachedChannels = snapshot.channelDiscoveryCache;
      if (cachedChannels && Array.isArray(cachedChannels.channels)) {
        this.channelDiscoveryCache = {
          key: cachedChannels.key,
          channels: cachedChannels.channels.filter(channel => typeof channel.id === 'string' && typeof channel.name === 'string'),
          expiresAt: Number(cachedChannels.expiresAt) || 0,
          missingGroupsScope: Boolean(cachedChannels.missingGroupsScope),
        };
      }
    } catch {
      // Missing or invalid snapshots are rebuilt from Slack.
    }
  }

  private saveDiscoverySnapshot(): void {
    if (!this.snapshotDirty || !this.currentUserId) return;
    const now = Date.now();
    for (const [channelId, count] of this.historyCounts) {
      if (now < count.reconciledAt || now - count.reconciledAt >= HISTORY_RECONCILE_MS) this.historyCounts.delete(channelId);
    }
    const snapshot: SlackDiscoverySnapshot = {
      version: 1,
      teamId: this.currentTeamId,
      userId: this.currentUserId,
      dmDiscoveryExpiresAt: this.dmDiscoveryExpiresAt,
      mpimMissingScopeUntil: this.mpimMissingScopeUntil,
      imScanCursor: this.imScanCursor,
      imListCursor: this.imListCursor,
      mpimListCursor: this.mpimListCursor,
      imChannels: [...this.imChannels.values()].map(channel => ({
        id: channel.id,
        updated: Number(channel.updated) || 0,
        user: channel.user || '',
        is_mpim: Boolean(channel.is_mpim),
      })),
      historyCounts: [...this.historyCounts.entries()].map(([channelId, count]) => ({ channelId, ...count })),
      channelDiscoveryCache: this.channelDiscoveryCache ? {
        key: this.channelDiscoveryCache.key,
        channels: this.channelDiscoveryCache.channels.map(channel => ({
          id: channel.id,
          name: channel.name,
          ...(typeof channel.is_private === 'boolean' ? { is_private: channel.is_private } : {}),
        })),
        expiresAt: this.channelDiscoveryCache.expiresAt,
        missingGroupsScope: this.channelDiscoveryCache.missingGroupsScope,
      } : null,
    };
    const tempFile = path.join(CONFIG_DIR, `.slack-discovery-${randomUUID()}.tmp`);
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(tempFile, JSON.stringify(snapshot), 'utf8');
      fs.renameSync(tempFile, DISCOVERY_SNAPSHOT_FILE);
      this.snapshotDirty = false;
    } catch (err) {
      try { fs.unlinkSync(tempFile); } catch {}
      console.error('[Slack] Could not save discovery snapshot:', err);
    }
  }

  async testConnection(customConfig?: { botToken?: string; userToken?: string }): Promise<{ success: boolean; message: string; details?: any }> {
    const cfg = customConfig || getConfig().slack;
    const token = cfg.userToken || cfg.botToken || '';
    if (!token) {
      return { success: false, message: 'Slack Bot Token (xoxb-...) or User Token (xoxp-...) is required.' };
    }

    try {
      const resp = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: this.getHeaders(token),
        signal: AbortSignal.timeout(8000),
      });

      const data = await resp.json() as any;
      if (!data.ok) {
        return { success: false, message: `Slack authentication error: ${data.error || 'Unknown error'}` };
      }

      this.currentUserId = data.user_id || '';
      this.currentTeamId = data.team_id || '';
      this.currentUserName = data.user || '';

      return {
        success: true,
        message: `Connected to workspace "${data.team}" as @${data.user}`,
        details: { user: data.user, team: data.team, url: data.url },
      };
    } catch (err: any) {
      return { success: false, message: `Slack connection error: ${err.message || String(err)}` };
    }
  }

  private async resolveUserName(userId: string, request: (url: string, timeout: number) => Promise<any>): Promise<string> {
    if (!userId) return 'Unknown';
    if (this.userCache.has(userId)) {
      return this.userCache.get(userId)!;
    }

    try {
      const data = await request(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, 5000);
      if (data.ok && data.user) {
        const name = data.user.real_name || data.user.profile?.real_name || data.user.name || userId;
        this.userCache.set(userId, name);
        return name;
      }
    } catch (e) {
      if (e instanceof Error && (e.message === 'rate_limited' || e.message === 'Slack request limit reached')) return userId;
      // Ignore network errors in name resolution
    }

    this.userCache.set(userId, userId);
    return userId;
  }

  private async countUnreadChannelMessages(channelId: string, lastRead: string, request: (url: string, timeout: number) => Promise<any>): Promise<{ count: number; cacheHit: boolean }> {
    const now = Date.now();
    const cached = this.historyCounts.get(channelId);
    const cacheHit = Boolean(cached && cached.lastRead === lastRead &&
      now >= cached.reconciledAt && now - cached.reconciledAt < HISTORY_RECONCILE_MS &&
      Number(cached.latestMessageTs) >= Number(lastRead));
    const oldest = cacheHit ? cached!.latestMessageTs : lastRead;
    let newUnread = 0;
    let latestMessageTs = oldest;
    let cursor = '';
    let pages = 0;

    do {
      const params = new URLSearchParams({ channel: channelId, oldest, limit: '100' });
      if (cursor) params.set('cursor', cursor);
      const data = await request(`https://slack.com/api/conversations.history?${params}`, 6000);
      if (!data.ok) throw new Error(data.error || 'Slack history query failed');

      for (const message of data.messages || []) {
        const messageTs = Number(message.ts);
        if (messageTs > Number(latestMessageTs)) latestMessageTs = String(message.ts);
        if (messageTs > Number(lastRead) && (!cacheHit || messageTs > Number(cached!.latestMessageTs)) &&
            (!this.currentUserId || message.user !== this.currentUserId)) newUnread++;
      }
      cursor = data.response_metadata?.next_cursor || '';
      pages++;
    } while (cursor && pages < 3);
    if (cursor) throw new Error('Slack history page limit reached');

    const count = cacheHit ? cached!.unread + newUnread : newUnread;
    this.historyCounts.set(channelId, {
      lastRead,
      latestMessageTs,
      unread: count,
      reconciledAt: cacheHit ? cached!.reconciledAt : now,
    });
    this.snapshotDirty = true;
    return { count, cacheHit };
  }

  private async resolveGroupName(channelId: string, request: (url: string, timeout: number) => Promise<any>, missingScopes: string[]): Promise<string> {
    // Without the authenticated ID we cannot reliably exclude the current user.
    if (!this.currentUserId) return 'Group DM';
    const members: string[] = [];
    let cursor = '';
    do {
      const params = new URLSearchParams({ channel: channelId, limit: '100' });
      if (cursor) params.set('cursor', cursor);
      const data = await request(`https://slack.com/api/conversations.members?${params}`, 5000);
      if (!data.ok) {
        if (data.error === 'missing_scope') missingScopes.push('mpim:read');
        return 'Group DM';
      }
      for (const userId of data.members || []) {
        if (userId !== this.currentUserId && !members.includes(userId)) members.push(userId);
      }
      cursor = data.response_metadata?.next_cursor || '';
    } while (cursor && members.length < 3);

    const names: string[] = [];
    for (const userId of members.slice(0, 3)) {
      const name = await this.resolveUserName(userId, request);
      names.push(name.trim().split(/\s+/)[0] || userId);
    }
    return names.join(', ') || 'Group DM';
  }

  async fetchData(): Promise<ProviderResult> {
    const now = new Date().toISOString();
    if (!this.isEnabled()) {
      return {
        source: this.name,
        displayName: this.displayName,
        status: 'disabled',
        statusMessage: 'Not configured or disabled',
        lastUpdated: now,
        metrics: [],
        notifications: [],
      };
    }

    const token = this.getToken();
    const headers = this.getHeaders(token);
    let requestCount = 0;
    let rateLimited = false;
    let requestLimited = false;
    let dmDiscoveryCacheHit = false;
    let channelDiscoveryCacheHit = false;
    let historyCacheHits = 0;
    const requestCounts: Record<string, number> = {};
    const incompleteReasons = new Set<string>();
    const request = async (url: string, timeout: number): Promise<any> => {
      const endpoint = new URL(url).pathname.split('/').pop() || 'unknown';
      if (rateLimited || Date.now() < this.rateLimitedUntil) {
        rateLimited = true;
        throw new Error('rate_limited');
      }
      if (requestCount >= 80) {
        requestLimited = true;
        incompleteReasons.add(`80-request limit before ${endpoint}`);
        throw new Error('Slack request limit reached');
      }
      requestCount++;
      requestCounts[endpoint] = (requestCounts[endpoint] || 0) + 1;
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
      if (resp.status === 429) {
        rateLimited = true;
        this.rateLimitedUntil = Date.now() + Math.max(60, Number(resp.headers.get('Retry-After')) || 0) * 1000;
        throw new Error('rate_limited');
      }
      return await resp.json();
    };
    const missingScopes: string[] = [];
    const trackedChannels = [...new Set((getConfig().slack.trackedChannels || [])
      .map(name => name.trim().replace(/^#/, '').trim().toLowerCase())
      .filter(Boolean))];
    const trackedChannelNames = new Set(trackedChannels);

    try {
      // 0. Ensure we know the authenticated user ID
      if (!this.currentUserId) {
        try {
          const authData = await request('https://slack.com/api/auth.test', 5000);
          if (authData.ok) {
            this.currentUserId = authData.user_id;
            this.currentTeamId = authData.team_id || '';
            this.currentUserName = authData.user;
          }
        } catch (_) {}
      }
      this.loadDiscoverySnapshot();

      // 1. Discover both individual and group DMs, with independent pagination.
      if (this.dmDiscoveryExpiresAt > Date.now() && !this.imListCursor && !this.mpimListCursor) {
        dmDiscoveryCacheHit = true;
        if (this.mpimMissingScopeUntil > Date.now()) missingScopes.push('mpim:read');
      } else {
        let discoveryComplete = true;
        for (const type of ['im', 'mpim'] as const) {
          if (type === 'mpim' && this.mpimMissingScopeUntil > Date.now()) {
            missingScopes.push('mpim:read');
            continue;
          }
          try {
            const params = new URLSearchParams({ types: type, exclude_archived: 'true', limit: '200' });
            const cursor = type === 'im' ? this.imListCursor : this.mpimListCursor;
            if (cursor) params.set('cursor', cursor);
            const data = await request(`https://slack.com/api/conversations.list?${params}`, 8000);
            if (!data.ok) {
              if (type === 'mpim' && data.error === 'missing_scope') {
                this.mpimMissingScopeUntil = Date.now() + CHANNEL_DISCOVERY_CACHE_MS;
                missingScopes.push('mpim:read');
                this.snapshotDirty = true;
                continue;
              }
              throw new Error(`Slack ${type.toUpperCase()} error: ${data.error}`);
            }
            if (type === 'im') this.imListCursor = data.response_metadata?.next_cursor || '';
            else {
              this.mpimListCursor = data.response_metadata?.next_cursor || '';
              this.mpimMissingScopeUntil = 0;
            }
            for (const im of data.channels || []) {
              if (im.is_user_deleted || im.is_archived) {
                this.imChannels.delete(im.id);
                this.imStates.delete(im.id);
                this.historyCounts.delete(im.id);
              } else {
                this.imChannels.set(im.id, { ...im, is_mpim: type === 'mpim' });
              }
            }
            this.snapshotDirty = true;
          } catch (err) {
            if (type === 'im') throw err;
            discoveryComplete = false;
            // Keep individual DMs available when group discovery fails.
            requestLimited = true;
            incompleteReasons.add(`mpim conversations.list: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        this.dmDiscoveryExpiresAt = discoveryComplete && !this.imListCursor && !this.mpimListCursor
          ? Date.now() + DM_DISCOVERY_CACHE_MS
          : 0;
        this.snapshotDirty = true;
      }
      const allIms = [...this.imChannels.values()];

      // Determine which IM channels to inspect this cycle
      const imsToInspect: any[] = [];
      const inspectedIds = new Set<string>();

      // Prioritize recent activity, then rotate through every discovered IM.
      for (const im of [...allIms].sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, 5)) {
        imsToInspect.push(im);
        inspectedIds.add(im.id);
      }
      let scanned = 0;
      for (let i = 0; i < allIms.length && imsToInspect.length < MAX_DMS_PER_POLL; i++) {
        const im = allIms[(this.imScanCursor + i) % allIms.length];
        scanned++;
        if (!inspectedIds.has(im.id)) {
          imsToInspect.push(im);
          inspectedIds.add(im.id);
        }
      }
      const previousScanCursor = this.imScanCursor;
      this.imScanCursor = (this.imScanCursor + scanned) % Math.max(1, allIms.length);
      if (this.imScanCursor !== previousScanCursor) this.snapshotDirty = true;

      for (let i = 0; i < imsToInspect.length; i += 5) {
        const batch = imsToInspect.slice(i, i + 5);
        await Promise.all(batch.map(async (im) => {
          try {
            const infoData = await request(`https://slack.com/api/conversations.info?channel=${im.id}`, 5000);
            if (infoData.ok && infoData.channel) {
              const ch = infoData.channel;
              const isGroup = Boolean(ch.is_mpim || im.is_mpim);
              let unread = ch.unread_count_display ?? ch.unread_count ?? 0;
              if (isGroup && ch.unread_count_display === undefined && ch.unread_count === undefined) {
                if (!ch.last_read) {
                  requestLimited = true;
                  incompleteReasons.add('mpim conversations.info omitted last_read');
                  return;
                }
                try {
                  const historyResult = await this.countUnreadChannelMessages(im.id, ch.last_read, request);
                  unread = historyResult.count;
                  if (historyResult.cacheHit) historyCacheHits++;
                } catch (err: any) {
                  if (err.message === 'missing_scope') missingScopes.push('mpim:history');
                  requestLimited = true;
                  incompleteReasons.add(`mpim conversations.history: ${err.message || String(err)}`);
                  return;
                }
              }
              this.imStates.set(im.id, {
                unread,
                updated: im.updated || 0,
                user: ch.user || im.user || '',
                isGroup,
              });
            }
          } catch (_) {
            // Ignore individual fetch failure
          }
        }));
      }

      // Collect all unread DMs
      const unreadImList: Array<IMState & { id: string }> = [];
      let totalUnreadDMs = 0;

      for (const [id, state] of this.imStates.entries()) {
        if (state.unread > 0) {
          totalUnreadDMs += state.unread;
          unreadImList.push({ id, ...state });
        }
      }

      // Sort by unread count descending, then by updated desc
      unreadImList.sort((a, b) => b.unread - a.unread || b.updated - a.updated);

      // Resolve user names for top 3 DMs
      const top3Dms = unreadImList.slice(0, 3);
      const topDMs: Array<{ sender: string; count: number; text: string }> = [];

      for (const item of top3Dms) {
        let sender: string;
        if (item.isGroup) {
          try {
            sender = await this.resolveGroupName(item.id, request, missingScopes);
          } catch (_) {
            sender = 'Group DM';
          }
        } else {
          sender = await this.resolveUserName(item.user, request);
        }
        topDMs.push({
          sender,
          count: item.unread,
          text: `${sender} - ${item.unread}`,
        });
      }

      // 2. Fetch unread mentions via search.messages
      const topMentions: Array<{ channel: string }> = [];
      let totalMentions = 0;

      try {
        const searchData = await request('https://slack.com/api/search.messages?query=to%3Ame%20is%3Aunread&sort=timestamp&sort_dir=desc&count=100', 6000);

        if (searchData.ok && searchData.messages) {
          const matches: any[] = searchData.messages.matches || [];
          const channelMatches = matches.filter((m: any) =>
            m.channel && !m.channel.is_im && !m.channel.is_mpim && !m.channel.id?.startsWith('D')
          );
          totalMentions = channelMatches.length;
          const seenChannels = new Set<string>();

          for (const m of channelMatches) {
            let chName = m.channel.name;
            if (chName && !chName.startsWith('#')) {
              chName = `#${chName}`;
            }
            if (chName && !seenChannels.has(chName)) {
              seenChannels.add(chName);
              topMentions.push({ channel: chName });
              if (topMentions.length >= 3) break;
            }
          }
        } else if (searchData.error === 'missing_scope') {
          missingScopes.push('search:read');
        }
      } catch (_) {
        // Search error
      }

      // 3. Fetch Channel unreads
      let unreadChannelsCount = 0;
      let trackedChannelMessages = 0;
      const trackedChannelUnreads: Array<{ channel: string; count: number }> = [];
      const unavailableTrackedChannels = new Set<string>();

      try {
        const channelCacheKey = JSON.stringify(trackedChannels);
        const cachedChannelDiscovery = this.channelDiscoveryCache?.key === channelCacheKey && this.channelDiscoveryCache.expiresAt > Date.now()
          ? this.channelDiscoveryCache
          : null;
        channelDiscoveryCacheHit = Boolean(cachedChannelDiscovery);
        let userChannels = cachedChannelDiscovery
          ? cachedChannelDiscovery.channels
          : null;
        let missingGroupsScope = cachedChannelDiscovery?.missingGroupsScope || false;
        if (missingGroupsScope) missingScopes.push('groups:read');

        if (!userChannels) {
          let channelTypes = 'public_channel,private_channel';
          const fetchChannels = async (cursor = '') => {
            const params = new URLSearchParams({ types: channelTypes, exclude_archived: 'true', limit: '100' });
            if (cursor) params.set('cursor', cursor);
            return await request(`https://slack.com/api/users.conversations?${params}`, 6000);
          };

          let chListData = await fetchChannels();
          if (!chListData.ok && chListData.error === 'missing_scope') {
            missingGroupsScope = true;
            missingScopes.push('groups:read');
            channelTypes = 'public_channel';
            chListData = await fetchChannels();
          }

          if (chListData.ok && chListData.channels) {
            userChannels = [...chListData.channels];
            let cursor = chListData.response_metadata?.next_cursor || '';
            while (trackedChannels.length && cursor) {
              const foundNames = new Set(userChannels.map(ch => ch.name?.toLowerCase()));
              if (Array.from(trackedChannelNames).every(name => foundNames.has(name))) break;
              chListData = await fetchChannels(cursor);
              if (!chListData.ok || !chListData.channels) break;
              userChannels.push(...chListData.channels);
              cursor = chListData.response_metadata?.next_cursor || '';
            }
            this.channelDiscoveryCache = {
              key: channelCacheKey,
              channels: userChannels,
              expiresAt: Date.now() + CHANNEL_DISCOVERY_CACHE_MS,
              missingGroupsScope,
            };
            this.snapshotDirty = true;
          }
        }

        if (userChannels) {
          const channelByName = new Map(userChannels.map(ch => [ch.name?.toLowerCase(), ch]));
          for (const name of trackedChannels) {
            if (!channelByName.has(name.toLowerCase())) unavailableTrackedChannels.add(name);
          }

          // Check only configured channels, or the existing top 15 when none are configured.
          const channelsToCheck = trackedChannels.length
            ? trackedChannels.map(name => channelByName.get(name.toLowerCase())).filter(Boolean)
            : userChannels.slice(0, 15);
          for (let i = 0; i < channelsToCheck.length; i += 5) {
            await Promise.all(channelsToCheck.slice(i, i + 5).map(async (ch) => {
              try {
                const infoData = await request(`https://slack.com/api/conversations.info?channel=${ch.id}`, 4000);
                if (infoData.ok && infoData.channel) {
                  const hasUnreadCount = infoData.channel.unread_count_display !== undefined || infoData.channel.unread_count !== undefined;
                  if (trackedChannels.length && !hasUnreadCount && infoData.channel.last_read) {
                    try {
                      const historyResult = await this.countUnreadChannelMessages(ch.id, infoData.channel.last_read, request);
                      trackedChannelMessages += historyResult.count;
                      if (historyResult.cacheHit) historyCacheHits++;
                      if (historyResult.count > 0) trackedChannelUnreads.push({ channel: `#${ch.name}`, count: historyResult.count });
                    } catch (err: any) {
                      if (err.message === 'missing_scope') {
                        const historyScope = ch.is_private ? 'groups:history' : 'channels:history';
                        if (!missingScopes.includes(historyScope)) missingScopes.push(historyScope);
                      }
                      unavailableTrackedChannels.add(ch.name);
                    }
                    return;
                  }
                  if (!hasUnreadCount) {
                    const historyScope = ch.is_private ? 'groups:history' : 'channels:history';
                    if (!missingScopes.includes(historyScope)) missingScopes.push(historyScope);
                    if (trackedChannels.length) unavailableTrackedChannels.add(ch.name);
                    return;
                  }
                  const unread = infoData.channel.unread_count_display ?? infoData.channel.unread_count ?? 0;
                  if (trackedChannels.length) {
                    trackedChannelMessages += unread;
                    if (unread > 0) trackedChannelUnreads.push({ channel: `#${ch.name}`, count: unread });
                  } else if (unread > 0) {
                    unreadChannelsCount++;
                  }
                } else if (trackedChannels.length) {
                  unavailableTrackedChannels.add(ch.name);
                }
              } catch (_) {
                if (trackedChannels.length) unavailableTrackedChannels.add(ch.name);
              }
            }));
          }
        } else if (trackedChannels.length) {
          trackedChannels.forEach(name => unavailableTrackedChannels.add(name));
        }
      } catch (_) {}

      // Build status and message
      const unreadItems: string[] = [];
      if (totalUnreadDMs > 0) unreadItems.push(`${totalUnreadDMs} unread direct message${totalUnreadDMs > 1 ? 's' : ''}`);
      if (trackedChannels.length && trackedChannelMessages > 0) {
        unreadItems.push(`${trackedChannelMessages} unread tracked channel message${trackedChannelMessages > 1 ? 's' : ''}`);
      } else if (!trackedChannels.length && unreadChannelsCount > 0) {
        unreadItems.push(`${unreadChannelsCount} unread channel${unreadChannelsCount > 1 ? 's' : ''}`);
      }
      if (unavailableTrackedChannels.size > 0) {
        unreadItems.push(`${unavailableTrackedChannels.size} tracked channel${unavailableTrackedChannels.size > 1 ? 's' : ''} unavailable`);
      }
      if (totalMentions > 0) unreadItems.push(`${totalMentions} unread mention${totalMentions > 1 ? 's' : ''}`);
      if (missingScopes.includes('mpim:read')) unreadItems.push('Group DMs require mpim:read');
      if (missingScopes.includes('mpim:history')) unreadItems.push('Group DM unread counts require mpim:history');
      if (rateLimited) unreadItems.push('Slack rate limited');
      else if (requestLimited) {
        const reason = incompleteReasons.values().next().value;
        unreadItems.push(reason ? `Slack data incomplete: ${reason}` : 'Slack data incomplete');
      }
      const status = unreadItems.length > 0 ? 'warning' : 'healthy';
      const statusMessage = unreadItems.join(' • ') || 'All caught up';

      // Notifications for any new unread DMs
      const notifications: NotificationItem[] = topDMs.map((dm, idx) => ({
        id: `slack-dm-${idx}-${Date.now()}`,
        source: 'slack',
        title: `DM: ${dm.sender}`,
        subtitle: `${dm.count} new message${dm.count > 1 ? 's' : ''}`,
        timestamp: now,
        level: 'warning',
      }));

      this.saveDiscoverySnapshot();

      const metrics: MetricItem[] = [
        {
          key: 'unread_dms',
          label: 'Direct DMs',
          value: totalUnreadDMs,
          status: totalUnreadDMs > 0 ? 'warning' : 'good',
        },
        {
          key: 'mentions',
          label: 'Unread Mentions',
          value: totalMentions > 0 ? totalMentions : (missingScopes.includes('search:read') ? '--' : 0),
          status: totalMentions > 0 ? 'warning' : 'neutral',
        },
        {
          key: 'unread_channels',
          label: trackedChannels.length ? 'Tracked Channel Messages' : 'Unread Channels',
          value: trackedChannels.length
            ? (unavailableTrackedChannels.size > 0 || rateLimited || requestLimited ? '--' : trackedChannelMessages)
            : (unreadChannelsCount > 0 ? unreadChannelsCount : (missingScopes.includes('channels:history') || rateLimited || requestLimited ? '--' : 0)),
          status: trackedChannelMessages > 0 || unreadChannelsCount > 0 ? 'warning' : 'neutral',
        },
      ];

      return {
        source: this.name,
        displayName: this.displayName,
        status,
        statusMessage,
        lastUpdated: now,
        metrics,
        notifications,
        details: {
          topDMs,
          topMentions,
          trackedChannelUnreads: trackedChannelUnreads.sort((a, b) =>
            trackedChannels.indexOf(a.channel.slice(1).toLowerCase()) - trackedChannels.indexOf(b.channel.slice(1).toLowerCase())
          ),
          trackedChannelMessages,
          unavailableTrackedChannels: Array.from(unavailableTrackedChannels),
          missingScopes: Array.from(new Set(missingScopes)),
          requestCount,
          requestCounts,
          incompleteReasons: Array.from(incompleteReasons),
          historyCacheHits,
          discoveryCache: {
            conversations: dmDiscoveryCacheHit ? 'hit' : 'miss',
            channels: channelDiscoveryCacheHit ? 'hit' : 'miss',
          },
          user: this.currentUserName,
        },
      };
    } catch (err: any) {
      return {
        source: this.name,
        displayName: this.displayName,
        status: 'error',
        statusMessage: `Error: ${err.message || String(err)}`,
        lastUpdated: now,
        metrics: [
          { key: 'unread_dms', label: 'Direct DMs', value: '--', status: 'bad' },
          { key: 'mentions', label: 'Mentions', value: '--', status: 'neutral' },
          { key: 'unread_channels', label: 'Unread Channels', value: '--', status: 'neutral' },
        ],
        notifications: [
          {
            id: `slack-err-${Date.now()}`,
            source: 'slack',
            title: 'Slack Connection Error',
            subtitle: err.message || 'Check Slack token',
            timestamp: now,
            level: 'critical',
          },
        ],
        details: {
          topDMs: [],
          topMentions: [],
          trackedChannelUnreads: [],
          missingScopes: [],
          requestCount,
          requestCounts,
          incompleteReasons: Array.from(incompleteReasons),
          historyCacheHits,
        },
      };
    }
  }
}
