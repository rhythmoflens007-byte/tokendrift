import * as vscode from "vscode";
import { getDriftData, DriftData, getSuggestData, SuggestData } from "./detector";
import { writeToken } from "./tokenIndex";
import { logException } from "./logger";

// ─── Code action provider ─────────────────────────────────────────────────────

export class TokenDriftCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds: vscode.CodeActionKind[] = [
    vscode.CodeActionKind.QuickFix,
  ];

  constructor(private readonly workspaceRoot: string) {}

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of context.diagnostics) {
      const drift = getDriftData(document, diagnostic);
      if (drift) {
        actions.push(this.buildUseTokenAction(document, diagnostic, drift));
        actions.push(this.buildMarkIntentionalAction(document, diagnostic, drift));
        continue;
      }

      const suggest = getSuggestData(document, diagnostic);
      if (suggest) {
        actions.push(this.buildSuggestNewTokenAction(document, diagnostic, suggest));
      }
    }

    return actions;
  }

  // ── Action 1: replace with var(--token-name) ────────────────────────────────

  private buildUseTokenAction(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic,
    data: DriftData
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      `Use token: ${data.tokenRef}`,
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.isPreferred = true;

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, diagnostic.range, data.tokenRef);
    action.edit = edit;

    return action;
  }

  // ── Action 3: suggest as new token ─────────────────────────────────────────

  private buildSuggestNewTokenAction(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic,
    data: SuggestData
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      `Suggest as new token: ${data.rawValue}`,
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.command = {
      command: "tokenDrift.suggestNewToken",
      title: "Suggest as New Token",
      arguments: [document, diagnostic, data, this.workspaceRoot],
    };
    return action;
  }

  // ── Action 2: mark as intentional ──────────────────────────────────────────

  private buildMarkIntentionalAction(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic,
    data: DriftData
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      `Mark as intentional: ${data.rawValue}`,
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];

    // The heavy lifting is delegated to a registered command so VS Code can
    // await async work (the input-box prompt + file write) after the light-
    // weight provideCodeActions call returns.
    action.command = {
      command: "tokenDrift.markIntentional",
      title: "Mark as Intentional",
      arguments: [document, diagnostic, data, this.workspaceRoot],
    };

    return action;
  }
}

// ─── Suggest-new-token command handler ───────────────────────────────────────

/**
 * Prompts the user for a token name, then writes the new token to
 * tokens.dtcg.json. The file watcher in extension.ts auto-reloads the index
 * so the blue underline disappears immediately after the file is saved.
 */
export async function handleSuggestNewToken(
  _document: vscode.TextDocument,
  _diagnostic: vscode.Diagnostic,
  data: SuggestData,
  workspaceRoot: string
): Promise<void> {
  const placeholder =
    data.valueType === "color"
      ? "e.g. color.brand.orange"
      : "e.g. spacing.2xs";

  const tokenName = await vscode.window.showInputBox({
    title: "Suggest as New Token",
    prompt: `Token name for ${data.rawValue}`,
    placeHolder: placeholder,
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (!v.trim()) return "Token name cannot be empty.";
      if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(v.trim())) {
        return "Use dot-separated lowercase names, e.g. color.brand.orange";
      }
      return null;
    },
  });

  if (!tokenName) return; // user cancelled

  const err = writeToken(
    workspaceRoot,
    tokenName.trim(),
    data.rawValue.toLowerCase(),
    data.valueType
  );

  if (err) {
    vscode.window.showErrorMessage(`Token Drift: ${err}`);
    return;
  }

  vscode.window.showInformationMessage(
    `Token Drift: "${tokenName}" added to tokens.dtcg.json — index reloading.`
  );
}

// ─── Command handler ──────────────────────────────────────────────────────────

/**
 * Invoked when the user picks "Mark as intentional" from the quick-fix menu.
 *
 * Shows an optional-reason input box, then writes to token-exceptions.json.
 * Registered as command `tokenDrift.markIntentional` in extension.ts.
 */
export async function handleMarkIntentional(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
  data: DriftData,
  workspaceRoot: string
): Promise<void> {
  const reason = await vscode.window.showInputBox({
    title: "Mark as intentional deviation",
    prompt: `Why is ${data.rawValue} hard-coded here? (optional — press Enter to skip)`,
    placeHolder: "E.g., animation perf fix, edge case, pending token approval…",
    ignoreFocusOut: true,
  });

  // undefined means the user pressed Escape — do nothing
  if (reason === undefined) return;

  const zeroBasedLine = diagnostic.range.start.line;

  const result = logException(
    workspaceRoot,
    document.uri.fsPath,
    zeroBasedLine,
    data.rawValue,
    data.tokenName,
    reason.trim()
  );

  if (result.error) {
    vscode.window.showErrorMessage(`Token Drift: ${result.error}`);
    return;
  }

  vscode.window.showInformationMessage(
    `Token Drift: exception logged for "${data.rawValue}" at line ${zeroBasedLine + 1}.`
  );
}
