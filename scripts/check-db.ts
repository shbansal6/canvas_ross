import { createClient } from '@supabase/supabase-js';

const s = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const { count } = await s.from('chunks').select('*', { count: 'exact', head: true });
console.log(`\nTotal chunks in DB: ${count}\n`);

const { data } = await s.from('chunks').select('course_id, course_name').limit(10000);
const map = new Map<string, { name: string; count: number }>();
for (const r of data ?? []) {
  const entry = map.get(r.course_id) ?? { name: r.course_name, count: 0 };
  entry.count++;
  map.set(r.course_id, entry);
}

console.log('Courses indexed:');
[...map.entries()]
  .sort((a, b) => a[1].name.localeCompare(b[1].name))
  .forEach(([id, { name, count }]) => console.log(`  [${id}] ${name} — ${count} chunks`));
