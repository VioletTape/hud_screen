import { IProvider } from './base.js';
import { ProviderResult, MetricItem, NotificationItem } from '../../shared/types.js';
import { getConfig } from '../config.js';
import { logError } from '../error-log.js';

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
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        logError('GitLab connection test /user', `HTTP ${resp.status}${resp.headers.get('Retry-After') ? `; Retry-After: ${resp.headers.get('Retry-After')}` : ''}`);
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
      logError('GitLab connection test /user', err);
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
    const request = async (path: string, timeout: number): Promise<{ response: Response; data: any }> => {
      const endpoint = path.split('?')[0];
      try {
        const response = await fetch(`${cleanUrl}/api/v4/${path}`, { headers, signal: AbortSignal.timeout(timeout) });
        if (!response.ok) {
          logError(`GitLab ${endpoint}`, `HTTP ${response.status}${response.headers.get('Retry-After') ? `; Retry-After: ${response.headers.get('Retry-After')}` : ''}`);
        }
        return { response, data: response.ok ? await response.json() : null };
      } catch (err) {
        logError(`GitLab ${endpoint}`, err);
        throw err;
      }
    };

    try {
      // 1. Get current user
      const { response: userResp, data: user } = await request('user', 10_000);
      if (!userResp.ok) {
        throw new Error(`GitLab Auth Failed (HTTP ${userResp.status})`);
      }
      const username = user.username;

      // 2. Parallel queries: Your open MRs, Review Requests, and To-Dos
      const getList = async (path: string): Promise<any[]> => {
        const { response, data } = await request(path, 10_000);
        if (!response.ok) throw new Error(`GitLab ${path.split('?')[0]} failed (HTTP ${response.status})`);
        if (!Array.isArray(data)) {
          logError(`GitLab ${path.split('?')[0]}`, 'Invalid list response');
          throw new Error(`GitLab ${path.split('?')[0]} returned invalid data`);
        }
        return data;
      };
      const [myMrsList, reviewReqs, todos] = await Promise.all([
        // ponytail: first 20 open MRs; paginate if more need tracking.
        getList('merge_requests?state=opened&scope=created_by_me&per_page=20'),
        getList(`merge_requests?state=opened&reviewer_username=${encodeURIComponent(username)}&per_page=20`),
        getList('todos?state=pending&per_page=20'),
      ]);

      // Support both GitLab 13.2+ native draft property and legacy 'Draft:' title prefix conventions.
      const myMrs = myMrsList.filter((mr: any) => mr.draft !== true && !/^Draft:\s*/i.test(mr.title || ''));
      let detailFailed = false;
      const fetchMr = async (mr: any) => {
        try {
          const [approvalResult, discussionResult, mergeRequestResult] = await Promise.allSettled([
            request(`projects/${mr.project_id}/merge_requests/${mr.iid}/approvals`, 10_000).then(r => r.data),
            // ponytail: first 100 discussion threads per MR; paginate if reviews exceed this.
            request(`projects/${mr.project_id}/merge_requests/${mr.iid}/discussions?per_page=100`, 10_000).then(r => r.data),
            request(`projects/${mr.project_id}/merge_requests/${mr.iid}`, 10_000).then(r => r.data),
          ]);

          if (approvalResult.status !== 'fulfilled' || !approvalResult.value ||
              discussionResult.status !== 'fulfilled' || !Array.isArray(discussionResult.value) ||
              mergeRequestResult.status !== 'fulfilled' || !mergeRequestResult.value) {
            detailFailed = true;
          }

          const approvals = approvalResult.status === 'fulfilled' ? approvalResult.value : null;
          const mergeRequest = mergeRequestResult.status === 'fulfilled' && mergeRequestResult.value
            ? mergeRequestResult.value
            : mr;
          const discussions = discussionResult.status === 'fulfilled' && Array.isArray(discussionResult.value)
            ? discussionResult.value
            : [];
          const hasApproval = Array.isArray(approvals?.approved_by) && approvals.approved_by.length > 0;
          // Evaluates inline diff discussions (DiffNote) excluding system audit notes.
          // If the MR author posted the most recent note in an unresolved thread, treat it as answered
          // so author replies clear the action badge even if the reviewer hasn't toggled resolved in GitLab.
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
          // Map GitLab 15.6+ detailed_merge_status and commit divergence to actionable states.
          // Precedence: approved > blocked (conflicts/rebase/divergence) > comments (pending replies) > waiting.
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
            status: hasApproval ? 'approved' : blockReasons.length ? 'blocked' : needsResponse ? 'comments' : 'waiting',
            blockReason: blockReasons.join('; ') || undefined,
          };
        } catch {
          detailFailed = true;
          return null;
        }
      };
      const trackedMrs = [];
      // ponytail: five MRs at a time; tune this if request bursts or refresh latency become a problem.
      for (let i = 0; i < myMrs.length; i += 5) {
        trackedMrs.push(...await Promise.all(myMrs.slice(i, i + 5).map(fetchMr)));
      }
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

      const status = detailFailed ? 'warning' : 'healthy';
      const statusMessage = detailFailed ? 'Connected • Some MR details unavailable' : 'Connected';

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
