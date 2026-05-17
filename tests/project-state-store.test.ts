import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ProjectStateStore,
  hydrateProjectStateMaps,
  serializeProjectStateMaps
} from '../src/project-state-store.js';

async function tempPath(name = 'project-state.json'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'project-state-'));
  return join(dir, name);
}

describe('ProjectStateStore', () => {
  it('returns empty state when the file does not exist', async () => {
    const warn = vi.fn();
    const store = new ProjectStateStore({ filePath: await tempPath(), warn });

    await expect(store.load()).resolves.toEqual({ version: 1, projects: {} });
    expect(warn).not.toHaveBeenCalled();
  });

  it('persists and reloads project state', async () => {
    const filePath = await tempPath();
    const store = new ProjectStateStore({ filePath });

    await store.save({
      version: 1,
      projects: {
        b: {
          star: 2,
          pushCount: 2,
          firstChannelMessage: { chatId: -1001234567890, messageId: 321 },
          updatedAt: '2026-05-17T00:00:00.000Z'
        }
      }
    });

    await expect(store.load()).resolves.toEqual({
      version: 1,
      projects: {
        b: {
          star: 2,
          pushCount: 2,
          firstChannelMessage: { chatId: -1001234567890, messageId: 321 },
          updatedAt: '2026-05-17T00:00:00.000Z'
        }
      }
    });
  });

  it('falls back to empty state when JSON is invalid', async () => {
    const filePath = await tempPath();
    await writeFile(filePath, '{bad json', 'utf8');
    const warn = vi.fn();
    const store = new ProjectStateStore({ filePath, warn });

    await expect(store.load()).resolves.toEqual({ version: 1, projects: {} });
    expect(warn.mock.calls[0][0]).toContain('读取项目状态失败');
  });
});

describe('project state map helpers', () => {
  it('hydrates and serializes service maps', () => {
    const stars = new Map<string, number>();
    const pushCounts = new Map<string, number>();
    const firstMessages = new Map<string, { chatId: number; messageId: number }>();

    hydrateProjectStateMaps(
      {
        version: 1,
        projects: {
          b: {
            star: 3,
            pushCount: 3,
            firstChannelMessage: { chatId: -1001, messageId: 10 },
            updatedAt: '2026-05-17T00:00:00.000Z'
          }
        }
      },
      stars,
      pushCounts,
      firstMessages
    );

    expect(stars.get('b')).toBe(3);
    expect(pushCounts.get('b')).toBe(3);
    expect(firstMessages.get('b')).toEqual({ chatId: -1001, messageId: 10 });

    expect(serializeProjectStateMaps(stars, pushCounts, firstMessages, new Date('2026-05-17T01:00:00.000Z'))).toEqual({
      version: 1,
      projects: {
        b: {
          star: 3,
          pushCount: 3,
          firstChannelMessage: { chatId: -1001, messageId: 10 },
          updatedAt: '2026-05-17T01:00:00.000Z'
        }
      }
    });
  });
});
