import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, rm, open } from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function sha256File(filePath) {
  return sha256(await readFile(filePath));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function writeJson(filePath, value) {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeText(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try { await handle.writeFile(value, typeof value === "string" ? "utf8" : undefined); await handle.sync(); }
  finally { await handle.close(); }
  // Windows may briefly lock the destination while the web UI reads progress.
  try { for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, filePath);
      break;
    } catch (error) {
      if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      await sleep(20 * (attempt + 1));
    }
  } } finally { await rm(temporary, { force: true }); }
}

export function normalizeText(value) {
  return value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trimEnd() + "\n";
}

export function safeName(value) {
  return value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "document";
}

export function timestampId(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fileSize(filePath) {
  return (await stat(filePath)).size;
}

export async function loadEnvFile(filePath) {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
