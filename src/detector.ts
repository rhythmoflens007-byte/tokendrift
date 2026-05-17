import * as vscode from "vscode";
import { TokenIndex } from "./tokenIndex";

// ─── Diagnostic payload store ─────────────────────────────────────────────────
// Keyed by "uri|line|col" so the quick-fix provider can retrieve typed data
// without exposing JSON in the hover tooltip via diagnostic.code.

type AnyPayload =
  | { kind: "drift"; data: DriftData }
  | { kind: "suggest"; data: SuggestData };

const payloadStore = new Map<string, AnyPayload>();

function storeKey(uri: vscode.Uri, range: vscode.Range): string {
  return `${uri.toString()}|${range.start.line}|${range.start.character}`;
}

function storePayload(
  uri: vscode.Uri,
  range: vscode.Range,
  payload: AnyPayload
): void {
  payloadStore.set(storeKey(uri, range), payload);
}

function clearPayloadsForUri(uri: vscode.Uri): void {
  const prefix = uri.toString() + "|";
  for (const key of payloadStore.keys()) {
    if (key.startsWith(prefix)) payloadStore.delete(key);
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 500;

/**
 * File-system paths that we never want to scan.
 * Checked against the document's fsPath using simple substring matching.
 */
const SKIP_PATH_FRAGMENTS: readonly string[] = [
  "node_modules",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "out",
  ".cache",
];

/** Languages the detector is willing to scan. */
const SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set([
  "css",
  "scss",
  "sass",
  "less",
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "vue",
  "astro",
  "html",
]);

// ─── Diagnostic codes ─────────────────────────────────────────────────────────

export const DIAGNOSTIC_CODE_HEX = "token-drift/hardcoded-hex";
export const DIAGNOSTIC_CODE_PX = "token-drift/hardcoded-px";

// ─── Public metadata attached to each Diagnostic ─────────────────────────────

export interface DriftData {
  /** The raw matched value, e.g. "#2563EB" or "16px" */
  rawValue: string;
  /** The token name that matches, e.g. "color.brand.primary" */
  tokenName: string;
  /** CSS custom-property reference, e.g. "var(--color-brand-primary)" */
  tokenRef: string;
}

// ─── Debounce helper ──────────────────────────────────────────────────────────

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Returns a debounced wrapper around `fn`.
 * Only the last call within `delay` ms is executed.
 */
function debounce<T extends unknown[]>(
  fn: (...args: T) => void,
  delay: number
): (...args: T) => void {
  let timer: TimerHandle | undefined;
  return (...args: T): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, delay);
  };
}

// ─── Skip-line heuristics ─────────────────────────────────────────────────────

/**
 * Returns true when we should skip a match because the context strongly
 * suggests it is not a real hard-coded design value.
 *
 * Rules (applied in order):
 *  1. Line is a single-line comment  (// … or # …)
 *  2. Match is inside a block comment (/* … or starts with *)
 *  3. Match is surrounded by a CSS variable reference  var(--…)
 *  4. Match is inside a url(…) function
 *  5. Match looks like it is inside a string literal (" or ')
 */
function shouldSkip(lineText: string, matchIndex: number): boolean {
  const trimmed = lineText.trimStart();

  // 1. Full-line single-line comment
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("#")) {
    return true;
  }

  // 2. Inside a block comment opening on this line
  const commentStart = lineText.indexOf("/*");
  if (commentStart !== -1 && commentStart < matchIndex) {
    return true;
  }

  // 3. CSS var(--…) reference — the match is part of a custom-property value
  //    e.g.  color: var(--color-primary, #2563eb)  ← the fallback is intentional
  //    We only skip the top-level reference, not fallback values, so we look
  //    for the pattern `var(--` that *contains* the match position.
  const beforeMatch = lineText.substring(0, matchIndex);
  const openVarIdx = beforeMatch.lastIndexOf("var(--");
  if (openVarIdx !== -1) {
    // Check there is no closing ) between var(-- and the match
    const betweenVarAndMatch = beforeMatch.substring(openVarIdx);
    if (!betweenVarAndMatch.includes(")")) {
      return true;
    }
  }

  // 4. Inside url(…)
  const openUrlIdx = beforeMatch.lastIndexOf("url(");
  if (openUrlIdx !== -1) {
    const betweenUrlAndMatch = beforeMatch.substring(openUrlIdx);
    if (!betweenUrlAndMatch.includes(")")) {
      return true;
    }
  }

  // 5. Inside a string literal — count unescaped quotes before the match;
  //    if the count is odd the match is inside a string.
  const singleQuotes = (beforeMatch.match(/(?<!\\)'/g) ?? []).length;
  const doubleQuotes = (beforeMatch.match(/(?<!\\)"/g) ?? []).length;
  if (singleQuotes % 2 === 1 || doubleQuotes % 2 === 1) {
    return true;
  }

  return false;
}

/**
 * Check whether `lineText` begins a block-comment that has not yet been
 * closed by the time we reach `matchIndex`.  Used for multi-line /* … *\/ spans.
 */
function isInsideBlockComment(
  documentText: string,
  matchAbsoluteOffset: number
): boolean {
  const textBefore = documentText.substring(0, matchAbsoluteOffset);
  const lastOpen = textBefore.lastIndexOf("/*");
  if (lastOpen === -1) return false;
  const lastClose = textBefore.lastIndexOf("*/");
  return lastClose < lastOpen;
}

// ─── Token-name → CSS custom-property ────────────────────────────────────────

/**
 * Convert a dot-separated token name to a CSS custom-property reference.
 *   "color.brand.primary" → "var(--color-brand-primary)"
 *   "spacing.2xl"         → "var(--spacing-2xl)"
 */
function tokenNameToVarRef(tokenName: string): string {
  const propName = tokenName.replace(/\./g, "-");
  return `var(--${propName})`;
}

// ─── Core scan logic ──────────────────────────────────────────────────────────

/**
 * Hex pattern: matches #RGB and #RRGGBB.
 * The word-boundary (\b) prevents partial matches inside longer hex strings.
 * We deliberately exclude #RGBA / #RRGGBBAA (8-char) — uncommon in token files.
 */
const HEX_PATTERN = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

/**
 * Px pattern: one or more digits followed by "px".
 * We only flag values >= 4px to avoid noise from thin borders (1px, 2px, 3px).
 */
const PX_PATTERN = /\b(\d+)px\b/g;

/**
 * Scan `document` for hard-coded values that match a token in `index`.
 * Returns a Diagnostic for each match together with DriftData stored in
 * diagnostic.code so quick-fix providers can read it without re-parsing.
 */
export function scanDocument(
  document: vscode.TextDocument,
  index: TokenIndex
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const fullText = document.getText();

  // ── Hex colours ─────────────────────────────────────────────────────────
  HEX_PATTERN.lastIndex = 0;
  let hexMatch: RegExpExecArray | null;

  while ((hexMatch = HEX_PATTERN.exec(fullText)) !== null) {
    const raw = hexMatch[0];
    const offset = hexMatch.index;
    const lineNum = document.positionAt(offset).line;
    const lineText = document.lineAt(lineNum).text;
    const colStart = document.positionAt(offset).character;

    if (shouldSkip(lineText, colStart)) continue;
    if (isInsideBlockComment(fullText, offset)) continue;

    const token = index.findByValue(raw);
    if (!token) continue;

    const range = new vscode.Range(
      document.positionAt(offset),
      document.positionAt(offset + raw.length)
    );

    const tokenRef = tokenNameToVarRef(token.name);
    const driftData: DriftData = {
      rawValue: raw,
      tokenName: token.name,
      tokenRef,
    };

    const diag = new vscode.Diagnostic(
      range,
      `Hard-coded color ${raw} matches token "${token.name}". Use ${tokenRef} instead.`,
      vscode.DiagnosticSeverity.Warning
    );
    diag.source = "Token Drift Detector";
    storePayload(document.uri, range, { kind: "drift", data: driftData });
    diagnostics.push(diag);
  }

  // ── Pixel values ─────────────────────────────────────────────────────────
  PX_PATTERN.lastIndex = 0;
  let pxMatch: RegExpExecArray | null;

  while ((pxMatch = PX_PATTERN.exec(fullText)) !== null) {
    const raw = pxMatch[0];
    const numericValue = parseInt(pxMatch[1], 10);
    const offset = pxMatch.index;

    // Skip thin-border magic numbers that are never tokens
    if (numericValue < 4) continue;

    const lineNum = document.positionAt(offset).line;
    const lineText = document.lineAt(lineNum).text;
    const colStart = document.positionAt(offset).character;

    if (shouldSkip(lineText, colStart)) continue;
    if (isInsideBlockComment(fullText, offset)) continue;

    const token = index.findByValue(raw);
    if (!token) continue;

    const range = new vscode.Range(
      document.positionAt(offset),
      document.positionAt(offset + raw.length)
    );

    const tokenRef = tokenNameToVarRef(token.name);
    const driftData: DriftData = {
      rawValue: raw,
      tokenName: token.name,
      tokenRef,
    };

    const diag = new vscode.Diagnostic(
      range,
      `Hard-coded dimension ${raw} matches token "${token.name}". Use ${tokenRef} instead.`,
      vscode.DiagnosticSeverity.Warning
    );
    diag.source = "Token Drift Detector";
    storePayload(document.uri, range, { kind: "drift", data: driftData });
    diagnostics.push(diag);
  }

  return diagnostics;
}

// ─── Guard helpers ────────────────────────────────────────────────────────────

/** Returns true when the document lives under a path we never scan. */
function isExcludedPath(document: vscode.TextDocument): boolean {
  const fsPath = document.uri.fsPath.replace(/\\/g, "/");
  return SKIP_PATH_FRAGMENTS.some((fragment) => fsPath.includes(`/${fragment}/`));
}

/** Returns true when the document's language is one we support. */
function isSupportedLanguage(document: vscode.TextDocument): boolean {
  return SUPPORTED_LANGUAGES.has(document.languageId);
}

// ─── Detector class ───────────────────────────────────────────────────────────

/**
 * Owns the DiagnosticCollection and wires VS Code document events to the
 * scanner.  Instantiated once in `extension.ts` and disposed on deactivation.
 */
export class Detector implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly disposables: vscode.Disposable[] = [];
  private index: TokenIndex;

  /** Debounced scan — shared across all documents. */
  private readonly scheduleScan: (doc: vscode.TextDocument) => void;

  constructor(index: TokenIndex) {
    this.index = index;
    this.collection = vscode.languages.createDiagnosticCollection("token-drift");

    this.scheduleScan = debounce((doc: vscode.TextDocument) => {
      this.runScan(doc);
    }, DEBOUNCE_MS);

    // Scan on every content change (debounced)
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        this.scheduleScan(e.document);
      })
    );

    // Scan when a file is first opened
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        this.scheduleScan(doc);
      })
    );

    // Clear diagnostics when a file is closed
    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.collection.delete(doc.uri);
      })
    );

    // Scan all already-open editors on startup
    vscode.workspace.textDocuments.forEach((doc) => this.scheduleScan(doc));
  }

  /** Call this after reloading tokens.dtcg.json to re-scan everything. */
  updateIndex(newIndex: TokenIndex): void {
    this.index = newIndex;
    vscode.workspace.textDocuments.forEach((doc) => this.runScan(doc));
  }

  /** Immediately clear and re-scan a single document (used by tests). */
  forceRescan(document: vscode.TextDocument): void {
    this.runScan(document);
  }

  private runScan(document: vscode.TextDocument): void {
    if (!isSupportedLanguage(document)) {
      return;
    }
    if (isExcludedPath(document)) {
      this.collection.delete(document.uri);
      return;
    }

    clearPayloadsForUri(document.uri);
    const diags = [
      ...scanDocument(document, this.index),
      ...scanForSuggestions(document, this.index),
    ];
    this.collection.set(document.uri, diags);
  }

  dispose(): void {
    this.collection.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

// ─── DriftData accessor ───────────────────────────────────────────────────────

/**
 * Parse DriftData back out of a diagnostic's code field.
 * Returns null if the diagnostic wasn't produced by this detector.
 */
export function getDriftData(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic
): DriftData | null {
  const payload = payloadStore.get(storeKey(document.uri, diagnostic.range));
  return payload?.kind === "drift" ? payload.data : null;
}

// ─── Suggest-new-token scan ───────────────────────────────────────────────────

export const DIAGNOSTIC_CODE_SUGGEST = "token-drift/suggest-token";

export interface SuggestData {
  rawValue: string;
  valueType: "color" | "dimension";
}

/**
 * Scan for hard-coded values that have NO matching token.
 * Emits Information-severity diagnostics so the developer can use
 * "Suggest as New Token" to add them to tokens.dtcg.json in one step.
 */
export function scanForSuggestions(
  document: vscode.TextDocument,
  index: TokenIndex
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const fullText = document.getText();

  // ── Unmatched hex colours ─────────────────────────────────────────────────
  const hexPat = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
  let m: RegExpExecArray | null;

  hexPat.lastIndex = 0;
  while ((m = hexPat.exec(fullText)) !== null) {
    const raw = m[0];
    const offset = m.index;
    const lineNum = document.positionAt(offset).line;
    const lineText = document.lineAt(lineNum).text;
    const colStart = document.positionAt(offset).character;

    if (shouldSkip(lineText, colStart)) continue;
    if (isInsideBlockComment(fullText, offset)) continue;
    if (index.findByValue(raw) !== null) continue; // already caught by scanDocument

    const range = new vscode.Range(
      document.positionAt(offset),
      document.positionAt(offset + raw.length)
    );
    const data: SuggestData = { rawValue: raw, valueType: "color" };
    const diag = new vscode.Diagnostic(
      range,
      `${raw} has no design token. Suggest one to keep the system in sync.`,
      vscode.DiagnosticSeverity.Information
    );
    diag.source = "Token Drift Detector";
    storePayload(document.uri, range, { kind: "suggest", data });
    diagnostics.push(diag);
  }

  // ── Unmatched px values ───────────────────────────────────────────────────
  const pxPat = /\b(\d+)px\b/g;
  pxPat.lastIndex = 0;

  while ((m = pxPat.exec(fullText)) !== null) {
    const raw = m[0];
    const num = parseInt(m[1], 10);
    const offset = m.index;

    if (num < 4) continue;

    const lineNum = document.positionAt(offset).line;
    const lineText = document.lineAt(lineNum).text;
    const colStart = document.positionAt(offset).character;

    if (shouldSkip(lineText, colStart)) continue;
    if (isInsideBlockComment(fullText, offset)) continue;
    if (index.findByValue(raw) !== null) continue;

    const range = new vscode.Range(
      document.positionAt(offset),
      document.positionAt(offset + raw.length)
    );
    const data: SuggestData = { rawValue: raw, valueType: "dimension" };
    const diag = new vscode.Diagnostic(
      range,
      `${raw} has no design token. Suggest one to keep the system in sync.`,
      vscode.DiagnosticSeverity.Information
    );
    diag.source = "Token Drift Detector";
    storePayload(document.uri, range, { kind: "suggest", data });
    diagnostics.push(diag);
  }

  return diagnostics;
}

export function getSuggestData(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic
): SuggestData | null {
  const payload = payloadStore.get(storeKey(document.uri, diagnostic.range));
  return payload?.kind === "suggest" ? payload.data : null;
}
