export interface FatalErrorHandlerOptions {
  error?: (message?: unknown, ...optionalParams: unknown[]) => void;
  exit?: (code: number) => never;
  delayMs?: number;
}

export function createFatalErrorHandler(options: FatalErrorHandlerOptions = {}) {
  const logError = options.error ?? console.error;
  const exit = options.exit ?? process.exit;
  const delayMs = options.delayMs ?? 100;
  let exiting = false;

  return (type: 'uncaughtException' | 'unhandledRejection', reason: unknown): void => {
    if (exiting) return;
    exiting = true;
    const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    logError(`[fatal ${type}] ${message}`);
    setTimeout(() => {
      exit(1);
    }, delayMs);
  };
}

export function installFatalErrorHandlers(): void {
  const handler = createFatalErrorHandler();
  process.on('uncaughtException', (error) => {
    handler('uncaughtException', error);
  });
  process.on('unhandledRejection', (reason) => {
    handler('unhandledRejection', reason);
  });
}
