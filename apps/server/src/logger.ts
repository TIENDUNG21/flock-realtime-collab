export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const line = (level: string, message: string, fields: LogFields = {}): string =>
  JSON.stringify({ time: new Date().toISOString(), level, message, ...fields });

/** One JSON object per line on stdout/stderr. */
export const jsonLogger: Logger = {
  info: (message, fields) => {
    console.info(line('info', message, fields));
  },
  warn: (message, fields) => {
    console.warn(line('warn', message, fields));
  },
  error: (message, fields) => {
    console.error(line('error', message, fields));
  },
};

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
