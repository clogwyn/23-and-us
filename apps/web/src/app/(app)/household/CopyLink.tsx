"use client";
import { useEffect, useState } from "react";

export function CopyLink({ path }: { path: string }) {
  const [done, setDone] = useState(false);
  const [url, setUrl] = useState(path);
  useEffect(() => setUrl(`${window.location.origin}${path}`), [path]);
  return (
    <span className="copy">
      <input readOnly value={url} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
      <button
        type="button"
        className="btn"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setDone(true);
            setTimeout(() => setDone(false), 2000);
          } catch {
            /* clipboard refused: the field is selectable instead */
          }
        }}
      >
        {done ? "Copied" : "Copy link"}
      </button>
    </span>
  );
}
