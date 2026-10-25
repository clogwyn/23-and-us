import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const sb = await supabaseServer();
  await sb.auth.signOut();
  const to = request.nextUrl.clone();
  to.pathname = "/sign-in";
  to.search = "";
  return NextResponse.redirect(to, { status: 303 });
}
