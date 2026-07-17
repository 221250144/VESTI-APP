import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const rootDir = process.cwd();
const frontendDir = path.resolve(rootDir, "../../frontend");
const distDir = path.resolve(rootDir, "dist");
const esbuildBin = path.resolve(
  frontendDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "esbuild.cmd" : "esbuild"
);
const tscBin = path.resolve(
  frontendDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc"
);

rmSync(distDir, { recursive: true, force: true });

for (const [label, bin] of [
  ["esbuild", esbuildBin],
  ["tsc", tscBin],
]) {
  if (!existsSync(bin)) {
    console.error(`[@vesti/content-package] ${label} binary not found: ${bin}`);
    process.exit(1);
  }
}

const entry = path.resolve(rootDir, "src/index.ts");
const tsconfigPath = path.resolve(rootDir, "tsconfig.build.json");

const esbuildCommonArgs = [
  entry,
  "--bundle",
  "--platform=neutral",
  "--target=es2020",
  `--tsconfig=${tsconfigPath}`,
];

const esmRun = spawnSync(
  esbuildBin,
  [...esbuildCommonArgs, "--format=esm", `--outfile=${path.resolve(distDir, "index.js")}`],
  {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  }
);

if (esmRun.error || (esmRun.status ?? 1) !== 0) {
  if (esmRun.error) {
    console.error(esmRun.error.message);
  }
  process.exit(esmRun.status ?? 1);
}

const cjsRun = spawnSync(
  esbuildBin,
  [...esbuildCommonArgs, "--format=cjs", `--outfile=${path.resolve(distDir, "index.cjs")}`],
  {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  }
);

if (cjsRun.error || (cjsRun.status ?? 1) !== 0) {
  if (cjsRun.error) {
    console.error(cjsRun.error.message);
  }
  process.exit(cjsRun.status ?? 1);
}

const dtsRun = spawnSync(
  tscBin,
  ["--project", tsconfigPath],
  {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  }
);

if (dtsRun.error) {
  console.error(dtsRun.error.message);
  process.exit(1);
}

process.exit(dtsRun.status ?? 1);
