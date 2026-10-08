import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FloorDef } from '../building.js';
import type { Floor } from '../floor.js';
import type { FloorInfo, GhIssue, GhPull, PluginManifest, PluginsState, ServiceInfo, WorkerInfo } from '../../shared/protocol.js';
import type { Ctx } from '../office/context.js';
import { PluginRegistry } from './registry.js';
import type { AgentProviderPlugin, FloorProvider, IssuesAdapter, OfficePlugin, ProjectsProvider, PullsAdapter, QueueAdapter, ServicesProvider } from './types.js';
import type { AgentProvider } from '../../shared/providers.js';
import { PROVIDER_META, registerAgentProvider, unregisterAgentProvider } from '../../shared/providers.js';
import { registerAgentProviderAdapter, unregisterAgentProviderAdapter } from '../providers/index.js';

const ENTRY_CANDIDATES = ['dist/index.js', 'index.js', 'plugin.js', 'dist/index.mjs', 'index.mjs'];

function parseGitUrl(url: string): { id: string; cloneUrl: string } | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const ALLOWED_PROTOCOLS = ['https:', 'http:', 'git:', 'ssh:'];
  try {
    const parsedUrl = new URL(trimmed);
    if (!ALLOWED_PROTOCOLS.includes(parsedUrl.protocol)) return null;
  } catch {
    if (!trimmed.includes('@') && !trimmed.startsWith('git://')) return null;
  }

  let cloneUrl = trimmed;
  if (cloneUrl.startsWith('-')) return null;
  if (cloneUrl.endsWith('/')) cloneUrl = cloneUrl.slice(0, -1);
  if (!cloneUrl.endsWith('.git')) cloneUrl += '.git';
  const match = /([^/]+?)(?:\.git)?$/.exec(cloneUrl);
  if (!match) return null;
  const id = match[1].toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  return { id, cloneUrl };
}

function getPluginDir(id: string, pluginsDir?: string): string {
  return path.join(pluginsDir ?? path.join(process.cwd(), '.agent-office', 'plugins'), id);
}

function candidatePluginDirs(id: string, registryPluginsDir?: string): string[] {
  return [path.join(process.cwd(), '.agent-office', 'plugins', id), registryPluginsDir ? path.join(registryPluginsDir, id) : null, path.resolve(process.cwd(), '..', 'agent-office-plugins', `agentoffice-${id}`), path.resolve(process.cwd(), '..', 'agent-office-plugins', `${id}-plugin-for-agent-office`), path.resolve(process.cwd(), '..', 'agent-office-plugins', `agent-office-plugin-${id}`), path.resolve(process.cwd(), '..', 'agent-office-plugins', id), path.resolve(process.cwd(), 'agent-office-plugins', `agentoffice-${id}`), path.resolve(process.cwd(), 'agent-office-plugins', `${id}-plugin-for-agent-office`), path.resolve(process.cwd(), 'agent-office-plugins', `agent-office-plugin-${id}`), path.resolve(process.cwd(), 'agent-office-plugins', id)].filter(Boolean) as string[];
}

function candidatePluginFiles(id: string, registryPluginsDir?: string): string[] {
  return [path.join(process.cwd(), `${id}.js`), registryPluginsDir ? path.join(registryPluginsDir, `${id}.js`) : null, registryPluginsDir ? path.join(registryPluginsDir, `${id}.mjs`) : null].filter(Boolean) as string[];
}

function detectEntryPath(pluginDir: string): string | null {
  for (const candidate of ENTRY_CANDIDATES) {
    const p = path.join(pluginDir, candidate);
    if (existsSync(p)) return p;
  }
  const pkgPath = path.join(pluginDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { main?: string; module?: string };
      const entry = pkg.main || pkg.module;
      if (entry) {
        const p = path.join(pluginDir, entry);
        if (existsSync(p)) return p;
      }
    } catch {
    }
  }
  return null;
}

function resolvePluginEntry(id: string, registryPluginsDir?: string, explicitEntry?: string): string | null {
  if (explicitEntry) {
    const resolved = path.isAbsolute(explicitEntry) ? explicitEntry : path.resolve(process.cwd(), explicitEntry);
    if (existsSync(resolved)) return resolved;
    if (registryPluginsDir) {
      const inReg = path.resolve(registryPluginsDir, path.basename(explicitEntry));
      if (existsSync(inReg)) return inReg;
    }
  }

  for (const dir of candidatePluginDirs(id, registryPluginsDir)) {
    if (existsSync(dir)) {
      const entry = detectEntryPath(dir);
      if (entry) return entry;
    }
  }

  for (const file of candidatePluginFiles(id, registryPluginsDir)) {
    if (existsSync(file)) return file;
  }

  return null;
}

async function fetchLatestRelease(githubUrl: string): Promise<string | null> {
  try {
    const match = /github\.com\/([^/]+)\/([^/]+)/.exec(githubUrl);
    if (!match) return null;
    const [, owner, repo] = match;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
    const res = await fetch(apiUrl, { headers: { Accept: 'application/vnd.github.v3+json' } });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string };
    return data.tag_name ?? null;
  } catch {
    return null;
  }
}

export class PluginManager {
  private registry: PluginRegistry;
  private plugins: Map<string, OfficePlugin> = new Map();
  public ctx?: Ctx;

  constructor(projectsDir?: string) {
    this.registry = new PluginRegistry(projectsDir);
  }

  async install(id: string): Promise<boolean> {
    const manifest = this.registry.get(id);
    if (!manifest) return false;

    let entryPath = resolvePluginEntry(manifest.id, this.registry.pluginsDir, (manifest as any).entry);
    if (!entryPath && manifest.githubUrl) {
      const cloneRes = await this.installFromGit(manifest.githubUrl);
      if (!cloneRes.ok) {
        manifest.status = 'error'; manifest.error = cloneRes.error ?? 'Git clone failed';
        this.registry.save(); return false;
      }
      entryPath = resolvePluginEntry(manifest.id, this.registry.pluginsDir, (manifest as any).entry);
    }

    if (!entryPath && this.ctx) {
      manifest.status = 'error'; manifest.error = `Plugin entry not found for ${manifest.id}`;
      this.registry.save(); return false;
    }

    manifest.installed = true;
    (manifest as any).enabled = true;
    manifest.status = 'active';
    if (this.ctx) {
      const loaded = await this.loadPlugin(manifest, this.ctx);
      if (!loaded) {
        manifest.installed = false; (manifest as any).enabled = false; manifest.status = 'error';
        this.registry.save(); return false;
      }
    }
    this.registry.save();
    return true;
  }

  async uninstall(id: string): Promise<boolean> {
    const manifest = this.registry.get(id);
    if (!manifest) return false;
    manifest.installed = false;
    (manifest as any).enabled = false;
    manifest.status = 'inactive';
    this.registry.save();
    const plugin = this.plugins.get(id);
    if (plugin) {
      if (plugin.agentProvider) {
        this.unregisterAgentProvider(plugin.agentProvider.id);
      }
      try {
        await plugin.shutdown?.();
      } catch {
        /* ignore */
      }
      this.plugins.delete(id);
    }
    return true;
  }

  async installFromGit(url: string): Promise<{ ok: boolean; id?: string; error?: string }> {
    const parsed = parseGitUrl(url);
    if (!parsed) return { ok: false, error: 'Invalid Git URL' };
    const { id, cloneUrl } = parsed;
    const pluginDir = getPluginDir(id, this.registry.pluginsDir);
    if (existsSync(pluginDir)) return { ok: false, error: `Plugin "${id}" is already installed` };
    mkdirSync(pluginDir, { recursive: true });
    try {
      execFileSync('git', ['clone', '--depth', '1', '--', cloneUrl, pluginDir], { stdio: 'pipe', timeout: 60_000 });
    } catch (err) {
      rmSync(pluginDir, { recursive: true, force: true });
      return { ok: false, error: `Git clone failed: ${(err as Error).message}` };
    }
    const entryPath = detectEntryPath(pluginDir);
    if (!entryPath) {
      rmSync(pluginDir, { recursive: true, force: true });
      return { ok: false, error: `Plugin entry not found in ${pluginDir}` };
    }
    const manifest: PluginManifest = {
      id,
      name: id,
      description: `Installed from ${cloneUrl}`,
      capabilities: [],
      installed: true,
      status: 'active',
      local: true,
    };
    this.registry.register(manifest);
    this.registry.save();
    if (this.ctx) {
      await this.loadPlugin(manifest, this.ctx);
    }
    return { ok: true, id };
  }

  async updatePlugin(id: string): Promise<{ ok: boolean; error?: string }> {
    const pluginDir = getPluginDir(id, this.registry.pluginsDir);
    if (!existsSync(pluginDir)) return { ok: false, error: `Plugin "${id}" is not installed from Git` };
    try {
      execFileSync('git', ['pull'], { cwd: pluginDir, stdio: 'pipe', timeout: 30_000 });
    } catch (err) {
      return { ok: false, error: `Git pull failed: ${(err as Error).message}` };
    }
    const manifest = this.registry.get(id);
    if (manifest && this.ctx) {
      const plugin = this.plugins.get(id);
      if (plugin) {
        try {
          await plugin.shutdown?.();
        } catch {
          /* ignore */
        }
        this.plugins.delete(id);
      }
      await this.loadPlugin(manifest, this.ctx);
    }
    return { ok: true };
  }

  async checkUpdates(): Promise<void> {
    const installed = this.registry.list().filter((m) => m.installed === true);
    await Promise.all(
      installed.map(async (m) => {
        if (!m.githubUrl) {
          if (!m.version) m.version = 'local';
          m.latestVersion = undefined;
          m.updateAvailable = false;
          return;
        }
        const latest = await fetchLatestRelease(m.githubUrl);
        if (latest) {
          m.latestVersion = latest;
          m.updateAvailable = m.version !== latest;
        }
      }),
    );
  }

  openFolder(id?: string): void {
    let targetDir = this.registry.pluginsDir;
    if (id) {
      for (const dir of candidatePluginDirs(id, this.registry.pluginsDir)) {
        if (existsSync(dir)) {
          targetDir = dir;
          break;
        }
      }
      if (targetDir === this.registry.pluginsDir) {
        const parentContainers = [
          path.resolve(process.cwd(), '..', 'agent-office-plugins'),
          path.resolve(process.cwd(), 'agent-office-plugins'),
        ];
        for (const parent of parentContainers) {
          if (existsSync(parent)) {
            try {
              const entries = readdirSync(parent, { withFileTypes: true });
              for (const entry of entries) {
                if (entry.isDirectory()) {
                  const candidate = path.join(parent, entry.name);
                  if (entry.name.toLowerCase().includes(id.toLowerCase())) {
                    targetDir = candidate;
                    break;
                  }
                  const pkgPath = path.join(candidate, 'package.json');
                  if (existsSync(pkgPath)) {
                    try {
                      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
                      if (pkg.name?.toLowerCase().includes(id.toLowerCase())) {
                        targetDir = candidate;
                        break;
                      }
                    } catch {}
                  }
                }
              }
              if (targetDir !== this.registry.pluginsDir) break;
            } catch {}
          }
        }
      }
      if (targetDir === this.registry.pluginsDir) {
        for (const file of candidatePluginFiles(id, this.registry.pluginsDir)) {
          if (existsSync(file)) {
            targetDir = path.dirname(file);
            break;
          }
        }
      }
    } else {
      const fallbackDirs = [
        path.resolve(process.cwd(), '..', 'agent-office-plugins'),
        path.resolve(process.cwd(), 'agent-office-plugins'),
        this.registry.pluginsDir,
      ];
      targetDir = fallbackDirs.find((d) => existsSync(d)) || targetDir;
    }
    if (!existsSync(targetDir)) {
      try {
        mkdirSync(targetDir, { recursive: true });
      } catch {
        /* ignore */
      }
    }
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(cmd, [targetDir], () => {});
  }

  async loadPlugin(manifest: PluginManifest, ctx: Ctx): Promise<OfficePlugin | null> {
    const entryPath = resolvePluginEntry(manifest.id, this.registry.pluginsDir, (manifest as any).entry);
    if (!entryPath) {
      manifest.status = 'error';
      manifest.error = `Plugin entry not found for ${manifest.id}`;
      return null;
    }
    try {
      const fileUrl = pathToFileURL(entryPath).href;
      const mod = await import(fileUrl);
      const factory = mod.createPlugin || mod.default || mod;
      const plugin: OfficePlugin = typeof factory === 'function' ? factory() : factory;
      if (plugin && plugin.manifest) {
        manifest.status = 'active';
        manifest.capabilities = plugin.manifest.capabilities ?? manifest.capabilities;
        manifest.name = plugin.manifest.name ?? manifest.name;
        manifest.description = plugin.manifest.description ?? manifest.description;
        manifest.version = plugin.manifest.version ?? manifest.version;
        manifest.author = plugin.manifest.author ?? manifest.author;
        manifest.githubUrl = plugin.manifest.githubUrl ?? manifest.githubUrl;
        this.plugins.set(manifest.id, plugin);
        if (plugin.manifest.id) {
          this.plugins.set(plugin.manifest.id, plugin);
          const regItem = this.registry.get(plugin.manifest.id);
          if (regItem && regItem !== manifest) {
            regItem.status = 'active';
            regItem.installed = true;
            regItem.version = plugin.manifest.version ?? regItem.version;
            regItem.author = plugin.manifest.author ?? regItem.author;
            regItem.githubUrl = plugin.manifest.githubUrl ?? regItem.githubUrl;
          }
        }
        await plugin.init?.(ctx);
        return plugin;
      }
    } catch (err) {
      manifest.status = 'error';
      manifest.error = (err as Error).message;
      console.error(`Failed to load plugin ${manifest.id}:`, err);
    }
    return null;
  }

  async init(ctx: Ctx) {
    this.ctx = ctx;

    const envPlugin = process.env.AGENT_OFFICE_PLUGIN;
    if (envPlugin && existsSync(envPlugin)) {
      const id = path.basename(envPlugin, path.extname(envPlugin));
      const existing = this.registry.get(id);
      if (existing) {
        existing.installed = true;
        (existing as any).entry = envPlugin;
      } else {
        this.registry.register({
          id,
          name: id,
          description: `Plugin loaded from ${envPlugin}`,
          capabilities: [],
          installed: true,
          status: 'active',
          local: true,
          entry: envPlugin,
        } as any);
      }
    }

    for (const manifest of this.registry.list()) {
      if (manifest.installed) {
        await this.loadPlugin(manifest, ctx);
      }
    }

    for (const plugin of this.plugins.values()) {
      if (plugin.agentProvider) {
        this.registerAgentProvider(plugin.agentProvider);
      }
    }
  }

  private registerAgentProvider(agentProvider: AgentProviderPlugin): void {
    const { id, meta, adapter } = agentProvider;
    if (PROVIDER_META[id as AgentProvider]) {
      console.warn(`Agent provider "${id}" already registered, skipping plugin provider`);
      return;
    }
    registerAgentProvider(id, meta);
    registerAgentProviderAdapter(id, adapter);
  }

  private unregisterAgentProvider(id: string): void {
    unregisterAgentProvider(id);
    unregisterAgentProviderAdapter(id);
  }

  async shutdown() {
    for (const p of this.plugins.values()) {
      try {
        await p.shutdown?.();
      } catch {
      }
    }
    this.plugins.clear();
  }

  getFloorProvider(): FloorProvider | null {
    for (const p of this.plugins.values()) {
      if (p.floorProvider) return p.floorProvider;
    }
    return null;
  }

  getIssuesAdapter(): IssuesAdapter | null {
    const adapters = [...new Set([...this.plugins.values()].map((p) => p.issuesAdapter))].filter(Boolean) as IssuesAdapter[];
    if (!adapters.length) return null;
    if (adapters.length === 1) return adapters[0];
    return {
      async listIssues(floor: Floor) {
        const results = await Promise.allSettled(adapters.map((a) => a.listIssues(floor)));
        const all: GhIssue[] = [];
        for (const r of results) {
          if (r.status === 'fulfilled' && Array.isArray(r.value)) {
            all.push(...r.value);
          }
        }
        return all;
      },
    };
  }

  getPullsAdapter(): PullsAdapter | null {
    const adapters = [...new Set([...this.plugins.values()].map((p) => p.pullsAdapter))].filter(Boolean) as PullsAdapter[];
    if (!adapters.length) return null;
    if (adapters.length === 1) return adapters[0];
    return {
      async listPulls(floor: Floor) {
        const results = await Promise.allSettled(adapters.map((a) => a.listPulls(floor)));
        const all: GhPull[] = [];
        for (const r of results) {
          if (r.status === 'fulfilled' && Array.isArray(r.value)) {
            all.push(...r.value);
          }
        }
        return all;
      },
    };
  }

  getQueueAdapter(): QueueAdapter | null {
    for (const p of this.plugins.values()) {
      if (p.queueAdapter) return p.queueAdapter;
    }
    return null;
  }

  getServicesProvider(): ServicesProvider | null {
    for (const p of this.plugins.values()) {
      if (p.servicesProvider) return p.servicesProvider;
    }
    return null;
  }

  decorateFloor(floor: Floor, info: FloorInfo): void {
    for (const p of this.plugins.values()) {
      p.floorProvider?.decorateFloorInfo?.(floor, info);
    }
  }

  sortFloors(floors: FloorInfo[]): FloorInfo[] {
    const provider = this.getFloorProvider();
    if (provider?.sortFloors) {
      return provider.sortFloors(floors);
    }
    return floors;
  }

  async listFloorDefs(): Promise<FloorDef[] | null> {
    const provider = this.getFloorProvider();
    if (provider) {
      return await provider.listFloors();
    }
    return null;
  }

  async createFloor(req: { repo?: string; dir?: string }): Promise<{ repo: string; dir: string; name: string } | null> {
    const provider = this.getFloorProvider();
    if (provider?.createFloor) {
      return await provider.createFloor(req);
    }
    return null;
  }

  async listServices(floor: Floor): Promise<ServiceInfo[] | null> {
    const provider = this.getServicesProvider();
    if (provider) {
      return await provider.listServices(floor);
    }
    return null;
  }

  getProjectsProvider(): ProjectsProvider | null {
    for (const p of this.plugins.values()) {
      if (p.projectsProvider) return p.projectsProvider;
    }
    return null;
  }

  getState(): PluginsState {
    const all = this.registry.getState();
    const installed = all.plugins.map((m) => {
      const active = this.plugins.has(m.id);
      const plugin = this.plugins.get(m.id);
      return {
        ...m,
        installed: true,
        version: plugin?.manifest?.version ?? m.version,
        author: plugin?.manifest?.author ?? m.author,
        status: (m.status === 'error' ? 'error' : active ? 'active' : 'inactive') as 'active' | 'inactive' | 'error',
      };
    });
    const store = (all.store ?? []).map((m) => {
      const plugin = this.plugins.get(m.id);
      return {
        ...m,
        version: plugin?.manifest?.version ?? m.version,
        author: plugin?.manifest?.author ?? m.author,
        installed: false,
        status: 'inactive' as const,
      };
    });
    return { plugins: installed, store, pluginsDir: this.registry.pluginsDir };
  }
}
