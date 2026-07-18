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

rmSync(distDir, { recursive: true, force: true });

if (!existsSync(esbuildBin)) {
  console.error(`[vesti-ui] esbuild binary not found: ${esbuildBin}`);
  process.exit(1);
}

const args = [
  path.resolve(rootDir, "src/index.ts"),
  "--bundle",
  "--format=esm",
  "--platform=browser",
  "--target=es2020",
  "--jsx=automatic",
  `--tsconfig=${path.resolve(rootDir, "tsconfig.build.json")}`,
  `--outfile=${path.resolve(rootDir, "dist/index.js")}`,
  "--external:react",
  "--external:react-dom",
  "--external:react/jsx-runtime",
  "--external:react/jsx-dev-runtime",
  "--external:lucide-react",
  "--external:marked",
  "--external:dompurify"
];

const run = spawnSync(esbuildBin, args, {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32"
});

if (run.error) {
  console.error(run.error.message);
  process.exit(1);
}

process.exit(run.status ?? 1);
