import path from 'node:path';
import Conf from 'conf';
import envPaths from 'env-paths';
import { isSea } from 'node:sea';
import { AppConfig } from '../shared/types.js';

// When running as a packaged SEA binary, resolve config adjacent to the executable
// rather than process.cwd(), ensuring stability when launched from shortcuts or startup scripts.
export const CONFIG_DIR = isSea() ? path.dirname(process.execPath) : path.resolve(process.cwd(), 'config');

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deserializeConfig(text: string): Record<string, any> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new SyntaxError('Configuration document is not valid JSON');
  }
  if (!isRecord(parsed)) throw new TypeError('Configuration document must be an object');
  return parsed;
}

export const SECRET_FIELDS: Record<string, string[]> = {
  gitlab: ['token'],
  litellm: ['masterKey'],
  slack: ['botToken', 'userToken'],
  email: ['password'],
  calendar: ['corporateUrl', 'personalUrl'],
  librus: ['login', 'password'],
};

type UserSecrets = Record<string, Record<string, string>>;
let userSecretsStore: Conf<UserSecrets>;
let workspaceConfigStore: Conf<Record<string, any>>;

function getUserSecretsStore(): Conf<UserSecrets> {
  const secretsPath = getUserSecretsPath();
  return userSecretsStore ??= new Conf<UserSecrets>({
    configName: path.basename(secretsPath),
    fileExtension: '',
    cwd: path.dirname(secretsPath),
    configFileMode: 0o600,
    deserialize: deserializeConfig,
    schema: Object.fromEntries(Object.entries(SECRET_FIELDS).map(([section, fields]) => [section, {
      type: 'object',
      properties: Object.fromEntries(fields.map(field => [field, { type: 'string' }])),
      additionalProperties: false,
    }])),
    rootSchema: { additionalProperties: false },
  });
}

function getWorkspaceConfigStore(): Conf<Record<string, any>> {
  return workspaceConfigStore ??= new Conf({
    cwd: CONFIG_DIR, configName: 'config', configFileMode: 0o600, deserialize: deserializeConfig,
  });
}

export function getUserSecretsPath(): string {
  if (process.env.SCREEN_HUD_SECRETS_PATH) return path.resolve(process.env.SCREEN_HUD_SECRETS_PATH);
  // Keep the existing Windows location; other platforms use the same path library as conf.
  const directory = process.platform === 'win32' && process.env.APPDATA
    ? path.join(process.env.APPDATA, 'ScreenHud') : envPaths('ScreenHud', { suffix: '' }).config;
  return path.join(directory, 'secrets.json');
}

export function extractSecretsFrom(config: Record<string, any>, options: { includeEmpty?: boolean } = {}): Record<string, any> {
  const { includeEmpty = false } = options;
  const secrets: Record<string, any> = {};
  for (const [section, fields] of Object.entries(SECRET_FIELDS)) {
    if (isRecord(config[section])) {
      for (const field of fields) {
        if (!Object.prototype.hasOwnProperty.call(config[section], field)) continue;
        const val = config[section][field];
        if (typeof val === 'string') {
          if (val.trim() !== '' || includeEmpty) {
            if (!secrets[section]) secrets[section] = {};
            secrets[section][field] = val;
          }
        }
      }
    }
  }
  return secrets;
}

export function stripSecretsFrom(config: Record<string, any>): Record<string, any> {
  const stripped = JSON.parse(JSON.stringify(config));
  for (const [section, fields] of Object.entries(SECRET_FIELDS)) {
    if (isRecord(stripped[section])) {
      for (const field of fields) {
        if (field in stripped[section]) {
          stripped[section][field] = '';
        }
      }
    }
  }
  return stripped;
}

export function loadUserSecrets(): UserSecrets {
  return getUserSecretsStore().store;
}

export function saveUserSecrets(secretsPatch: UserSecrets): void {
  const store = getUserSecretsStore();
  const merged = store.store;
  for (const [section, fields] of Object.entries(secretsPatch)) {
    merged[section] = { ...merged[section], ...fields };
    for (const [field, value] of Object.entries(fields)) {
      if (value === '') delete merged[section][field];
    }
    if (Object.keys(merged[section]).length === 0) delete merged[section];
  }
  store.store = merged;
}

export const DEFAULT_CONFIG: AppConfig = {
  mockMode: true,
  display: {
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
    thresholdEnabled: false,
    thresholdHours: 12,
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
  const store = getWorkspaceConfigStore();
  let parsed = store.store;
  const userSecrets = loadUserSecrets();
  const extracted = extractSecretsFrom(parsed);
  if (Object.keys(extracted).length > 0) {
    for (const [section, fields] of Object.entries(extracted)) {
      userSecrets[section] = { ...fields, ...userSecrets[section] };
    }
    getUserSecretsStore().store = userSecrets;
    parsed = stripSecretsFrom(parsed);
    store.store = parsed;
    console.log('[Config] Migrated workspace secrets to', getUserSecretsPath());
  } else if (Object.keys(parsed).length === 0) {
    parsed = stripSecretsFrom(DEFAULT_CONFIG);
    store.store = parsed;
  }

  currentConfig = {
    ...DEFAULT_CONFIG,
    ...parsed,
    display: { ...DEFAULT_CONFIG.display, ...(parsed.display || {}) },
    gitlab: { ...DEFAULT_CONFIG.gitlab, ...(parsed.gitlab || {}), ...(userSecrets.gitlab || {}) },
    litellm: { ...DEFAULT_CONFIG.litellm, ...(parsed.litellm || {}), ...(userSecrets.litellm || {}) },
    slack: { ...DEFAULT_CONFIG.slack, ...(parsed.slack || {}), ...(userSecrets.slack || {}) },
    email: { ...DEFAULT_CONFIG.email, ...(parsed.email || {}), ...(userSecrets.email || {}) },
    calendar: { ...DEFAULT_CONFIG.calendar, ...(parsed.calendar || {}), ...(userSecrets.calendar || {}) },
    librus: { ...DEFAULT_CONFIG.librus, ...(parsed.librus || {}), ...(userSecrets.librus || {}) },
    transit: { ...DEFAULT_CONFIG.transit, ...(parsed.transit || {}) },
  };
  return currentConfig;
}

export function getConfig(): AppConfig {
  return currentConfig;
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
        (field === 'dailyBudgetLimit' && fieldValue < 0) ||
        (field === 'thresholdHours' && (!Number.isInteger(fieldValue) || fieldValue < 1 || fieldValue > 168))
      )) throw new TypeError(`Invalid configuration field: ${section}.${field}`);
      if (section === 'display' && field === 'theme' && !['oled-dark', 'cyberpunk', 'graphite'].includes(fieldValue as string)) {
        throw new TypeError('Invalid display.theme');
      }
    }
  }
}

export function saveConfig(newConfig: unknown): AppConfig {
  validateConfigPatch(newConfig);
  const patch = newConfig as Partial<AppConfig>;
  const baseConfig = loadConfig();

  const secretsPatch = extractSecretsFrom(patch as Record<string, any>, { includeEmpty: true });
  const hasSecretsPatch = Object.keys(secretsPatch).length > 0;
  const previousSecrets = hasSecretsPatch ? loadUserSecrets() : undefined;

  // Merge full configuration in memory
  const updatedConfig: AppConfig = {
    ...baseConfig,
    ...patch,
    display: { ...baseConfig.display, ...(patch.display || {}) },
    gitlab: { ...baseConfig.gitlab, ...(patch.gitlab || {}) },
    litellm: { ...baseConfig.litellm, ...(patch.litellm || {}) },
    slack: { ...baseConfig.slack, ...(patch.slack || {}) },
    email: { ...baseConfig.email, ...(patch.email || {}) },
    calendar: { ...baseConfig.calendar, ...(patch.calendar || {}) },
    librus: { ...baseConfig.librus, ...(patch.librus || {}) },
    transit: { ...baseConfig.transit, ...(patch.transit || {}) },
  };

  let secretsSaved = false;
  // shortcut: rollback covers write errors, add recovery if saves must survive process termination.
  try {
    if (hasSecretsPatch) {
      saveUserSecrets(secretsPatch);
      secretsSaved = true;
    }
    getWorkspaceConfigStore().store = stripSecretsFrom(updatedConfig);
  } catch (error) {
    if (secretsSaved) {
      try {
        getUserSecretsStore().store = previousSecrets!;
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Configuration save failed and previous secrets could not be restored');
      }
    }
    throw error;
  }
  currentConfig = updatedConfig;
  console.log('[Config] Config saved successfully to', getWorkspaceConfigStore().path);
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
