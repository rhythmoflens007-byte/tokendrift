import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExceptionEntry {
  /** The raw hard-coded value, e.g. "#2563eb" or "16px" */
  value: string;
  /** Matching token name, e.g. "color.brand.primary" */
  token_match: string;
  /** Optional developer reason */
  reason: string;
  /** ISO-8601 timestamp when the exception was logged */
  logged_date: string;
  /** Workspace-relative file path */
  file: string;
  /** 1-indexed line number */
  line: number;
}

/** The full shape of token-exceptions.json */
export type ExceptionsFile = Record<string, ExceptionEntry>;

export interface LogResult {
  /** The key used to store the exception, e.g. "src/Button.tsx::42" */
  key: string;
  error?: string;
}

// ─── Key helpers ──────────────────────────────────────────────────────────────

/**
 * Build the unique key for an exception.
 * Format: `<workspace-relative-path>::<1-indexed-line>`
 */
function makeKey(filePath: string, zeroBasedLine: number): string {
  const rel = vscode.workspace.asRelativePath(filePath, false);
  return `${rel}::${zeroBasedLine + 1}`;
}

// ─── I/O helpers ──────────────────────────────────────────────────────────────

function exceptionsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, "token-exceptions.json");
}

function readExceptions(workspaceRoot: string): ExceptionsFile {
  const fp = exceptionsPath(workspaceRoot);
  if (!fs.existsSync(fp)) return {};

  try {
    const raw = fs.readFileSync(fp, "utf-8").trim();
    if (!raw || raw === "") return {};
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as ExceptionsFile;
    }
    return {};
  } catch {
    // Corrupted file — start fresh rather than crash
    return {};
  }
}

function writeExceptions(
  workspaceRoot: string,
  data: ExceptionsFile
): string | undefined {
  const fp = exceptionsPath(workspaceRoot);
  try {
    fs.writeFileSync(fp, JSON.stringify(data, null, 2) + "\n", "utf-8");
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Write (or update) an intentional exception to `token-exceptions.json`.
 *
 * If an entry already exists for `filePath::line`, its `logged_date` is
 * refreshed and the reason is updated — no duplicate entries are created.
 */
export function logException(
  workspaceRoot: string,
  filePath: string,
  zeroBasedLine: number,
  value: string,
  tokenMatch: string,
  reason: string
): LogResult {
  const existing = readExceptions(workspaceRoot);
  const key = makeKey(filePath, zeroBasedLine);

  existing[key] = {
    value,
    token_match: tokenMatch,
    reason,
    logged_date: new Date().toISOString(),
    file: vscode.workspace.asRelativePath(filePath, false),
    line: zeroBasedLine + 1,
  };

  const err = writeExceptions(workspaceRoot, existing);
  if (err) {
    return { key, error: `Failed to write token-exceptions.json: ${err}` };
  }
  return { key };
}

/**
 * Returns true when the given file + line already has an intentional exception
 * logged, meaning the CI gate and diagnostic should treat it as allowed.
 */
export function isExcepted(
  workspaceRoot: string,
  filePath: string,
  zeroBasedLine: number
): boolean {
  const existing = readExceptions(workspaceRoot);
  const key = makeKey(filePath, zeroBasedLine);
  return Object.prototype.hasOwnProperty.call(existing, key);
}

/**
 * Return all current exceptions, keyed by their path::line string.
 * Used by the dashboard generator and any future status-bar summary.
 */
export function getAllExceptions(workspaceRoot: string): ExceptionsFile {
  return readExceptions(workspaceRoot);
}
