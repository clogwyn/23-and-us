import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import { safeNext } from "@/lib/safe-next";

/**
 * Where the sign-in email lands. Handles both link styles:
 *  - ?token_hash=…&type=email  (works when the email is opened on another device)
 *  - ?code=…                   (Supabase's default link; same browser only)
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const next = safeNext(q.get("next"));
  const sb = await supabaseServer();

  const tokenHash = q.get("token_hash");
  const type = q.get("type") as EmailOtpType | null;
  const code = q.get("code");

  let error: string | null = null;
  if (tokenHash && type) {
    const { error: e } = await sb.auth.verifyOtp({ token_hash: tokenHash, type });
    error = e?.message ?? null;
  } else if (code) {
    const { error: e } = await sb.auth.exchangeCodeForSession(code);
    error = e?.message ?? null;
  } else {
    error = "The sign-in link is incomplete.";
  }

  const to = request.nextUrl.clone();
  to.search = "";
  if (error) {
    to.pathname = "/sign-in";
    to.searchParams.set("error", "link");
    if (next !== "/projects") to.searchParams.set("next", next);
  } else {
    to.pathname = next;
  }
  return NextResponse.redirect(to);
}
