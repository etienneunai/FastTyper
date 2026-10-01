import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prod = (process.argv[2] === "production");

// Ensure wordlist-compressed.ts exists
const wordlistSrc = path.join(__dirname, "src/wordlist.json");
const wordlistCompressed = path.join(__dirname, "src/wordlist-compressed.ts");
if (!fs.existsSync(wordlistCompressed) && fs.existsSync(wordlistSrc)) {
  const raw = fs.readFileSync(wordlistSrc);
  const gzipped = zlib.gzipSync(raw);
  fs.writeFileSync(
    wordlistCompressed,
    `export const GZIPPED_WORDLIST_B64 = "${gzipped.toString("base64")}";\n`,
    "utf8"
  );
}

const context = await esbuild.context({
  entryPoints: [path.join(__dirname, "src/main.ts")],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins
  ],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: path.join(__dirname, "main.js"),
});

if (fs.existsSync(wordlistSrc)) {
  fs.copyFileSync(wordlistSrc, path.join(__dirname, "wordlist.json"));
}

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
