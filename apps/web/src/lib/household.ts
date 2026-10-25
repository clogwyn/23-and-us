import "server-only";
import { redirect } from "next/navigation";
import { currentUser } from "./supabase/server";

/** For pages inside the app: a signed-in user who belongs to a household, or a redirect. */
export async function requireHousehold() {
  const { sb, user } = await currentUser();
  if (!user) redirect("/sign-in");
  const { data: householdId, error } = await sb.rpc("my_household");
  if (error) throw new Error(`Couldn't load your household: ${error.message}`);
  if (!householdId) redirect("/welcome");
  return { sb, user, householdId: householdId as string };
}
