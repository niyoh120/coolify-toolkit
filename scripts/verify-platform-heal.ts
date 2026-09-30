// One-shot verification on a DB COPY: run a full sync (Coolify GETs only;
// writes go to the copy) and report parent serverUuid + child platform outcome.
import { eq } from 'drizzle-orm';
import { openDatabase } from '../src/server/db/client.js';
import { imageTracks, resources } from '../src/server/db/schema.js';
import { SettingsRepo } from '../src/server/db/settings-repo.js';
import { CoolifyClient } from '../src/server/integrations/coolify/client.js';
import { InventorySync } from '../src/server/modules/inventory/sync.js';

const dbPath = process.argv[2];
if (dbPath == null)
  throw new Error('usage: tsx --env-file=.env scripts/verify-platform-heal.ts <db-copy>');
const short = (v: string | null | undefined): string => (v == null ? 'null' : v.slice(0, 8));

const handle = openDatabase(dbPath);
const db = handle.db;
const before = db.select().from(resources).where(eq(resources.kind, 'compose_service')).all();
const nullBefore = before.filter((p) => p.serverUuid == null).length;
console.log(`before: services=${before.length} serverUuidNull=${nullBefore}`);

const client = new CoolifyClient({
  baseUrl: process.env.COOLIFY_BASE_URL ?? '',
  apiKey: process.env.COOLIFY_API_KEY ?? '',
  verifyTls: process.env.COOLIFY_VERIFY_TLS !== 'false',
});
const sync = new InventorySync(
  db,
  client,
  {
    coolifyBaseUrl: process.env.COOLIFY_BASE_URL ?? '',
    coolifyApiKey: '',
    coolifyVerifyTls: process.env.COOLIFY_VERIFY_TLS !== 'false',
    excludedUuids: (process.env.EXCLUDED_RESOURCE_UUIDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    databasePath: dbPath,
    registryCredentials: {},
    githubToken: null,
    port: 0,
    publicOrigin: null,
    apprise: { apiUrl: null, configKey: null, tag: null, user: null, password: null },
    deployConcurrency: 1,
    dataDir: '.',
  },
  new SettingsRepo(db),
);
const result = await sync.run();
console.log(
  `sync: seen=${result.resourcesSeen} created=${result.created} errors=${result.errors.length}`,
);

const after = db.select().from(resources).where(eq(resources.kind, 'compose_service')).all();
const nullAfter = after.filter((p) => p.serverUuid == null).length;
console.log(`after: services=${after.length} serverUuidNull=${nullAfter}`);
for (const p of after.slice(0, 6)) {
  console.log(`  ${p.name} serverUuid=${short(p.serverUuid)} serverName=${p.serverName ?? 'null'}`);
}

const children = db.select().from(resources).where(eq(resources.kind, 'service_application')).all();
const dist = new Map<string, number>();
for (const c of children) {
  const t = db.select().from(imageTracks).where(eq(imageTracks.resourceId, c.id)).get();
  const key = `platform=${t?.targetPlatform ?? 'null'} source=${t?.platformSource ?? 'null'}`;
  dist.set(key, (dist.get(key) ?? 0) + 1);
}
console.log(`child tracks (${children.length}):`);
for (const [k, n] of [...dist.entries()].sort()) console.log(`  ${n}\t${k}`);
handle.close();
