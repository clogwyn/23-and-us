/** Only allow same-site relative paths as post-sign-in destinations (no open redirects). */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/projects";
  return raw;
}
