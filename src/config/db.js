const { createClient } = require("@supabase/supabase-js");

let supabaseClient = null;

function getSupabaseConfig() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl) {
    throw new Error("SUPABASE_URL is missing. Set it in .env");
  }
  if (!supabaseKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY is missing. Set it in .env");
  }

  return {
    supabaseUrl,
    supabaseKey,
    usingServiceRole: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
  };
}

function createSupabaseClient() {
  const { supabaseUrl, supabaseKey } = getSupabaseConfig();
  return createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
}

function connectDatabase() {
  if (!supabaseClient) {
    supabaseClient = createSupabaseClient();
  }
  return supabaseClient;
}

function getSupabase() {
  if (!supabaseClient) {
    return connectDatabase();
  }
  return supabaseClient;
}

/**
 * Allows automated tests to inject an isolated in-memory Supabase/Storage client
 * without touching production databases or credentials.
 */
function setSupabaseClientForTest(client) {
  supabaseClient = client;
}

async function throwIfError(error, fallbackMessage) {
  if (!error) {
    return;
  }
  const message = error.message || fallbackMessage || "Supabase query failed";
  const wrapped = new Error(message);
  wrapped.cause = error;
  throw wrapped;
}

module.exports = {
  getSupabaseConfig,
  connectDatabase,
  getSupabase,
  setSupabaseClientForTest,
  throwIfError
};
