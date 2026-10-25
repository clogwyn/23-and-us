import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Welcome" };

async function createHousehold() {
  "use server";
  const { sb, user } = await currentUser();
  if (!user) redirect("/sign-in");
  const { error } = await sb.rpc("create_household", { p_name: "23 & Us" });
  if (error) throw new Error(`Couldn't set up your household: ${error.message}`);
  redirect("/projects");
}

export default async function Welcome() {
  const { sb, user } = await currentUser();
  if (!user) redirect("/sign-in");
  const { data: existing } = await sb.rpc("my_household");
  if (existing) redirect("/projects");

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="auth-photo">
          <img src="/house-front.jpg" alt="Number 23 from the front path" width={540} height={386} />
          <span className="logo">23 <span className="amp">&amp;</span> Us</span>
        </div>
        <div className="auth-body">
          <h1>Set up your household</h1>
          <p>You're signed in as <strong>{user.email}</strong>. Your projects, tasks, budgets and files will live in this household, and you can invite your partner to it.</p>
          <p className="muted">Joining someone else's household instead? Open the invite link they sent you rather than setting up a new one.</p>
          <form action={createHousehold} className="form-actions">
            <button className="btn btn-primary">Create household</button>
          </form>
        </div>
      </div>
    </main>
  );
}
