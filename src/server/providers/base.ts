import { ProviderResult } from '../../shared/types.js';

export interface IProvider {
  name: string;
  displayName: string;
  isEnabled(): boolean;
  testConnection(): Promise<{ success: boolean; message: string; details?: any }>;
  fetchData(): Promise<ProviderResult>;
}
