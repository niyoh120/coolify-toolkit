// Unified error mapping for registry interactions.
// Raw SDK errors / responses must never reach the frontend or logs verbatim.
import { ApiRequestError, errorCodes } from '../../../shared/errors.js';

export type RegistryErrorKind =
  | 'auth' // 401/403 — credentials or permissions
  | 'not_found' // 404 — repository or tag missing
  | 'rate_limited' // 429
  | 'platform' // requested platform missing from index
  | 'network' // timeouts, DNS, TLS
  | 'server' // 5xx
  | 'unknown';

export interface NormalizedRegistryError {
  kind: RegistryErrorKind;
  message: string;
  statusCode?: number;
  retryAfterSeconds?: number;
  retryable: boolean;
}

export function classifyRegistryError(err: unknown): NormalizedRegistryError {
  if (err instanceof ApiRequestError && err.code === errorCodes.registryError) {
    return { kind: 'unknown', message: err.message, retryable: false };
  }
  const anyErr = err as
    | (Record<string, unknown> & {
        statusCode?: number;
        status?: number;
        message?: string;
        code?: string;
        headers?: Record<string, unknown>;
      })
    | null;
  const status = anyErr?.statusCode ?? anyErr?.status;
  const rawMessage = typeof anyErr?.message === 'string' ? anyErr.message : String(err);
  const sanitized = rawMessage.length > 300 ? `${rawMessage.slice(0, 300)}…` : rawMessage;
  // Strip anything resembling credentials/token fragments from Needle error text.
  const message = sanitized
    .replace(/(authorization|bearer|token|password)\s*[:=]\s*\S+/gi, '$1=<redacted>')
    .replace(/\s+/g, ' ');

  if (status === 401 || status === 403) {
    return {
      kind: 'auth',
      message: `Registry authentication failed (HTTP ${status})`,
      statusCode: status,
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      kind: 'not_found',
      message: 'Repository or tag not found',
      statusCode: status,
      retryable: false,
    };
  }
  if (status === 429) {
    const rawRetryAfter =
      anyErr?.headers?.['retry-after'] ?? anyErr?.headers?.['Retry-After'] ?? anyErr?.retryAfter;
    const ra = Number(rawRetryAfter);
    return {
      kind: 'rate_limited',
      message: 'Registry rate limit reached (HTTP 429)',
      statusCode: 429,
      retryAfterSeconds: Number.isFinite(ra) && ra > 0 ? ra : undefined,
      retryable: true,
    };
  }
  if (status != null && status >= 500) {
    return {
      kind: 'server',
      message: `Registry server error (HTTP ${status})`,
      statusCode: status,
      retryable: true,
    };
  }
  if (status != null && status >= 400) {
    return {
      kind: 'unknown',
      message: `Registry rejected the request (HTTP ${status})`,
      statusCode: status,
      retryable: false,
    };
  }
  const code = anyErr?.code;
  if (typeof code === 'string' && /TIMEOUT|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(code)) {
    return { kind: 'network', message: `Registry network error (${code})`, retryable: true };
  }
  if (/platform/i.test(message) && /not found|cannot|no matching/i.test(message)) {
    return {
      kind: 'platform',
      message: 'Requested platform not present in the image index',
      retryable: false,
    };
  }
  return { kind: 'network', message: message || 'Registry request failed', retryable: true };
}
