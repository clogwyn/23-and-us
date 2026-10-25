"use client";
/**
 * Photos are resized on the device before upload: about 2,000 px on the long edge for
 * viewing, plus a 480 px thumbnail for the gallery grid. Keeps the Free plan's 1 GB
 * for a couple of thousand photos and makes the gallery fast on a phone.
 */
export interface Encoded {
  blob: Blob;
  type: string;
  width: number;
  height: number;
}

async function encode(bmp: ImageBitmap, maxEdge: number, quality: number): Promise<Encoded> {
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const width = Math.round(bmp.width * scale);
  const height = Math.round(bmp.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("This browser can't process images.");
  g.imageSmoothingQuality = "high";
  g.drawImage(bmp, 0, 0, width, height);
  const toBlob = (type: string) => new Promise<Blob | null>((res) => canvas.toBlob(res, type, quality));
  // Prefer WebP; some browsers silently fall back to PNG, so check what came back.
  let blob = await toBlob("image/webp");
  if (!blob || blob.type !== "image/webp") blob = await toBlob("image/jpeg");
  if (!blob) throw new Error("Couldn't compress the photo.");
  return { blob, type: blob.type, width, height };
}

export async function preparePhoto(file: File): Promise<{ full: Encoded; thumb: Encoded }> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(
      /heic|heif/i.test(file.type || file.name)
        ? `${file.name} is a HEIC photo, which this browser can't read. Upload it from your iPhone, or export it as JPEG first.`
        : `${file.name} isn't an image this browser can read.`,
    );
  }
  try {
    return { full: await encode(bmp, 2000, 0.82), thumb: await encode(bmp, 480, 0.75) };
  } finally {
    bmp.close();
  }
}
