import { resolve } from 'node:path';

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly dataDir: string;
  readonly fsync: boolean;
  readonly compactEvery: number;
  readonly allowedOrigins: readonly string[] | undefined;
}

export const DEFAULT_PORT = 5130;

function integer(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function flag(name: string, raw: string | undefined): boolean {
  if (raw === undefined || raw === '' || raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  throw new Error(`${name} must be 0/1/true/false, got "${raw}"`);
}

/**
 * Reads the server configuration from environment variables:
 * `PORT` (5130), `HOST` (127.0.0.1), `DATA_DIR` (./data), `FLOCK_FSYNC` (0),
 * `FLOCK_COMPACT_EVERY` (1000), `FLOCK_ALLOWED_ORIGINS` (comma-separated; unset = any origin).
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): ServerConfig {
  const origins = env['FLOCK_ALLOWED_ORIGINS']
    ?.split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return {
    port: integer('PORT', env['PORT'], DEFAULT_PORT, 0, 65535),
    host: env['HOST'] && env['HOST'] !== '' ? env['HOST'] : '127.0.0.1',
    dataDir: resolve(cwd, env['DATA_DIR'] && env['DATA_DIR'] !== '' ? env['DATA_DIR'] : 'data'),
    fsync: flag('FLOCK_FSYNC', env['FLOCK_FSYNC']),
    compactEvery: integer('FLOCK_COMPACT_EVERY', env['FLOCK_COMPACT_EVERY'], 1000, 2, 1_000_000),
    allowedOrigins: origins && origins.length > 0 ? origins : undefined,
  };
}
