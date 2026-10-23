import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isSea } from 'node:sea';
import { AppConfig } from '../shared/types.js';

// When running as a packaged SEA binary, resolve config adjacent to the executable
// rather than process.cwd(), ensuring stability when launched from shortcuts or startup scripts.
export const CONFIG_DIR = isSea() ? path.dirname(process.execPath) : path.resolve(process.cwd(), 'config');
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
  transit: {
    destinations: [
      { id: 'port-popowice', name: 'Port Popowice', glyph: '⚓', directOnly: true },
      { id: 'niedzwiedzia', name: 'Niedźwiedzia', glyph: '🏬', directOnly: true },
      { id: 'dworzec-glowny', name: 'Dworzec Główny', glyph: '🚅', directOnly: false },
    ],
  },
  librus: { enabled: false, login: '', password: '' },
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
      // Perform a two-level deep merge per section so newly added default options
      // are preserved when reading older config files from disk.
      currentConfig = {
        ...DEFAULT_CONFIG,
        ...parsed,
        display: { ...DEFAULT_CONFIG.display, ...(parsed.display || {}) },
        gitlab: { ...DEFAULT_CONFIG.gitlab, ...(parsed.gitlab || {}) },
        litellm: { ...DEFAULT_CONFIG.litellm, ...(parsed.litellm || {}) },
        slack: { ...DEFAULT_CONFIG.slack, ...(parsed.slack || {}) },
        email: { ...DEFAULT_CONFIG.email, ...(parsed.email || {}) },
        calendar: { ...DEFAULT_CONFIG.calendar, ...(parsed.calendar || {}) },
        librus: { ...DEFAULT_CONFIG.librus, ...(parsed.librus || {}) },
        transit: { ...DEFAULT_CONFIG.transit, ...(parsed.transit || {}) },
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

function validateTransitDestinations(value: unknown): void {
  if (!Array.isArray(value) || value.length > 24) throw new TypeError('Use up to 24 transit destinations');
  const ids = new Set<string>();
  for (const destination of value) {
    if (!isRecord(destination) || Object.keys(destination).some(key => !['id', 'name', 'glyph', 'directOnly'].includes(key)) ||
        typeof destination.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(destination.id) || ids.has(destination.id) ||
        typeof destination.name !== 'string' || !destination.name.trim() || destination.name.length > 100 ||
        typeof destination.glyph !== 'string' || !destination.glyph.trim() || destination.glyph.length > 32 ||
        typeof destination.directOnly !== 'boolean') {
      throw new TypeError('Each transit destination needs a unique ID, stop name, icon, and direct-only option');
    }
    ids.add(destination.id);
  }
}

// Strict runtime schema validation against DEFAULT_CONFIG prototypes and numeric bounds.
// targetMonitorIndex is explicitly allowed as an optional display property not present in defaults.
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
      if (section === 'transit' && field === 'destinations') {
        validateTransitDestinations(fieldValue);
        continue;
      }
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
    librus: { ...currentConfig.librus, ...(newConfig.librus || {}) },
    transit: { ...currentConfig.transit, ...(newConfig.transit || {}) },
  };

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // Write atomically via a temporary file with owner-only permissions (0o600) and sync flush
  // before renaming, preventing partial-write corruption and protecting credential confidentiality.
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
    librus: {
      ...cfg.librus,
      password: '',
      hasPassword: Boolean(cfg.librus.password),
    },
    // Private iCal feeds embed auth tokens directly within query parameters or path segments;
    // strip URLs completely and return boolean indicators to avoid leaking access tokens to the UI.
    calendar: {
      ...cfg.calendar,
      corporateUrl: '',
      personalUrl: '',
      hasCorporateUrl: Boolean(cfg.calendar.corporateUrl),
      hasPersonalUrl: Boolean(cfg.calendar.personalUrl),
    },
  };
}
