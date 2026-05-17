import * as vscode from "vscode";
import { loadTokenIndex } from "./tokenIndex";
import { Detector } from "./detector";
import {
  TokenDriftCodeActionProvider,
  handleMarkIntentional,
  handleSuggestNewToken,
} from "./quickFix";

// ─── Document selector ────────────────────────────────────────────────────────

const DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { language: "css" },
  { language: "scss" },
  { language: "sass" },
  { language: "less" },
  { language: "typescript" },
  { language: "typescriptreact" },
  { language: "javascript" },
  { language: "javascriptreact" },
  { language: "vue" },
  { language: "astro" },
  { language: "html" },
];

// ─── Activate ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    // Extension is active but there is no open folder — nothing we can do.
    return;
  }

  const workspaceRoot = folders[0].uri.fsPath;

  // ── 1. Load initial token index ────────────────────────────────────────────
  const { index: initialIndex, errors: loadErrors } =
    loadTokenIndex(workspaceRoot);

  for (const err of loadErrors) {
    vscode.window.showErrorMessage(`Token Drift Detector: ${err}`);
  }

  // ── 2. Diagnostic engine ───────────────────────────────────────────────────
  const detector = new Detector(initialIndex);
  context.subscriptions.push(detector);

  // ── 3. Quick-fix provider ──────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      DOCUMENT_SELECTOR,
      new TokenDriftCodeActionProvider(workspaceRoot),
      {
        providedCodeActionKinds:
          TokenDriftCodeActionProvider.providedCodeActionKinds,
      }
    )
  );

  // ── 4. Commands ────────────────────────────────────────────────────────────

  // "Mark as Intentional" — called by quick-fix command with 4 arguments
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "tokenDrift.markIntentional",
      (
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic,
        data: { rawValue: string; tokenName: string; tokenRef: string },
        root: string
      ) => handleMarkIntentional(document, diagnostic, data, root)
    )
  );

  // "Suggest as New Token" — called by quick-fix command
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "tokenDrift.suggestNewToken",
      (
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic,
        data: { rawValue: string; valueType: "color" | "dimension" },
        root: string
      ) => handleSuggestNewToken(document, diagnostic, data, root)
    )
  );

  // "Reload tokens.dtcg.json" — palette command + status-bar click
  context.subscriptions.push(
    vscode.commands.registerCommand("tokenDrift.reloadTokens", () => {
      const { index: freshIndex, errors: reloadErrors } =
        loadTokenIndex(workspaceRoot);

      for (const err of reloadErrors) {
        vscode.window.showErrorMessage(`Token Drift Detector: ${err}`);
      }

      detector.updateIndex(freshIndex);
      statusBar.text = `$(symbol-color) ${freshIndex.entries.length} tokens`;

      if (reloadErrors.length === 0) {
        vscode.window.showInformationMessage(
          `Token Drift: reloaded ${freshIndex.entries.length} tokens.`
        );
      }
    })
  );

  // ── 5. File watcher: auto-reload when tokens.dtcg.json changes ────────────
  const tokensWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, "tokens.dtcg.json")
  );

  tokensWatcher.onDidChange(() => {
    const { index, errors } = loadTokenIndex(workspaceRoot);
    errors.forEach((e) =>
      vscode.window.showErrorMessage(`Token Drift Detector: ${e}`)
    );
    detector.updateIndex(index);
    statusBar.text = `$(symbol-color) ${index.entries.length} tokens`;
  });

  tokensWatcher.onDidCreate(() => {
    const { index, errors } = loadTokenIndex(workspaceRoot);
    errors.forEach((e) =>
      vscode.window.showErrorMessage(`Token Drift Detector: ${e}`)
    );
    detector.updateIndex(index);
    statusBar.text = `$(symbol-color) ${index.entries.length} tokens`;
    vscode.window.showInformationMessage(
      "Token Drift: tokens.dtcg.json detected — drift detection active."
    );
  });

  tokensWatcher.onDidDelete(() => {
    vscode.window.showWarningMessage(
      "Token Drift: tokens.dtcg.json was deleted. " +
        "Drift detection is paused until the file is restored."
    );
  });

  context.subscriptions.push(tokensWatcher);

  // ── 6. Status bar ──────────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.text = `$(symbol-color) ${initialIndex.entries.length} tokens`;
  statusBar.tooltip = "Token Drift Detector — click to reload tokens";
  statusBar.command = "tokenDrift.reloadTokens";
  statusBar.show();
  context.subscriptions.push(statusBar);
}

// ─── Deactivate ───────────────────────────────────────────────────────────────

export function deactivate(): void {
  // VS Code automatically disposes everything in context.subscriptions.
}
