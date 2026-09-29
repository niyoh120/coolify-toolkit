// Coolify instance read-only smoke: version + inventory counts.
// Run explicitly: npx tsx scripts/smoke-coolify.ts (uses .env credentials).
import '../src/server/sdk-env.js';
import { loadConfig } from '../src/server/config.js';
import { CoolifyClient } from '../src/server/integrations/coolify/client.js';

const cfg = loadConfig();
const client = new CoolifyClient({
  baseUrl: cfg.coolifyBaseUrl,
  apiKey: cfg.coolifyApiKey,
  verifyTls: cfg.coolifyVerifyTls,
});

const probe = await client.probe();
console.log(`version probe: ${JSON.stringify(probe)}`);
if (!probe.ok) process.exit(1);

const apps = await client.listApplications();
const dockerimage = apps.filter((a) => a.build_pack === 'dockerimage');
console.log(
  `applications: ${apps.length} total, ${dockerimage.length} dockerimage (manageable phase-1)`,
);

const services = await client.listServices();
console.log(`services: ${services.length}`);
let children = 0;
for (const svc of services.slice(0, 10)) {
  const list = await client.listServiceApplications(svc.uuid);
  children += list.length;
}
console.log(`service applications (first ${Math.min(10, services.length)} services): ${children}`);
