import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ChannelMessageReference } from './service.js';

export interface ProjectStateRecord {
  star: number;
  pushCount: number;
  firstChannelMessage?: ChannelMessageReference;
  updatedAt: string;
}

export interface ProjectStateFile {
  version: 1;
  projects: Record<string, ProjectStateRecord>;
}

export interface ProjectStateStoreOptions {
  filePath: string;
  warn?: (message: string) => void;
}

export class ProjectStateStore {
  private readonly filePath: string;
  private readonly warn: (message: string) => void;

  constructor(options: ProjectStateStoreOptions) {
    this.filePath = options.filePath;
    this.warn = options.warn ?? console.warn;
  }

  async load(): Promise<ProjectStateFile> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as ProjectStateFile;
      if (parsed.version !== 1 || !parsed.projects || typeof parsed.projects !== 'object') {
        throw new Error('invalid project state format');
      }
      return parsed;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return { version: 1, projects: {} };
      }
      this.warn(`读取项目状态失败，使用空状态：${error instanceof Error ? error.message : String(error)}`);
      return { version: 1, projects: {} };
    }
  }

  async save(state: ProjectStateFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.filePath);
  }
}

export function hydrateProjectStateMaps(
  state: ProjectStateFile,
  projectStars: Map<string, number>,
  projectPushCounts: Map<string, number>,
  projectFirstChannelMessages: Map<string, ChannelMessageReference>
): void {
  for (const [projectKey, record] of Object.entries(state.projects)) {
    projectStars.set(projectKey, record.star);
    projectPushCounts.set(projectKey, record.pushCount);
    if (record.firstChannelMessage) {
      projectFirstChannelMessages.set(projectKey, record.firstChannelMessage);
    }
  }
}

export function serializeProjectStateMaps(
  projectStars: Map<string, number>,
  projectPushCounts: Map<string, number>,
  projectFirstChannelMessages: Map<string, ChannelMessageReference>,
  now = new Date()
): ProjectStateFile {
  const projects: ProjectStateFile['projects'] = {};
  const keys = new Set<string>([
    ...projectStars.keys(),
    ...projectPushCounts.keys(),
    ...projectFirstChannelMessages.keys()
  ]);
  for (const key of keys) {
    projects[key] = {
      star: projectStars.get(key) ?? 0,
      pushCount: projectPushCounts.get(key) ?? 0,
      firstChannelMessage: projectFirstChannelMessages.get(key),
      updatedAt: now.toISOString()
    };
  }
  return { version: 1, projects };
}
