// Minimal migrator: applies supabase/migrations/*.sql in filename order, each in
// its own transaction, and records applied files in public._migrations.
// Used by `npm run db:migrate` and by the test harness (see docs/decisions.md D2).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, here.includes(`${path.sep}dist${path.sep}`) ? '../..' : '..');
export const MIGRATIONS_DIR = path.join(repoRoot, 'supabase', 'migrations');

export async function migrate(databaseUrl: string, opts: { quiet?: boolean } = {}): Promise<string[]> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const applied: string[] = [];
  try {
    await sql`create table if not exists public._migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    // Serialise concurrent migrators.
    await sql`select pg_advisory_lock(hashtext('venture-engine-migrate'))`;
    const done = new Set((await sql<{ name: string }[]>`select name from public._migrations`).map((r) => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const body = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into public._migrations (name) values (${file})`;
      });
      applied.push(file);
      if (!opts.quiet) console.log(`applied ${file}`);
    }
    if (!opts.quiet && applied.length === 0) console.log('database is up to date');
    await sql`select pg_advisory_unlock(hashtext('venture-engine-migrate'))`;
  } finally {
    await sql.end();
  }
  return applied;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  migrate(url).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
