
// ── Migration: old token_grace schema is rebuilt ─────────────────────────────

test('migration: legacy token_grace (host_id) is rebuilt with device_id', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'airelay-mig-'));
  const prevDir = process.env.AIRELAY_CONFIG_DIR;
  process.env.AIRELAY_CONFIG_DIR = dir;

  // Create the LEGACY schema by hand, as an older relay version would have.
  const db = new DatabaseSync(join(dir, 'relay.db'));
  db.exec(`CREATE TABLE token_grace (
    token TEXT PRIMARY KEY, host_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`);
  db.exec(`INSERT INTO token_grace VALUES ('legacy-tok', 'legacy-host', 9999999999)`);
  db.close();

  // Fresh import opens the DB and must run the migration.
  delete globalThis.__airelayDbForTest;
  await import('../dist/db.js');
  const db2 = new DatabaseSync(join(dir, 'relay.db'));
  const cols = db2.prepare('PRAGMA table_info(token_grace)').all();
  const names = cols.map((c) => c.name);
  db2.close();
  assert.ok(names.includes('device_id'), 'device_id column present after migration');
  assert.ok(!names.includes('host_id'), 'legacy host_id column dropped');
  assert.equal(names.length, 3, 'exactly token/device_id/expires_at');

  process.env.AIRELAY_CONFIG_DIR = prevDir;
  rmSync(dir, { recursive: true, force: true });
});
