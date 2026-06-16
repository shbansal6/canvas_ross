# Ross Course Base — MCP Knowledge Server

Retrieval-augmented search over your Ross MBA Canvas course materials, exposed as an MCP server for Claude Desktop.

## How it works

1. An ingestion script downloads your Canvas course files (PDFs, slides, pages), extracts text, chunks it, embeds it with OpenAI, and stores it in Supabase.
2. An MCP server exposes three tools to Claude Desktop: `search_course_materials`, `list_courses`, and `get_session_summary`.
3. You add the MCP server to your Claude Desktop config once. Claude can then answer course questions and cite exact Canvas source links.

---

## Setup (operator — you do this once)

### Prerequisites

- Node.js 18+
- A [Supabase](https://supabase.com) project (free tier is fine)
- An [OpenAI API key](https://platform.openai.com/api-keys) with a small credit balance (~$5 covers all ingestion)
- Your Canvas personal access token

### 1. Clone and install

```bash
git clone <this-repo>
cd ross-course-base
npm install
```

### 2. Create your .env file

```bash
cp .env.example .env
```

Edit `.env` and fill in:

```
CANVAS_BASE_URL=https://umich.instructure.com
CANVAS_API_TOKEN=<your Canvas token from Account > Settings > New Access Token>
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://<project-id>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key from Supabase Dashboard > Settings > API>
```

### 3. Apply the Supabase schema

In your Supabase project, go to **SQL Editor** and run the contents of:

```
supabase/migrations/001_chunks.sql
```

This creates the `chunks` table and the vector similarity search function.

### 4. Run ingestion (one-time, ~$1-2 in OpenAI costs)

```bash
# Preview what will be ingested without writing to Supabase:
npm run ingest:dry

# Run the full ingestion:
npm run ingest
```

The script auto-discovers all your Canvas courses (active + completed), downloads supported files (PDF, PPTX, DOCX, HTML pages), extracts text, chunks it, and embeds + stores everything. Expect 15-60 minutes depending on corpus size.

**Configurable defaults** (edit in `scripts/ingest.ts`):
- `CHUNK_SIZE_TOKENS` — default 750 tokens per chunk
- `CHUNK_OVERLAP_TOKENS` — default 100 token overlap
- Canvas enrollment states fetched — currently `active` + `completed`

---

## Connecting to Claude Desktop (local stdio — Option A)

This is the simplest setup: Claude Desktop runs the MCP server as a local process.

### Step 1: Find your Claude Desktop config file

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

### Step 2: Add the MCP server

Open the config file and add (or merge) this JSON:

```json
{
  "mcpServers": {
    "ross-course-base": {
      "command": "node",
      "args": ["/absolute/path/to/ross-course-base/dist/src/server.js"],
      "env": {
        "SUPABASE_URL": "https://<your-project>.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "<your-service-role-key>",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

Replace `/absolute/path/to/ross-course-base` with the actual path where you cloned this repo.

If you prefer running via `tsx` without building first:

```json
{
  "mcpServers": {
    "ross-course-base": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/ross-course-base/src/server.ts"],
      "env": {
        "SUPABASE_URL": "https://<your-project>.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "<your-service-role-key>",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

### Step 3: Build (if using compiled JS)

```bash
npm run build
```

### Step 4: Restart Claude Desktop

Quit and reopen Claude Desktop. You should see a hammer icon (🔨) in the input area — click it to verify the three tools appear: `search_course_materials`, `list_courses`, `get_session_summary`.

---

## Hosted deployment (Vercel — Option B)

For sharing with other students without requiring them to install anything.

### Deploy to Vercel

```bash
npm install -g vercel
vercel deploy
```

Set these environment variables in the Vercel dashboard (Project → Settings → Environment Variables):

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
OPENAI_API_KEY
```

### Student Claude Desktop config (hosted)

Students add this to their `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ross-course-base": {
      "url": "https://<your-vercel-deployment>.vercel.app/api/mcp"
    }
  }
}
```

No Node, no local setup required.

---

## Using the tools in Claude

Once connected, Claude will automatically use the tools when relevant. You can also ask explicitly:

- **"Search for content about Porter's Five Forces"** → calls `search_course_materials`
- **"What courses do you have indexed?"** → calls `list_courses`
- **"Catch me up on Week 3 of STRATEGY 501"** → calls `get_session_summary`

Claude will cite `document_url` links so you can verify every answer against the original Canvas source.

---

## Re-ingesting after new course materials are added

Just run `npm run ingest` again. The script uses `insert` (not upsert) by default, so if you want to avoid duplicates after re-running, truncate the `chunks` table in Supabase first:

```sql
truncate table chunks;
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Tools don't appear in Claude | Check config file path and JSON syntax; restart Claude Desktop |
| `SUPABASE_URL is required` error | Env vars not being passed — check the `env` block in your config |
| No results from search | Run ingestion first; check Supabase table has rows |
| Canvas download errors | Token may have expired — regenerate in Canvas Account > Settings |
| PDF/PPTX extraction empty | File may be image-only (scanned); those can't be extracted without OCR |
