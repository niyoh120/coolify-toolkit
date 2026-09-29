// Config fingerprints: hash over the update-relevant Coolify fields only.
// Whole compose/env payloads may contain credentials — only whitelisted fields
// participate, and raw payloads stay in memory.
import { createHash } from 'node:crypto';

export function fingerprintObject(obj: Record<string, unknown>): string {
  const stable = JSON.stringify(obj, Object.keys(obj).sort());
  return createHash('sha256').update(stable).digest('hex').slice(0, 32);
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function shortDigest(digest: string | null | undefined): string {
  if (digest == null) return '—';
  const hex = digest.startsWith('sha256:') ? digest.slice(7) : digest;
  return hex.slice(0, 12);
}
