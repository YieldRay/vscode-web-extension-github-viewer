import { Octokit } from "@octokit/rest";

interface GitHubRepoInfo {
  owner: string;
  repo: string;
  branch: string;
}

/**
 * GitHub API client for interacting with repositories
 */
export class GitHubClient {
  private octokit: Octokit;
  private currentRepo: GitHubRepoInfo | null = null;
  private fileCache = new Map<string, Uint8Array>();

  constructor(token?: string) {
    this.octokit = new Octokit({
      auth: token,
      request: {
        fetch: fetch,
      },
    });
  }

  /**
   * Check if error is a rate limit error and throw user-friendly message
   */
  private handleRateLimitError(error: any): void {
    if (error?.status === 403 && error?.message?.toLowerCase().includes('rate limit')) {
      const resetTime = error?.response?.headers?.['x-ratelimit-reset'];
      const resetDate = resetTime ? new Date(parseInt(resetTime) * 1000).toLocaleTimeString() : 'unknown';
      throw new Error(`GitHub API rate limit exceeded. Resets at ${resetDate}. Please provide a GitHub token to increase your rate limit.`);
    }

    if (error?.status === 429) {
      throw new Error('GitHub API rate limit exceeded. Please wait a moment or provide a GitHub token.');
    }
  }

  /**
   * Set the current repository to fetch files from
   */
  setRepository(owner: string, repo: string, branch: string = "main"): void {
    // Only reset cache when repository actually changes
    if (
      this.currentRepo?.owner !== owner ||
      this.currentRepo?.repo !== repo ||
      this.currentRepo?.branch !== branch
    ) {
      this.fileCache.clear();
      this.currentRepo = { owner, repo, branch };
    }
  }

  /**
   * Get the current repository info
   */
  getCurrentRepo(): GitHubRepoInfo | null {
    return this.currentRepo;
  }

  /**
   * Determine the type (file or directory) and size of a path via a single API call.
   * Returns null if the path does not exist.
   */
  async getPathInfo(filePath: string): Promise<{ type: "file" | "dir"; size: number } | null> {
    if (!this.currentRepo) {
      throw new Error("Repository not set");
    }

    try {
      const response = await this.octokit.repos.getContent({
        owner: this.currentRepo.owner,
        repo: this.currentRepo.repo,
        path: filePath === "/" || filePath === "" ? "" : filePath,
        ref: this.currentRepo.branch,
      });

      if (Array.isArray(response.data)) {
        return { type: "dir", size: 0 };
      }

      const data = response.data as any;
      return { type: data.type === "dir" ? "dir" : "file", size: data.size || 0 };
    } catch (error: any) {
      if (error?.status === 404) {
        return null;
      }
      this.handleRateLimitError(error);
      // 403 on a directory could mean it's too large; still exists
      if (error?.status === 403) {
        return { type: "dir", size: 0 };
      }
      throw error;
    }
  }

  /**
   * Fetch file content from GitHub
   */
  async getFileContent(filePath: string): Promise<Uint8Array> {
    if (!this.currentRepo) {
      throw new Error("Repository not set");
    }

    const cacheKey = `${this.currentRepo.owner}/${this.currentRepo.repo}/${this.currentRepo.branch}:${filePath}`;
    if (this.fileCache.has(cacheKey)) {
      return this.fileCache.get(cacheKey)!;
    }

    try {
      const response = await this.octokit.repos.getContent({
        owner: this.currentRepo.owner,
        repo: this.currentRepo.repo,
        path: filePath,
        ref: this.currentRepo.branch,
      });

      // Handle case where response is an array (directory listing)
      if (Array.isArray(response.data)) {
        throw new Error("Path is a directory, not a file");
      }

      // Decode base64 content
      const content = response.data as any;
      if (content.encoding === "base64" && content.content) {
        const binaryString = atob(content.content.replace(/\n/g, ""));
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        this.fileCache.set(cacheKey, bytes);
        return bytes;
      }

      throw new Error("Unexpected response format from GitHub API");
    } catch (error: any) {
      if (error?.status === 404) {
        throw new Error(`File not found: ${filePath}`);
      }

      // Check for rate limit errors
      this.handleRateLimitError(error);

      // GitHub's contents API returns 403 for files over 1 MB; fall back to raw URL fetch.
      // For public repos this is almost always a size limit; access-denied repos return 404.
      if (error?.status === 403) {
        try {
          const bytes = await this.fetchRawContent(filePath);
          this.fileCache.set(cacheKey, bytes);
          return bytes;
        } catch {
          throw new Error(`Access denied or file too large to fetch: ${filePath}`);
        }
      }

      throw error;
    }
  }

  private async fetchRawContent(filePath: string): Promise<Uint8Array> {
    if (!this.currentRepo) {
      throw new Error("Repository not set");
    }

    const { owner, repo, branch } = this.currentRepo;
    const encodedBranch = encodeURIComponent(branch);
    const encodedPath = filePath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");

    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodedBranch}/${encodedPath}`;
    const response = await fetch(rawUrl);

    if (!response.ok) {
      throw new Error(`Failed to fetch raw content: ${response.status} ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  /**
   * List directory contents from GitHub
   */
  async listDirectory(dirPath: string = ""): Promise<Array<{ name: string; type: "file" | "dir" }>> {
    if (!this.currentRepo) {
      throw new Error("Repository not set");
    }

    try {
      // For root directory, pass empty path
      const path = dirPath === "/" || dirPath === "" ? "" : dirPath;

      const response = await this.octokit.repos.getContent({
        owner: this.currentRepo.owner,
        repo: this.currentRepo.repo,
        path: path,
        ref: this.currentRepo.branch,
      });

      // Handle case where response is a single file
      if (!Array.isArray(response.data)) {
        throw new Error("Path is a file, not a directory");
      }

      return response.data.map((item: any) => ({
        name: item.name,
        type: item.type === "dir" ? "dir" : "file",
      }));
    } catch (error: any) {
      if (error?.status === 404) {
        throw new Error(`Directory not found: ${dirPath}`);
      }

      // Check for rate limit errors
      this.handleRateLimitError(error);

      // Contents API can return 403 (size limits or abuse detection). Try git tree as a fallback.
      if (error?.status === 403) {
        return this.listDirectoryViaGitTree(dirPath);
      }

      throw error;
    }
  }

  async listDirectoryViaGitTree(dirPath: string): Promise<Array<{ name: string; type: "file" | "dir" }>> {
    if (!this.currentRepo) {
      throw new Error("Repository not set");
    }

    const { owner, repo, branch } = this.currentRepo;
    try {
      const response = await this.octokit.git.getTree({
        owner,
        repo,
        tree_sha: branch,
        recursive: "1",
      });

      const prefix = dirPath === "/" || dirPath === "" ? "" : dirPath.replace(/\/+$/, "") + "/";
      const entries = new Map<string, "file" | "dir">();

      for (const item of response.data.tree) {
        const itemPath = item.path;
        if (!itemPath || !itemPath.startsWith(prefix)) {
          continue;
        }

        const relative = itemPath.slice(prefix.length);
        if (!relative) {
          continue;
        }

        const parts = relative.split("/").filter(Boolean);
        if (parts.length === 0) {
          continue;
        }

        const name = parts[0];
        if (parts.length === 1) {
          entries.set(name, item.type === "tree" ? "dir" : "file");
        } else {
          // Any deeper entry means the first segment is a directory
          if (!entries.has(name)) {
            entries.set(name, "dir");
          }
        }
      }

      return Array.from(entries, ([name, type]) => ({ name, type }));
    } catch (error: any) {
      if (error?.status === 404) {
        throw new Error(`Repository or branch not found: ${owner}/${repo}@${branch}`);
      }
      
      // Check for rate limit errors
      this.handleRateLimitError(error);
      
      throw error;
    }
  }

  /**
   * Get repository info (metadata)
   */
  async getRepositoryInfo(): Promise<any> {
    if (!this.currentRepo) {
      throw new Error("Repository not set");
    }

    try {
      const response = await this.octokit.repos.get({
        owner: this.currentRepo.owner,
        repo: this.currentRepo.repo,
      });

      return {
        name: response.data.name,
        description: response.data.description,
        url: response.data.html_url,
        stars: response.data.stargazers_count,
        defaultBranch: response.data.default_branch,
      };
    } catch (error: any) {
      if (error?.status === 404) {
        throw new Error(`Repository not found: ${this.currentRepo.owner}/${this.currentRepo.repo}`);
      }
      throw error;
    }
  }

  /**
   * Fetch the default branch name for a given owner/repo (does not require setRepository).
   */
  async getDefaultBranch(owner: string, repo: string): Promise<string> {
    try {
      const response = await this.octokit.repos.get({ owner, repo });
      return response.data.default_branch;
    } catch (error: any) {
      if (error?.status === 404) {
        throw new Error(`Repository not found: ${owner}/${repo}`);
      }
      this.handleRateLimitError(error);
      throw error;
    }
  }

  /**
   * Get available branches for the repository
   */
  async getBranches(): Promise<string[]> {
    if (!this.currentRepo) {
      throw new Error("Repository not set");
    }

    try {
      const branches: string[] = [];
      let page = 1;
      const perPage = 100;

      while (true) {
        const response = await this.octokit.repos.listBranches({
          owner: this.currentRepo.owner,
          repo: this.currentRepo.repo,
          per_page: perPage,
          page,
        });

        for (const branch of response.data) {
          branches.push((branch as any).name);
        }

        if (response.data.length < perPage) {
          break;
        }
        page++;
      }

      return branches;
    } catch (error: any) {
      if (error?.status === 404) {
        throw new Error(`Repository not found: ${this.currentRepo.owner}/${this.currentRepo.repo}`);
      }
      throw error;
    }
  }

  /**
   * Clear the file cache
   */
  clearCache(): void {
    this.fileCache.clear();
  }
}

// Export singleton instance
export const githubClient = new GitHubClient();
