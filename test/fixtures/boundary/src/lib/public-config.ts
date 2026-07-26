/** Configuration the browser is allowed to see.
 *
 * Next.js inlines every `NEXT_PUBLIC_*` variable into the client bundle, so nothing
 * here is a credential — including the anon key, which Supabase publishes on purpose
 * and guards with row-level security rather than secrecy. Both names would trip a
 * substring test for "key"; neither should be badged as a secret. */
export const publicConfig = {
  appUrl: process.env.NEXT_PUBLIC_APP_URL,
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
};
