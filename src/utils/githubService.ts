import type { GitHubRepo, GitHubUser, ProjectFile } from '../types/ide';

async function postJson<T>(url: string, body: any = {}): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error(`Request failed (${res.status})`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data?.error) {
    throw new Error(`Request failed (${res.status})`);
  }
  return data as T;
}

export const githubService = {
  async getAuthStatus(): Promise<{
    success: boolean;
    authenticated: boolean;
    user?: GitHubUser | null;
    authMethod?: 'oauth' | 'gh-cli' | 'pat' | null;
    oauthConfigured?: boolean;
    ghCliAvailable?: boolean;
    expired?: boolean;
    error?: string;
  }> {
    try {
      return await postJson('/api/github/status', {});
    } catch (err: any) {
      return {
        success: false,
        authenticated: false,
        user: null,
        error: err?.message || 'Failed to check GitHub session status',
      };
    }
  },

  async loginWithCli(): Promise<{
    success: boolean;
    authenticated?: boolean;
    user?: GitHubUser;
    authMethod?: 'gh-cli';
    error?: string;
  }> {
    try {
      return await postJson('/api/github/login-cli', {});
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to sign in with GitHub CLI' };
    }
  },

  async loginWithPat(token: string): Promise<{
    success: boolean;
    authenticated?: boolean;
    user?: GitHubUser;
    authMethod?: 'pat';
    unauthorized?: boolean;
    error?: string;
  }> {
    try {
      return await postJson('/api/github/login-pat', { token });
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to verify GitHub token' };
    }
  },

  async logout(): Promise<{ success: boolean }> {
    try {
      return await postJson('/api/github/logout', {});
    } catch {
      return { success: false };
    }
  },

  async startDeviceFlow(clientId?: string): Promise<{
    success: boolean;
    code?: string;
    clientId?: string;
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
  }> {
    try {
      return await postJson('/api/github/device-code', clientId ? { clientId } : {});
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to start GitHub Device Flow' };
    }
  },

  async pollDeviceToken(deviceCode: string, clientId?: string): Promise<{
    success: boolean;
    authenticated?: boolean;
    pending?: boolean;
    slowDown?: boolean;
    user?: GitHubUser;
    error?: string;
    error_description?: string;
  }> {
    try {
      return await postJson('/api/github/device-token', {
        deviceCode,
        ...(clientId ? { clientId } : {}),
      });
    } catch (err: any) {
      return { success: false, error: err?.message || 'Polling failed' };
    }
  },

  async listRepos(): Promise<{
    success: boolean;
    repos?: GitHubRepo[];
    unauthorized?: boolean;
    error?: string;
  }> {
    try {
      return await postJson('/api/github/repos', {});
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to fetch repositories' };
    }
  },

  async createRepo(
    name: string,
    description: string,
    isPrivate: boolean
  ): Promise<{ success: boolean; repo?: GitHubRepo; unauthorized?: boolean; error?: string }> {
    try {
      return await postJson('/api/github/create-repo', { name, description, isPrivate });
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to create repository' };
    }
  },

  async cloneRepo(params: {
    cloneUrl: string;
    repoName: string;
    owner?: string;
    branch?: string;
  }): Promise<{
    success: boolean;
    cloudMode?: boolean;
    folderName?: string;
    workspacePath?: string;
    repoRoot?: string;
    branch?: string;
    files?: ProjectFile[];
    error?: string;
  }> {
    try {
      return await postJson('/api/github/clone', params);
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to clone repository' };
    }
  },

  async fetchRepoFiles(params: {
    owner: string;
    repo: string;
    branch?: string;
  }): Promise<{
    success: boolean;
    files?: ProjectFile[];
    branch?: string;
    error?: string;
  }> {
    try {
      return await postJson('/api/github/repo-files', params);
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to pull repository files' };
    }
  },

  async pushRepoFiles(params: {
    owner: string;
    repo: string;
    branch?: string;
    message?: string;
    files: { path: string; content: string }[];
  }): Promise<{
    success: boolean;
    branch?: string;
    commitHash?: string;
    error?: string;
  }> {
    try {
      return await postJson('/api/github/push-files', params);
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to push changes to GitHub' };
    }
  },

  async publishWorkspace(params: {
    workspacePath?: string | null;
    repoName: string;
    description?: string;
    isPrivate: boolean;
    commitMessage?: string;
    authorName?: string;
    authorEmail?: string;
    files?: { path: string; content: string }[];
  }): Promise<{
    success: boolean;
    cloudMode?: boolean;
    workspacePath?: string;
    repoRoot?: string;
    branch?: string;
    remoteUrl?: string;
    repo?: GitHubRepo;
    unauthorized?: boolean;
    error?: string;
  }> {
    try {
      return await postJson('/api/git/publish', params);
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to publish to GitHub' };
    }
  },
};
