import 'server-only'
import { createClient } from '@supabase/supabase-js'

// Server-only. Uses the service role key which bypasses Row Level Security.
// Never import this in client components or expose to the browser.
// The `import 'server-only'` above causes the build to fail if this is
// accidentally imported in a client context.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )
}
