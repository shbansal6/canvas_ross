import type { IncomingMessage, ServerResponse } from 'http';

const BASE = 'https://15canvastool.vercel.app';

export default function handler(_req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify({
    resource: `${BASE}/api/mcp`,
    authorization_servers: [BASE],
    bearer_methods_supported: ['header'],
    resource_name: 'Ross Course Base MCP',
  }));
}
