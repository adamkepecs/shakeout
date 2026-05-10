import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, "src");
const distDir = join(root, "dist");

await mkdir(distDir, { recursive: true });

const entries = await readdir(srcDir);
for (const entry of entries) {
  if (!entry.endsWith(".ts")) continue;
  const sourcePath = join(srcDir, entry);
  const targetPath = join(distDir, entry.replace(/\.ts$/, ".js"));
  const source = await readFile(sourcePath, "utf8");
  const built = source
    .replaceAll('.ts"', '.js"')
    .replaceAll(".ts'", ".js'");
  await writeFile(targetPath, built);
}

console.log(`Built ${entries.filter((entry) => entry.endsWith(".ts")).length} modules to dist/`);
