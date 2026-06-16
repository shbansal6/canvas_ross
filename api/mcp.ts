import type { IncomingMessage, ServerResponse } from 'http';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

function getGeminiKey(req: IncomingMessage): string {
  const header = req.headers['x-gemini-api-key'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  return fromHeader ?? process.env.GEMINI_API_KEY ?? '';
}

async function embedQuery(query: string, geminiKey: string): Promise<number[]> {
  const ai = new GoogleGenAI({ apiKey: geminiKey });
  const result = await ai.models.embedContent({
    model: 'gemini-embedding-001',
    contents: query,
    config: { outputDimensionality: 768 },
  });
  return (result.embeddings ?? [])[0]?.values ?? [];
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const TOOLS = [
  {
    name: 'search_course_materials',
    description: 'Search Ross MBA course materials semantically. Always cite document_url for every claim.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question or topic to search for' },
        course_id: { type: 'string', description: 'Optional course ID to limit search (get from list_courses)' },
        top_k: { type: 'number', description: 'Number of results (1-20, default 8)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_courses',
    description: 'List all indexed Ross MBA courses with their IDs and terms.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_session_summary',
    description: 'Get all content for a specific course module/week. Always cite document_url.',
    inputSchema: {
      type: 'object',
      properties: {
        course_id: { type: 'string', description: 'Course ID from list_courses' },
        module_name: { type: 'string', description: 'Module name (partial match OK, e.g. "Week 3")' },
      },
      required: ['course_id', 'module_name'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>, geminiKey: string) {
  if (name === 'list_courses') {
    const { data, error } = await supabase
      .from('chunks')
      .select('course_id, course_name, course_term')
      .limit(5000);
    if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    const seen = new Set<string>();
    const courses = (data ?? []).filter((r: { course_id: string }) => {
      if (seen.has(r.course_id)) return false;
      seen.add(r.course_id);
      return true;
    });
    return { content: [{ type: 'text', text: JSON.stringify(courses, null, 2) }] };
  }

  if (name === 'search_course_materials') {
    if (!geminiKey) {
      return { content: [{ type: 'text', text: 'No Gemini API key provided. Set the X-Gemini-Api-Key header when adding this MCP server.' }], isError: true };
    }
    const query = args.query as string;
    const course_id = args.course_id as string | undefined;
    const top_k = (args.top_k as number) ?? 8;
    const embedding = await embedQuery(query, geminiKey);
    const { data, error } = await supabase.rpc('match_chunks', {
      query_embedding: embedding,
      match_count: top_k,
      filter_course_id: course_id ?? null,
    });
    if (error) return { content: [{ type: 'text', text: `Search error: ${error.message}` }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  if (name === 'get_session_summary') {
    const course_id = args.course_id as string;
    const module_name = args.module_name as string;
    const { data, error } = await supabase
      .from('chunks')
      .select('document_title, document_url, content, module_name')
      .eq('course_id', course_id)
      .ilike('module_name', `%${module_name}%`)
      .order('id', { ascending: true });
    if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    if (!data?.length) {
      return { content: [{ type: 'text', text: `No content found for course ${course_id} module "${module_name}". Use list_courses to see available courses.` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Gemini-Api-Key, Mcp-Session-Id',
  });
  res.end(payload);
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Gemini-Api-Key, Mcp-Session-Id',
    });
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    json(res, 405, { error: 'Method not allowed' });
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch {
    json(res, 400, { error: 'Failed to read body' });
    return;
  }

  let message: Record<string, unknown>;
  try {
    message = JSON.parse(body);
  } catch {
    json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    return;
  }

  const { method, id, params } = message as {
    method: string;
    id?: string | number;
    params?: Record<string, unknown>;
  };

  const geminiKey = getGeminiKey(req);

  if (method === 'initialize') {
    json(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ross-course-base', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    res.writeHead(202, { 'Access-Control-Allow-Origin': '*' });
    res.end();
    return;
  }

  if (method === 'ping') {
    json(res, 200, { jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'tools/list') {
    json(res, 200, { jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = (params ?? {}) as { name: string; arguments: Record<string, unknown> };
    try {
      const result = await callTool(name, args ?? {}, geminiKey);
      json(res, 200, { jsonrpc: '2.0', id, result });
    } catch (err) {
      json(res, 200, {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `Tool error: ${String(err)}` }], isError: true },
      });
    }
    return;
  }

  json(res, 200, {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
}
