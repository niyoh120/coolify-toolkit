import path from 'node:path';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: path.resolve(import.meta.dirname, 'src/server/db/schema.ts'),
  out: path.resolve(import.meta.dirname, 'drizzle'),
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? ':memory:',
  },
  strict: true,
  verbose: true,
});
