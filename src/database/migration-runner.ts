import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const { Pool } = pg;

export interface MigrationClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

export interface MigrationPool {
  connect(): Promise<MigrationClient>;
  end(): Promise<void>;
}

interface MigrationRunnerOptions {
  migrationsDir: string;
  pool?: MigrationPool;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}

export async function runMigrations(opts: MigrationRunnerOptions): Promise<void> {
  const pool: MigrationPool =
    opts.pool ??
    new Pool({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      password: opts.password,
      database: opts.database,
    });

  try {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version   VARCHAR(255) PRIMARY KEY,
          name      VARCHAR(255) NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);

      const files = (await readdir(opts.migrationsDir))
        .filter((f) => f.endsWith('.sql'))
        .sort();

      const { rows: applied } = await client.query(
        'SELECT version FROM schema_migrations',
      );
      const appliedSet = new Set(applied.map((r) => r['version'] as string));

      for (const file of files) {
        const version = file.replace(/\.sql$/, '');
        if (appliedSet.has(version)) {
          console.log(`Migration ${file} already applied, skipping.`);
          continue;
        }

        const sql = await readFile(join(opts.migrationsDir, file), 'utf-8');
        console.log(`Applying migration ${file}…`);

        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
            [version, file],
          );
          await client.query('COMMIT');
          console.log(`Migration ${file} applied successfully.`);
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

// CLI entry point
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('migration-runner.js');

if (isMainModule) {
  const migrationsDir =
    process.env['MIGRATIONS_DIR'] ??
    join(import.meta.dirname ?? '.', 'migrations');

  runMigrations({
    host: process.env['DB_HOST'] ?? 'localhost',
    port: parseInt(process.env['DB_PORT'] ?? '5432', 10),
    user: process.env['DB_USER'] ?? 'postgres',
    password: process.env['DB_PASSWORD'] ?? 'postgres',
    database: process.env['DB_NAME'] ?? 'webhooks',
    migrationsDir,
  })
    .then(() => {
      console.log('All migrations applied.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
