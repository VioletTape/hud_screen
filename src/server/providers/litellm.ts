import { IProvider } from './base.js';
import { ProviderResult, MetricItem, NotificationItem } from '../../shared/types.js';
import { getConfig } from '../config.js';

interface SingleKeyInfo {
  key: string;
  maskedKey: string;
  alias: string;
  userId: string;
  spend: number;
  maxBudget: number | null;
  models: string[];
}

interface FetchKeyOutcome {
  ok: boolean;
  info?: SingleKeyInfo;
  error?: string;
  statusCode?: number;
}

export class LiteLLMProvider implements IProvider {
  name = 'litellm';
  displayName = 'LiteLLM';

  isEnabled(): boolean {
    const cfg = getConfig().litellm;
    return Boolean(cfg.enabled && cfg.baseUrl);
  }

  private cleanBaseUrl(url: string): string {
    return url.replace(/\/+$/, '');
  }

  private parseKeys(input?: string): string[] {
    if (!input) return [];
    return input
      .split(/[\s,;]+/)
      .map(k => k.trim())
      .filter(k => k.length > 0);
  }

  private getMasked(key: string): string {
    if (key.length <= 8) return key;
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
  }

  private formatSpend(amount: number): string {
    if (amount === 0) return '$0.00';
    if (amount < 10) {
      const str4 = amount.toFixed(4);
      if (str4.endsWith('00')) {
        return `$${amount.toFixed(2)}`;
      }
      return `$${str4}`;
    }
    return `$${amount.toFixed(2)}`;
  }

  private async fetchSingleKey(cleanUrl: string, key: string, authBearer?: string): Promise<FetchKeyOutcome> {
    const maskedKey = this.getMasked(key);
    const bearer = authBearer || key;
    const headers = {
      'Accept': 'application/json',
      'Authorization': `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    };

    let lastError = '';
    let lastStatusCode = 0;

    // Attempt 1: GET /key/info?key=...
    try {
      const res = await fetch(`${cleanUrl}/key/info?key=${encodeURIComponent(key)}`, {
        headers,
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const data = await res.json() as any;
        const info = data.info || data;
        return {
          ok: true,
          info: {
            key,
            maskedKey: info.key_name || maskedKey,
            alias: info.key_alias || info.key_name || info.key_name_alias || maskedKey,
            userId: info.user_id || '',
            spend: typeof info.spend === 'number' ? info.spend : 0,
            maxBudget: info.max_budget != null && Number(info.max_budget) > 0 ? Number(info.max_budget) : null,
            models: Array.isArray(info.models) ? info.models : [],
          },
        };
      }
      lastStatusCode = res.status;
      try {
        const errJson = await res.json() as any;
        const msg = errJson?.error?.message || errJson?.detail || errJson?.message;
        lastError = msg ? `HTTP ${res.status}: ${msg}` : `HTTP ${res.status} ${res.statusText}`;
      } catch {
        const text = await res.text().catch(() => '');
        lastError = `HTTP ${res.status} ${res.statusText}${text ? ': ' + text.slice(0, 100) : ''}`;
      }
    } catch (e: any) {
      lastError = e.message || String(e);
    }

    // Attempt 2: If key is a standard API key (starts with sk-), try GET /key/info
    if (key.startsWith('sk-')) {
      try {
        const res = await fetch(`${cleanUrl}/key/info`, {
          headers,
          signal: AbortSignal.timeout(6000),
        });
        if (res.ok) {
          const data = await res.json() as any;
          const info = data.info || data;
          return {
            ok: true,
            info: {
              key,
              maskedKey: info.key_name || maskedKey,
              alias: info.key_alias || info.key_name || info.key_name_alias || maskedKey,
              userId: info.user_id || '',
              spend: typeof info.spend === 'number' ? info.spend : 0,
              maxBudget: info.max_budget != null && Number(info.max_budget) > 0 ? Number(info.max_budget) : null,
              models: Array.isArray(info.models) ? info.models : [],
            },
          };
        }
        lastStatusCode = res.status;
      } catch (e: any) {
        lastError = e.message || String(e);
      }
    }

    return { ok: false, error: lastError, statusCode: lastStatusCode };
  }

  private async fetchUserKeys(cleanUrl: string, userId: string, authBearer: string): Promise<SingleKeyInfo[]> {
    const headers = {
      'Accept': 'application/json',
      'Authorization': `Bearer ${authBearer}`,
      'Content-Type': 'application/json',
    };

    // Attempt 1: Call GET /user/info?user_id=...
    try {
      const userRes = await fetch(`${cleanUrl}/user/info?user_id=${encodeURIComponent(userId)}`, {
        headers,
        signal: AbortSignal.timeout(6000),
      });
      if (userRes.ok) {
        const userData = await userRes.json() as any;
        if (Array.isArray(userData?.keys) && userData.keys.length > 0) {
          return userData.keys.map((k: any) => ({
            key: k.token || k.key_name || '',
            maskedKey: k.key_name || (k.token ? this.getMasked(k.token) : ''),
            alias: k.key_alias || k.key_name || 'LiteLLM Key',
            userId: k.user_id || userId,
            spend: typeof k.spend === 'number' ? k.spend : 0,
            maxBudget: k.max_budget != null && Number(k.max_budget) > 0 ? Number(k.max_budget) : null,
            models: Array.isArray(k.models) ? k.models : [],
          }));
        }
      }
    } catch {
      // ignore and fallback to /key/list
    }

    // Attempt 2: Call GET /key/list?user_id=...
    try {
      const listRes = await fetch(`${cleanUrl}/key/list?user_id=${encodeURIComponent(userId)}`, {
        headers,
        signal: AbortSignal.timeout(6000),
      });
      if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);
      const listData = await listRes.json() as any;
      if (!Array.isArray(listData?.keys)) throw new Error('Invalid key list');
      const results: SingleKeyInfo[] = [];
      // ponytail: four keys at a time; tune this if key discovery becomes slow.
      for (let i = 0; i < listData.keys.length; i += 4) {
        const outcomes = await Promise.all(listData.keys.slice(i, i + 4).map((tok: string) =>
          this.fetchSingleKey(cleanUrl, tok, authBearer)
        ));
        for (const outcome of outcomes) {
          if (!outcome.ok || !outcome.info) throw new Error(outcome.error || 'Key info unavailable');
          results.push(outcome.info);
        }
      }
      return results;
    } catch (err: any) {
      throw new Error(`LiteLLM key discovery failed: ${err.message || String(err)}`);
    }
  }

  async testConnection(customConfig?: { baseUrl: string; masterKey?: string; userId?: string; dailyBudgetLimit?: number }): Promise<{ success: boolean; message: string; details?: any }> {
    const cfg = customConfig || getConfig().litellm;
    if (!cfg.baseUrl) {
      return { success: false, message: 'Base URL is required.' };
    }
    const cleanUrl = this.cleanBaseUrl(cfg.baseUrl);
    const keys = this.parseKeys(cfg.masterKey);
    const primaryKey = keys[0];
    let userId = cfg.userId?.trim();

    if (!primaryKey && !userId) {
      return { success: false, message: 'Please provide at least one API key or a User ID.' };
    }

    const discoveredKeys: SingleKeyInfo[] = [];
    let lastError = '';

    // Step 1: Check primary key
    if (primaryKey) {
      const primaryOutcome = await this.fetchSingleKey(cleanUrl, primaryKey);
      if (primaryOutcome.ok && primaryOutcome.info) {
        discoveredKeys.push(primaryOutcome.info);
        if (!userId && primaryOutcome.info.userId) {
          userId = primaryOutcome.info.userId;
        }
      } else if (primaryOutcome.error) {
        lastError = primaryOutcome.error;
      }
    }

    // Step 2: If userId available and primaryKey available, discover all user keys
    if (userId && primaryKey) {
      try {
        const userKeys = await this.fetchUserKeys(cleanUrl, userId, primaryKey);
        for (const uk of userKeys) {
          const idx = discoveredKeys.findIndex(
            k => (uk.alias && k.alias === uk.alias) || (uk.key && k.key === uk.key)
          );
          if (idx === -1) {
            discoveredKeys.push(uk);
          } else if (uk.spend > discoveredKeys[idx].spend) {
            discoveredKeys[idx] = uk;
          }
        }
      } catch (err: any) {
        lastError = err.message || String(err);
      }
    }

    if (discoveredKeys.length > 0) {
      const totalSpend = discoveredKeys.reduce((sum, k) => sum + k.spend, 0);
      const keyBudget = discoveredKeys.find(k => k.maxBudget != null)?.maxBudget || null;
      const totalBudget = cfg.dailyBudgetLimit || keyBudget || 150.0;
      const spendFormatted = this.formatSpend(totalSpend);
      const budgetFormatted = `$${totalBudget.toFixed(2)}`;

      const activeKeys = discoveredKeys.filter(k => k.spend > 0);
      const activeDesc = activeKeys.length > 0
        ? ` (active: ${activeKeys.map(k => `${k.alias} ${this.formatSpend(k.spend)}`).join(', ')})`
        : '';

      return {
        success: true,
        message: `Connected: ${discoveredKeys.length} key(s) • ${spendFormatted} / ${budgetFormatted}${activeDesc}${lastError ? ' • Key discovery incomplete' : ''}`,
        details: discoveredKeys,
      };
    }

    return {
      success: false,
      message: lastError
        ? `LiteLLM error: ${lastError}`
        : `Could not retrieve key or user info from ${cleanUrl}. Verify the master key and permissions.`,
    };
  }

  async fetchData(): Promise<ProviderResult> {
    const cfg = getConfig().litellm;
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
    const keys = this.parseKeys(cfg.masterKey);
    const primaryKey = keys[0];
    let userId = cfg.userId?.trim();

    try {
      const allKeys: SingleKeyInfo[] = [];
      let incomplete = false;

      // Step 1: Query primary masterKey
      if (primaryKey) {
        const primaryOutcome = await this.fetchSingleKey(cleanUrl, primaryKey);
        if (primaryOutcome.ok && primaryOutcome.info) {
          allKeys.push(primaryOutcome.info);
          if (!userId && primaryOutcome.info.userId) {
            userId = primaryOutcome.info.userId;
          }
        } else {
          incomplete = true;
        }
      }

      // Step 2: Discover all user keys if userId and primaryKey are available
      if (userId && primaryKey) {
        try {
          const userKeys = await this.fetchUserKeys(cleanUrl, userId, primaryKey);
          for (const uk of userKeys) {
            const idx = allKeys.findIndex(
              k => (uk.alias && k.alias === uk.alias) || (uk.key && k.key === uk.key)
            );
            if (idx === -1) {
              allKeys.push(uk);
            } else if (uk.spend > allKeys[idx].spend) {
              allKeys[idx] = uk;
            }
          }
        } catch {
          incomplete = true;
        }
      }

      // Step 3: If additional keys configured manually, fetch them
      if (keys.length > 1) {
        for (let i = 1; i < keys.length; i++) {
          const outcome = await this.fetchSingleKey(cleanUrl, keys[i]);
          if (!outcome.ok || !outcome.info) throw new Error(outcome.error || `Key ${i + 1} unavailable`);
          const idx = allKeys.findIndex(
            k => (outcome.info!.alias && k.alias === outcome.info!.alias) || (k.key === outcome.info!.key)
          );
          if (idx === -1) {
            allKeys.push(outcome.info);
          } else if (outcome.info.spend > allKeys[idx].spend) {
            allKeys[idx] = outcome.info;
          }
        }
      }

      let totalSpend = 0;
      let totalBudget = 0;
      let totalModels = 0;
      const notifications: NotificationItem[] = [];

      if (allKeys.length > 0) {
        totalSpend = allKeys.reduce((sum, k) => sum + k.spend, 0);
        const keyBudget = allKeys.find(k => k.maxBudget != null)?.maxBudget || null;
        totalBudget = cfg.dailyBudgetLimit || keyBudget || 150.0;

        const allModels = new Set<string>();
        for (const k of allKeys) {
          for (const m of k.models) allModels.add(m);
        }
        totalModels = allModels.size;

        // Add per-key breakdown to notifications if any key is high
        for (const k of allKeys) {
          const kBudget = k.maxBudget || totalBudget;
          const kPct = kBudget > 0 ? (k.spend / kBudget) * 100 : 0;
          if (kPct >= 80) {
            notifications.push({
              id: `llm-key-warn-${k.maskedKey}`,
              source: 'litellm',
              title: `Key "${k.alias}" at ${Math.round(kPct)}% Budget`,
              subtitle: `${this.formatSpend(k.spend)} spent of $${kBudget.toFixed(2)} limit`,
              timestamp: now,
              level: kPct >= 90 ? 'critical' : 'warning',
            });
          }
        }
      } else if (userId && primaryKey) {
        // Fallback to /user/info without key array
        const userUrl = `${cleanUrl}/user/info?user_id=${encodeURIComponent(userId)}`;
        const headers = { 'Authorization': `Bearer ${primaryKey}` };
        const res = await fetch(userUrl, { headers, signal: AbortSignal.timeout(6000) });
        if (!res.ok) throw new Error(`LiteLLM user info failed (HTTP ${res.status})`);
        const data = await res.json() as any;
        const info = data.user_info || data;
        if (typeof info.spend !== 'number') throw new Error('LiteLLM user info has no spend data');
        totalSpend = info.spend;
        if (info.max_budget != null) totalBudget = Number(info.max_budget);
      }

      if (!allKeys.length && (!userId || !primaryKey)) throw new Error('LiteLLM key info unavailable');

      const budgetLimit = totalBudget > 0 ? totalBudget : (cfg.dailyBudgetLimit || 150.0);
      const rawPct = budgetLimit > 0 ? (totalSpend / budgetLimit) * 100 : 0;
      const pctDisplay = rawPct > 0 && rawPct < 1 ? `${rawPct.toFixed(1)}%` : `${Math.round(rawPct)}%`;

      if (rawPct >= 90) {
        notifications.push({
          id: `llm-budget-crit-${Date.now()}`,
          source: 'litellm',
          title: `LiteLLM Total Budget Critical: ${pctDisplay}`,
          subtitle: `${this.formatSpend(totalSpend)} spent of $${budgetLimit.toFixed(2)} limit`,
          timestamp: now,
          level: 'critical',
        });
      }

      const status = rawPct >= 90 || incomplete ? 'warning' : 'healthy';
      const spendDisplay = this.formatSpend(totalSpend);
      const budgetDisplay = `$${budgetLimit.toFixed(2)}`;

      const statusMessage = allKeys.length === 1
        ? `Key: "${allKeys[0].alias}" • ${spendDisplay} / ${budgetDisplay}`
        : `${allKeys.length} keys tracked • ${spendDisplay} / ${budgetDisplay}`;

      const modelsDisplay = totalModels > 0
        ? `${totalModels} Models`
        : `${allKeys.length} Keys`;

      const metrics: MetricItem[] = [
        {
          key: 'today_spend',
          label: 'Spent',
          value: spendDisplay,
          unit: `/ ${budgetDisplay}`,
          status: rawPct >= 90 ? 'bad' : rawPct >= 75 ? 'warning' : 'good',
        },
        {
          key: 'max_budget',
          label: 'Limit',
          value: budgetDisplay,
          status: 'good',
        },
        {
          key: 'active_models',
          label: 'Models / Keys',
          value: modelsDisplay,
          status: 'good',
        },
        {
          key: 'budget_pct',
          label: 'Budget Used',
          value: pctDisplay,
          status: rawPct >= 90 ? 'bad' : rawPct >= 75 ? 'warning' : 'good',
        },
      ];

      return {
        source: this.name,
        displayName: 'LiteLLM Proxy',
        status,
        statusMessage: `${statusMessage}${incomplete ? ' • Key data incomplete' : ''}`,
        lastUpdated: now,
        metrics,
        notifications,
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
            id: `llm-err-${Date.now()}`,
            source: 'litellm',
            title: 'LiteLLM Connection Error',
            subtitle: err.message || 'Could not fetch key info',
            timestamp: now,
            level: 'critical',
          },
        ],
      };
    }
  }
}
