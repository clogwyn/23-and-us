import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Join household" };

async function accept(formData: FormData) {
  "use server";
  const token = String(formData.get("token"));
  const { sb, user } = await currentUser();
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`);
  const { error } = await sb.rpc("accept_invite", { p_token: token });
  if (error) redirect(`/invite/${token}?error=${encodeURIComponent(error.message)}`);
  redirect("/projects");
}

export default async function Invite({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;
  const { user } = await currentUser();

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="auth-photo">
          <img src="/house-front.jpg" alt="Number 23 from the front path" width={540} height={386} />
          <span className="logo">23 <span className="amp">&amp;</span> Us</span>
        </div>
        <div className="auth-body">
          <h1>You're invited</h1>
          <p>Join the household to see and edit its renovation projects, tasks, budgets and files.</p>
          {error && <p className="form-error" role="alert">{error}</p>}
          {user ? (
            <>
              <p className="muted">Signed in as <strong>{user.email}</strong>. This must be the address the invite was sent to.</p>
              <form action={accept} className="form-actions">
                <input type="hidden" name="token" value={token} />
                <button className="btn btn-primary">Join household</button>
              </form>
            </>
          ) : (
            <div className="form-actions">
              <Link className="btn btn-primary" href={`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`}>Sign in to join</Link>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
