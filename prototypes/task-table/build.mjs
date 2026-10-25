// Bundles src/main.ts (with the real engine) and inlines it into one self-contained HTML page.
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const out = await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "iife",
  target: "es2020",
  minify: true,
  write: false,
  legalComments: "none",
});
const js = out.outputFiles[0].text.replaceAll("</script", "<\\/script");
const css = (await readFile("src/styles.css", "utf8")) + "\n" + (await readFile("src/views.css", "utf8"));
const shell = await readFile("src/shell.html", "utf8");

const house = `data:image/jpeg;base64,${(await readFile("src/assets/house-front.jpg")).toString("base64")}`;
const html = shell
  .replace("/*__CSS__*/", () => css)
  .replace("/*__JS__*/", () => js)
  .replace("__HOUSE__", () => house);
await mkdir("dist", { recursive: true });
await writeFile("dist/index.html", html);
console.log(`dist/index.html  ${(html.length / 1024).toFixed(1)} KB`);
