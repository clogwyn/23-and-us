import Link from "next/link";
import { requireHousehold } from "@/lib/household";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireHousehold();
  return (
    <div className="shell">
      <nav className="topnav" aria-label="Main">
        <Link href="/projects" className="topnav-mark">23 <span className="amp">&amp;</span> Us</Link>
        <div className="topnav-links">
          <Link href="/projects">Projects</Link>
          <Link href="/household">Household</Link>
          <form action="/auth/sign-out" method="post">
            <button className="linkish" title={user.email ?? undefined}>Sign out</button>
          </form>
        </div>
      </nav>
      {children}
    </div>
  );
}
