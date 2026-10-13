import express, { Request, Response } from 'express';
import path from 'node:path';
import { getAsset, isSea } from 'node:sea';
import { loadConfig, saveConfig, getSanitizedConfig, getConfig } from './config.js';
import { GitLabProvider } from './providers/gitlab.js';
import { LiteLLMProvider } from './providers/litellm.js';
import { SlackProvider } from './providers/slack.js';
import { EmailProvider } from './providers/email.js';
import { CalendarProvider } from './providers/calendar.js';
import { getMockProvidersData } from './providers/mock.js';
import { getSystemStats } from './system-stats.js';
import { logError, logSlackPoll } from './error-log.js';
import {
  detectWindowsMonitors,
  launchHUDOnMonitor,
  clipMouseToMonitors,
  releaseMouseClip,
} from './monitor.js';
import { DashboardState, NotificationItem, ProviderResult } from '../shared/types.js';

// In Single Executable Application (SEA) mode, client assets are embedded directly
// in the executable binary via node:sea and served from memory rather than disk.
const SEA_MODE = isSea();
const CLIENT_DIR = path.resolve(process.cwd(), 'src/client');

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3888;

function sendClientFile(res: Response, file: string) {
  if (SEA_MODE) return res.type(path.extname(file)).send(Buffer.from(getAsset(`client/${file}`)));
  return res.sendFile(path.join(CLIENT_DIR, file));
}

app.use(express.json());
if (SEA_MODE) {
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const file = req.path === '/' ? 'index.html' : req.path.slice(1);
    try {
      res.type(path.extname(file)).send(Buffer.from(getAsset(`client/${file}`)));
    } catch {
      next();
    }
  });
} else {
  app.use(express.static(CLIENT_DIR));
}

// Load configuration
loadConfig();

// Instantiate providers
const gitlabProvider = new GitLabProvider();
const litellmProvider = new LiteLLMProvider();
const slackProvider = new SlackProvider();
const emailProvider = new EmailProvider();
const calendarProvider = new CalendarProvider();

// In-memory state cache
let latestState: DashboardState = {
  timestamp: new Date().toISOString(),
  orientation: getConfig().display.orientation || 'horizontal',
  scale: getConfig().display.scale || 1.0,
  providers: {},
  recentAlerts: [],
};

// SSE Subscribers
const sseClients: Response[] = [];

function broadcastState(state: DashboardState) {
  const data = `data: ${JSON.stringify(state)}\n\n`;
  // Iterate backwards so dead SSE client connections can be pruned via splice()
  // during iteration without skipping subsequent clients.
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try {
      sseClients[i].write(data);
    } catch {
      sseClients.splice(i, 1);
    }
  }
}

// Polling manager
let isPolling = false;
let refreshPending = false;
// Keep the last GitLab result through five consecutive failed polls.
let gitlabConsecutiveErrors = 0;

// Single-flight poll latch: prevents overlapping provider fetches while queuing
// an immediate follow-up poll if a configuration change arrives while polling is active.
async function pollAllProviders(configRefresh = false) {
  if (isPolling) {
    if (configRefresh) refreshPending = true;
    return;
  }
  isPolling = true;

  try {
    const cfg = getConfig();
    const providersResult: Record<string, ProviderResult> = {};
    const allAlerts: NotificationItem[] = [];
    const systemStats = getSystemStats();

    if (cfg.mockMode) {
      gitlabConsecutiveErrors = 0;
      // Use mock providers
      const mockData = getMockProvidersData();
      Object.assign(providersResult, mockData);
    } else {
      // Real providers polled concurrently
      const results = await Promise.allSettled([
        gitlabProvider.fetchData(),
        litellmProvider.fetchData(),
        slackProvider.fetchData(),
        emailProvider.fetchData(),
        calendarProvider.fetchData().catch(err => {
          console.error('[Calendar] Polling failed:', err);
          logError('Calendar polling', err);
          return {
            source: 'calendar',
            displayName: 'Upcoming Meetings',
            status: 'error' as const,
            statusMessage: 'Calendar feed unavailable',
            lastUpdated: new Date().toISOString(),
            metrics: [],
            notifications: [],
            details: { meetings: [] },
          };
        }),
      ]);

      for (const res of results) {
        if (res.status === 'fulfilled') {
          const providerData = res.value;
          if (
            providerData.source === 'slack' &&
            providerData.details &&
            'requestCount' in providerData.details &&
            typeof providerData.details.requestCount === 'number'
          ) {
            const details = providerData.details;
            logSlackPoll({
              status: providerData.status,
              statusMessage: providerData.statusMessage,
              requestCount: details.requestCount,
              requestCounts: 'requestCounts' in details ? details.requestCounts : {},
              incompleteReasons: 'incompleteReasons' in details ? details.incompleteReasons : [],
              historyCacheHits: 'historyCacheHits' in details ? details.historyCacheHits : 0,
              discoveryCache: 'discoveryCache' in details ? details.discoveryCache : {},
            });
          }
          if (providerData.source === 'gitlab') {
            // Dampen transient GitLab API hiccups: preserve the last known good state for up to
            // five consecutive failed polls (~5 minutes) before surfacing the error to the HUD.
            gitlabConsecutiveErrors = providerData.status === 'error' ? gitlabConsecutiveErrors + 1 : 0;
            if (providerData.status === 'error' && gitlabConsecutiveErrors <= 5) {
              if (latestState.providers.gitlab) providersResult.gitlab = latestState.providers.gitlab;
              logError(providerData.displayName, providerData.statusMessage || 'Unknown provider error');
              continue;
            }
          }
          providersResult[providerData.source] = providerData;
          if (providerData.status === 'error') {
            logError(providerData.displayName, providerData.statusMessage || 'Unknown provider error');
          }
        }
      }
    }

    providersResult.system = await systemStats;

    for (const key of ['gitlab', 'litellm', 'slack', 'email', 'calendar'] as const) {
      if (!cfg[key].enabled) delete providersResult[key];
      else allAlerts.push(...(providersResult[key]?.notifications || []));
    }

    // Sort alerts by timestamp descending
    allAlerts.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    latestState = {
      timestamp: new Date().toISOString(),
      orientation: cfg.display.orientation,
      scale: cfg.display.scale,
      providers: providersResult,
      recentAlerts: allAlerts.slice(0, 10),
    };

    broadcastState(latestState);
  } catch (err) {
    console.error('[Poller] Error during provider polling cycle:', err);
    logError('Poller', err);
  } finally {
    isPolling = false;
    if (refreshPending) {
      refreshPending = false;
      void pollAllProviders();
    }
  }
}

// Initial poll and recurring timer
pollAllProviders();
setInterval(pollAllProviders, 60000); // 60 second cycle

// Routes
app.get('/api/state', (req: Request, res: Response) => {
  res.json(latestState);
});

// Server-Sent Events (SSE) for zero-latency push to HUD
app.get('/api/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  // Flush headers immediately to establish the SSE stream, then push current state
  // so the connecting HUD displays data instantly without waiting for the next poll cycle.
  res.flushHeaders();

  // Send current state immediately
  res.write(`data: ${JSON.stringify(latestState)}\n\n`);

  sseClients.push(res);

  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) {
      sseClients.splice(idx, 1);
    }
  });
});

app.get('/api/config', (req: Request, res: Response) => {
  res.json(getSanitizedConfig());
});

app.post('/api/config', (req: Request, res: Response) => {
  try {
    saveConfig(req.body);
    // Trigger immediate refresh with new settings
    setTimeout(() => pollAllProviders(true), 100);
    res.json({ success: true, config: getSanitizedConfig() });
  } catch (err) {
    if (err instanceof TypeError) return res.status(400).json({ success: false, message: err.message });
    console.error('[Config] Failed to save config to disk:', err);
    logError('Config save', err);
    return res.status(500).json({ success: false, message: 'Failed to save configuration' });
  }
});

// Test Connection Endpoints
app.post('/api/test/:provider', async (req: Request, res: Response) => {
  const provider = req.params.provider;
  const payload = req.body;

  try {
    switch (provider) {
      case 'gitlab': {
        const testRes = await gitlabProvider.testConnection(payload);
        return res.json(testRes);
      }
      case 'litellm': {
        const testRes = await litellmProvider.testConnection(payload);
        return res.json(testRes);
      }
      case 'slack': {
        const testRes = await slackProvider.testConnection(payload);
        return res.json(testRes);
      }
      case 'email': {
        const testRes = await emailProvider.testConnection(payload);
        return res.json(testRes);
      }
      case 'calendar': {
        const testRes = await calendarProvider.testConnection(payload);
        return res.json(testRes);
      }
      default:
        return res.status(400).json({ success: false, message: `Unknown provider: ${provider}` });
    }
  } catch (err: any) {
    return res.status(500).json({ success: false, message: `Test failed: ${err.message || String(err)}` });
  }
});

// Monitor Detection & Launcher Endpoints
app.get('/api/monitors', async (req: Request, res: Response) => {
  const monitors = await detectWindowsMonitors();
  res.json(monitors);
});

app.post('/api/launch', async (req: Request, res: Response) => {
  const { monitorIndex } = req.body;
  const monitors = await detectWindowsMonitors();
  const monitor = monitors.find(m => m.index === Number(monitorIndex)) || monitors[0];

  const hudUrl = `http://localhost:${PORT}/index.html`;
  const result = await launchHUDOnMonitor(monitor, hudUrl);
  res.json(result);
});

app.post('/api/mouse/lock', async (req: Request, res: Response) => {
  const result = await clipMouseToMonitors();
  res.json(result);
});

app.post('/api/mouse/unlock', async (req: Request, res: Response) => {
  const result = await releaseMouseClip();
  res.json(result);
});

// Client routes
app.get('/settings', (req: Request, res: Response) => {
  sendClientFile(res, 'settings.html');
});

app.get('/hud', (req: Request, res: Response) => {
  sendClientFile(res, 'index.html');
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`=======================================================`);
  console.log(`🚀 Control Panel Server started!`);
  console.log(`   HUD View (for 8.8" screen):    http://localhost:${PORT}/`);
  console.log(`   Settings & Auth (main screen): http://localhost:${PORT}/settings`);
  console.log(`=======================================================`);
});
