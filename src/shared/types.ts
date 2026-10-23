export type ProviderStatus = 'healthy' | 'warning' | 'error' | 'disabled';

export interface NotificationItem {
  id: string;
  source: string;
  title: string;
  subtitle?: string;
  timestamp: string;
  level: 'info' | 'warning' | 'critical' | 'success';
  meta?: Record<string, any>;
}

export interface MetricItem {
  key: string;
  label: string;
  value: string | number;
  unit?: string;
  change?: string;
  status?: 'good' | 'warning' | 'bad' | 'neutral';
}

export interface ProviderResult {
  source: string;
  displayName: string;
  status: ProviderStatus;
  statusMessage?: string;
  lastUpdated: string;
  metrics: MetricItem[];
  notifications: NotificationItem[];
  details?: Record<string, any>;
}

export interface DashboardState {
  timestamp: string;
  orientation: 'horizontal' | 'vertical';
  scale: number;
  providers: Record<string, ProviderResult>;
  recentAlerts: NotificationItem[];
  transitDestinations: TransitDestination[];
}

export interface GitLabConfig {
  enabled: boolean;
  baseUrl: string;
  token: string;
  projectIds?: string[];
  pollIntervalSec: number;
}

export interface LiteLLMConfig {
  enabled: boolean;
  baseUrl: string;
  masterKey: string;
  userId?: string;
  dailyBudgetLimit?: number;
  pollIntervalSec: number;
}

export interface SlackConfig {
  enabled: boolean;
  botToken?: string;
  userToken?: string;
  trackedChannels?: string[];
  pollIntervalSec: number;
}

export interface EmailConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password?: string;
  mailbox?: string;
  pollIntervalSec: number;
}

export interface CalendarConfig {
  enabled: boolean;
  corporateUrl: string;
  personalUrl: string;
}

export interface LibrusConfig {
  enabled: boolean;
  login: string;
  password: string;
}

export interface SchoolDay {
  date: string;
  firstLessonStart?: string;
  firstLessonTitle?: string;
  lastLessonEnd?: string;
}

export interface TransitDestination {
  id: string;
  name: string;
  glyph: string;
  directOnly: boolean;
}

export interface TransitConfig {
  destinations: TransitDestination[];
}

export interface DisplayConfig {
  orientation: 'horizontal' | 'vertical';
  targetMonitorIndex?: number;
  scale: number;
  theme: 'oled-dark' | 'cyberpunk' | 'graphite';
  enableMouseTrapProtection: boolean;
}

export interface AppConfig {
  mockMode: boolean;
  display: DisplayConfig;
  gitlab: GitLabConfig;
  litellm: LiteLLMConfig;
  slack: SlackConfig;
  email: EmailConfig;
  calendar: CalendarConfig;
  librus: LibrusConfig;
  transit: TransitConfig;
}
