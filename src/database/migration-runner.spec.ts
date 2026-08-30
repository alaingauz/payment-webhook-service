import { runMigrations, MigrationPool } from './migration-runner.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('MigrationRunner', () => {
  let tempDir: string;
  let queryLog: string[];
  let mockClient: Record<string, any>;
  let mockPool: MigrationPool;

  function createMockPool(
    queryFn?: (sql: string, params?: unknown[]) => Promise<any>,
  ): MigrationPool {
    queryLog = [];

    const defaultQuery = async (sql: string) => {
      queryLog.push(sql.trim().substring(0, 60));
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return { rows: [] };
      }
      return { rows: [] };
    };

    mockClient = {
      query: vi.fn(queryFn ?? defaultQuery),
      release: vi.fn(),
    };

    return {
      connect: vi.fn().mockResolvedValue(mockClient),
      end: vi.fn(),
    };
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'migrations-'));
    mockPool = createMockPool();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should create schema_migrations table', async () => {
    await runMigrations({ migrationsDir: tempDir, pool: mockPool });

    const createTableQuery = queryLog.find((q) =>
      q.includes('CREATE TABLE IF NOT EXISTS schema_migrations'),
    );
    expect(createTableQuery).toBeDefined();
    expect(mockClient.release).toHaveBeenCalled();
    expect(mockPool.end).toHaveBeenCalled();
  });

  it('should apply pending SQL migrations in order', async () => {
    await writeFile(join(tempDir, '001-first.sql'), 'CREATE TABLE t1 (id INT);');
    await writeFile(join(tempDir, '002-second.sql'), 'CREATE TABLE t2 (id INT);');

    await runMigrations({ migrationsDir: tempDir, pool: mockPool });

    const beginCount = queryLog.filter((q) => q === 'BEGIN').length;
    const commitCount = queryLog.filter((q) => q === 'COMMIT').length;
    expect(beginCount).toBe(2);
    expect(commitCount).toBe(2);

    const inserts = queryLog.filter((q) =>
      q.includes('INSERT INTO schema_migrations'),
    );
    expect(inserts).toHaveLength(2);
  });

  it('should skip already-applied migrations', async () => {
    await writeFile(join(tempDir, '001-first.sql'), 'CREATE TABLE t1 (id INT);');

    mockPool = createMockPool(async (sql: string) => {
      queryLog.push(sql.trim().substring(0, 60));
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return { rows: [{ version: '001-first' }] };
      }
      return { rows: [] };
    });

    await runMigrations({ migrationsDir: tempDir, pool: mockPool });

    const beginCount = queryLog.filter((q) => q === 'BEGIN').length;
    expect(beginCount).toBe(0);
  });

  it('should rollback on migration failure', async () => {
    await writeFile(join(tempDir, '001-bad.sql'), 'INVALID SQL;');

    mockPool = createMockPool(async (sql: string) => {
      queryLog.push(sql.trim().substring(0, 60));
      if (sql.includes('SELECT version FROM schema_migrations')) {
        return { rows: [] };
      }
      if (sql.includes('INVALID SQL')) {
        throw new Error('syntax error');
      }
      return { rows: [] };
    });

    await expect(
      runMigrations({ migrationsDir: tempDir, pool: mockPool }),
    ).rejects.toThrow('syntax error');

    const rollbackCount = queryLog.filter((q) => q === 'ROLLBACK').length;
    expect(rollbackCount).toBe(1);
    expect(mockPool.end).toHaveBeenCalled();
  });

  it('should ignore non-SQL files', async () => {
    await writeFile(join(tempDir, 'README.md'), '# Not a migration');
    await writeFile(join(tempDir, '001-real.sql'), 'CREATE TABLE t1 (id INT);');

    await runMigrations({ migrationsDir: tempDir, pool: mockPool });

    const beginCount = queryLog.filter((q) => q === 'BEGIN').length;
    expect(beginCount).toBe(1);
  });
});
