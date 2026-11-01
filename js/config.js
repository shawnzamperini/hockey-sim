// Accounts and bet tracking (Supabase). The URL and publishable key are
// public by design: what they can do is limited by the database's row-level
// security rules (supabase/schema.sql). Never put the secret key here.
export const SUPABASE_URL = "https://kkapsiyinomruzpnxkgf.supabase.co";
export const SUPABASE_KEY = "sb_publishable_WOYUfHjI6F-ohU8OJq-1JA_Nljfw_wa";

// Public data (schedule, scores, standings, finished predictions), uploaded
// hourly to a public storage bucket. Everything model-based comes from the
// signed-in model API (the "model" Edge Function).
export const DATA_URL = `${SUPABASE_URL}/storage/v1/object/public/public-data`;
