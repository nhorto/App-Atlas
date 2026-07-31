import { createClient as createSupabaseClient } from '@supabase/supabase-js';

/**
 * The app's own wrapper round the Supabase client, which is how nearly every real
 * project builds one — and the reason the client cannot be traced back to the package
 * anywhere else in this fixture. Everything downstream has only the shape of the call
 * to go on.
 */
export function createClient() {
  return createSupabaseClient('https://example.supabase.co', 'anon-key');
}
