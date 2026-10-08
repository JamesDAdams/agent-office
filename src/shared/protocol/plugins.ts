// Manifest and configuration for Agent Office plugins.

export type PluginCapability = 'floors' | 'queue' | 'services' | 'agent' | 'issues' | 'pulls';

export interface PluginManifest {
  id: string;
  name: string;
  author?: string;
  description: string;
  capabilities: PluginCapability[];
  githubUrl?: string;
  installed?: boolean;
  status?: 'active' | 'inactive' | 'error';
  error?: string;
  version?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  local?: boolean;
}

export interface PluginsState {
  plugins: PluginManifest[];
  store?: PluginManifest[];
  pluginsDir?: string;
}
