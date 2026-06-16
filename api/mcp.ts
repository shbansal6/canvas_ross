/**
 * Vercel serverless endpoint — HTTP/SSE MCP transport.
 *
 * Users supply their own Gemini key via the X-Gemini-Api-Key request header.
 * Falls back to the server's GEMINI_API_KEY env var if the header is absent.
 * Supabase is always server-side (read-only queries, no user key needed).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'http';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

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

function buildServer(geminiKey: string): McpServer {
  const server = new McpServer({ name: 'ross-course-base', version: '1.0.0' });

  server.registerTool(
    'search_course_materials',
    {
      description: 'Search Ross MBA course materials semantically. Always cite document_url for every claim.',
      inputSchema: z.object({
        query: z.string().describe('The question or topic to search for'),
        course_id: z.string().optional().describe('Optional course ID to limit search (get from list_courses)'),
        top_k: z.number().int().min(1).max(20).optional().default(8),
      }),
    },
    async ({ query, course_id, top_k }) => {
      if (!geminiKey) {
        return {
          content: [{ type: 'text' as const, text: 'No Gemini API key provided. Set the X-Gemini-Api-Key header when connecting this MCP server, or ask the server admin.' }],
          isError: true,
        };
      }
      const embedding = await embedQuery(query, geminiKey);
      const { data, error } = await supabase.rpc('match_chunks', {
        query_embedding: embedding,
        match_count: top_k ?? 8,
        filter_course_id: course_id ?? null,
      });
      if (error) return { content: [{ type: 'text' as const, text: `Search error: ${error.message}` }], isError: true };
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.registerTool(
    'list_courses',
    {
      description: 'List all indexed Ross MBA courses with their IDs and terms.',
      inputSchema: z.object({}),
    },
    async () => {
      const { data, error } = await supabase
        .from('chunks')
        .select('course_id, course_name, course_term')
        .limit(5000);
      if (error) return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }], isError: true };
      const seen = new Set<string>();
      const courses = (data ?? []).filter((r: { course_id: string }) => {
        if (seen.has(r.course_id)) return false;
        seen.add(r.course_id);
        return true;
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(courses, null, 2) }] };
    },
  );

  server.registerTool(
    'get_session_summary',
    {
      description: 'Get all content for a specific course module/week. Always cite document_url.',
      inputSchema: z.object({
        course_id: z.string().describe('Course ID from list_courses'),
        module_name: z.string().describe('Module name (partial match OK, e.g. "Week 3")'),
      }),
    },
    async ({ course_id, module_name }) => {
      const { data, error } = await supabase
        .from('chunks')
        .select('document_title, document_url, content, module_name')
        .eq('course_id', course_id)
        .ilike('module_name', `%${module_name}%`)
        .order('id', { ascending: true });
      if (error) return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }], isError: true };
      if (!data?.length) {
        return { content: [{ type: 'text' as const, text: `No content found for course ${course_id} module "${module_name}". Use list_courses to see available courses.` }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  return server;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const geminiKey = getGeminiKey(req);
  const mcpServer = buildServer(geminiKey);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res);
}
