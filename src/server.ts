/**
 * Ross Course Base — MCP Server (stdio transport, local Claude Desktop)
 *
 * Add to claude_desktop_config.json:
 *   "command": "npx", "args": ["tsx", "/path/to/src/server.ts"]
 *   env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!SUPABASE_URL) throw new Error('SUPABASE_URL env var is required');
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY env var is required');
if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY env var is required');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

async function embedQuery(query: string): Promise<number[]> {
  const result = await ai.models.embedContent({
    model: 'gemini-embedding-001',
    contents: query,
    config: { outputDimensionality: 768 },
  });
  return (result.embeddings ?? [])[0]?.values ?? [];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchRow {
  course_id: string;
  course_name: string;
  module_name: string | null;
  document_title: string;
  document_url: string | null;
  content: string;
  similarity: number;
}

interface ChunkRow {
  document_title: string;
  document_url: string | null;
  content: string;
  module_name: string | null;
}

interface CourseRow {
  course_id: string;
  course_name: string;
  course_term: string | null;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'ross-course-base', version: '1.0.0' });

// ---------------------------------------------------------------------------
// Tool: search_course_materials
// ---------------------------------------------------------------------------

server.registerTool(
  'search_course_materials',
  {
    description: `Search Ross MBA course materials using semantic similarity.
Returns the most relevant content chunks with full source citations.
IMPORTANT: Always cite document_url for every claim drawn from retrieved content so students can verify against the original Canvas source.`,
    inputSchema: z.object({
      query: z.string().describe('The question or topic to search for'),
      course_id: z.string().optional().describe(
        'Optional: limit to one course. Get valid IDs from list_courses.',
      ),
      top_k: z.number().int().min(1).max(20).optional().default(8).describe(
        'Number of results (default 8)',
      ),
    }),
  },
  async ({ query, course_id, top_k }) => {
    const embedding = await embedQuery(query);

    const { data, error } = await supabase.rpc('match_chunks', {
      query_embedding: embedding,
      match_count: top_k ?? 8,
      filter_course_id: course_id ?? null,
    });

    if (error) {
      return { content: [{ type: 'text' as const, text: `Search error: ${error.message}` }], isError: true };
    }

    if (!data || (data as SearchRow[]).length === 0) {
      return { content: [{ type: 'text' as const, text: 'No results found. Try a different query or check that ingestion has been run.' }] };
    }

    const results = (data as SearchRow[]).map((row) => ({
      course_name: row.course_name,
      module_name: row.module_name ?? 'Unknown module',
      document_title: row.document_title,
      document_url: row.document_url ?? null,
      content: row.content,
      similarity_score: Math.round(row.similarity * 1000) / 1000,
    }));

    return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
  },
);

// ---------------------------------------------------------------------------
// Tool: list_courses
// ---------------------------------------------------------------------------

server.registerTool(
  'list_courses',
  {
    description: 'List all Ross MBA courses that have been indexed. Use the returned course_id to filter search_course_materials or get_session_summary.',
    inputSchema: z.object({}),
  },
  async () => {
    const { data, error } = await supabase
      .from('chunks')
      .select('course_id, course_name, course_term')
      .limit(5000);

    if (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }], isError: true };
    }

    const seen = new Set<string>();
    const courses = (data as CourseRow[] ?? [])
      .filter((r) => { if (seen.has(r.course_id)) return false; seen.add(r.course_id); return true; })
      .sort((a, b) => a.course_name.localeCompare(b.course_name));

    return { content: [{ type: 'text' as const, text: JSON.stringify(courses, null, 2) }] };
  },
);

// ---------------------------------------------------------------------------
// Tool: get_session_summary
// ---------------------------------------------------------------------------

server.registerTool(
  'get_session_summary',
  {
    description: `Retrieve all content for a specific course module or week — "catch me up" mode.
Pulls every chunk for the given course + module in document order. Use this when a student missed class or wants a full structured review of a session.
IMPORTANT: Always cite document_url for every section you summarise.`,
    inputSchema: z.object({
      course_id: z.string().describe('Course ID from list_courses'),
      module_name: z.string().describe(
        'Module or week name as it appears in Canvas (partial match OK, e.g. "Week 3")',
      ),
    }),
  },
  async ({ course_id, module_name }) => {
    const { data, error } = await supabase
      .from('chunks')
      .select('document_title, document_url, content, module_name')
      .eq('course_id', course_id)
      .ilike('module_name', `%${module_name}%`)
      .order('id', { ascending: true });

    if (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }], isError: true };
    }

    const rows = data as ChunkRow[] | null;
    if (!rows || rows.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: `No content found for course ${course_id} with module matching "${module_name}". Use list_courses to see available courses and confirm module name.`,
        }],
      };
    }

    // Group chunks by document
    const byDoc = new Map<string, { document_title: string; document_url: string | null; chunks: string[] }>();
    for (const row of rows) {
      const key = row.document_url ?? row.document_title;
      if (!byDoc.has(key)) {
        byDoc.set(key, { document_title: row.document_title, document_url: row.document_url ?? null, chunks: [] });
      }
      byDoc.get(key)!.chunks.push(row.content);
    }

    const documents = Array.from(byDoc.values()).map((doc) => ({
      document_title: doc.document_title,
      document_url: doc.document_url,
      content: doc.chunks.join('\n\n---\n\n'),
    }));

    const sessionMetadata = {
      course_id,
      module_name: rows[0]?.module_name ?? module_name,
      total_chunks: rows.length,
      total_documents: documents.length,
    };

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ session_metadata: sessionMetadata, documents }, null, 2),
      }],
    };
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('Ross Course Base MCP server running (stdio)\n');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
