"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { useWS } from "../workspace/context";
import { preparePhoto } from "./image";

type Kind = "photo" | "drawing" | "quote" | "invoice" | "warranty" | "certificate" | "document" | "other";
const DOC_KINDS: { id: Kind; label: string }[] = [
  { id: "drawing", label: "Plans & drawings" },
  { id: "quote", label: "Quotes" },
  { id: "invoice", label: "Invoices & receipts" },
  { id: "certificate", label: "Certificates" },
  { id: "warranty", label: "Warranties & manuals" },
  { id: "document", label: "Other documents" },
];
const DOC_MIME = [
  "application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain", "text/csv",
];
const MAX_BYTES = 50 * 1024 * 1024;
const BUCKET = "attachments";

interface Att {
  id: string;
  storagePath: string;
  thumbPath: string | null;
  mime: string;
  bytes: number;
  kind: Kind;
  caption: string;
  takenAt: string | null;
  createdAt: string;
  taskId: string | null;
}

const safeName = (n: string) => n.normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").slice(-80) || "file";
const size = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export function Files({ kind }: { kind: "photos" | "documents" }) {
  const ws = useWS();
  const { store } = ws;
  const sb = supabaseBrowser();
  const project = store.state.project;
  const [items, setItems] = useState<Att[] | null>(null);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Att | null>(null);
  const [docKind, setDocKind] = useState<Kind>("drawing");

  const refresh = useCallback(async () => {
    const { data: links, error } = await sb.from("attachment_links").select("attachment_id").eq("project_id", project.id);
    if (error) return ws.toast(`Couldn't load files: ${error.message}`);
    const ids = (links ?? []).map((l) => l.attachment_id as string);
    if (!ids.length) { setItems([]); return; }
    const taskIds = store.state.tasks.map((t) => t.id);
    const [{ data: rows }, { data: tlinks }] = await Promise.all([
      sb.from("attachments").select("*").in("id", ids),
      taskIds.length ? sb.from("attachment_links").select("attachment_id, task_id").in("attachment_id", ids).not("task_id", "is", null) : Promise.resolve({ data: [] as { attachment_id: string; task_id: string }[] }),
    ]);
    const taskOf = new Map((tlinks ?? []).map((l) => [l.attachment_id as string, l.task_id as string]));
    const list: Att[] = (rows ?? []).map((r) => ({
      id: r.id, storagePath: r.storage_path, thumbPath: r.thumb_path, mime: r.mime, bytes: Number(r.bytes), kind: r.kind,
      caption: r.caption ?? "", takenAt: r.taken_at, createdAt: r.created_at, taskId: taskOf.get(r.id) ?? null,
    }));
    list.sort((a, b) => (b.takenAt ?? b.createdAt).localeCompare(a.takenAt ?? a.createdAt));
    setItems(list);
    const paths = list.filter((a) => a.kind === "photo").map((a) => a.thumbPath ?? a.storagePath);
    if (paths.length) {
      const { data: signed } = await sb.storage.from(BUCKET).createSignedUrls(paths, 3600);
      setUrls(new Map((signed ?? []).filter((s) => s.signedUrl && s.path).map((s) => [s.path as string, s.signedUrl as string])));
    }
  }, [sb, project.id, store, ws]);

  useEffect(() => {
    void refresh();
    const ch = sb
      .channel(`files:${project.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "attachment_links", filter: `project_id=eq.${project.id}` }, () => void refresh())
      .subscribe();
    return () => void sb.removeChannel(ch);
  }, [sb, project.id, refresh]);

  const photos = useMemo(() => (items ?? []).filter((a) => a.kind === "photo"), [items]);
  const docs = useMemo(() => (items ?? []).filter((a) => a.kind !== "photo"), [items]);

  async function register(id: string, path: string, thumb: string | null, mime: string, bytes: number, k: Kind, takenAt: string | null, w?: number, h?: number) {
    const { data: u } = await sb.auth.getUser();
    const ins = await sb.from("attachments").insert({
      id, household_id: project.householdId, storage_path: path, thumb_path: thumb, mime, bytes, kind: k,
      caption: "", taken_at: takenAt, width: w ?? null, height: h ?? null, created_by: u.user?.id ?? null,
    });
    if (ins.error) throw new Error(ins.error.message);
    const link = await sb.from("attachment_links").insert({ household_id: project.householdId, attachment_id: id, project_id: project.id });
    if (link.error) throw new Error(link.error.message);
  }

  async function uploadPhotos(files: FileList) {
    const list = [...files];
    let done = 0;
    for (const file of list) {
      setBusy(`Preparing ${done + 1} of ${list.length}…`);
      try {
        const { full, thumb } = await preparePhoto(file);
        const id = crypto.randomUUID();
        const ext = full.type === "image/webp" ? "webp" : "jpg";
        const base = `${project.householdId}/${id}`;
        const path = `${base}/${safeName(file.name.replace(/\.[^.]+$/, ""))}.${ext}`;
        const tpath = `${base}/thumb.${thumb.type === "image/webp" ? "webp" : "jpg"}`;
        setBusy(`Uploading ${done + 1} of ${list.length}…`);
        const up1 = await sb.storage.from(BUCKET).upload(path, full.blob, { contentType: full.type });
        if (up1.error) throw new Error(up1.error.message);
        const up2 = await sb.storage.from(BUCKET).upload(tpath, thumb.blob, { contentType: thumb.type });
        if (up2.error) throw new Error(up2.error.message);
        const taken = file.lastModified ? new Date(file.lastModified).toISOString().slice(0, 10) : null;
        await register(id, path, tpath, full.type, full.blob.size, "photo", taken, full.width, full.height);
        done++;
      } catch (e) {
        ws.toast(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setBusy(null);
    if (done) ws.toast(`Added ${done} photo${done === 1 ? "" : "s"}.`);
    await refresh();
  }

  async function uploadDocs(files: FileList) {
    let done = 0;
    for (const file of [...files]) {
      if (file.size > MAX_BYTES) { ws.toast(`${file.name} is over 50 MB, the largest file storage accepts.`); continue; }
      const mime = file.type || "application/octet-stream";
      if (!DOC_MIME.includes(mime)) { ws.toast(`${file.name}: only PDFs, images, Word, Excel, text and CSV files can be stored.`); continue; }
      setBusy(`Uploading ${file.name}…`);
      try {
        const id = crypto.randomUUID();
        const path = `${project.householdId}/${id}/${safeName(file.name)}`;
        const up = await sb.storage.from(BUCKET).upload(path, file, { contentType: mime });
        if (up.error) throw new Error(up.error.message);
        await register(id, path, null, mime, file.size, docKind, null);
        done++;
      } catch (e) {
        ws.toast(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setBusy(null);
    if (done) ws.toast(`Added ${done} document${done === 1 ? "" : "s"}.`);
    await refresh();
  }

  async function openFile(a: Att): Promise<string | undefined> {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(a.storagePath, 600);
    if (error || !data) {
      ws.toast("Couldn't open the file.");
      return undefined;
    }
    if (a.kind === "photo") setUrls((m) => new Map(m).set(a.storagePath, data.signedUrl));
    return data.signedUrl;
  }

  async function remove(a: Att) {
    const paths = [a.storagePath, a.thumbPath].filter(Boolean) as string[];
    const del = await sb.from("attachments").delete().eq("id", a.id);
    if (del.error) return ws.toast(`Couldn't delete: ${del.error.message}`);
    await sb.storage.from(BUCKET).remove(paths);
    setOpen(null);
    ws.toast("Deleted.");
    await refresh();
  }

  async function saveMeta(a: Att, patch: { caption?: string; kind?: Kind; taskId?: string | null }) {
    if (patch.caption !== undefined || patch.kind !== undefined) {
      const upd = await sb.from("attachments").update({ ...(patch.caption !== undefined && { caption: patch.caption }), ...(patch.kind && { kind: patch.kind }) }).eq("id", a.id);
      if (upd.error) return ws.toast(`Couldn't save: ${upd.error.message}`);
    }
    if (patch.taskId !== undefined) {
      await sb.from("attachment_links").delete().eq("attachment_id", a.id).not("task_id", "is", null);
      if (patch.taskId) {
        const l = await sb.from("attachment_links").insert({ household_id: project.householdId, attachment_id: a.id, task_id: patch.taskId });
        if (l.error) return ws.toast(`Couldn't link to the task: ${l.error.message}`);
      }
    }
    await refresh();
  }

  const taskOptions = store.state.tasks
    .filter((t) => !store.isSummary(t.id))
    .sort((a, b) => store.wbs(a.id).localeCompare(store.wbs(b.id), undefined, { numeric: true }));
  const taskLabel = (id: string | null) => (id ? `${store.wbs(id)} ${store.task(id)?.title ?? ""}` : "");

  if (kind === "photos") {
    return (
      <section className="files">
        <header className="files-head">
          <div>
            <h2>Photos</h2>
            <p className="muted">Before, during and after. Photos are resized on your device before upload, so they're quick to share between you.</p>
          </div>
          <label className="btn btn-primary file-btn">
            {busy ?? "Add photos"}
            <input type="file" accept="image/*" multiple hidden disabled={!!busy} onChange={(e) => { if (e.target.files?.length) void uploadPhotos(e.target.files); e.target.value = ""; }} />
          </label>
        </header>
        {items === null ? <p className="muted">Loading…</p> : photos.length === 0 ? (
          <p className="empty-state panel">No photos yet. Add some from your phone's camera roll, or take one now.</p>
        ) : (
          <ul className="gallery">
            {photos.map((a) => (
              <li key={a.id}>
                <button className="tile" onClick={() => { setOpen(a); void openFile(a); }} aria-label={a.caption || `Photo from ${day(a.takenAt ?? a.createdAt)}`}>
                  {urls.get(a.thumbPath ?? a.storagePath) ? <img src={urls.get(a.thumbPath ?? a.storagePath)} alt="" loading="lazy" /> : <span className="tile-ph" />}
                  <span className="tile-cap">{a.caption || day(a.takenAt ?? a.createdAt)}{a.taskId ? ` · ${store.wbs(a.taskId)}` : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {open && (
          <Viewer
            a={open}
            src={urls.get(open.storagePath) ?? urls.get(open.thumbPath ?? "") ?? null}
            onClose={() => setOpen(null)}
            onDelete={() => remove(open)}
            onSave={(p) => saveMeta(open, p).then(() => setOpen({ ...open, ...p }))}
            tasks={taskOptions.map((t) => ({ id: t.id, label: taskLabel(t.id) }))}
          />
        )}
      </section>
    );
  }

  return (
    <section className="files">
      <header className="files-head">
        <div>
          <h2>Plans &amp; documents</h2>
          <p className="muted">Drawings, quotes, invoices, certificates (Part P, Gas Safe, Building Control) and warranties. Up to 50 MB each.</p>
        </div>
        <div className="files-actions">
          <label className="field-inline" htmlFor="docKind">Type
            <select id="docKind" value={docKind} onChange={(e) => setDocKind(e.target.value as Kind)}>
              {DOC_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
          </label>
          <label className="btn btn-primary file-btn">
            {busy ?? "Upload"}
            <input type="file" multiple hidden disabled={!!busy} accept={DOC_MIME.join(",")} onChange={(e) => { if (e.target.files?.length) void uploadDocs(e.target.files); e.target.value = ""; }} />
          </label>
        </div>
      </header>
      {items === null ? <p className="muted">Loading…</p> : docs.length === 0 ? (
        <p className="empty-state panel">No documents yet. Choose a type, then upload plans, quotes or certificates.</p>
      ) : (
        DOC_KINDS.map((k) => {
          const group = docs.filter((d) => d.kind === k.id || (k.id === "document" && d.kind === "other"));
          if (!group.length) return null;
          return (
            <div key={k.id} className="doc-group">
              <h3>{k.label}</h3>
              <ul className="docs">
                {group.map((d) => <DocRow key={d.id} d={d} onOpen={() => openFile(d)} onDelete={() => remove(d)} onSave={(p) => saveMeta(d, p)} tasks={taskOptions.map((t) => ({ id: t.id, label: taskLabel(t.id) }))} />)}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}

type Save = (p: { caption?: string; kind?: Kind; taskId?: string | null }) => Promise<unknown>;

function DocRow({ d, onOpen, onDelete, onSave, tasks }: { d: Att; onOpen: () => Promise<string | undefined>; onDelete: () => void; onSave: Save; tasks: { id: string; label: string }[] }) {
  const [confirm, setConfirm] = useState(false);
  const name = d.storagePath.split("/").pop() ?? "file";
  return (
    <li className="doc">
      <span className="doc-ext">{(name.split(".").pop() ?? "").toUpperCase().slice(0, 4)}</span>
      <div className="doc-main">
        <button className="linkish doc-name" onClick={async () => { const u = await onOpen(); if (u) window.open(u, "_blank", "noopener"); }}>{name}</button>
        <input className="doc-cap" aria-label={`Note for ${name}`} placeholder="Add a note" defaultValue={d.caption} onBlur={(e) => e.target.value !== d.caption && onSave({ caption: e.target.value })} />
      </div>
      <select aria-label={`Task for ${name}`} value={d.taskId ?? ""} onChange={(e) => onSave({ taskId: e.target.value || null })}>
        <option value="">Whole project</option>
        {tasks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select>
      <span className="muted doc-size">{size(d.bytes)}, {day(d.createdAt)}</span>
      {confirm ? (
        <span className="confirm"><button className="btn btn-danger" onClick={onDelete}>Delete</button><button className="btn btn-quiet" onClick={() => setConfirm(false)}>Keep</button></span>
      ) : <button className="icon-btn" aria-label={`Delete ${name}`} onClick={() => setConfirm(true)}>×</button>}
    </li>
  );
}

function Viewer({ a, src, onClose, onDelete, onSave, tasks }: { a: Att; src: string | null; onClose: () => void; onDelete: () => void; onSave: Save; tasks: { id: string; label: string }[] }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label="Photo" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="viewer-body">
        {src ? <img src={src} alt={a.caption || "Photo"} /> : <span className="tile-ph" />}
        <div className="viewer-meta">
          <input aria-label="Caption" placeholder="Add a caption" defaultValue={a.caption} onBlur={(e) => e.target.value !== a.caption && onSave({ caption: e.target.value })} />
          <select aria-label="Task" value={a.taskId ?? ""} onChange={(e) => onSave({ taskId: e.target.value || null })}>
            <option value="">Whole project</option>
            {tasks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <span className="muted">{day(a.takenAt ?? a.createdAt)}, {size(a.bytes)}</span>
          {confirm ? (
            <span className="confirm"><button className="btn btn-danger" onClick={onDelete}>Delete photo</button><button className="btn btn-quiet" onClick={() => setConfirm(false)}>Keep</button></span>
          ) : <button className="btn btn-quiet" onClick={() => setConfirm(true)}>Delete</button>}
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
