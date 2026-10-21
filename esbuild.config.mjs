import esbuild from "esbuild";
import { builtinModules } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";

const production = process.argv[2] === "production";
const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  // Java 插件仅使用 util；避免把带文件系统配置发现的 Prettier CLI 打入 Obsidian。
  plugins: [{ name: "prettier-standalone", setup(build) {
    build.onResolve({ filter: /^prettier$/ }, () => ({ path: fileURLToPath(import.meta.resolve("prettier/standalone")) }));
  } }],
  external: ["obsidian", "electron", "node:*", "@codemirror/*", "@lezer/*", ...builtinModules],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js"
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
