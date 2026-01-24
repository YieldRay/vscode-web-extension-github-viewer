# GitHub Viewer

A read-only GitHub repository viewer powered by VS Code Web (like [github1s](https://github.com/conwnet/github1s)). Browse any public GitHub repository directly in your browser with the full VS Code editing experience.

## Features

- 🌐 Browse any public GitHub repository in VS Code Web
- 📂 Full file system support with directory navigation
- 🔍 Syntax highlighting and IntelliSense
- 📖 Read-only mode (no accidental modifications)
- 🌿 Support for different branches via `@branch` syntax
- ⚡ Smart caching for improved performance
- 🚫 Automatic `.vscode` directory filtering
- 🔄 Fallback to raw GitHub content for large files (>1MB)
- ⚠️ Rate limit detection with helpful error messages

## Usage

Open a repository by navigating to:

```
http://localhost:3000/#/owner/repo
```

Or specify a branch:

```
http://localhost:3000/#/owner/repo@branch
```

### Examples

- Default branch: `http://localhost:3000/#/microsoft/vscode`
- Specific branch: `http://localhost:3000/#/microsoft/vscode@release/1.20`

### Switch Repository

Use the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:

```
GitHub Viewer: Switch Repository
```

Enter the repository in format: `owner/repo` or `owner/repo@branch`

## Development

Install dependencies:

```sh
pnpm install
```

Start development server:

```sh
pnpm run dev
```

The application will be available at `http://localhost:3000`

## Build

Build the extension:

```sh
pnpm run build
```

The built extension will be output to the `extension/dist` folder.

## Technical Details

- Built with [VS Code Web Extension API](https://code.visualstudio.com/api/extension-guides/web-extensions)
- Uses [Octokit](https://github.com/octokit/rest.js) for GitHub API integration
- Implements VS Code's `FileSystemProvider` for virtual file system
- Leverages GitHub Contents API with git tree API fallback
- Raw content fetching for files exceeding GitHub's API limits

## Rate Limits

GitHub API has rate limits for unauthenticated requests (60 requests/hour). If you encounter rate limit errors, consider:

1. Waiting for the rate limit to reset (shown in error message)
2. Adding a GitHub token for higher limits (5000 requests/hour)
3. Learn more: [GitHub API Rate Limiting](https://docs.github.com/en/rest/overview/resources-in-the-rest-api#rate-limiting)

## License

MIT
