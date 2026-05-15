export interface RetryOptions {
  attempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function retry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const minDelayMs = Math.max(0, options.minDelayMs ?? 500);
  const maxDelayMs = Math.max(minDelayMs, options.maxDelayMs ?? 5_000);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || options.shouldRetry?.(error, attempt) === false) {
        throw error;
      }
      const delayMs = Math.min(maxDelayMs, minDelayMs * 2 ** (attempt - 1));
      options.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError;
}
