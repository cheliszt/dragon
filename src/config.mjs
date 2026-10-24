import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile, readJson } from "./utils.mjs";

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function loadConfig(root = APP_ROOT) {
  await loadEnvFile(path.join(root, ".env"));
  const settings = await readJson(path.join(root, "config", "settings.json"));
  settings.openai.model = process.env.OPENAI_MODEL || settings.openai.model;
  settings.openai.baseUrl = process.env.OPENAI_BASE_URL || settings.openai.baseUrl;
  return settings;
}

export async function loadPromptFiles(baseDir = path.join(APP_ROOT, "config")) {
  const names = ["workflow.md", "style-guide.md", "glossary.md"];
  const entries = await Promise.all(names.map(async (name) => [
    name,
    await readFile(path.join(baseDir, name), "utf8"),
  ]));
  return Object.fromEntries(entries);
}

export function requireSecret(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`缺少 ${name}。请复制 .env.example 为 .env，并填写该项。`);
  }
  return value;
}
