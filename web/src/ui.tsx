import { useEffect, useRef, useState } from 'react';
import { ApiRequestError } from './api.js';

/**
 * 共享 UI 原语。
 *
 * 存在这个文件的理由：Badge 曾在 5 个视图里各写一份完全相同的实现，
 * 模态框也各写一份且都不支持 Esc / 遮罩关闭 / 焦点管理。散落的复制品会随视图数量继续分叉。
 */

export type BadgeTone = 'neutral' | 'accent' | 'discover' | 'alert';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-soft text-muted border-line',
  accent: 'bg-accent-soft text-accent border-accent',
  discover: 'bg-discover-soft text-discover border-discover',
  alert: 'bg-alert-soft text-alert border-alert'
};

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: React.ReactNode }): React.ReactElement {
  return <span className={`rounded-full border px-2 py-[1px] text-2xs ${BADGE_TONES[tone]}`}>{children}</span>;
}

/**
 * 大数字的可读化：30 万比 300000 好读，也避免健康条被长数字挤爆。
 * 只做展示，不改变任何判定或存储值。
 */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿`;
  if (abs >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
  return value.toLocaleString('zh-CN');
}

/**
 * 错误文案：给用户一句能懂的结论，把技术细节单独留出来。
 *
 * 起因：之前页面直接把 `X.rows is not iterable` 这类内部错误显示给用户（第 19 节记录的真实缺陷），
 * 用户看不懂、也分不清"权限问题"和"服务故障"。这里按状态码分类，技术细节放在 detail 里供折叠/悬停查看。
 */
export function describeError(error: unknown): { text: string; detail: string | null; retryable: boolean } {
  if (error instanceof ApiRequestError) {
    const detail = error.message;
    switch (error.status) {
      case 401:
        return { text: '登录状态已失效，请重新进入页面', detail, retryable: false };
      case 403:
        return { text: '需要管理员权限：点顶部“管理”输入管理员密码', detail, retryable: false };
      case 404:
        return { text: '记录不存在（可能已被清理）', detail, retryable: false };
      case 409:
        return { text: detail || '当前状态不允许该操作', detail, retryable: false };
      case 429:
        return { text: '操作过于频繁，请稍后再试', detail, retryable: true };
      default:
        return { text: '数据服务异常，请稍后重试', detail, retryable: true };
    }
  }
  return {
    text: '数据服务异常，请稍后重试',
    detail: error instanceof Error ? error.message : String(error),
    retryable: true
  };
}

/**
 * 模态框：支持 Esc 关闭、点遮罩关闭、打开时把焦点移入对话框。
 * 这三件事是键盘与触屏用户的基本预期，之前每个自建弹窗都缺。
 */
export function Modal({
  title,
  hint,
  onClose,
  children
}: {
  title: string;
  hint?: string;
  onClose: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    boxRef.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      // 只在点到遮罩本身时关闭，避免点内容时误关。
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={boxRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-xl border border-line bg-surface p-4 shadow-lg focus:outline-none"
      >
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint ? <p className="mt-1 text-2xs text-muted">{hint}</p> : null}
        {children}
      </div>
    </div>
  );
}

/**
 * 输入对话框：替代 `window.prompt`。
 *
 * 原生 prompt 的问题：无法样式化、阻塞主线程、部分浏览器/内嵌环境会直接抑制它，
 * 而且"必填"只能靠事后判空。这里在提交前就把必填做实。
 */
export function PromptDialog({
  title,
  hint,
  label,
  placeholder,
  confirmLabel = '确认',
  danger = false,
  busy = false,
  error = null,
  onSubmit,
  onClose
}: {
  title: string;
  hint?: string;
  label: string;
  placeholder?: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  /** 只在非空时调用（必填由对话框内保证）。 */
  onSubmit: (value: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const [value, setValue] = useState('');
  const trimmed = value.trim();

  return (
    <Modal title={title} {...(hint !== undefined ? { hint } : {})} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed.length === 0) return;
          onSubmit(trimmed);
        }}
      >
        <label className="mt-3 block text-2xs text-muted">
          {label}
          <input
            value={value}
            autoFocus
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder ?? ''}
            className="mt-1 w-full rounded-md border border-line bg-surface-soft px-2 py-1 text-xs outline-none focus:border-accent"
          />
        </label>
        {error ? (
          <p role="alert" className="mt-2 text-2xs text-alert">
            {error}
          </p>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-line px-3 py-1 text-2xs text-muted">
            取消
          </button>
          <button
            type="submit"
            disabled={busy || trimmed.length === 0}
            className={`rounded-md border px-3 py-1 text-2xs disabled:opacity-50 ${
              danger ? 'border-alert bg-alert-soft text-alert' : 'border-accent bg-accent-soft text-accent'
            }`}
          >
            {busy ? '执行中…' : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
