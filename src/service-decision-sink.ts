import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LegacyDecisionEvent, LegacyDecisionSink } from './service.js';

/**
 * 影子期结构化证据 sink（Q32-B、Q38-D、Q42）。
 *
 * 约束：
 * - **只写本地文件**：旧 worker 不连接新系统数据库，避免让生产服务依赖未验收的组件；
 * - **追加写、不轮转**：sink 是一次性证据，迁移验收后销毁，不进备份（Q42）；
 * - **写入失败不影响业务**：调用方（service.ts 的决策回调）已捕获异常，这里只负责尽量写入；
 * - 记录里带 `restartedInWindow`：旧 worker 重启后内存去重集为空，该窗口内的判定不可比（Q39）。
 */

export interface DecisionSinkOptions {
  filePath: string;
  /** 由 worker 入口传入：本次启动是否处在重启窗口内。 */
  isRestartWindow?: () => boolean;
  /** 样本来源标记；影子期真实流量为 live，离线重放为 synthetic（Q57）。 */
  sampleSource?: 'live' | 'synthetic';
  onError?: (error: unknown) => void;
}

/** 创建可直接传给 processAlphaMessage 的 onDecision 回调。 */
export function createDecisionSink(options: DecisionSinkOptions): LegacyDecisionSink {
  let directoryReady: Promise<void> | null = null;
  const ensureDirectory = async (): Promise<void> => {
    directoryReady ??= mkdir(dirname(options.filePath), { recursive: true }).then(() => undefined);
    await directoryReady;
  };

  return async (event: LegacyDecisionEvent): Promise<void> => {
    try {
      await ensureDirectory();
      const record = {
        ...event,
        sampleSource: options.sampleSource ?? 'live',
        restartedInWindow: options.isRestartWindow?.() ?? false,
        recordedAt: new Date().toISOString()
      };
      // 逐行 JSON：便于流式读取与坏行隔离；追加写保证进程重启不丢已写证据。
      await appendFile(options.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      options.onError?.(error);
    }
  };
}
