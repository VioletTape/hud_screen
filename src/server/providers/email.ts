import { ImapFlow } from 'imapflow';
import { IProvider } from './base.js';
import { ProviderResult, MetricItem, NotificationItem } from '../../shared/types.js';
import { getConfig } from '../config.js';

export class EmailProvider implements IProvider {
  name = 'email';
  displayName = 'Email';

  isEnabled(): boolean {
    const cfg = getConfig().email;
    return Boolean(cfg.enabled && cfg.host && cfg.user && cfg.password);
  }

  private createClient(customConfig?: any): ImapFlow {
    const cfg = customConfig || getConfig().email;
    return new ImapFlow({
      host: cfg.host,
      port: Number(cfg.port) || 993,
      secure: Boolean(cfg.secure !== false),
      auth: {
        user: cfg.user,
        pass: cfg.password || '',
      },
      logger: false,
    });
  }

  async testConnection(customConfig?: any): Promise<{ success: boolean; message: string; details?: any }> {
    const cfg = customConfig || getConfig().email;
    if (!cfg.host || !cfg.user || !cfg.password) {
      return { success: false, message: 'IMAP host, username/email, and password are required.' };
    }

    const client = this.createClient(cfg);
    try {
      await client.connect();
      const mailboxes = await client.list();
      await client.logout();
      return {
        success: true,
        message: `Successfully connected to ${cfg.host} as ${cfg.user} (${mailboxes.length} mailboxes found).`,
        details: { mailboxCount: mailboxes.length },
      };
    } catch (err: any) {
      try {
        await client.logout();
      } catch {
        // ignore
      }
      return {
        success: false,
        message: `IMAP connection error: ${err.message || String(err)}`,
      };
    }
  }

  async fetchData(): Promise<ProviderResult> {
    const cfg = getConfig().email;
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

    const client = this.createClient();
    try {
      await client.connect();
      const mailboxName = cfg.mailbox || 'INBOX';
      // RFC 3501 IMAP connections are stateful; getMailboxLock selects the mailbox and serializes
      // commands. Always release the lock and log out in finally to prevent orphaned server-side sessions.
      const lock = await client.getMailboxLock(mailboxName);

      let unreadCount = 0;
      let totalCount = 0;
      const notifications: NotificationItem[] = [];

      try {
        // RFC 3501 STATUS: Retrieve atomic server-side unseen and message counts in a single round-trip
        // without downloading flags or message sequence sets.
        const mailboxStatus = await client.status(mailboxName, { unseen: true, messages: true });
        unreadCount = mailboxStatus.unseen || 0;
        totalCount = mailboxStatus.messages || 0;

        // Fetch recent unseen messages if any
        if (unreadCount > 0) {
          const messages = client.fetch({ seen: false }, {
            envelope: true,
            flags: true,
          });

          let count = 0;
          for await (const msg of messages) {
            count++;
            // IMAP ENVELOPE structures parse RFC 2822 headers server-side; prefer display name over raw mailbox address.
            const env = msg.envelope;
            const fromStr = env?.from?.[0]?.name || env?.from?.[0]?.address || 'Unknown Sender';
            const subject = env?.subject || '(No Subject)';
            const dateStr = env?.date ? env.date.toISOString() : now;

            notifications.push({
              id: `mail-${msg.uid || count}`,
              source: 'email',
              title: `${fromStr}: ${subject}`,
              subtitle: `Received in ${mailboxName}`,
              timestamp: dateStr,
              level: 'info',
            });

            if (count >= 3) break;
          }
        }
      } finally {
        lock.release();
        await client.logout();
      }

      const status = unreadCount > 10 ? 'warning' : 'healthy';
      const statusMessage = unreadCount > 0
        ? `${unreadCount} unread message${unreadCount > 1 ? 's' : ''}`
        : 'Inbox zero';

      const metrics: MetricItem[] = [
        {
          key: 'inbox_unread',
          label: 'Unread Mail',
          value: unreadCount,
          status: unreadCount > 0 ? 'warning' : 'good',
        },
        {
          key: 'total_messages',
          label: 'Total in Box',
          value: totalCount,
          status: 'neutral',
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
      };
    } catch (err: any) {
      try {
        await client.logout();
      } catch {
        // ignore
      }
      return {
        source: this.name,
        displayName: this.displayName,
        status: 'error',
        statusMessage: `Error: ${err.message || String(err)}`,
        lastUpdated: now,
        metrics: [
          { key: 'error', label: 'Status', value: 'Offline', status: 'bad' },
        ],
        notifications: [
          {
            id: `email-err-${Date.now()}`,
            source: 'email',
            title: 'Email Connection Error',
            subtitle: err.message || 'Could not connect to IMAP server',
            timestamp: now,
            level: 'critical',
          },
        ],
      };
    }
  }
}
