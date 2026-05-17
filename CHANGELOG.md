# Changelog

## [0.1.0] — 2026-05-17

### Added

- Real-time detection of hard-coded hex colours and pixel dimensions that match design tokens
- DTCG (`tokens.dtcg.json`) parser with unlimited nesting depth and O(1) value lookup
- Warning diagnostics for values that match an existing token
- Information diagnostics for unrecognised values with no token match
- **Use Token** code action — replaces the hard-coded value with `var(--token-name)`
- **Mark as Intentional** code action — records the exception to `token-exceptions.json` with an optional reason
- **Suggest as New Token** code action — appends the value as a new token to `tokens.dtcg.json` and reloads the index
- Status bar item showing the number of loaded tokens; click to reload
- File watcher on `tokens.dtcg.json` — index reloads automatically when the file changes
- Skip rules: single-line comments, block comments, `var(--)`, `url()`, string literals, `// token-skip-line`
- GitHub Actions CI workflow with PR comment table and `ALLOW_NEW_COLORS` escape hatch
- GitHub Pages deployment of the team health dashboard
- Zero-dependency HTML dashboard with animated metrics, SVG trend chart, exception log, and pending approvals
