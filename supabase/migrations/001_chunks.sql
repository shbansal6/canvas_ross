-- Enable pgvector extension
create extension if not exists vector;

-- Main chunks table
create table if not exists chunks (
  id bigserial primary key,
  course_id text not null,
  course_name text not null,
  course_term text,
  module_name text,
  document_title text not null,
  document_url text,
  content text not null,
  embedding vector(768),
  created_at timestamptz default now()
);

-- Disable RLS — private single-user project, no need for row-level security
alter table chunks disable row level security;

-- HNSW index for fast cosine similarity search
create index if not exists chunks_embedding_idx
  on chunks using hnsw (embedding vector_cosine_ops);

-- Index for filtering by course
create index if not exists chunks_course_id_idx on chunks (course_id);

-- Composite index for get_session_summary queries
create index if not exists chunks_course_module_idx on chunks (course_id, module_name);

-- Vector similarity search function
create or replace function match_chunks(
  query_embedding vector(768),
  match_count int default 8,
  filter_course_id text default null
)
returns table (
  id bigint,
  course_id text,
  course_name text,
  course_term text,
  module_name text,
  document_title text,
  document_url text,
  content text,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    c.id,
    c.course_id,
    c.course_name,
    c.course_term,
    c.module_name,
    c.document_title,
    c.document_url,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  where
    (filter_course_id is null or c.course_id = filter_course_id)
    and c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
end;
$$;
