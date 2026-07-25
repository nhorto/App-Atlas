/** Fire-and-forget usage metrics, written straight to Supabase — no schema file
 * declares `page_views`, so the analyzer only ever sees the table's name in these
 * queries. */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);

export async function recordPageView(path: string): Promise<void> {
  await supabase.from('page_views').insert({ path, at: new Date().toISOString() });
}

export async function topPages(): Promise<unknown[]> {
  const { data } = await supabase.from('page_views').select('*').limit(10);
  return data ?? [];
}
