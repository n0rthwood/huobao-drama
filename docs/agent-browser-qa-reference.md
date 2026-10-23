# Agent Browser QA Reference

## Decision

Use `agent-browser` CLI with its version-matched `dogfood` skill for Huobao Drama Web QA. Do not register or start its MCP server for normal QA.

Use `browser39` only for web search, documentation, and static content extraction. It is not a product-QA browser: its documented DOM sandbox does not execute the target page's own Vue/React/Angular scripts, and it does not provide the full visual, accessibility, console, and network evidence required for this Nuxt SPA.

Primary references:

- [agent-browser skills](https://agent-browser.dev/skills)
- [agent-browser commands](https://agent-browser.dev/commands)
- [agent-browser snapshots](https://agent-browser.dev/snapshots)
- [Browser39 JSONL protocol](https://github.com/alejandroqh/browser39/blob/main/docs/jsonl-protocol.md)

## Why CLI plus skill

Measured on the local installed tools during selection:

| Context payload | Size |
| --- | ---: |
| `agent-browser` default MCP tools schema (29 tools) | 78,065 bytes |
| `browser39` MCP tools schema (29 tools) | 31,982 bytes |
| `agent-browser skills get dogfood` | 10,845 bytes |
| `agent-browser skills get core` | 38,018 bytes |

Byte size is not an exact token count because tokenization and client-side MCP injection differ. It is a stable payload comparison: the task-specific `dogfood` skill is about 86% smaller than the default agent-browser MCP schema and is loaded only when QA needs it.

On the rendered project home page, Browser39 returned only the 13-byte static title. Agent-browser returned the rendered application text and a 687-byte compact interactive snapshot, then opened the New Project dialog and returned a 1,047-byte compact snapshot. Browser39's smaller result omitted the behavior under test, so it is not a valid QA optimization.

Do not copy agent-browser's complete skills into this repository. `agent-browser skills get ...` returns instructions that match the installed CLI version; duplicating them here would create version drift.

## Host prerequisites

Install or upgrade outside the repository:

```bash
npm install -g --prefix "$HOME/.local" agent-browser
agent-browser install
agent-browser --version
agent-browser doctor --offline --quick
agent-browser skills get dogfood
```

`agent-browser doctor` may warn that `ffmpeg` is absent. That only blocks repro video recording; snapshots, interaction, screenshots, console, network, and accessibility checks still work. Install `ffmpeg` before a QA task that requires video evidence.

### Chinese screenshot fonts

The machine must have at least one Chinese font. Accessibility text can be correct while screenshots show square glyphs, which invalidates visual QA.

Check:

```bash
fc-list :lang=zh family | sort -u
```

If the command is empty, install Noto CJK through the host package manager or into `~/.local/share/fonts`, then refresh and recheck:

```bash
fc-cache -f
fc-list :lang=zh family | sort -u
```

Fonts and browser binaries are machine configuration, not repository files. Re-run these checks after workstation or agent-browser upgrades.

## Start a QA session

Read the task-specific skill first:

```bash
agent-browser skills get dogfood
```

Use an isolated session derived from the current worktree. Never use the shared default session:

```bash
export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix huobao-qa)"
```

Resolve the workstation's user-accessible LAN host from the runtime or external local configuration. Never commit an internal address. User-facing links must use that host rather than `localhost`.

```bash
export HUOBAO_DEV_HOST='<current-workstation-lan-host>'
export HUOBAO_WEB_URL="http://${HUOBAO_DEV_HOST}:3013"
```

Verify the application chain before browser work:

```bash
curl -fsS "${HUOBAO_WEB_URL}/api/v1/health"
curl -fsS http://localhost:5679/api/v1/health
```

Do not start or restart Huobao development services from an ephemeral agent process. Follow the PM2 rules in `AGENTS.md`.

## Token-efficient interaction loop

Open and orient:

```bash
agent-browser open "$HUOBAO_WEB_URL"
agent-browser wait --load domcontentloaded
agent-browser wait --text '项目启动台'
agent-browser snapshot -i -c
```

Rules:

1. Default to text output. JSON adds structure and tokens; use `--json` only for scripts that parse it.
2. Use `snapshot -i -c` to discover actionable controls.
3. Use `read` for page copy or unstructured content when refs are not needed.
4. Use `snapshot --delta` for repeated observations and `--full` only to reset its baseline.
5. Scope large pages with `-s '<selector>'` or `-d <depth>`.
6. Interact with snapshot refs (`@eN`). Prefer semantic `find role/label/text` when a ref is unavailable; raw CSS is the fallback.
7. After navigation or a meaningful DOM change, wait for the expected state and take a fresh snapshot before using refs.
8. Wait for an element, text, URL, or explicit JavaScript condition. Do not replace a state check with an arbitrary sleep.
9. Use `batch --bail` only for a known sequence whose intermediate outputs do not require agent decisions.

Example interaction:

```bash
agent-browser snapshot -i -c
agent-browser click @e7
agent-browser wait --text '创建项目'
agent-browser snapshot -i -c
```

Ref numbers are observations, not stable test fixtures. Never hard-code an example ref without first taking the current snapshot.

## Required smoke evidence

A Web change is not verified by build output alone. Exercise the changed path in the rendered application and observe all relevant evidence.

### Functional state

```bash
agent-browser snapshot -i -c
agent-browser get url
agent-browser get title
```

Perform the realistic interaction specified by the Issue. Verify the resulting text, URL, enabled/visible state, or persisted data rather than merely checking that a click command returned success.

### Runtime errors

```bash
agent-browser errors
agent-browser console
agent-browser network requests --filter '/api/'
```

Expected Vite connection messages and known framework informational messages are not application failures. New uncaught errors, failed API requests, or unexpected non-2xx responses require investigation.

### Visual state

Use screenshots only when visual correctness or defect evidence matters:

```bash
mkdir -p /tmp/huobao-qa
agent-browser screenshot --annotate /tmp/huobao-qa/current.png
agent-browser screenshot --if-changed /tmp/huobao-qa/changed.png
```

The agent must open the resulting image with the reading tool before making a visual claim. Check layout, clipping, overlays, loading states, image content, language glyphs, and the exact result of the interaction. Do not infer a screenshot's contents from its file path.

For repeated screenshots, prefer `--if-changed`. For a static visible-on-load issue, one annotated screenshot is sufficient. For an interactive defect, preserve before/action/after screenshots and reproducible steps; use video only when timing or motion is essential.

### Accessibility and optional diagnostics

```bash
agent-browser a11y --tags wcag2a,wcag2aa
agent-browser vitals
```

Run these when the Issue affects accessibility or performance, or during a broad QA pass. Do not add unrelated fixes to the current Issue solely because an optional audit found them; report them separately.

## Authentication and sensitive data

- Never put passwords, cookies, tokens, or internal endpoints in the repository, Issue, command line, screenshots, or QA report.
- Use agent-browser auth storage or an approved external credential provider for authenticated QA.
- Use `--allowed-domains` for sessions that handle sensitive data when its restrictions are compatible with the test.
- Keep screenshots and recordings outside the repository unless the Issue explicitly requires committed fixtures.

## Finish

```bash
agent-browser close
```

Before reporting completion:

- The changed path was exercised in the real UI.
- The resulting UI state was observed.
- Relevant screenshot content was actually read.
- `errors`, `console`, and critical API requests were inspected.
- The named browser session was closed.
- Temporary QA files contain no credentials and are not accidentally staged.
