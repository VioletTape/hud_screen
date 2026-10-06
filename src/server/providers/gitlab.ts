import { IProvider } from './base.js';
import { ProviderResult, MetricItem, NotificationItem } from '../../shared/types.js';
import { getConfig } from '../config.js';

export class GitLabProvider implements IProvider {
  name = 'gitlab';
  displayName = 'GitLab';

  isEnabled(): boolean {
    const cfg = getConfig().gitlab;
    return Boolean(cfg.enabled && cfg.baseUrl && cfg.token);
  }

  private getHeaders(token: string) {
    return {
      'PRIVATE-TOKEN': token,
      'Accept': 'application/json',
    };
  }

  private cleanBaseUrl(url: string): string {
    return url.replace(/\/+$/, '');
  }

  async testConnection(customConfig?: { baseUrl: string; token: string }): Promise<{ success: boolean; message: string; details?: any }> {
    const cfg = customConfig || getConfig().gitlab;
    if (!cfg.baseUrl || !cfg.token) {
      return { success: false, message: 'Base URL and Personal Access Token are required.' };
    }
    const cleanUrl = this.cleanBaseUrl(cfg.baseUrl);
    try {
      const resp = await fetch(`${cleanUrl}/api/v4/user`, {
        headers: this.getHeaders(cfg.token),
        signal: AbortSignal.timeout(8000),
      });

      if (!resp.ok) {
        if (resp.status === 401) {
          return { success: false, message: 'Authentication failed (HTTP 401): Invalid Personal Access Token.' };
        }
        return { success: false, message: `GitLab returned HTTP error: ${resp.status} ${resp.statusText}` };
      }

      const user = await resp.json() as any;
      return {
        success: true,
        message: `Successfully connected as @${user.username} (${user.name})`,
        details: { id: user.id, username: user.username, name: user.name, web_url: user.web_url },
      };
    } catch (err: any) {
      return { success: false, message: `Connection error: ${err.message || String(err)}` };
    }
  }

  async fetchData(): Promise<ProviderResult> {
    const cfg = getConfig().gitlab;
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

    const cleanUrl = this.cleanBaseUrl(cfg.baseUrl);
    const headers = this.getHeaders(cfg.token);

    try {
      // 1. Get current user
      const userResp = await fetch(`${cleanUrl}/api/v4/user`, { headers, signal: AbortSignal.timeout(6000) });
      if (!userResp.ok) {
        throw new Error(`GitLab Auth Failed (HTTP ${userResp.status})`);
      }
      const user = await userResp.json() as any;
      const username = user.username;

      // 2. Parallel queries: Your open MRs, Review Requests, and To-Dos
      const [myMrsRes, reviewRes, todosRes] = await Promise.allSettled([
        // ponytail: first 20 open MRs; paginate if more need tracking.
        fetch(`${cleanUrl}/api/v4/merge_requests?state=opened&scope=created_by_me&per_page=20`, { headers, signal: AbortSignal.timeout(8000) }).then(r => r.json()),
        fetch(`${cleanUrl}/api/v4/merge_requests?state=opened&reviewer_username=${encodeURIComponent(username)}&per_page=20`, { headers, signal: AbortSignal.timeout(8000) }).then(r => r.json()),
        fetch(`${cleanUrl}/api/v4/todos?state=pending&per_page=20`, { headers, signal: AbortSignal.timeout(8000) }).then(r => r.json()),
      ]);

      const myMrs = myMrsRes.status === 'fulfilled' && Array.isArray(myMrsRes.value)
        ? myMrsRes.value.filter((mr: any) => mr.draft !== true && !/^Draft:\s*/i.test(mr.title || ''))
        : [];
      const reviewReqs = reviewRes.status === 'fulfilled' && Array.isArray(reviewRes.value) ? reviewRes.value : [];
      const todos = todosRes.status === 'fulfilled' && Array.isArray(todosRes.value) ? todosRes.value : [];
      const trackedMrs = await Promise.all(myMrs.map(async (mr: any) => {
        try {
          const [approvalResult, discussionResult, mergeRequestResult] = await Promise.allSettled([
            fetch(`${cleanUrl}/api/v4/projects/${mr.project_id}/merge_requests/${mr.iid}/approvals`, {
              headers,
              signal: AbortSignal.timeout(8000),
            }).then(r => r.ok ? r.json() : null),
            // ponytail: first 100 discussion threads per MR; paginate if reviews exceed this.
            fetch(`${cleanUrl}/api/v4/projects/${mr.project_id}/merge_requests/${mr.iid}/discussions?per_page=100`, {
              headers,
              signal: AbortSignal.timeout(8000),
            }).then(r => r.ok ? r.json() : null),
            fetch(`${cleanUrl}/api/v4/projects/${mr.project_id}/merge_requests/${mr.iid}`, {
              headers,
              signal: AbortSignal.timeout(8000),
            }).then(r => r.ok ? r.json() : null),
          ]);

          const approvals = approvalResult.status === 'fulfilled' ? approvalResult.value : null;
          const mergeRequest = mergeRequestResult.status === 'fulfilled' && mergeRequestResult.value
            ? mergeRequestResult.value
            : mr;
          const discussions = discussionResult.status === 'fulfilled' && Array.isArray(discussionResult.value)
            ? discussionResult.value
            : [];
          const hasApproval = Array.isArray(approvals?.approved_by) && approvals.approved_by.length > 0;
          const needsResponse = discussions.some((discussion: any) => {
            const codeNotes = Array.isArray(discussion.notes)
              ? discussion.notes.filter((note: any) => !note.system && note.type === 'DiffNote')
              : [];
            if (!codeNotes.some((note: any) => note.author?.id != null && note.author.id !== user.id)) return false;

            const latestNote = codeNotes.reduce((latest: any, note: any) =>
              Date.parse(note.created_at) >= Date.parse(latest.created_at) ? note : latest
            );
            const resolvableNotes = codeNotes.filter((note: any) => note.resolvable);
            const resolved = resolvableNotes.length > 0 && resolvableNotes.every((note: any) => note.resolved === true);
            // Your latest reply clears 💬 even when GitLab still marks the thread unresolved.
            return !resolved && latestNote.author?.id !== user.id;
          });

          const projectName = mr.references?.full?.split('/').pop()?.split('!')[0] || '';
          if (!projectName) return null;
          const behindCount = Number(mergeRequest.diverged_commits_count) || 0;
          const detailedMergeStatus = mergeRequest.detailed_merge_status;
          const blockReasons = [
            mergeRequest.has_conflicts === true || detailedMergeStatus === 'conflict' ? 'Has merge conflicts' : '',
            detailedMergeStatus === 'need_rebase' ? 'Needs rebase' : '',
            behindCount >= 10 ? `${behindCount} commits behind target` : '',
          ].filter(Boolean);
          return {
            projectName,
            iid: mr.iid,
            status: blockReasons.length ? 'blocked' : needsResponse ? 'comments' : hasApproval ? 'approved' : 'waiting',
            blockReason: blockReasons.join('; ') || undefined,
          };
        } catch {
          return null;
        }
      }));
      const trackedMrList = trackedMrs.filter((mr: any) => mr !== null);

      const notifications: NotificationItem[] = [];

      // Add review requests notifications
      for (const mr of reviewReqs.slice(0, 3)) {
        notifications.push({
          id: `gl-mr-${mr.id}`,
          source: 'gitlab',
          title: `Review: ${mr.title}`,
          subtitle: `By @${mr.author?.username || 'unknown'} in ${mr.references?.full || ''}`,
          timestamp: mr.updated_at || now,
          level: 'info',
          meta: { web_url: mr.web_url },
        });
      }

      const status = 'healthy';
      const statusMessage = 'Connected';

      const metrics: MetricItem[] = [
        {
          key: 'review_requests',
          label: 'Review Req',
          value: reviewReqs.length,
          status: reviewReqs.length > 0 ? 'warning' : 'neutral',
        },
        {
          key: 'todos',
          label: 'To-Dos',
          value: todos.length,
          status: todos.length > 5 ? 'warning' : 'neutral',
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
        details: { myMrs: trackedMrList },
      };
    } catch (err: any) {
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
            id: `gl-err-${Date.now()}`,
            source: 'gitlab',
            title: 'GitLab Connection Failed',
            subtitle: err.message || 'Could not reach server',
            timestamp: now,
            level: 'critical',
          },
        ],
      };
    }
  }
}
