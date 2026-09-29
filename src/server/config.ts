// Environment-driven configuration. Parse once at startup; fail fast on invalid values.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function env(name: string): string | undefined {
  const v = process.env[name];
  return v != null && v !== '' ? v : undefined;
}

function required(name: string): string {
  const v = env(name);
  if (v == null) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = env(name);
  if (v == null) return fallback;
  return v === 'true' || v === '1';
}

function int(name: string, fallback: number): number {
  const v = env(name);
  if (v == null) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid integer for ${name}: ${v}`);
  return n;
}

/** Explicitly excluded resource UUIDs (infrastructure, toolkit itself, databases...). */
function excludedUuids(): string[] {
  const raw = env('EXCLUDED_RESOURCE_UUIDS') ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface RegistryCredential {
  username?: string;
  password?: string;
}

export interface RegistryCredentials {
  [registry: string]: RegistryCredential;
}

function loadRegistryCredentials(): RegistryCredentials {
  const file = env('REGISTRY_CREDENTIALS_FILE');
  if (!file) return {};
  if (!existsSync(file)) {
    throw new Error(`REGISTRY_CREDENTIALS_FILE points to missing file: ${file}`);
  }
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed == null) {
    throw new Error('Registry credentials file must contain a JSON object');
  }
  const out: RegistryCredentials = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'object' && v != null) {
      const cred = v as Record<string, unknown>;
      out[k] = {
        username: typeof cred.username === 'string' ? cred.username : undefined,
        password: typeof cred.password === 'string' ? cred.password : undefined,
      };
    }
  }
  return out;
}

export interface AppConfig {
  coolifyBaseUrl: string;
  coolifyApiKey: string;
  coolifyVerifyTls: boolean;
  excludedUuids: string[];
  databasePath: string;
  registryCredentials: RegistryCredentials;
  /** Optional GitHub token (read:packages) for GHCR tag update times. */
  githubToken: string | null;
  port: number;
  publicOrigin: string | null;
  apprise: {
    apiUrl: string | null;
    configKey: string | null;
    tag: string | null;
    user: string | null;
    password: string | null;
  };
  deployConcurrency: number;
  /** Directory of the SQLite file; created if missing. */
  dataDir: string;
}

export function loadConfig(): AppConfig {
  const coolifyBaseUrl = required('COOLIFY_BASE_URL').replace(/\/+$/, '');
  // Validate URL shape early; the Coolify client relies on it.
  new URL(coolifyBaseUrl);

  const databasePath = env('DATABASE_PATH') ?? './data/toolkit.db';
  const dataDir = path.dirname(databasePath);

  const githubToken = env('GITHUB_TOKEN') ?? null;

  const appriseApiUrl = env('APPRISE_API_URL');
  const appriseConfigKey = env('APPRISE_CONFIG_KEY');
  if (appriseApiUrl != null && appriseConfigKey != null && env('APPRISE_TAG') == null) {
    // apprise-api v2.0.0 公开/已锁定 mode rejects tagless stateful notify (HTTP 400).
    console.warn(
      '[toolkit] APPRISE_TAG is not set. apprise-api v2.0.0 in 公开/已锁定 access mode requires it; set it if notifications fail with HTTP 400.',
    );
  }

  return {
    coolifyBaseUrl,
    coolifyApiKey: required('COOLIFY_API_KEY'),
    coolifyVerifyTls: bool('COOLIFY_VERIFY_TLS', true),
    excludedUuids: excludedUuids(),
    databasePath,
    registryCredentials: loadRegistryCredentials(),
    githubToken,
    port: int('PORT', 8080),
    publicOrigin: env('PUBLIC_ORIGIN')?.replace(/\/+$/, '') ?? null,
    apprise: {
      apiUrl: appriseApiUrl?.replace(/\/+$/, '') ?? null,
      configKey: appriseConfigKey ?? null,
      tag: env('APPRISE_TAG') ?? null,
      user: env('APPRISE_USER') ?? null,
      password: env('APPRISE_PASSWORD') ?? null,
    },
    deployConcurrency: Math.max(1, int('DEPLOY_CONCURRENCY', 1)),
    dataDir,
  };
}

let cached: AppConfig | null = null;

export function config(): AppConfig {
  if (cached == null) cached = loadConfig();
  return cached;
}

/** Test hook: reset memoized config. */
export function resetConfigCache(): void {
  cached = null;
}
