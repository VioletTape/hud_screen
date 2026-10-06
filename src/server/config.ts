import fs from 'node:fs';
import path from 'node:path';
import { isSea } from 'node:sea';
import { AppConfig } from '../shared/types.js';

const CONFIG_DIR = isSea() ? path.dirname(process.execPath) : path.resolve(process.cwd(), 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export const DEFAULT_CONFIG: AppConfig = {
  mockMode: true,
  display: {
    orientation: 'horizontal',
    scale: 1.0,
    theme: 'oled-dark',
    enableMouseTrapProtection: true,
  },
  gitlab: {
    enabled: false,
    baseUrl: 'https://gitlab.example.com',
    token: '',
    projectIds: [],
    pollIntervalSec: 60,
  },
  litellm: {
    enabled: false,
    baseUrl: 'http://localhost:4000',
    masterKey: '',
    userId: '',
    dailyBudgetLimit: 20.0,
    pollIntervalSec: 30,
  },
  slack: {
    enabled: false,
    botToken: '',
    userToken: '',
    trackedChannels: [],
    pollIntervalSec: 30,
  },
  email: {
    enabled: false,
    host: 'imap.example.com',
    port: 993,
    secure: true,
    user: '',
    password: '',
    mailbox: 'INBOX',
    pollIntervalSec: 60,
  },
  calendar: {
    enabled: true,
    corporateUrl: '',
    personalUrl: '',
  },
};

let currentConfig: AppConfig = { ...DEFAULT_CONFIG };

export function loadConfig(): AppConfig {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      currentConfig = {
        ...DEFAULT_CONFIG,
        ...parsed,
        display: { ...DEFAULT_CONFIG.display, ...(parsed.display || {}) },
        gitlab: { ...DEFAULT_CONFIG.gitlab, ...(parsed.gitlab || {}) },
        litellm: { ...DEFAULT_CONFIG.litellm, ...(parsed.litellm || {}) },
        slack: { ...DEFAULT_CONFIG.slack, ...(parsed.slack || {}) },
        email: { ...DEFAULT_CONFIG.email, ...(parsed.email || {}) },
        calendar: { ...DEFAULT_CONFIG.calendar, ...(parsed.calendar || {}) },
      };
    } else {
      saveConfig(DEFAULT_CONFIG);
    }
  } catch (err) {
    console.error('[Config] Failed to load config file, falling back to defaults:', err);
    currentConfig = { ...DEFAULT_CONFIG };
  }
  return currentConfig;
}

export function getConfig(): AppConfig {
  return currentConfig;
}

export function saveConfig(newConfig: Partial<AppConfig>): AppConfig {
  currentConfig = {
    ...currentConfig,
    ...newConfig,
    display: { ...currentConfig.display, ...(newConfig.display || {}) },
    gitlab: { ...currentConfig.gitlab, ...(newConfig.gitlab || {}) },
    litellm: { ...currentConfig.litellm, ...(newConfig.litellm || {}) },
    slack: { ...currentConfig.slack, ...(newConfig.slack || {}) },
    email: { ...currentConfig.email, ...(newConfig.email || {}) },
    calendar: { ...currentConfig.calendar, ...(newConfig.calendar || {}) },
  };

  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(currentConfig, null, 2), 'utf-8');
    console.log('[Config] Config saved successfully to', CONFIG_FILE);
  } catch (err) {
    console.error('[Config] Failed to save config to disk:', err);
  }
  return currentConfig;
}

export function getSanitizedConfig(): Record<string, any> {
  const cfg = getConfig();
  return {
    ...cfg,
    gitlab: {
      ...cfg.gitlab,
      token: cfg.gitlab.token ? '••••••••' + cfg.gitlab.token.slice(-4) : '',
      hasToken: Boolean(cfg.gitlab.token),
    },
    litellm: {
      ...cfg.litellm,
      masterKey: cfg.litellm.masterKey ? '••••••••' + cfg.litellm.masterKey.slice(-4) : '',
      hasMasterKey: Boolean(cfg.litellm.masterKey),
    },
    slack: {
      ...cfg.slack,
      botToken: cfg.slack.botToken ? '••••••••' + cfg.slack.botToken.slice(-4) : '',
      userToken: cfg.slack.userToken ? '••••••••' + cfg.slack.userToken.slice(-4) : '',
      hasToken: Boolean(cfg.slack.botToken || cfg.slack.userToken),
    },
    email: {
      ...cfg.email,
      password: cfg.email.password ? '••••••••' : '',
      hasPassword: Boolean(cfg.email.password),
    },
    calendar: {
      ...cfg.calendar,
      corporateUrl: '',
      personalUrl: '',
      hasCorporateUrl: Boolean(cfg.calendar.corporateUrl),
      hasPersonalUrl: Boolean(cfg.calendar.personalUrl),
    },
  };
}
