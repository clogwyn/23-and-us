import type { Metadata } from "next";
import { safeNext } from "@/lib/safe-next";
import { SignInForm } from "./SignInForm";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignIn({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams;
  return (
    <main className="auth">
      <div className="auth-card">
        <div className="auth-photo">
          <img src="/house-front.jpg" alt="Number 23 from the front path" width={540} height={386} />
          <span className="logo">23 <span className="amp">&amp;</span> Us</span>
        </div>
        <div className="auth-body">
          <h1>Sign in</h1>
          <p className="muted">We'll email you a link and a 6-digit code. No password needed.</p>
          {sp.error === "link" && (
            <p className="form-error" role="alert">That sign-in link has expired or was already used. Request a new one below.</p>
          )}
          <SignInForm next={safeNext(sp.next)} />
        </div>
      </div>
    </main>
  );
}
