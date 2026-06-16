import type { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'https://15canvastool.vercel.app');
  const redirectUri = url.searchParams.get('redirect_uri') ?? '';
  const state = url.searchParams.get('state') ?? '';

  if (!redirectUri) {
    res.statusCode = 400;
    res.end('Missing redirect_uri');
    return;
  }

  const code = `ross-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const callback = new URL(redirectUri);
  callback.searchParams.set('code', code);
  if (state) callback.searchParams.set('state', state);

  res.setHeader('Location', callback.toString());
  res.statusCode = 302;
  res.end();
}
