// @ts-check
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, 'data', 'provider-orders.json');
const PORT = parseInt(process.env['PORT'] ?? '4000', 10);

/**
 * Read provider-orders.json safely.
 * - File missing → { generated_at, orders: [] }
 * - File empty → { generated_at, orders: [] }
 * - JSON corrupt → throws Error (caller should respond 500)
 * - orders not an array → returns as-is (let ProviderClient reject)
 * @param {string} filePath
 * @returns {Promise<object>}
 */
export async function readOrders(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { generated_at: new Date().toISOString(), orders: [] };
    }
    throw err;
  }

  if (!raw.trim()) {
    return { generated_at: new Date().toISOString(), orders: [] };
  }

  // Let JSON.parse throw on corrupt data — caller handles it as 500
  const parsed = JSON.parse(raw);

  return {
    generated_at: parsed.generated_at ?? new Date().toISOString(),
    orders: parsed.orders,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // GET /health
  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // GET /provider/orders
  if (req.method === 'GET' && pathname === '/provider/orders') {
    let data;
    try {
      data = await readOrders(DATA_FILE);
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read provider orders' }));
      return;
    }

    const updatedSince = url.searchParams.get('updated_since');

    if (updatedSince) {
      const since = new Date(updatedSince);
      if (isNaN(since.getTime())) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid updated_since parameter' }));
        return;
      }
      if (Array.isArray(data.orders)) {
        data.orders = data.orders.filter(
          (o) => new Date(o.updated_at) > since,
        );
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Only start listening when run directly (not when imported for testing)
const isMainModule = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMainModule) {
  server.listen(PORT, () => {
    console.log(`Provider simulator listening on port ${PORT}`);
  });
}
