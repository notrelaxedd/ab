import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db.js';
import { getSettings } from '../worker/lib/db.js';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.cleanup();
});

describe('schema', () => {
  it('seeds a single settings row with safe defaults', async () => {
    const s = await getSettings(db.sql);
    expect(s.dry_run).toBe(true);
    expect(s.kill_switch).toBe(false);
    expect(s.max_active_ventures).toBe(3);
    expect(s.max_concurrency).toBe(2);
    expect(s.monthly_budget_usd).toBe(0);
    expect(s.venture_budget_usd).toBe(0);
    await expect(db.sql`insert into settings (id) values (2)`).rejects.toThrow();
  });

  it('rejects invalid enum values and slugs', async () => {
    await expect(db.sql`insert into tasks (stage, status) values ('NOOP', 'bogus')`).rejects.toThrow();
    await expect(db.sql`insert into ventures (slug, name) values ('Bad_Slug', 'x')`).rejects.toThrow();
    await expect(
      db.sql`insert into ledger (category, kind, amount_usd, source) values ('ads', 'actual', -1, 't')`,
    ).rejects.toThrow();
  });

  it('computes venture_spend and monthly_spend from the ledger', async () => {
    await db.sql`update settings set monthly_budget_usd = 100 where id = 1`;
    const [v] = await db.sql`insert into ventures (slug, name, budget_cap_usd) values ('spend-test', 'S', 50) returning id`;
    const vid = v!.id as string;
    await db.sql`insert into ledger (venture_id, category, kind, amount_usd, source, ref) values
      (${vid}, 'ads', 'reservation', 20, 'budget-guard', 'c1'),
      (${vid}, 'ads', 'actual', 5, 'meta', 'c1'),
      (${vid}, 'ads', 'release', 5, 'meta', 'c1'),
      (${vid}, 'ads', 'reservation', 3, 'budget-guard', 'c2'),
      (${vid}, 'ads', 'release', 10, 'budget-guard', 'c2')`;
    const [vs] = await db.sql`select * from venture_spend where venture_id = ${vid}`;
    // open: c1 = 20-5 = 15, c2 = max(3-10, 0) = 0; actual 5 → remaining 50-5-15 = 30
    expect(Number(vs!.reserved_usd)).toBe(15);
    expect(Number(vs!.actual_usd)).toBe(5);
    expect(Number(vs!.remaining_usd)).toBe(30);
    const [ms] = await db.sql`select * from monthly_spend`;
    expect(Number(ms!.remaining_usd)).toBe(80);
  });

  it('denies the anon role access to tables, views and claim_task', async () => {
    const tryAs = (q: string) =>
      db.sql.begin(async (tx) => {
        await tx.unsafe('set local role anon');
        return tx.unsafe(q);
      });
    await expect(tryAs('select * from settings')).rejects.toThrow(/permission denied/);
    await expect(tryAs('select * from tasks')).rejects.toThrow(/permission denied/);
    await expect(tryAs('select * from venture_spend')).rejects.toThrow(/permission denied/);
    await expect(tryAs('select * from monthly_spend')).rejects.toThrow(/permission denied/);
    await expect(tryAs(`select * from claim_task('x')`)).rejects.toThrow(/permission denied/);
  });
});
