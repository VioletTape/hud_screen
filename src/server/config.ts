import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateConfigPatch(value: unknown): asserts value is Partial<AppConfig> {
  if (!isRecord(value)) throw new TypeError('Configuration must be an object');
  const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;
  for (const [section, fields] of Object.entries(value)) {
    if (!Object.hasOwn(defaults, section)) throw new TypeError(`Unknown configuration section: ${section}`);
    if (section === 'mockMode') {
      if (typeof fields !== 'boolean') throw new TypeError('mockMode must be a boolean');
      continue;
    }
    if (!isRecord(fields)) throw new TypeError(`${section} must be an object`);
    const sectionDefaults = defaults[section] as Record<string, unknown>;
    for (const [field, fieldValue] of Object.entries(fields)) {
      if (!Object.hasOwn(sectionDefaults, field) && !(section === 'display' && field === 'targetMonitorIndex')) {
        throw new TypeError(`Unknown configuration field: ${section}.${field}`);
      }
      const expected = sectionDefaults[field];
      const valid = field === 'targetMonitorIndex' && section === 'display'
        ? Number.isInteger(fieldValue) && (fieldValue as number) >= 0
        : Array.isArray(expected)
          ? Array.isArray(fieldValue) && fieldValue.every(item => typeof item === 'string')
          : typeof fieldValue === typeof expected && (
            typeof fieldValue !== 'number' || Number.isFinite(fieldValue)
          );
      if (!valid) throw new TypeError(`Invalid configuration field: ${section}.${field}`);
      if (typeof fieldValue === 'number' && (
        (field === 'port' && (!Number.isInteger(fieldValue) || fieldValue < 1 || fieldValue > 65535)) ||
        (field === 'pollIntervalSec' && (!Number.isInteger(fieldValue) || fieldValue < 1)) ||
        (field === 'scale' && fieldValue <= 0) ||
        (field === 'dailyBudgetLimit' && fieldValue < 0)
      )) throw new TypeError(`Invalid configuration field: ${section}.${field}`);
      if (section === 'display' && field === 'orientation' && !['horizontal', 'vertical'].includes(fieldValue as string)) {
        throw new TypeError('Invalid display.orientation');
      }
      if (section === 'display' && field === 'theme' && !['oled-dark', 'cyberpunk', 'graphite'].includes(fieldValue as string)) {
        throw new TypeError('Invalid display.theme');
      }
    }
  }
}

export function saveConfig(newConfig: unknown): AppConfig {
  validateConfigPatch(newConfig);
  const updatedConfig: AppConfig = {
    ...currentConfig,
    ...newConfig,
    display: { ...currentConfig.display, ...(newConfig.display || {}) },
    gitlab: { ...currentConfig.gitlab, ...(newConfig.gitlab || {}) },
    litellm: { ...currentConfig.litellm, ...(newConfig.litellm || {}) },
    slack: { ...currentConfig.slack, ...(newConfig.slack || {}) },
    email: { ...currentConfig.email, ...(newConfig.email || {}) },
    calendar: { ...currentConfig.calendar, ...(newConfig.calendar || {}) },
  };

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tempFile = path.join(CONFIG_DIR, `.config-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempFile, JSON.stringify(updatedConfig, null, 2), {
      encoding: 'utf-8', mode: 0o600, flag: 'wx', flush: true,
    });
    fs.renameSync(tempFile, CONFIG_FILE);
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
  currentConfig = updatedConfig;
  console.log('[Config] Config saved successfully to', CONFIG_FILE);
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
