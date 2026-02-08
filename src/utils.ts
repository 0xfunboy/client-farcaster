import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { elizaLogger } from "@elizaos/core";

export function nowTs(): number {
  return Date.now();
}

export function jitterMs(minMs: number, maxMs: number): number {
  if (maxMs <= minMs) return minMs;
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

export function ensureDirForFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      ensureDirForFile(filePath);
      fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2), "utf8");
      return fallback;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    elizaLogger.warn(`[Farcaster] failed to read JSON ${filePath}, using fallback`, error);
    return fallback;
  }
}

export function writeJsonFile<T>(filePath: string, value: T): void {
  ensureDirForFile(filePath);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

export function splitCastText(text: string, maxLen: number): string[] {
  const normalized = text.trim();
  if (normalized.length <= maxLen) return [normalized];

  const parts: string[] = [];
  const paragraphs = normalized.split(/\n\s*\n/g).map((p) => p.trim()).filter(Boolean);
  let current = "";

  const pushCurrent = () => {
    const value = current.trim();
    if (value) parts.push(value);
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (!current) {
      if (paragraph.length <= maxLen) {
        current = paragraph;
        continue;
      }

      let rest = paragraph;
      while (rest.length > maxLen) {
        let idx = rest.lastIndexOf(" ", maxLen);
        if (idx < 0) idx = maxLen;
        parts.push(rest.slice(0, idx).trim());
        rest = rest.slice(idx).trim();
      }
      current = rest;
      continue;
    }

    const candidate = `${current}\n\n${paragraph}`;
    if (candidate.length <= maxLen) {
      current = candidate;
      continue;
    }

    pushCurrent();
    if (paragraph.length <= maxLen) {
      current = paragraph;
      continue;
    }

    let rest = paragraph;
    while (rest.length > maxLen) {
      let idx = rest.lastIndexOf(" ", maxLen);
      if (idx < 0) idx = maxLen;
      parts.push(rest.slice(0, idx).trim());
      rest = rest.slice(idx).trim();
    }
    current = rest;
  }

  pushCurrent();
  return parts.length ? parts : [normalized.slice(0, maxLen)];
}

export function sanitizeForLog(value: string): string {
  if (!value) return "";
  if (value.length <= 6) return "***";
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

export function extractFirstTicker(text: string): string | null {
  const m = text.match(/\$([A-Za-z][A-Za-z0-9]{1,9})/);
  return m ? m[1].toUpperCase() : null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getPackageRootFromModuleDir(moduleDir: string): string {
  // Works for both src/* and dist/* execution
  return path.resolve(moduleDir, "..");
}

export function resolvePackagePath(...parts: string[]): string {
  const packageRoot = getPackageRootFromModuleDir(__dirname);
  return path.join(packageRoot, ...parts);
}

export function resolveWorkspacePath(...parts: string[]): string {
  const packageRoot = getPackageRootFromModuleDir(__dirname);
  const workspaceRoot = path.resolve(packageRoot, "..", "..");
  return path.join(workspaceRoot, ...parts);
}
