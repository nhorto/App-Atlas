// A deployed door the rest of the repo never mentions: Supabase serves this file
// over HTTP at /functions/v1/greet. Nothing in package.json announces it — the
// directory convention is the whole deployment contract.
//
// The handler also checks the caller itself, which puts *two* guards in this one
// file: the platform's JWT verification and the in-handler auth call. Real edge
// functions do exactly this, and it once crashed the analyzer.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req: Request) => {
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!);
  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
  const { data: auth } = await supabase.auth.getUser(jwt);
  if (!auth?.user) {
    return new Response('who are you?', { status: 401 });
  }

  const { name } = await req.json().catch(() => ({ name: 'stranger' }));
  return new Response(JSON.stringify({ hello: name }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
