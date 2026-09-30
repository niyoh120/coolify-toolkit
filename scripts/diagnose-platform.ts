// Read-only diagnosis: where does the child-platform chain break?
// 1. local DB: parent serverUuid + child track platform distribution
// 2. Coolify GET /resources: per-entry destination/server/arch shape + parse failures
// 3. Coolify GET /services: destination presence
// Prints whitelisted fields only (short uuids); never prints credentials.
import { eq } from 'drizzle-orm';
import { openDatabase } from '../src/server/db/client.js';
import { imageTracks, resources } from '../src/server/db/schema.js';
import { CoolifyClient } from '../src/server/integrations/coolify/client.js';
import { type CoolifyResourceEntry, coolifyResourceEntrySchema } from '../src/shared/schemas.js';

const short = (v: string | null | undefined): string => (v == null ? 'null' : v.slice(0, 8));

const handle = openDatabase('./data/toolkit.db');

console.log('=== 1. local DB: compose_service rows ===');
const parents = handle.db
  .select()
  .from(resources)
  .where(eq(resources.kind, 'compose_service'))
  .all();
for (const p of parents.slice(0, 8)) {
  console.log(
    `id=${p.id} ${short(p.coolifyUuid)} name=${p.name} serverUuid=${p.serverUuid ?? 'null'} serverName=${p.serverName ?? 'null'}`,
  );
}
console.log(`... total ${parents.length} services`);

console.log('\n=== 2. local DB: child track platform distribution ===');
const children = handle.db
  .select()
  .from(resources)
  .where(eq(resources.kind, 'service_application'))
  .all();
const dist = new Map<string, number>();
let missingParent = 0;
for (const c of children) {
  const t = handle.db.select().from(imageTracks).where(eq(imageTracks.resourceId, c.id)).get();
  const key = `platform=${t?.targetPlatform ?? 'null'} source=${t?.platformSource ?? 'null'}`;
  dist.set(key, (dist.get(key) ?? 0) + 1);
  if (c.parentResourceId == null || !parents.some((p) => p.id === c.parentResourceId))
    missingParent += 1;
}
for (const [k, n] of [...dist.entries()].sort()) console.log(`${n}\t${k}`);
console.log(`children total=${children.length} orphanOrMissingParent=${missingParent}`);
const parentById = new Map(parents.map((p) => [p.id, p]));
const nullServerParent = children.filter((c) => {
  const p = c.parentResourceId != null ? parentById.get(c.parentResourceId) : undefined;
  return p != null && p.serverUuid == null;
}).length;
console.log(`children whose parent row has serverUuid=null: ${nullServerParent}`);

console.log('\n=== 3. Coolify GET /resources (read-only) ===');
const client = new CoolifyClient({
  baseUrl: process.env.COOLIFY_BASE_URL ?? '',
  apiKey: process.env.COOLIFY_API_KEY ?? '',
  verifyTls: process.env.COOLIFY_VERIFY_TLS !== 'false',
});
const res = await client.listResourceEntries().then(
  (r) => r,
  (err) => {
    console.log(`listResourceEntries FAILED: ${err instanceof Error ? err.message : err}`);
    return null;
  },
);
if (res != null) {
  const byServer = new Map<
    string,
    { uuid: string | null; name: string | null; arch: string | null; destIds: Set<string> }
  >();
  let parseFail = 0;
  for (const raw of res as unknown[]) {
    const parsed = coolifyResourceEntrySchema.safeParse(raw);
    if (!parsed.success) {
      parseFail += 1;
      if (parseFail <= 2) {
        const keys =
          raw != null && typeof raw === 'object' ? Object.keys(raw).join(',') : String(raw);
        console.log(`  parse fail sample keys: ${keys}`);
      }
      continue;
    }
    const e: CoolifyResourceEntry = parsed.data;
    const srv = e.destination?.server ?? e.server ?? null;
    const destId = e.destination?.id ?? e.destination_id ?? null;
    if (srv?.uuid != null) {
      const entry = byServer.get(srv.uuid) ?? {
        uuid: srv.uuid,
        name: srv.name ?? null,
        arch: srv.server_metadata?.arch ?? null,
        destIds: new Set<string>(),
      };
      if (destId != null) entry.destIds.add(String(destId));
      const archNow = srv.server_metadata?.arch ?? null;
      if (entry.arch == null && archNow != null) entry.arch = archNow;
      byServer.set(srv.uuid, entry);
    }
  }
  console.log(
    `entries=${(res as unknown[]).length} parseFail=${parseFail} distinctServers=${byServer.size}`,
  );
  for (const s of byServer.values()) {
    console.log(
      `server ${short(s.uuid)} name=${s.name} arch=${s.arch ?? 'null'} destIds=${[...s.destIds].join(',')}`,
    );
  }
  const parentServerUuids = new Set(
    parents.map((p) => p.serverUuid).filter((v): v is string => v != null),
  );
  for (const uuid of parentServerUuids) {
    const known = byServer.get(uuid);
    console.log(
      `parent serverUuid ${short(uuid)} -> ${known ? `known arch=${known.arch ?? 'null'}` : 'UNKNOWN in /resources topology'}`,
    );
  }
}

console.log('\n=== 4. Coolify GET /services destination shape (read-only) ===');
const svcs = await client.listServices().then(
  (r) => r,
  (err) => {
    console.log(`listServices FAILED: ${err instanceof Error ? err.message : err}`);
    return null;
  },
);
if (svcs != null) {
  const withDest = svcs.filter((s) => s.destination?.id != null).length;
  console.log(`services=${svcs.length} withDestinationId=${withDest}`);
  const sample = svcs[0];
  if (sample != null)
    console.log(`sample: uuid=${short(sample.uuid)} destId=${sample.destination?.id ?? 'null'}`);
}

handle.close();
