// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOrders } from './server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(__dirname, 'data', '.test-tmp');

async function withTempFile(name, content, fn) {
  await mkdir(TMP_DIR, { recursive: true });
  const path = join(TMP_DIR, name);
  if (content !== null) {
    await writeFile(path, content, 'utf-8');
  }
  try {
    return await fn(path);
  } finally {
    try { await unlink(path); } catch {}
  }
}

describe('readOrders', () => {
  it('returns empty orders for non-existent file', async () => {
    const result = await readOrders(join(TMP_DIR, 'does-not-exist.json'));
    assert.ok(result.generated_at);
    assert.deepStrictEqual(result.orders, []);
  });

  it('returns empty orders for empty file', async () => {
    const result = await withTempFile('empty.json', '', async (path) => {
      return readOrders(path);
    });
    assert.ok(result.generated_at);
    assert.deepStrictEqual(result.orders, []);
  });

  it('parses valid JSON correctly', async () => {
    const data = {
      generated_at: '2026-01-01T00:00:00Z',
      orders: [{ id: 'o1', status: 'captured', sequence: 1, amount: '10.00', currency: 'MXN', updated_at: '2026-01-01T00:00:00Z' }],
    };
    const result = await withTempFile('valid.json', JSON.stringify(data), async (path) => {
      return readOrders(path);
    });
    assert.equal(result.generated_at, '2026-01-01T00:00:00Z');
    assert.equal(result.orders.length, 1);
    assert.equal(result.orders[0].id, 'o1');
  });

  it('throws on corrupt JSON', async () => {
    await withTempFile('corrupt.json', '{not valid json!!!', async (path) => {
      await assert.rejects(() => readOrders(path), SyntaxError);
    });
  });

  it('returns orders field as-is when not an array', async () => {
    const data = { generated_at: '2026-01-01T00:00:00Z', orders: 'not-an-array' };
    const result = await withTempFile('bad-orders.json', JSON.stringify(data), async (path) => {
      return readOrders(path);
    });
    assert.equal(result.orders, 'not-an-array');
  });
});
