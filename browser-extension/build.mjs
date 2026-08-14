import esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  format: "iife",
  target: ["firefox115"],
  logLevel: "info",
  sourcemap: watch ? "inline" : false,
  treeShaking: true,
};

const options = [
  { ...common, entryPoints: ["src/content.ts"], outfile: "dist/content.js" },
  { ...common, entryPoints: ["src/background.ts"], outfile: "dist/background.js" },
  { ...common, entryPoints: ["src/popup.ts"], outfile: "dist/popup.js" },
];

// Static assets copied verbatim into dist/.
const statics = ["manifest.json", "popup.html", "content.css", "styles.css"];

function copyStatics() {
  mkdirSync("dist", { recursive: true });
  for (const f of statics) {
    cpSync(f, `dist/${f}`);
  }
}

if (watch) {
  copyStatics();
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  copyStatics();
  await Promise.all(options.map((o) => esbuild.build(o)));
}
