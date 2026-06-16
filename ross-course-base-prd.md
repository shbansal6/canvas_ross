# PRD: Ross Course Base (MCP Knowledge Server)

## 1. Purpose

A retrieval system over Ross MBA Canvas course materials, exposed as an MCP server. Students connect it to Claude (Desktop or any MCP-compatible client) using their own Claude Pro subscription. Inference cost is borne by the student via their Pro plan; hosting cost is borne by the operator at zero or near-zero using free tiers.

This is a clone of the Course Base model (insead.course-base.org), rebuilt for University of Michigan Ross.

## 2. Goals

- Ingest Canvas course materials (PDFs, slides, HTML pages) for a defined set of courses
- Chunk, embed, and store content with course/session metadata in a vector database
- Expose a retrieval tool via MCP (Model Context Protocol) that any MCP client can call
- Zero ongoing cost to operator at expected scale (single user to small cohort)
- Zero cost to students beyond their existing Claude Pro subscription

## 3. Non-Goals (v1)

- No web UI / chat interface (MCP-only access via Claude Desktop)
- No multi-tenant auth system (single shared MCP key, or no auth for v1 if usage stays small)
- No quiz/flashcard generation (future enhancement, not v1)
- No cross-course synthesis layer (future enhancement)
- No support for DRM-protected external readings (e.g., Harvard Business Publishing cases) -- only materials Canvas itself stores

## 4. Architecture

```
Canvas API (personal access token)
        |
        v
Ingestion script (Node or Python, run locally/on-demand)
  - Fetch course list, modules, files, pages per course
  - Download files to local storage
  - Extract text (PDF -> text, HTML -> text)
  - Chunk text (500-1000 tokens, ~100 token overlap)
  - Embed chunks (OpenAI text-embedding-3-small or Voyage)
  - Upsert into Supabase pgvector table with metadata
        |
        v
Supabase (Postgres + pgvector extension, free tier)
  Table: chunks
    - id
    - course_id
    - course_name
    - module_name
    - document_title
    - document_url (Canvas source link)
    - content (text chunk)
    - embedding (vector)
        |
        v
MCP Server (Node.js, deployed on Vercel or run locally via stdio)
  - Tool: search_course_materials(query, course_filter?)
    -> embeds query, runs pgvector cosine similarity search, returns top-k chunks with citations
  - Tool: list_courses()
    -> returns list of indexed courses for filtering
        |
        v
Claude Desktop (student's own Pro account)
  - Student adds MCP server URL/config to claude_desktop_config.json
  - Claude calls search_course_materials mid-conversation
  - Inference billed to student's Pro subscription
```

## 5. Data Ingestion Spec

### 5.1 Canvas API access

- Base URL: `<CANVAS_BASE_URL>` (confirm exact subdomain, e.g., `https://umich.instructure.com`)
- Auth: Personal access token via `Authorization: Bearer <CANVAS_API_TOKEN>` header
- Endpoints to use:
  - `GET /api/v1/courses?enrollment_state=completed&include[]=term` -- list courses
  - `GET /api/v1/courses/:id/modules?include[]=items` -- module structure
  - `GET /api/v1/courses/:id/files?per_page=100` -- all files (paginated)
  - `GET /api/v1/courses/:id/pages` -- HTML content pages
  - `GET /api/v1/files/:id` -- file metadata + download URL

### 5.2 File handling

- Supported: PDF, PPTX, DOCX, HTML pages
- PDF text extraction: `pdf-parse` (Node) or `pdfplumber` (Python)
- PPTX/DOCX: convert to text via `mammoth` (docx) or `node-pptx-parser` / unzip + XML parse (pptx)
- HTML pages: strip tags via `cheerio` or `BeautifulSoup`, keep text content
- Skip: video/audio links, external publisher links (cannot download), quiz content

### 5.3 Chunking

- Chunk size: 500-1000 tokens
- Overlap: 100 tokens
- Preserve metadata per chunk: course name, course code, module/week name, document title, source Canvas URL
- Use a token-aware splitter (e.g., `tiktoken` for counting, recursive character splitter for splitting)

### 5.4 Embeddings

- Model: `text-embedding-3-small` (OpenAI) -- cheapest viable option, ~$0.02 per 1M tokens
- Alternative if avoiding OpenAI entirely: Voyage AI `voyage-3-lite` (Anthropic-recommended embedding partner)
- One-time ingestion cost for entire Ross MBA corpus across ~15-20 courses: likely under $2

### 5.5 Storage schema (Supabase / Postgres + pgvector)

```sql
create extension if not exists vector;

create table chunks (
  id bigserial primary key,
  course_id text not null,
  course_name text not null,
  module_name text,
  document_title text not null,
  document_url text,
  content text not null,
  embedding vector(1536),
  created_at timestamptz default now()
);

create index on chunks using hnsw (embedding vector_cosine_ops);
```

## 6. MCP Server Spec

### 6.1 Tools to expose

**`search_course_materials`**
- Input: `query` (string, required), `course_id` (string, optional filter)
- Behavior: embed query using same embedding model as ingestion, run pgvector similarity search (cosine distance), return top 5-8 chunks
- Output: array of `{ course_name, module_name, document_title, document_url, content, similarity_score }`

**`list_courses`**
- Input: none
- Output: array of `{ course_id, course_name, term }` -- lets the model/user know what's indexed

**`get_session_summary`** ("catch me up" mode)
- Input: `course_id` (string, required), `module_name` or `week_number` (string, required)
- Behavior: retrieve all chunks tagged with the given course + module/week, ordered by document sequence, no similarity ranking (this is a full pull, not a search)
- Output: array of `{ document_title, document_url, content }` for every chunk in that session, plus a `session_metadata` object (module name, date range if available)
- Use case: student missed a class or is reviewing before a cold-call; Claude uses this to produce a structured summary of everything covered that week

### 6.2 Citation requirements (all tools)

Every chunk returned by any tool must include:
- `document_url`: direct Canvas link to the source file (constructed from Canvas file/page ID during ingestion)
- `document_title`: exact file/page name as it appears in Canvas
- `course_name` and `module_name`: so the student can locate it in Canvas without re-searching

System prompt / tool description must instruct Claude to cite `document_url` for every claim drawn from retrieved content, so students can verify against the original source before relying on it for exams. This is the primary trust mechanism distinguishing retrieval-grounded answers from generic Claude knowledge.

### 6.3 Transport

- Use MCP SDK (`@modelcontextprotocol/sdk` for Node)
- Transport: stdio (for local Claude Desktop config) is simplest and free
- If hosted remotely (Vercel/Render free tier): use SSE/HTTP transport per MCP spec, students point Claude Desktop config at the hosted URL instead of a local binary

### 6.4 Embedding query at search time

- Server must call the embedding API (OpenAI/Voyage) using the OPERATOR's key for query embedding (small, near-zero cost -- a handful of tokens per query)
- This is the only ongoing cost to the operator; at expected usage (single user to ~10 students), this is well under $1/month

## 7. Deployment Options (choose one)

**Option A -- Local stdio MCP server (simplest, truly $0)**
- Each student clones the repo, runs `npm install`, adds the server to their `claude_desktop_config.json` pointing at the local script
- Supabase connection is shared (read-only credentials embedded in config or `.env`)
- Pros: zero hosting, zero auth complexity
- Cons: requires students to have Node installed and run a setup step

**Option B -- Hosted MCP server (Vercel/Render free tier)**
- Single deployment, students just add the hosted URL to their config
- Slightly more setup for operator, easier for students
- Free tier limits are generous enough for this scale

Recommend Option B for the PRD given the goal of "extremely easy for students."

## 8. Setup Requirements (operator-side, gather before starting)

1. Canvas base URL for Ross (confirm exact instance URL)
2. Canvas personal access token (generate via Account > Settings > New Access Token)
3. List of course IDs to ingest (or "all completed enrollments" auto-discovery)
4. Supabase project (free tier) -- project URL + service role key
5. OpenAI or Voyage API key for embeddings (ingestion-time and query-time)
6. Vercel account for hosting the MCP server (if Option B)
7. Decision: open access (anyone with URL) vs. shared secret key in MCP config for v1

## 9. Build Plan for Claude Code

1. Scaffold Node.js project with `@modelcontextprotocol/sdk`, `@supabase/supabase-js`, embedding client
2. Write Canvas ingestion script (`scripts/ingest.ts`):
   - Fetch courses -> modules -> files/pages
   - Download + extract text
   - Chunk + embed + upsert to Supabase
3. Write Supabase schema migration (pgvector table + index)
4. Build MCP server (`src/server.ts`) with `search_course_materials` and `list_courses` tools
5. Deploy to Vercel (if Option B) with SSE transport
6. Write setup README for students: how to add the MCP URL to Claude Desktop config
7. Test: run ingestion on 1-2 courses first, verify retrieval quality before running full corpus

## 10. Open Questions to Resolve Before Build

- Exact Ross Canvas base URL
- Which courses to include in v1 (all, or a curated subset)
- Embedding provider preference (OpenAI vs Voyage)
- Local stdio vs hosted MCP server
- Whether to gate access at all for v1, or treat it as single-user initially
