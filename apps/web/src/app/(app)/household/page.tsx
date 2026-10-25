import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { requireHousehold } from "@/lib/household";
import { CopyLink } from "./CopyLink";

export const metadata: Metadata = { title: "Household" };

async function invite(formData: FormData) {
  "use server";
  const { sb, householdId, user } = await requireHousehold();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter a valid email address.");
  const { error } = await sb.from("household_invites").insert({ household_id: householdId, email, created_by: user.id });
  if (error) throw new Error(`Couldn't create the invite: ${error.message}`);
  revalidatePath("/household");
}

async function revoke(formData: FormData) {
  "use server";
  const { sb } = await requireHousehold();
  await sb.from("household_invites").delete().eq("id", String(formData.get("id")));
  revalidatePath("/household");
}

export default async function Household() {
  const { sb, householdId, user } = await requireHousehold();
  const [{ data: members }, { data: invites }] = await Promise.all([
    sb.from("household_members").select("user_id, email, created_at").eq("household_id", householdId).order("created_at"),
    sb.from("household_invites").select("id, email, token, expires_at, accepted_at").eq("household_id", householdId).is("accepted_at", null).order("created_at", { ascending: false }),
  ]);

  return (
    <main className="page narrow">
      <h1>Household</h1>
      <section className="panel">
        <h2>Members</h2>
        <ul className="list">
          {(members ?? []).map((m) => (
            <li key={m.user_id}>
              <span>{m.email ?? "Member"}</span>
              <span className="muted">{m.user_id === user.id ? "You" : `Joined ${new Date(m.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>Invite your partner</h2>
        <p className="muted">Enter their email, then send them the link yourself (message, WhatsApp, email). They sign in with that same email address to join. Links last 14 days.</p>
        <form action={invite} className="form inline">
          <label htmlFor="inviteEmail" className="sr-only">Their email address</label>
          <input id="inviteEmail" name="email" type="email" placeholder="their@email.com" required />
          <button className="btn btn-primary">Create invite link</button>
        </form>
        {(invites ?? []).length > 0 && (
          <ul className="list">
            {(invites ?? []).map((i) => {
              const expired = new Date(i.expires_at) < new Date();
              return (
                <li key={i.id} className="invite">
                  <div>
                    <strong>{i.email}</strong>
                    <span className="muted"> {expired ? "Expired" : `Expires ${new Date(i.expires_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`}</span>
                  </div>
                  <div className="invite-actions">
                    {!expired && <CopyLink path={`/invite/${i.token}`} />}
                    <form action={revoke}><input type="hidden" name="id" value={i.id} /><button className="btn btn-quiet">Cancel</button></form>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
