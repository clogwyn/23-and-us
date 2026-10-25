"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/browser";

export function SignInForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const redirect = `${window.location.origin}/auth/confirm?next=${encodeURIComponent(next)}`;
    const { error } = await supabaseBrowser().auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: redirect, shouldCreateUser: true },
    });
    setBusy(false);
    if (error) {
      setError(
        error.status === 429
          ? "Too many emails have been sent in the last hour. Wait a little and try again."
          : `Couldn't send the email: ${error.message}`,
      );
      return;
    }
    setStage("code");
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabaseBrowser().auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
    setBusy(false);
    if (error) {
      setError("That code didn't work. Check it, or request a new email.");
      return;
    }
    router.replace(next);
    router.refresh();
  }

  if (stage === "code") {
    return (
      <form className="form" onSubmit={verify}>
        <p>
          Email sent to <strong>{email}</strong>. Open the link in it <strong>on this device</strong> to sign in.
        </p>
        <p className="muted">If your email includes a 6-digit code, you can type it here instead.</p>
        <label htmlFor="code">6-digit code</label>
        <input
          id="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          required
        />
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button className="btn btn-primary" disabled={busy || code.length !== 6}>Sign in</button>
          <button type="button" className="btn btn-quiet" onClick={() => setStage("email")}>Use a different email</button>
        </div>
      </form>
    );
  }

  return (
    <form className="form" onSubmit={send}>
      <label htmlFor="email">Email address</label>
      <input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions">
        <button className="btn btn-primary" disabled={busy}>{busy ? "Sending…" : "Email me a sign-in link"}</button>
      </div>
    </form>
  );
}
