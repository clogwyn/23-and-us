import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireHousehold } from "@/lib/household";
import { load } from "@/features/workspace/mapping";
import { Workspace } from "@/features/workspace/Workspace";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const { sb } = await requireHousehold();
  const { data } = await sb.from("projects").select("name").eq("id", id).maybeSingle();
  return { title: data?.name ?? "Project" };
}

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { sb, householdId } = await requireHousehold();

  const { data: exists } = await sb.from("projects").select("id").eq("id", id).maybeSingle();
  if (!exists) notFound();

  const [state, areas, categories] = await Promise.all([
    load(sb, id),
    sb.from("areas").select("id, name").eq("household_id", householdId).order("sort"),
    sb.from("cost_categories").select("id, name").eq("household_id", householdId).order("sort"),
  ]);

  return <Workspace initial={state} areas={areas.data ?? []} categories={categories.data ?? []} />;
}
