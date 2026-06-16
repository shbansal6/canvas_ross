import type { IncomingMessage, ServerResponse } from 'http';

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(data) as Record<string, unknown>); } catch { resolve({}); }
    });
  });
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  const body = await readBody(req);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 201;
  res.end(JSON.stringify({
    ...body,
    client_id: `ross-client-${Date.now()}`,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: 'none',
  }));
}
