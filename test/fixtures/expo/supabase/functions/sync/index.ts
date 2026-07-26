// The one door in this app a stranger can actually reach: everything else is a
// screen, which needs the app already installed and open. Guarded, so the auth list
// has exactly one entry and every screen stays out of it.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req: Request) => {
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!);
  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
  const { data: auth } = await supabase.auth.getUser(jwt);
  if (!auth?.user) return new Response('who are you?', { status: 401 });

  const { bottleId } = await req.json();
  await supabase.from('cellar_bottles').update({ synced: true }).eq('id', bottleId);
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
});
