# AGENTS.md

## Project

Read-only GitHub repository browser running VS Code Web entirely in the browser. Uses a `github://` virtual filesystem backed by the GitHub Contents API (via Octokit).

## Commands

```bash
pnpm install              # install deps (pnpm 10.28+, declared in packageManager)
pnpm run dev              # dev server + webpack watch (via mprocs)
pnpm run build            # production build (extension/dist/)
```

There are **no tests, no linter, no formatter** configured.

## Architecture

```
index.html                 # Loads VS Code Web from CDN, parses URL hash for repo
extension/
  src/extension.ts         # Entry: registers read-only FileSystemProvider on github://
  src/github.ts            # GitHubClient: Octokit wrapper with caching + fallbacks
  webpack.config.ts        # Bundles extension as webworker target
  package.json             # VS Code extension manifest (activates on onFileSystem:github)
```

**Flow:** `index.html` → loads VS Code workbench from CDN → parses `#/owner/repo[@branch]` from URL hash → mounts `github://` workspace → extension activates → resolves default branch if not specified → GitHubClient fetches contents from GitHub API.

**URI scheme:** `github://{owner}%2F{repo}%40{branch}/path/to/file` — authority encodes `owner/repo@branch` (percent-encoded); path is purely the file path. Branch may be omitted to auto-resolve the repo's default branch.

## Key Conventions

- Filesystem is **strictly read-only** — all write operations throw `NoPermissions`
- `.vscode` directories are filtered from all listings and blocked from access
- Branch defaults to the repo's **default branch** (resolved via GitHub API) when unspecified
- Webpack's `CopyFilesPlugin` copies `package.json` + `package.nls.json` into `extension/dist/` — this is required because VS Code resolves extension metadata relative to the JS entrypoint
- Extension gallery points to **Open VSX**, not Microsoft marketplace
- `pnpm-lock.yaml` is gitignored (not committed)

## Toolchain Quirks

- **Webpack config is TypeScript** (`webpack.config.ts`), transpiled via `esbuild-register`
- **Target is `webworker`** — no Node.js APIs available at runtime; polyfills for `buffer`, `process`, `path`, `assert` are configured in webpack
- TypeScript is strict mode, ES2024 target, CommonJS modules
- VS Code Web assets are loaded entirely from CDN — no local VS Code build step

## CI

Single workflow (`.github/workflows/page.yml`): `pnpm install` → `pnpm build` → deploy `index.html` + `extension/dist/` to GitHub Pages.
