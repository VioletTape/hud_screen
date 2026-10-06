import { IProvider } from './base.js';
import { ProviderResult, MetricItem, NotificationItem } from '../../shared/types.js';
import { getConfig } from '../config.js';

interface IMState {
  unread: number;
  updated: number;
  user: string;
}

export class SlackProvider implements IProvider {
  name = 'slack';
  displayName = 'Slack';

  private userCache: Map<string, string> = new Map();
  private imStates: Map<string, IMState> = new Map();
  private initialScanDone = false;
  private imScanCursor = 0;
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

  private async resolveUserName(userId: string, headers: Record<string, string>): Promise<string> {
    if (!userId) return 'Unknown';
    if (this.userCache.has(userId)) {
      return this.userCache.get(userId)!;
    }

    try {
      const resp = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      const data = await resp.json() as any;
      if (data.ok && data.user) {
        const name = data.user.real_name || data.user.profile?.real_name || data.user.name || userId;
        this.userCache.set(userId, name);
        return name;
      }
    } catch (e) {
      // Ignore network errors in name resolution
    }

    this.userCache.set(userId, userId);
    return userId;
  }

  private async countUnreadChannelMessages(channelId: string, lastRead: string, headers: Record<string, string>): Promise<number> {
    let count = 0;
    let cursor = '';

    do {
      const params = new URLSearchParams({ channel: channelId, oldest: lastRead, limit: '100' });
      if (cursor) params.set('cursor', cursor);
      const resp = await fetch(`https://slack.com/api/conversations.history?${params}`, {
        headers,
        signal: AbortSignal.timeout(6000),
      });
      const data = await resp.json() as any;
      if (!data.ok) throw new Error(data.error || 'Slack history query failed');

      count += (data.messages || []).filter((message: any) =>
        Number(message.ts) > Number(lastRead) && (!this.currentUserId || message.user !== this.currentUserId)
      ).length;
      cursor = data.response_metadata?.next_cursor || '';
    } while (cursor);

    return count;
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
    const missingScopes: string[] = [];
    const trackedChannels = [...new Set((getConfig().slack.trackedChannels || [])
      .map(name => name.trim().replace(/^#/, '').trim().toLowerCase())
      .filter(Boolean))];
    const trackedChannelNames = new Set(trackedChannels);

    try {
      // 0. Ensure we know the authenticated user ID
      if (!this.currentUserId) {
        try {
          const authResp = await fetch('https://slack.com/api/auth.test', {
            headers,
            signal: AbortSignal.timeout(5000),
          });
          const authData = await authResp.json() as any;
          if (authData.ok) {
            this.currentUserId = authData.user_id;
            this.currentUserName = authData.user;
          }
        } catch (_) {}
      }

      // 1. Fetch IM Conversations list
      const imsResp = await fetch('https://slack.com/api/conversations.list?types=im&limit=200', {
        headers,
        signal: AbortSignal.timeout(8000),
      });
      const imsData = await imsResp.json() as any;
      if (!imsData.ok) {
        throw new Error(`Slack IM error: ${imsData.error}`);
      }

      const allIms: any[] = (imsData.channels || []).filter((c: any) => !c.is_user_deleted);

      // Determine which IM channels to inspect this cycle
      const imsToInspect: any[] = [];
      const inspectedIds = new Set<string>();

      if (!this.initialScanDone) {
        // First run: inspect all active IMs to establish baseline
        // To stay well within rate limits, inspect up to 50 active IMs on first pass
        for (const im of allIms) {
          imsToInspect.push(im);
          inspectedIds.add(im.id);
        }
        this.initialScanDone = true;
      } else {
        // Subsequent runs:
        // 1. Always inspect IMs that were previously recorded as unread
        for (const [imId, state] of this.imStates.entries()) {
          if (state.unread > 0) {
            const imObj = allIms.find(c => c.id === imId);
            if (imObj && !inspectedIds.has(imId)) {
              imsToInspect.push(imObj);
              inspectedIds.add(imId);
            }
          }
        }

        // 2. Inspect the top 10 most recently updated IMs
        const sortedByUpdated = [...allIms].sort((a, b) => (b.updated || 0) - (a.updated || 0));
        for (const im of sortedByUpdated.slice(0, 10)) {
          if (!inspectedIds.has(im.id)) {
            imsToInspect.push(im);
            inspectedIds.add(im.id);
          }
        }

        // 3. Inspect a rotating window of 10 older IMs to verify nothing was missed
        const remaining = allIms.filter(c => !inspectedIds.has(c.id));
        if (remaining.length > 0) {
          const start = this.imScanCursor % remaining.length;
          const slice = remaining.slice(start, start + 10);
          this.imScanCursor = (this.imScanCursor + 10) % Math.max(1, remaining.length);
          for (const im of slice) {
            imsToInspect.push(im);
            inspectedIds.add(im.id);
          }
        }
      }

      // Query conversations.info in small batches of 15
      for (let i = 0; i < imsToInspect.length; i += 15) {
        const batch = imsToInspect.slice(i, i + 15);
        await Promise.all(batch.map(async (im) => {
          try {
            const infoResp = await fetch(`https://slack.com/api/conversations.info?channel=${im.id}`, {
              headers,
              signal: AbortSignal.timeout(5000),
            });
            const infoData = await infoResp.json() as any;
            if (infoData.ok && infoData.channel) {
              const ch = infoData.channel;
              const unread = Math.max(ch.unread_count_display || 0, ch.unread_count || 0);
              this.imStates.set(im.id, {
                unread,
                updated: im.updated || 0,
                user: ch.user || im.user,
              });
            }
          } catch (_) {
            // Ignore individual fetch failure
          }
        }));
      }

      // Collect all unread DMs
      const unreadImList: Array<{ id: string; user: string; unread: number; updated: number }> = [];
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
        const sender = await this.resolveUserName(item.user, headers);
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
        const searchResp = await fetch('https://slack.com/api/search.messages?query=to%3Ame%20is%3Aunread&sort=timestamp&sort_dir=desc&count=100', {
          headers,
          signal: AbortSignal.timeout(6000),
        });
        const searchData = await searchResp.json() as any;

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
      const unavailableTrackedChannels = new Set<string>();

      try {
        // Try to fetch public & private channels
        let channelTypes = 'public_channel,private_channel';
        const fetchChannels = async (cursor = '') => {
          const params = new URLSearchParams({ types: channelTypes, exclude_archived: 'true', limit: '100' });
          if (cursor) params.set('cursor', cursor);
          const resp = await fetch(`https://slack.com/api/users.conversations?${params}`, {
            headers,
            signal: AbortSignal.timeout(6000),
          });
          return await resp.json() as any;
        };

        let chListData = await fetchChannels();

        if (!chListData.ok && chListData.error === 'missing_scope') {
          missingScopes.push('groups:read');
          // Fall back to public channels only
          channelTypes = 'public_channel';
          chListData = await fetchChannels();
        }

        if (chListData.ok && chListData.channels) {
          const userChannels: any[] = [...chListData.channels];
          let cursor = chListData.response_metadata?.next_cursor || '';
          while (trackedChannels.length && cursor) {
            const foundNames = new Set(userChannels.map(ch => ch.name?.toLowerCase()));
            if (Array.from(trackedChannelNames).every(name => foundNames.has(name))) break;
            chListData = await fetchChannels(cursor);
            if (!chListData.ok || !chListData.channels) break;
            userChannels.push(...chListData.channels);
            cursor = chListData.response_metadata?.next_cursor || '';
          }

          const channelByName = new Map(userChannels.map(ch => [ch.name?.toLowerCase(), ch]));
          for (const name of trackedChannels) {
            if (!channelByName.has(name.toLowerCase())) unavailableTrackedChannels.add(name);
          }

          // Check only configured channels, or the existing top 15 when none are configured.
          const channelsToCheck = trackedChannels.length
            ? trackedChannels.map(name => channelByName.get(name.toLowerCase())).filter(Boolean)
            : userChannels.slice(0, 15);
          await Promise.all(channelsToCheck.map(async (ch) => {
            try {
              const infoResp = await fetch(`https://slack.com/api/conversations.info?channel=${ch.id}`, {
                headers,
                signal: AbortSignal.timeout(4000),
              });
              const infoData = await infoResp.json() as any;
              if (infoData.ok && infoData.channel) {
                const hasUnreadCount = infoData.channel.unread_count_display !== undefined || infoData.channel.unread_count !== undefined;
                if (trackedChannels.length && !hasUnreadCount && infoData.channel.last_read) {
                  try {
                    trackedChannelMessages += await this.countUnreadChannelMessages(ch.id, infoData.channel.last_read, headers);
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
                const unread = Math.max(infoData.channel.unread_count_display || 0, infoData.channel.unread_count || 0);
                if (trackedChannels.length) {
                  trackedChannelMessages += unread;
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
            ? (unavailableTrackedChannels.size > 0 ? '--' : trackedChannelMessages)
            : (unreadChannelsCount > 0 ? unreadChannelsCount : (missingScopes.includes('channels:history') ? '--' : 0)),
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
          trackedChannelMessages,
          unavailableTrackedChannels: Array.from(unavailableTrackedChannels),
          missingScopes: Array.from(new Set(missingScopes)),
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
          missingScopes: [],
        },
      };
    }
  }
}
