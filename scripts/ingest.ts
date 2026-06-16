/**
 * Canvas ingestion script.
 * Run with: npm run ingest
 * Dry-run (no Supabase writes): npm run ingest:dry
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';
import { encode, decode } from 'gpt-tokenizer';
import * as cheerio from 'cheerio';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import path from 'path';

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------

const CANVAS_BASE_URL = process.env.CANVAS_BASE_URL ?? 'https://umich.instructure.com';
const CANVAS_API_TOKEN = process.env.CANVAS_API_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = process.env.DRY_RUN === 'true';
// Optional: comma-separated course IDs to ingest only specific courses
// e.g. COURSE_IDS=799152,824721 npm run ingest
const COURSE_IDS = process.env.COURSE_IDS
  ? new Set(process.env.COURSE_IDS.split(',').map((s) => s.trim()))
  : null;

const CHUNK_SIZE_TOKENS = 750;
const CHUNK_OVERLAP_TOKENS = 100;
const EMBED_BATCH_SIZE = 20;  // how many chunks to collect before writing to Supabase
const EMBED_CALL_DELAY_MS = 1500; // 1.5 s between individual embed calls → 40 RPM (free tier limit: 100 RPM)
const CANVAS_DELAY_MS = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CanvasCourse {
  id: number;
  name: string;
  course_code: string;
  enrollment_state: string;
  term?: { name: string };
}

interface CanvasModule {
  id: number;
  name: string;
  items?: CanvasModuleItem[];
}

interface CanvasModuleItem {
  id: number;
  type: string;
  title: string;
  content_id?: number;
  page_url?: string;
}

interface CanvasFile {
  id: number;
  filename: string;
  display_name: string;
  'content-type': string;
  url: string;
}

interface CanvasPage {
  url: string;
  title: string;
  body: string | null;
}

interface ChunkRecord {
  course_id: string;
  course_name: string;
  course_term: string | null;
  module_name: string | null;
  document_title: string;
  document_url: string | null;
  content: string;
  embedding: number[];
}

// ---------------------------------------------------------------------------
// Canvas API helpers
// ---------------------------------------------------------------------------

const canvasHeaders = {
  Authorization: `Bearer ${CANVAS_API_TOKEN}`,
  'Content-Type': 'application/json',
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

async function fetchAllPages<T>(endpoint: string): Promise<T[]> {
  const results: T[] = [];
  let nextUrl: string | null = `${CANVAS_BASE_URL}${endpoint}`;

  while (nextUrl) {
    await sleep(CANVAS_DELAY_MS);
    const res = await fetch(nextUrl, { headers: canvasHeaders });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canvas API ${res.status} at ${nextUrl}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as T[];
    results.push(...data);
    nextUrl = parseNextLink(res.headers.get('Link'));
  }

  return results;
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

async function extractPdf(buffer: Buffer): Promise<string> {
  const pdfParse = (await import('pdf-parse')).default;
  const result = await pdfParse(buffer);
  return result.text;
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function extractPptx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const texts: string[] = [];
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort();
  for (const slideFile of slideFiles) {
    const xml = await zip.files[slideFile].async('text');
    const matches = xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g) ?? [];
    const slideText = matches.map((m) => m.replace(/<[^>]+>/g, '')).join(' ').trim();
    if (slideText) texts.push(slideText);
  }
  return texts.join('\n\n');
}

function extractHtml(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, nav, header, footer').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

async function extractText(buffer: Buffer, contentType: string, filename: string): Promise<string | null> {
  const ext = path.extname(filename).toLowerCase();
  try {
    if (ext === '.pdf' || contentType.includes('pdf')) return await extractPdf(buffer);
    if (ext === '.docx' || contentType.includes('wordprocessingml')) return await extractDocx(buffer);
    if (ext === '.pptx' || contentType.includes('presentationml')) return await extractPptx(buffer);
    if (ext === '.html' || ext === '.htm' || contentType.includes('html')) return extractHtml(buffer.toString('utf-8'));
    if (ext === '.txt' || contentType.startsWith('text/')) return buffer.toString('utf-8');
    return null;
  } catch (err) {
    console.warn(`  ⚠ Extract failed for ${filename}: ${(err as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Chunking (token-aware)
// ---------------------------------------------------------------------------

function chunkText(text: string): string[] {
  const tokens = encode(text);
  if (tokens.length === 0) return [];

  const chunks: string[] = [];
  let start = 0;

  while (start < tokens.length) {
    const end = Math.min(start + CHUNK_SIZE_TOKENS, tokens.length);
    const chunk = decode(tokens.slice(start, end));
    if (chunk.trim().length > 50) chunks.push(chunk.trim());
    if (end === tokens.length) break;
    start += CHUNK_SIZE_TOKENS - CHUNK_OVERLAP_TOKENS;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Embeddings — Gemini gemini-embedding-001 (3072 dims)
// ---------------------------------------------------------------------------

let ai: GoogleGenAI;

async function embedOne(text: string, retries = 4): Promise<number[]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await ai.models.embedContent({
        model: 'gemini-embedding-001',
        contents: text,
        config: { outputDimensionality: 768 },
      });
      return (result.embeddings ?? [])[0]?.values ?? [];
    } catch (err) {
      const msg = String(err);
      const isRateLimit = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
      if (isRateLimit && attempt < retries) {
        const wait = 60_000 * (attempt + 1);
        console.log(`\n  ⏳ Rate limit — waiting ${wait / 1000}s (retry ${attempt + 1}/${retries})...`);
        await sleep(wait);
      } else {
        throw err;
      }
    }
  }
  return [];
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    results.push(await embedOne(texts[i]));
    if (i < texts.length - 1) await sleep(EMBED_CALL_DELAY_MS);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Supabase upsert
// ---------------------------------------------------------------------------

async function upsertChunks(supabase: SupabaseClient, records: ChunkRecord[]): Promise<void> {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would insert ${records.length} chunks`);
    return;
  }
  const { error } = await supabase.from('chunks').insert(records);
  if (error) throw new Error(`Supabase insert error: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Module → content mapping helpers
// ---------------------------------------------------------------------------

function buildFileModuleMap(modules: CanvasModule[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const mod of modules) {
    for (const item of mod.items ?? []) {
      if (item.type === 'File' && item.content_id != null) map.set(item.content_id, mod.name);
    }
  }
  return map;
}

function buildPageModuleMap(modules: CanvasModule[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const mod of modules) {
    for (const item of mod.items ?? []) {
      if (item.type === 'Page' && item.page_url) map.set(item.page_url, mod.name);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Process one course
// ---------------------------------------------------------------------------

async function processCourse(course: CanvasCourse, supabase: SupabaseClient): Promise<void> {
  const courseId = String(course.id);
  const courseName = course.name;
  const courseTerm = course.term?.name ?? null;

  console.log(`\n📚 ${courseName} (${courseId})`);

  const modules = await fetchAllPages<CanvasModule>(
    `/api/v1/courses/${courseId}/modules?include[]=items&per_page=100`,
  );
  const fileModuleMap = buildFileModuleMap(modules);
  const pageModuleMap = buildPageModuleMap(modules);

  const files = await fetchAllPages<CanvasFile>(
    `/api/v1/courses/${courseId}/files?per_page=100`,
  );
  console.log(`  ${files.length} files, ${modules.length} modules`);

  const pendingChunks: Omit<ChunkRecord, 'embedding'>[] = [];

  // --- Files ---
  for (const file of files) {
    const ct = file['content-type'] ?? '';
    const supported =
      ct.includes('pdf') ||
      ct.includes('wordprocessingml') ||
      ct.includes('presentationml') ||
      ct.includes('html') ||
      ct.startsWith('text/') ||
      /\.(pdf|docx|pptx|html?|txt)$/i.test(file.filename);

    if (!supported || !file.url) continue;

    let buffer: Buffer;
    try {
      await sleep(CANVAS_DELAY_MS);
      const res = await fetch(file.url, { headers: canvasHeaders });
      if (!res.ok) { console.warn(`  ⚠ Skip ${file.display_name} (${res.status})`); continue; }
      buffer = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      console.warn(`  ⚠ Download failed ${file.display_name}: ${(err as Error).message}`);
      continue;
    }

    const text = await extractText(buffer, ct, file.filename);
    if (!text || text.trim().length < 100) continue;

    const chunks = chunkText(text);
    const moduleName = fileModuleMap.get(file.id) ?? null;
    const documentUrl = `${CANVAS_BASE_URL}/courses/${courseId}/files/${file.id}`;

    for (const chunk of chunks) {
      pendingChunks.push({
        course_id: courseId, course_name: courseName, course_term: courseTerm,
        module_name: moduleName, document_title: file.display_name,
        document_url: documentUrl, content: chunk,
      });
    }
    console.log(`  ✓ ${file.display_name} → ${chunks.length} chunks`);
  }

  // --- Pages (some courses disable the pages API — treat 404 as empty) ---
  let pages: CanvasPage[] = [];
  try {
    pages = await fetchAllPages<CanvasPage>(
      `/api/v1/courses/${courseId}/pages?per_page=100`,
    );
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (!msg.includes('404')) throw err; // only swallow "page disabled" 404s
  }
  for (const page of pages) {
    if (!page.body) continue;
    const text = extractHtml(page.body);
    if (text.trim().length < 100) continue;

    const chunks = chunkText(text);
    const moduleName = pageModuleMap.get(page.url) ?? null;
    const documentUrl = `${CANVAS_BASE_URL}/courses/${courseId}/pages/${page.url}`;

    for (const chunk of chunks) {
      pendingChunks.push({
        course_id: courseId, course_name: courseName, course_term: courseTerm,
        module_name: moduleName, document_title: page.title,
        document_url: documentUrl, content: chunk,
      });
    }
    console.log(`  ✓ [page] ${page.title} → ${chunks.length} chunks`);
  }

  if (pendingChunks.length === 0) {
    console.log('  (no extractable content)');
    return;
  }

  // Embed in batches
  console.log(`  Embedding ${pendingChunks.length} chunks...`);
  const records: ChunkRecord[] = [];

  for (let i = 0; i < pendingChunks.length; i += EMBED_BATCH_SIZE) {
    const batch = pendingChunks.slice(i, i + EMBED_BATCH_SIZE);
    const embeddings = await embedBatch(batch.map((c) => c.content));
    for (let j = 0; j < batch.length; j++) {
      records.push({ ...batch[j], embedding: embeddings[j] });
    }
    process.stdout.write(`  ${Math.min(i + EMBED_BATCH_SIZE, pendingChunks.length)}/${pendingChunks.length}\r`);
  }
  console.log();

  await upsertChunks(supabase, records);
  console.log(`  ✅ ${records.length} chunks saved`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!CANVAS_API_TOKEN) throw new Error('CANVAS_API_TOKEN is required');
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required');
  if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required (or set DRY_RUN=true)');
  }

  ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

  const supabase = createClient(
    SUPABASE_URL ?? 'http://localhost:54321',
    SUPABASE_SERVICE_ROLE_KEY ?? 'placeholder',
  );

  console.log(`🎓 Ross Course Base — Ingestion`);
  console.log(`Canvas: ${CANVAS_BASE_URL}`);
  console.log(`Embedding: Gemini gemini-embedding-001 (3072 dims)`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  const activeCourses = await fetchAllPages<CanvasCourse>(
    '/api/v1/courses?enrollment_state=active&include[]=term&per_page=100',
  );
  const completedCourses = await fetchAllPages<CanvasCourse>(
    '/api/v1/courses?enrollment_state=completed&include[]=term&per_page=100',
  );

  const seen = new Set<number>();
  const allCourses = [...activeCourses, ...completedCourses].filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  console.log(`Found ${allCourses.length} courses:\n`);
  allCourses.forEach((c, i) => console.log(`  ${i + 1}. [${c.id}] ${c.term?.name ?? 'No Term'} — ${c.name}`));
  console.log();

  const filteredCourses = COURSE_IDS
    ? allCourses.filter((c) => COURSE_IDS.has(String(c.id)))
    : allCourses;

  if (COURSE_IDS) {
    console.log(`Targeting ${filteredCourses.length} specific course(s)\n`);
  }

  for (const course of filteredCourses) {
    try {
      await processCourse(course, supabase);
    } catch (err) {
      console.error(`  ❌ ${course.name}: ${(err as Error).message}`);
    }
  }

  console.log('\n✅ Ingestion complete');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
