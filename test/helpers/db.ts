// Gives each test file its own throwaway database, migrated with the real migrator.
// Requires TEST_DATABASE_URL pointing at a Postgres >= 15 superuser connection
// (local cluster, or `supabase start`'s postgresql://postgres:postgres@127.0.0.1:54322/postgres).
import crypto from 'node:crypto';
import postgres from 'postgres';
import { migrate } from '../../scripts/migrate.js';
import { createDb, type Sql } from '../../worker/lib/db.js';

export interface TestDb {
  url: string;
  sql: Sql;
  /** Open an additional, independent connection pool (e.g. a second worker). */
  connect(max?: number): Sql;
  cleanup(): Promise<void>;
}

function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Point it at a Postgres >= 15 superuser connection, e.g. ' +
        'postgresql://ve:ve@127.0.0.1:5432/ve (see docs/SETUP.md).',
    );
  }
  return url;
}

export async function createTestDb(): Promise<TestDb> {
  const base = adminUrl();
  const name = `ve_test_${crypto.randomBytes(6).toString('hex')}`;
  const admin = postgres(base, { max: 1, onnotice: () => {} });
  try {
    // Supabase roles, so migrations' revokes/grants behave as in production.
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await admin.unsafe(`
        do $$ begin
          create role ${role} nologin;
        exception when duplicate_object or unique_violation then null;
        end $$;`);
    }
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.end();
  }

  const u = new URL(base);
  u.pathname = `/${name}`;
  const url = u.toString();
  await migrate(url, { quiet: true });

  const pools: Sql[] = [];
  const connect = (max = 5) => {
    const s = createDb(url, { max });
    pools.push(s);
    return s;
  };
  const sql = connect();

  return {
    url,
    sql,
    connect,
    async cleanup() {
      await Promise.all(pools.map((p) => p.end({ timeout: 5 })));
      const a = postgres(base, { max: 1, onnotice: () => {} });
      try {
        await a.unsafe(`drop database if exists ${name} with (force)`);
      } finally {
        await a.end();
      }
    },
  };
}
