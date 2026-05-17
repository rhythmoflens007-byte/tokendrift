import * as fs from "fs";
import * as path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenEntry {
  /** Dot-separated token path, e.g. "color.brand.primary" */
  name: string;
  /** Raw value from the file, e.g. "#2563eb" or "16px" */
  value: string;
  /** DTCG $type, e.g. "color" | "dimension" */
  type: string;
}

export interface TokenIndex {
  /** All parsed entries */
  entries: ReadonlyArray<TokenEntry>;
  /**
   * Returns the first token whose normalised value matches the given input,
   * or null if no token matches.
   * Accepts: hex (#RRGGBB / #RGB, any case), rgb(...), px dimensions.
   */
  findByValue(value: string): TokenEntry | null;
}

// ─── Normalisation helpers ────────────────────────────────────────────────────

/**
 * Expand a 3-digit hex shorthand to 6 digits and lowercase everything.
 *   "#FFF"  → "#ffffff"
 *   "#2563EB" → "#2563eb"
 */
function normalizeHex(raw: string): string {
  const hex = raw.toLowerCase().replace(/^#/, "");
  if (hex.length === 3) {
    return "#" + hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  return "#" + hex;
}

/**
 * Convert rgb(r, g, b) to normalised hex.
 * Returns null when the input is not a recognised rgb() string.
 */
function rgbToNormalizedHex(raw: string): string | null {
  const match = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(
    raw.trim()
  );
  if (!match) return null;

  const r = parseInt(match[1], 10);
  const g = parseInt(match[2], 10);
  const b = parseInt(match[3], 10);

  if (r > 255 || g > 255 || b > 255) return null;

  return (
    "#" +
    r.toString(16).padStart(2, "0") +
    g.toString(16).padStart(2, "0") +
    b.toString(16).padStart(2, "0")
  );
}

/**
 * Return a canonical string for any value type so we can compare apples to
 * apples in the lookup map.
 *
 * - Hex colours  → normaliseHex()        e.g. "#2563eb"
 * - rgb() values → rgbToNormalizedHex()  e.g. "#2563eb"
 * - px values    → lowercase as-is       e.g. "16px"
 * - anything else → lowercase trim
 */
export function normalizeValue(raw: string): string {
  const trimmed = raw.trim();

  if (/^#[0-9a-fA-F]{3,6}$/.test(trimmed)) {
    return normalizeHex(trimmed);
  }

  if (/^rgb\s*\(/i.test(trimmed)) {
    return rgbToNormalizedHex(trimmed) ?? trimmed.toLowerCase();
  }

  return trimmed.toLowerCase();
}

// ─── DTCG recursive parser ────────────────────────────────────────────────────

/**
 * The DTCG format allows token nodes to be arbitrarily nested.  A leaf node
 * has a $value property; group nodes just hold more nested objects.
 * We walk the tree depth-first and collect every leaf.
 */
type DtcgNode = { [key: string]: unknown };

function parseNode(
  node: DtcgNode,
  pathParts: string[],
  results: TokenEntry[]
): void {
  // A leaf token node MUST have $value
  if ("$value" in node && typeof node["$value"] === "string") {
    const name = pathParts.join(".");
    const value = node["$value"] as string;
    const type =
      typeof node["$type"] === "string" ? (node["$type"] as string) : "unknown";

    results.push({ name, value, type });
    return; // don't recurse further — children of a leaf are metadata
  }

  // Group node: recurse into all non-$ keys
  for (const key of Object.keys(node)) {
    if (key.startsWith("$")) continue; // skip $schema, $description, etc.
    const child = node[key];
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      parseNode(child as DtcgNode, [...pathParts, key], results);
    }
  }
}

// ─── Public factory ───────────────────────────────────────────────────────────

export interface LoadResult {
  index: TokenIndex;
  errors: string[];
}

/**
 * Build a TokenIndex by reading `tokens.dtcg.json` from the given workspace
 * root directory.
 *
 * Errors (file not found, invalid JSON, etc.) are returned in the `errors`
 * array rather than thrown so that callers can surface them as VS Code
 * notifications without try/catch boilerplate.
 */
export function loadTokenIndex(workspaceRoot: string): LoadResult {
  const errors: string[] = [];
  const filePath = path.join(workspaceRoot, "tokens.dtcg.json");

  // ── 1. File existence check ──────────────────────────────────────────────
  if (!fs.existsSync(filePath)) {
    errors.push(
      `tokens.dtcg.json not found at workspace root: ${workspaceRoot}`
    );
    return { index: buildIndex([]), errors };
  }

  // ── 2. Read raw bytes ────────────────────────────────────────────────────
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Failed to read tokens.dtcg.json: ${msg}`);
    return { index: buildIndex([]), errors };
  }

  // ── 3. JSON parse ────────────────────────────────────────────────────────
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`tokens.dtcg.json contains invalid JSON: ${msg}`);
    return { index: buildIndex([]), errors };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push("tokens.dtcg.json must be a JSON object at the top level.");
    return { index: buildIndex([]), errors };
  }

  // ── 4. Recursive parse ───────────────────────────────────────────────────
  const entries: TokenEntry[] = [];
  parseNode(parsed as DtcgNode, [], entries);

  if (entries.length === 0) {
    errors.push(
      "tokens.dtcg.json was parsed but contained no token entries. " +
        "Make sure leaf nodes have a $value property."
    );
  }

  return { index: buildIndex(entries), errors };
}

// ─── Index builder ────────────────────────────────────────────────────────────

// ─── Write a new token back to tokens.dtcg.json ──────────────────────────────

/**
 * Append a new token at the given dot-separated path inside tokens.dtcg.json.
 * Intermediate group nodes are created automatically if they don't exist.
 * Returns an error string on failure, or undefined on success.
 *
 * Example: writeToken(root, "color.brand.orange", "#ff6b00", "color")
 */
export function writeToken(
  workspaceRoot: string,
  tokenPath: string,
  value: string,
  type: string
): string | undefined {
  const filePath = path.join(workspaceRoot, "tokens.dtcg.json");

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    return `Cannot read tokens.dtcg.json: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "tokens.dtcg.json must be a JSON object at the top level.";
  }

  // Walk / create intermediate nodes
  const parts = tokenPath.split(".");
  let node = parsed as Record<string, unknown>;

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (typeof node[key] !== "object" || node[key] === null) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }

  const leaf = parts[parts.length - 1];
  node[leaf] = { $value: value, $type: type };

  try {
    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
    return undefined;
  } catch (err) {
    return `Cannot write tokens.dtcg.json: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── Index builder ────────────────────────────────────────────────────────────

function buildIndex(entries: TokenEntry[]): TokenIndex {
  // Pre-compute a map from normalised value → first matching TokenEntry.
  // We keep the map private; consumers call findByValue().
  const map = new Map<string, TokenEntry>();

  for (const entry of entries) {
    const key = normalizeValue(entry.value);
    if (!map.has(key)) {
      map.set(key, entry);
    }
  }

  return {
    entries,

    findByValue(rawValue: string): TokenEntry | null {
      const key = normalizeValue(rawValue);
      return map.get(key) ?? null;
    },
  };
}
