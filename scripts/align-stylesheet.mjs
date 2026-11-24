import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", ".output");
const assetsDir = join(root, "public", "assets");
const serverDir = join(root, "server");
const css = readdirSync(assetsDir).filter((name) => /^styles-[A-Za-z0-9_-]+\.css$/.test(name));
if (css.length !== 1) {
  console.error(`[styles] expected one styles-*.css, found ${css.join(", ") || "none"}`);
  process.exit(css.length === 0 ? 1 : 0);
}
const real = css[0];
let files = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path);
      continue;
    }
    if (!/\.(mjs|js|html)$/.test(entry)) continue;
    const text = readFileSync(path, "utf8");
    const next = text.replace(/styles-[A-Za-z0-9_-]+\.css/g, real);
    if (next !== text) {
      writeFileSync(path, next);
      files += 1;
    }
  }
};
walk(serverDir);
console.log(files ? `[styles] pointed ${files} server file(s) at ${real}` : `[styles] ${real} already matches`);
