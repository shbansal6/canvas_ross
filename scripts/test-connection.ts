import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const { data, error } = await supabase.from('chunks').select('id').limit(1);
if (error) {
  console.log('chunks table:', error.message, '| code:', error.code);
} else {
  console.log('✅ chunks table: OK');
}

const { error: rpcErr } = await supabase.rpc('match_chunks', {
  query_embedding: new Array(768).fill(0),
  match_count: 1,
  filter_course_id: null,
});
if (rpcErr) {
  console.log('match_chunks fn:', rpcErr.message);
} else {
  console.log('✅ match_chunks fn: OK');
}
