import { createClient } from '@supabase/supabase-js';
const s = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const { error } = await s.from('chunks').delete().neq('id', 0);
if (error) console.log('error:', error.message);
else console.log('✅ chunks table cleared');
