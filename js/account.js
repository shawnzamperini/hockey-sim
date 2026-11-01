// Accounts and saved bets, through Supabase (config.js). Sign-in is by email
// and password. Accounts are invite-only: the project owner creates each one
// in the Supabase dashboard with a starting password, and people can change
// it from the Bets tab. (Password sign-in needs no emails, which matters on
// Supabase's free plan: new projects can't customize auth emails without
// their own mail service, and the built-in sender allows only a few per hour.)
//
// The Supabase client (~60 KB compressed) loads only when it's needed: on the
// Bets tab or when tracking a bet.

import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const STORAGE_KEY = "hockeysim-auth";
let clientPromise = null;

export const configured = () => Boolean(SUPABASE_URL && SUPABASE_KEY);

/** Has this device signed in before (so loading the client is worthwhile)? */
export function hasStoredSession() {
  try { return Boolean(localStorage.getItem(STORAGE_KEY)); } catch { return false; }
}

function client() {
  clientPromise ??= import("./vendor/supabase.js").then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: STORAGE_KEY },
  }));
  return clientPromise;
}

/** The signed-in user ({ id, email }) or null. */
export async function currentUser() {
  if (!configured()) return null;
  const c = await client();
  const { data } = await c.auth.getSession();
  return data.session?.user ?? null;
}

/** Called with the user (or null) whenever sign-in state changes. */
export async function onAuthChange(fn) {
  if (!configured()) return;
  const c = await client();
  c.auth.onAuthStateChange((_event, session) => fn(session?.user ?? null));
}

const friendly = (error) => {
  const m = String(error?.message || error || "");
  if (/signups? not allowed|user not found|not allowed for otp/i.test(m)) return "That email hasn't been invited yet. Ask the app's owner to add you.";
  if (/rate limit|too many|security purposes/i.test(m)) return "Too many codes requested. Wait a minute and try again.";
  if (/expired|invalid|otp/i.test(m)) return "That code didn't work. Check it, or send a new one.";
  if (/fetch|network/i.test(m)) return "Couldn't reach the server. Check your connection.";
  return m || "Something went wrong.";
};

/** Sign in with email and password. */
export async function signInPassword(email, password) {
  const c = await client();
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) {
    if (/invalid login|invalid credentials/i.test(error.message)) throw new Error("Wrong email or password.");
    throw new Error(friendly(error));
  }
  return data.user;
}

/** Change the signed-in user's password. */
export async function changePassword(password) {
  const c = await client();
  const { error } = await c.auth.updateUser({ password });
  if (error) {
    if (/same|different from the old/i.test(error.message)) throw new Error("That's your current password.");
    if (/weak|short|at least/i.test(error.message)) throw new Error(error.message);
    throw new Error(friendly(error));
  }
}

/** Email a one-time sign-in code (existing accounts only; needs a code email template). */
export async function sendCode(email) {
  const c = await client();
  const { error } = await c.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  if (error) throw new Error(friendly(error));
}

/** Check the code and sign in. */
export async function verifyCode(email, token) {
  const c = await client();
  const { data, error } = await c.auth.verifyOtp({ email, token, type: "email" });
  if (error) throw new Error(friendly(error));
  return data.user;
}

export async function signOut() {
  const c = await client();
  await c.auth.signOut();
}

/** This user's bets, newest first. */
export async function listBets() {
  const c = await client();
  const { data, error } = await c.from("bets").select("*").order("start_time", { ascending: false }).limit(2000);
  if (error) throw new Error(friendly(error));
  return data;
}

/** Save a bet (columns of the bets table). Returns the saved row. */
export async function addBet(row) {
  const c = await client();
  const { data, error } = await c.from("bets").insert(row).select().single();
  if (error) {
    if (/row-level security/i.test(error.message)) throw new Error("Bets can only be saved before the game starts.");
    throw new Error(friendly(error));
  }
  return data;
}

/** Delete an open bet. */
export async function deleteBet(id) {
  const c = await client();
  const { error } = await c.from("bets").delete().eq("id", id);
  if (error) throw new Error(friendly(error));
}

/**
 * Call the private model API (Edge Function "model") as the signed-in user:
 * { action: "details" | "simulate", gameId, ... }.
 */
export async function callModel(body) {
  const c = await client();
  const { data, error } = await c.functions.invoke("model", { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch { /* not JSON */ }
    if (error.context?.status === 401) msg = "Sign in to use the model.";
    if (/Failed to send|fetch/i.test(msg)) msg = "Couldn't reach the server. Check your connection.";
    const e = new Error(msg);
    e.status = error.context?.status;
    throw e;
  }
  return data;
}
