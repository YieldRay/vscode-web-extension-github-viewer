/**
 * https://code.visualstudio.com/api/extension-guides/web-extensions
 * https://code.visualstudio.com/api/extension-guides/virtual-workspaces
 *
 * GitHub Viewer - A VS Code Web extension that provides a read-only file system
 * backed by GitHub repositories
 */

import * as vscode from "vscode";
import { GitHubClient } from "./github";

interface ParsedRepositoryUri {
  owner: string;
  repo: string;
  branch: string; // may be empty if not yet resolved
  repoPath: string;
}

/**
 * Parse repository info and file path from a github:// URI.
 * Authority format: owner/repo@branch (percent-encoded).
 *   - owner and repo are separated by the first "/"
 *   - repo and branch are separated by the first "@" after the "/"
 *   - branch may be empty (to be resolved via API)
 * Path: purely the file/directory path within the repo.
 */
function parseRepositoryFromUri(uri: vscode.Uri): ParsedRepositoryUri | null {
  const rawAuthority = decodeURIComponent(uri.authority);
  if (!rawAuthority) {
    return null;
  }

  const slashIndex = rawAuthority.indexOf("/");
  if (slashIndex === -1) {
    return null;
  }

  const owner = rawAuthority.slice(0, slashIndex);
  const rest = rawAuthority.slice(slashIndex + 1);

  let repo: string;
  let branch: string;
  const atIndex = rest.indexOf("@");
  if (atIndex !== -1) {
    repo = rest.slice(0, atIndex);
    branch = rest.slice(atIndex + 1);
  } else {
    repo = rest;
    branch = "";
  }

  if (!owner || !repo) {
    return null;
  }

  // Path is the file path within the repo (strip leading slash)
  const repoPath = uri.path.replace(/^\/+/, "");

  return { owner, repo, branch, repoPath };
}

export async function activate(context: vscode.ExtensionContext) {
  console.log("GitHub Viewer extension activating...");

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("No workspace folder found. Did VS Code Web start correctly?");
    return;
  }

  const parsed = parseRepositoryFromUri(workspaceFolder.uri);
  if (!parsed) {
    vscode.window.showErrorMessage(
      "Invalid workspace URI. Expected authority format: owner/repo@branch"
    );
    return;
  }

  const githubClient = new GitHubClient();

  // Resolve branch: if not specified in the URL, fetch the repo's default branch
  let branch = parsed.branch;
  try {
    if (!branch) {
      branch = await githubClient.getDefaultBranch(parsed.owner, parsed.repo);
    }
    githubClient.setRepository(parsed.owner, parsed.repo, branch);

    // Verify branch exists
    const branches = await githubClient.getBranches();
    if (!branches.includes(branch)) {
      vscode.window.showErrorMessage(
        `Branch "${branch}" not found in ${parsed.owner}/${parsed.repo}. Available branches: ${branches.slice(0, 5).join(", ")}${branches.length > 5 ? "..." : ""}`
      );
      return;
    }
  } catch (error: any) {
    const message = error?.message || String(error);
    if (message.includes("not found") || message.includes("404")) {
      vscode.window.showErrorMessage(
        `Repository "${parsed.owner}/${parsed.repo}" not found. Please check the URL and try again.`
      );
    } else if (message.includes("rate limit")) {
      vscode.window.showErrorMessage(message, "Learn More").then(selection => {
        if (selection === "Learn More") {
          vscode.env.openExternal(vscode.Uri.parse("https://docs.github.com/en/rest/overview/resources-in-the-rest-api#rate-limiting"));
        }
      });
    } else {
      vscode.window.showErrorMessage(
        `Failed to access repository: ${message}`
      );
    }
    return;
  }

  const gitHubFS = new GitHubFileSystem("github", githubClient);
  context.subscriptions.push(gitHubFS);

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider("github", gitHubFS, {
      isCaseSensitive: true,
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("githubViewer.switchRepository", async () => {
      const input = await vscode.window.showInputBox({
        placeHolder: "owner/repo or owner/repo@branch",
        prompt: "Enter GitHub repository (e.g., microsoft/vscode or microsoft/vscode@main)",
      });

      if (!input) {
        return;
      }

      // Parse input: owner/repo or owner/repo@branch
      // Split on first "@" after owner/repo
      const parts = input.split("/").filter(Boolean);
      if (parts.length < 2) {
        vscode.window.showErrorMessage("Invalid format. Use: owner/repo or owner/repo@branch");
        return;
      }
      const owner = parts[0];
      const rest = parts.slice(1).join("/");
      const atIndex = rest.indexOf("@");

      let repo: string, inputBranch: string;
      if (atIndex !== -1) {
        repo = rest.slice(0, atIndex);
        inputBranch = rest.slice(atIndex + 1);
      } else {
        repo = rest;
        inputBranch = "";
      }

      if (!repo) {
        vscode.window.showErrorMessage("Invalid format. Use: owner/repo or owner/repo@branch");
        return;
      }

      const url = inputBranch ? `#/${owner}/${repo}@${inputBranch}` : `#/${owner}/${repo}`;
      vscode.window.showInformationMessage(
        `Update the browser URL to ${url} and reload the page.`
      );
    })
  );

  vscode.window.showInformationMessage(
    `GitHub Viewer loaded: ${parsed.owner}/${parsed.repo}@${branch}`
  );
}

class GitHubFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  constructor(
    public readonly scheme: string,
    private githubClient: GitHubClient
  ) {}

  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = () => new vscode.Disposable(() => undefined);

  dispose(): void {
    // no-op
  }

  watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  /**
   * Check if path is .vscode directory (blocked from access)
   */
  private isVSCodeDirectory(repoPath: string): boolean {
    return repoPath === '.vscode' || repoPath.startsWith('.vscode/') || repoPath.includes('/.vscode');
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const parsed = this.ensureParsed(uri);

    // Block access to .vscode directory
    if (this.isVSCodeDirectory(parsed.repoPath)) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    const info = await this.githubClient.getPathInfo(parsed.repoPath);
    if (!info) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return {
      type: info.type === "dir" ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: 0,
      mtime: 0,
      size: info.size,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const parsed = this.ensureParsed(uri);

    try {
      const entries = await this.githubClient.listDirectory(parsed.repoPath);
      const result: [string, vscode.FileType][] = [];

      for (const entry of entries) {
        // Filter out .vscode directory
        if (entry.name === '.vscode') {
          continue;
        }
        const type = entry.type === "dir" ? vscode.FileType.Directory : vscode.FileType.File;
        result.push([entry.name, type]);
      }

      return result;
    } catch (error) {
      throw this.toFileSystemError(error, uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const parsed = this.ensureParsed(uri);

    // Block access to .vscode directory
    if (this.isVSCodeDirectory(parsed.repoPath)) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    try {
      const data = await this.githubClient.getFileContent(parsed.repoPath);
      return data instanceof Uint8Array ? data : new Uint8Array(data);
    } catch (error) {
      throw this.toFileSystemError(error, uri);
    }
  }

  async writeFile(
    uri: vscode.Uri,
    _content: Uint8Array,
    _options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    throw vscode.FileSystemError.NoPermissions(
      "GitHub Viewer file system is read-only. Writes are not allowed."
    );
  }

  async delete(_uri: vscode.Uri, _options: { recursive: boolean }): Promise<void> {
    throw vscode.FileSystemError.NoPermissions("GitHub Viewer file system is read-only");
  }

  async rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { overwrite: boolean }): Promise<void> {
    throw vscode.FileSystemError.NoPermissions("GitHub Viewer file system is read-only");
  }

  async copy(_source: vscode.Uri, _destination: vscode.Uri, _options: { overwrite: boolean }): Promise<void> {
    throw vscode.FileSystemError.NoPermissions("GitHub Viewer file system is read-only");
  }

  async createDirectory(_uri: vscode.Uri): Promise<void> {
    throw vscode.FileSystemError.NoPermissions("GitHub Viewer file system is read-only");
  }

  private ensureParsed(uri: vscode.Uri): ParsedRepositoryUri {
    const parsed = parseRepositoryFromUri(uri);
    if (!parsed) {
      throw vscode.FileSystemError.Unavailable(
        "Invalid URI. Expected authority format: owner/repo@branch"
      );
    }
    return parsed;
  }

  private toFileSystemError(error: unknown, uri: vscode.Uri): vscode.FileSystemError {
    const err = error as any;
    const message = err?.message || String(error);

    // Show user-friendly rate limit message
    if (message.includes("rate limit")) {
      vscode.window.showErrorMessage(
        message,
        "Learn More"
      ).then(selection => {
        if (selection === "Learn More") {
          vscode.env.openExternal(vscode.Uri.parse("https://docs.github.com/en/rest/overview/resources-in-the-rest-api#rate-limiting"));
        }
      });
      return vscode.FileSystemError.Unavailable(message);
    }

    if (message.includes("not found") || message.includes("404")) {
      return vscode.FileSystemError.FileNotFound(uri);
    }

    if (message.includes("read-only") || message.includes("permission")) {
      return vscode.FileSystemError.NoPermissions(message);
    }

    return vscode.FileSystemError.Unavailable(message);
  }
}
