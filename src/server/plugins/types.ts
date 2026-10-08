import type { FloorDef } from '../building.js';
import type { Floor } from '../floor.js';
import type { FloorInfo, GhIssue, GhPull, PluginManifest, QueueTask, ServiceInfo, WorkerInfo } from '../../shared/protocol.js';
import type { Ctx } from '../office/context.js';
import type { ProviderMeta } from '../../shared/providers.js';
import type { SomeAdapter } from '../providers/types.js';

export interface FloorProvider {
  listFloors(): Promise<FloorDef[]> | FloorDef[];
  sortFloors?(floors: FloorInfo[]): FloorInfo[];
  createFloor?(req: { repo?: string; dir?: string }): Promise<{ repo: string; dir: string; name: string } | null>;
  decorateFloorInfo?(floor: Floor, info: FloorInfo): void;
}

export interface IssuesAdapter {
  listIssues(floor: Floor): Promise<GhIssue[]>;
}

export interface PullsAdapter {
  listPulls(floor: Floor): Promise<GhPull[]>;
}

export interface QueueAdapter {
  listTasks?(floor: Floor): Promise<QueueTask[]>;
  onTaskCreated?(floor: Floor, prompt: string): Promise<void>;
  onTaskDeleted?(floor: Floor, taskId: string): Promise<void>;
}

export interface ServicesProvider {
  listServices(floor: Floor): Promise<ServiceInfo[]>;
}

export interface AgentProviderPlugin {
  id: string;
  meta: ProviderMeta;
  adapter: SomeAdapter;
}

export interface ProjectConfig {
  id: string;
  name?: string;
  url?: string;
  token?: string;
  [key: string]: unknown;
}

export interface ProjectsProvider {
  listProjects?(floor: Floor): Promise<ProjectConfig[]>;
  saveProjects?(floor: Floor, projects: ProjectConfig[]): Promise<void>;
}

export interface OfficePlugin {
  manifest: PluginManifest;
  init?(ctx: Ctx): Promise<void> | void;
  shutdown?(): Promise<void> | void;
  floorProvider?: FloorProvider;
  issuesAdapter?: IssuesAdapter;
  pullsAdapter?: PullsAdapter;
  queueAdapter?: QueueAdapter;
  servicesProvider?: ServicesProvider;
  agentProvider?: AgentProviderPlugin;
  projectsProvider?: ProjectsProvider;
}

