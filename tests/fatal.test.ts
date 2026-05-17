import { describe, expect, it, vi } from 'vitest';
import { createFatalErrorHandler } from '../src/fatal.js';

describe('createFatalErrorHandler', () => {
  it('logs and exits with code 1 once', () => {
    vi.useFakeTimers();
    const error = vi.fn();
    const exit = vi.fn();
    const handler = createFatalErrorHandler({
      error,
      exit: exit as unknown as (code: number) => never,
      delayMs: 10
    });

    handler('uncaughtException', new Error('boom'));
    handler('unhandledRejection', new Error('again'));
    vi.advanceTimersByTime(10);
    vi.useRealTimers();

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('fatal uncaughtException');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
