import {
  clearBackendSession,
  getActiveGitHubToken,
  getConfiguredOAuthClientId,
  githubApiFetch,
  isTrustedGitHubUrl,
  pollOAuthDeviceToken,
  sanitizeCredentialText,
  saveBackendSession,
  startOAuthDeviceFlow,
  verifyGitHubToken,
} from '../vite-github-utils.js';
import {
  clearAllBackendApiKeys,
  getBackendApiKey,
  getProviderKeyStatuses,
  requestProviderChat,
  requestProviderModels,
  setBackendApiKey,
} from '../vite-ai-utils.js';

const GH_COOKIE_NAME = 'intellicode_gh_session';
const AI_COOKIE_NAME = 'intellicode_ai_keys';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg', 'bmp',
  'pdf', 'zip', 'tar', 'gz', 'exe', 'dll', 'bin', 'iso',
  'woff', 'woff2', 'ttf', 'eot', 'mp3', 'mp4', 'wav', 'docx',
]);

function detectLangFromPath(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  if (ext === 'c' || ext === 'h' || ext === 'cpp' || ext === 'hpp') return 'c';
  if (ext === 'py') return 'python';
  if (ext === 'json') return 'json';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'css' || ext === 'scss') return 'css';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs') return 'javascript';
  return 'typescript';
}

function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

function parseCookies(req) {
  const header = req.headers?.cookie || '';
  const result = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) result[key] = decodeURIComponent(val);
  }
  return result;
}

function decodeCookieJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function encodeCookieJson(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function appendSetCookie(res, cookieStr) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', [cookieStr]);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieStr]);
  } else {
    res.setHeader('Set-Cookie', [String(existing), cookieStr]);
  }
}

function setHttpOnlyCookie(req, res, name, valueObj, maxAge = COOKIE_MAX_AGE) {
  const proto = req.headers?.['x-forwarded-proto'] || '';
  const isHttps = String(proto).includes('https') || process.env.VERCEL === '1';
  const secureFlag = isHttps ? '; Secure' : '';
  const val = valueObj ? encodeCookieJson(valueObj) : '';
  appendSetCookie(
    res,
    `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureFlag}`
  );
}

function clearHttpOnlyCookie(req, res, name) {
  setHttpOnlyCookie(req, res, name, null, 0);
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function fetchRepoFilesFromGitHubApi(token, owner, repo, requestedBranch = 'main') {
  let branch = requestedBranch || 'main';
  let treeRes = await githubApiFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    token
  );

  if (!treeRes.ok && (treeRes.status === 404 || treeRes.status === 409)) {
    const repoMeta = await githubApiFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      token
    );
    if (repoMeta.ok && repoMeta.data?.default_branch && repoMeta.data.default_branch !== branch) {
      branch = repoMeta.data.default_branch;
      treeRes = await githubApiFetch(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        token
      );
    }
  }

  if (!treeRes.ok) {
    if (treeRes.status === 404 || treeRes.status === 409) {
      return { success: true, files: [], branch, empty: true };
    }
    return {
      success: false,
      status: treeRes.status,
      unauthorized: treeRes.status === 401,
      error: sanitizeCredentialText(treeRes.data?.message || 'Failed to read repository files', token),
    };
  }

  const blobs = (Array.isArray(treeRes.data?.tree) ? treeRes.data.tree : [])
    .filter((item) => {
      if (item.type !== 'blob' || !item.path) return false;
      if (item.path.startsWith('node_modules/') || item.path.startsWith('.git/') || item.path.startsWith('dist/')) {
        return false;
      }
      const ext = item.path.split('.').pop()?.toLowerCase() || '';
      if (BINARY_EXTS.has(ext)) return false;
      if (item.size && item.size > 300 * 1024) return false;
      return true;
    })
    .slice(0, 75);

  const files = [];
  const batchSize = 10;
  for (let i = 0; i < blobs.length; i += batchSize) {
    const slice = blobs.slice(i, i + batchSize);
    const loaded = await Promise.all(
      slice.map(async (item, idx) => {
        const blobRes = await githubApiFetch(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${item.sha}`,
          token
        );
        if (!blobRes.ok || !blobRes.data?.content) return null;
        try {
          const decoded = Buffer.from(blobRes.data.content.replace(/\n/g, ''), 'base64').toString('utf8');
          const name = item.path.split('/').pop() || item.path;
          return {
            id: `gh-${String(item.sha).slice(0, 10)}-${i + idx}`,
            name,
            path: item.path,
            language: detectLangFromPath(item.path),
            content: decoded,
            savedContent: decoded,
            isDirty: false,
          };
        } catch {
          return null;
        }
      })
    );
    for (const f of loaded) {
      if (f) files.push(f);
    }
  }

  return { success: true, files, branch };
}

async function pushFilesViaGitHubApi({ token, owner, repo, branch = 'main', message = 'Update from IntelliCode IDE', files = [] }) {
  const baseRepoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const filesToPush = Array.isArray(files) && files.length > 0
    ? files.filter((f) => f?.path && !String(f.path).includes('..'))
    : [{ path: 'README.md', content: `# ${repo}\n\nCreated with IntelliCode IDE.\n` }];

  let refRes = await githubApiFetch(`${baseRepoPath}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  if (!refRes.ok) {
    const first = filesToPush[0];
    const putFirst = await githubApiFetch(`${baseRepoPath}/contents/${first.path}`, token, {
      method: 'PUT',
      body: {
        message,
        content: Buffer.from(first.content ?? '', 'utf8').toString('base64'),
        branch,
      },
    });
    if (!putFirst.ok) {
      return {
        success: false,
        status: putFirst.status,
        error: sanitizeCredentialText(putFirst.data?.message || 'Failed to push initial commit to GitHub', token),
      };
    }
    if (filesToPush.length === 1) {
      return { success: true, branch, commitHash: putFirst.data?.commit?.sha || '' };
    }
    refRes = await githubApiFetch(`${baseRepoPath}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  }

  const parentCommitSha = refRes.data?.object?.sha;
  if (!parentCommitSha) {
    return { success: false, status: 400, error: 'Could not resolve branch reference on GitHub' };
  }
  const commitRes = await githubApiFetch(`${baseRepoPath}/git/commits/${parentCommitSha}`, token);
  const baseTreeSha = commitRes.data?.tree?.sha;

  const treeEntries = [];
  for (const f of filesToPush) {
    const blobRes = await githubApiFetch(`${baseRepoPath}/git/blobs`, token, {
      method: 'POST',
      body: { content: f.content ?? '', encoding: 'utf-8' },
    });
    if (blobRes.ok && blobRes.data?.sha) {
      treeEntries.push({
        path: String(f.path).replace(/^\/+/, ''),
        mode: '100644',
        type: 'blob',
        sha: blobRes.data.sha,
      });
    }
  }

  const newTreeRes = await githubApiFetch(`${baseRepoPath}/git/trees`, token, {
    method: 'POST',
    body: { base_tree: baseTreeSha, tree: treeEntries },
  });
  if (!newTreeRes.ok || !newTreeRes.data?.sha) {
    return {
      success: false,
      status: 400,
      error: sanitizeCredentialText(newTreeRes.data?.message || 'Failed to create Git tree', token),
    };
  }

  const newCommitRes = await githubApiFetch(`${baseRepoPath}/git/commits`, token, {
    method: 'POST',
    body: {
      message,
      tree: newTreeRes.data.sha,
      parents: [parentCommitSha],
    },
  });
  if (!newCommitRes.ok || !newCommitRes.data?.sha) {
    return {
      success: false,
      status: 400,
      error: sanitizeCredentialText(newCommitRes.data?.message || 'Failed to create commit', token),
    };
  }

  const updateRefRes = await githubApiFetch(`${baseRepoPath}/git/refs/heads/${encodeURIComponent(branch)}`, token, {
    method: 'PATCH',
    body: { sha: newCommitRes.data.sha },
  });
  if (!updateRefRes.ok) {
    return {
      success: false,
      status: 400,
      error: sanitizeCredentialText(updateRefRes.data?.message || 'Failed to update branch ref', token),
    };
  }

  return { success: true, branch, commitHash: newCommitRes.data.sha };
}

export default async function handler(req, res) {
  const url = (req.url || '').split('?')[0];

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.end();
    return;
  }

  const body = req.method === 'POST' ? await readJsonBody(req) : {};
  const cookies = parseCookies(req);

  // Hydrate per-request session & keys from HttpOnly cookies (stateless across Vercel lambdas)
  clearBackendSession(false);
  const ghCookie = decodeCookieJson(cookies[GH_COOKIE_NAME]);
  if (ghCookie && ghCookie.token) {
    saveBackendSession(
      { token: ghCookie.token, authMethod: ghCookie.authMethod || 'oauth', user: ghCookie.user || null },
      false
    );
  }

  clearAllBackendApiKeys(false);
  const aiCookie = decodeCookieJson(cookies[AI_COOKIE_NAME]);
  const aiCookieMap = aiCookie && typeof aiCookie === 'object' ? { ...aiCookie } : {};
  for (const [k, v] of Object.entries(aiCookieMap)) {
    if (typeof v === 'string' && v.trim()) {
      setBackendApiKey(k, v, false);
    }
  }

  try {
    // ============================================================
    // AI GATEWAY ENDPOINTS
    // ============================================================
    if (url === '/api/ai/keys/status') {
      return sendJson(res, 200, { success: true, ...getProviderKeyStatuses() });
    }

    if (url === '/api/ai/keys/set') {
      const { providerKey, apiKey } = body;
      if (!providerKey) {
        return sendJson(res, 400, { success: false, error: 'providerKey is required' });
      }
      const keyName = String(providerKey).trim();
      const val = String(apiKey || '').trim();
      setBackendApiKey(keyName, val, false);
      if (val) aiCookieMap[keyName] = val;
      else delete aiCookieMap[keyName];
      setHttpOnlyCookie(req, res, AI_COOKIE_NAME, aiCookieMap);
      return sendJson(res, 200, { success: true, ...getProviderKeyStatuses() });
    }

    if (url === '/api/ai/test') {
      const { format = 'openai', baseUrl = '', apiKey = '', providerKey = '', modelId } = body;
      if (modelId) {
        const chatTest = await requestProviderChat({
          format,
          baseUrl,
          apiKey,
          providerKey,
          modelId,
          messages: [{ role: 'user', content: 'Reply with OK' }],
          temperature: 0,
          maxTokens: 16,
          timeoutMs: 15000,
        });
        return sendJson(res, chatTest.status || 200, {
          success: chatTest.success,
          error: chatTest.error,
          ...getProviderKeyStatuses(),
        });
      }
      const modTest = await requestProviderModels({ format, baseUrl, apiKey, providerKey });
      return sendJson(res, modTest.status || 200, {
        success: modTest.success,
        modelsCount: modTest.models?.length || 0,
        error: modTest.error,
        ...getProviderKeyStatuses(),
      });
    }

    if (url === '/api/ai/models') {
      const result = await requestProviderModels({
        format: body.format || 'gemini',
        baseUrl: body.baseUrl || '',
        apiKey: body.apiKey || '',
        providerKey: body.providerKey || '',
      });
      return sendJson(res, result.status || 200, { ...result, ...getProviderKeyStatuses() });
    }

    if (url === '/api/ai/chat') {
      const controller = new AbortController();
      req.on('close', () => controller.abort());
      const result = await requestProviderChat({
        format: body.format || 'openai',
        baseUrl: body.baseUrl || '',
        apiKey: body.apiKey || '',
        providerKey: body.providerKey || '',
        modelId: body.modelId,
        messages: body.messages || [],
        systemPrompt: body.systemPrompt || '',
        temperature: body.temperature ?? 0.2,
        maxTokens: body.maxTokens ?? 8192,
        signal: controller.signal,
      });
      return sendJson(res, result.status || 200, { ...result, ...getProviderKeyStatuses() });
    }

    if (url === '/api/ai/chat-stream') {
      const controller = new AbortController();
      req.on('close', () => controller.abort());

      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');

      const result = await requestProviderChat({
        format: body.format || 'openai',
        baseUrl: body.baseUrl || '',
        apiKey: body.apiKey || '',
        providerKey: body.providerKey || '',
        modelId: body.modelId,
        messages: body.messages || [],
        systemPrompt: body.systemPrompt || '',
        temperature: body.temperature ?? 0.2,
        maxTokens: body.maxTokens ?? 8192,
        signal: controller.signal,
      });

      if (!res.writableEnded) {
        if (result.success) {
          res.write(`data: ${JSON.stringify({ delta: result.content || '' })}\n\n`);
          res.write(`data: ${JSON.stringify({ done: true, usage: result.usage, ...getProviderKeyStatuses() })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ error: result.error || 'AI request failed', aborted: result.aborted })}\n\n`);
        }
        res.end();
      }
      return;
    }

    // ============================================================
    // GITHUB AUTH & REPOSITORY CLOUD ENDPOINTS
    // ============================================================
    if (url === '/api/github/status') {
      const oauthConfigured = Boolean(getConfiguredOAuthClientId(process.env));
      const ghCliAvailable = false; // Cloud runtime has no local gh CLI

      const activeToken = getActiveGitHubToken();
      if (!activeToken) {
        return sendJson(res, 200, {
          success: true,
          authenticated: false,
          user: null,
          authMethod: null,
          oauthConfigured,
          ghCliAvailable,
        });
      }

      const verified = await verifyGitHubToken(activeToken);
      if (!verified.success || !verified.user) {
        clearBackendSession(false);
        clearHttpOnlyCookie(req, res, GH_COOKIE_NAME);
        return sendJson(res, 200, {
          success: true,
          authenticated: false,
          user: null,
          authMethod: null,
          expired: verified.unauthorized,
          error: verified.unauthorized ? 'GitHub session expired or invalid. Please sign in again.' : verified.error,
          oauthConfigured,
          ghCliAvailable,
        });
      }

      return sendJson(res, 200, {
        success: true,
        authenticated: true,
        user: verified.user,
        authMethod: ghCookie?.authMethod || 'oauth',
        oauthConfigured,
        ghCliAvailable,
      });
    }

    if (url === '/api/github/login-cli') {
      return sendJson(res, 400, {
        success: false,
        error: 'GitHub CLI (`gh`) is only available when running IntelliCode locally. Use Connect GitHub or a Personal Access Token.',
      });
    }

    if (url === '/api/github/login-pat' || url === '/api/github/user') {
      const tok = String(body.token || '').trim();
      if (!tok) {
        return sendJson(res, 400, { success: false, error: 'Personal Access Token is required' });
      }
      const verified = await verifyGitHubToken(tok);
      if (!verified.success || !verified.user) {
        return sendJson(res, verified.status || 401, {
          success: false,
          unauthorized: verified.unauthorized,
          error: verified.error || 'Invalid GitHub token',
        });
      }
      setHttpOnlyCookie(req, res, GH_COOKIE_NAME, { token: tok, authMethod: 'pat', user: verified.user });
      return sendJson(res, 200, {
        success: true,
        authenticated: true,
        user: verified.user,
        authMethod: 'pat',
      });
    }

    if (url === '/api/github/logout') {
      clearBackendSession(false);
      clearHttpOnlyCookie(req, res, GH_COOKIE_NAME);
      return sendJson(res, 200, { success: true });
    }

    if (url === '/api/github/device-code') {
      const result = await startOAuthDeviceFlow({ clientId: body.clientId, env: process.env });
      if (!result.success) {
        return sendJson(res, 400, result);
      }
      return sendJson(res, 200, result);
    }

    if (url === '/api/github/device-token') {
      const result = await pollOAuthDeviceToken({
        clientId: body.clientId,
        deviceCode: body.deviceCode,
        env: process.env,
        persistToDisk: false,
      });
      if (result.authenticated && result.user) {
        const newTok = getActiveGitHubToken();
        if (newTok) {
          setHttpOnlyCookie(req, res, GH_COOKIE_NAME, { token: newTok, authMethod: 'oauth', user: result.user });
        }
      }
      return sendJson(res, 200, result);
    }

    if (url === '/api/github/repos') {
      const activeToken = getActiveGitHubToken();
      if (!activeToken) {
        return sendJson(res, 401, { success: false, unauthorized: true, error: 'GitHub authentication required' });
      }
      const gh = await githubApiFetch(
        '/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member',
        activeToken
      );
      if (!gh.ok) {
        if (gh.status === 401) clearHttpOnlyCookie(req, res, GH_COOKIE_NAME);
        return sendJson(res, gh.status, {
          success: false,
          unauthorized: gh.status === 401,
          error: sanitizeCredentialText(gh.data?.message || 'Failed to fetch repositories', activeToken),
        });
      }
      const repos = (Array.isArray(gh.data) ? gh.data : []).map((r) => ({
        id: r.id,
        name: r.name,
        fullName: r.full_name,
        private: !!r.private,
        description: r.description || '',
        htmlUrl: r.html_url,
        cloneUrl: r.clone_url,
        defaultBranch: r.default_branch || 'main',
        updatedAt: r.updated_at,
        language: r.language || '',
        owner: r.owner?.login || '',
      }));
      return sendJson(res, 200, { success: true, repos });
    }

    if (url === '/api/github/create-repo') {
      const activeToken = getActiveGitHubToken();
      const { name, description = '', isPrivate = true } = body;
      if (!activeToken || !name) {
        return sendJson(res, activeToken ? 400 : 401, {
          success: false,
          unauthorized: !activeToken,
          error: activeToken ? 'Repository name is required' : 'GitHub authentication required',
        });
      }
      const gh = await githubApiFetch('/user/repos', activeToken, {
        method: 'POST',
        body: { name: name.trim(), description, private: !!isPrivate, auto_init: false },
      });
      if (!gh.ok) {
        if (gh.status === 401) clearHttpOnlyCookie(req, res, GH_COOKIE_NAME);
        return sendJson(res, gh.status, {
          success: false,
          unauthorized: gh.status === 401,
          error: sanitizeCredentialText(
            gh.data?.errors?.[0]?.message || gh.data?.message || 'Failed to create repository on GitHub',
            activeToken
          ),
        });
      }
      return sendJson(res, 200, {
        success: true,
        repo: {
          id: gh.data.id,
          name: gh.data.name,
          fullName: gh.data.full_name,
          private: !!gh.data.private,
          description: gh.data.description || '',
          htmlUrl: gh.data.html_url,
          cloneUrl: gh.data.clone_url,
          defaultBranch: gh.data.default_branch || 'main',
          updatedAt: gh.data.updated_at,
          language: gh.data.language || '',
          owner: gh.data.owner?.login || '',
        },
      });
    }

    if (url === '/api/github/clone' || url === '/api/github/repo-files') {
      const activeToken = getActiveGitHubToken();
      const { cloneUrl, repoName, owner, repo, branch } = body;
      const targetRepo = repo || repoName;
      let targetOwner = owner;

      if (cloneUrl && !isTrustedGitHubUrl(cloneUrl)) {
        return sendJson(res, 400, { success: false, error: 'Untrusted repository URL.' });
      }
      if (!targetOwner && cloneUrl) {
        const m = String(cloneUrl).match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
        if (m) targetOwner = m[1];
      }
      if (!targetOwner || !targetRepo) {
        return sendJson(res, 400, { success: false, error: 'Repository owner and name are required' });
      }

      const filesRes = await fetchRepoFilesFromGitHubApi(activeToken, targetOwner, targetRepo, branch || 'main');
      if (!filesRes.success) {
        return sendJson(res, filesRes.status || 400, filesRes);
      }

      return sendJson(res, 200, {
        success: true,
        cloudMode: true,
        folderName: targetRepo,
        branch: filesRes.branch || 'main',
        files: filesRes.files || [],
      });
    }

    if (url === '/api/github/push-files') {
      const activeToken = getActiveGitHubToken();
      if (!activeToken) {
        return sendJson(res, 401, { success: false, unauthorized: true, error: 'GitHub authentication required' });
      }
      const { owner, repo, branch = 'main', message = 'Update from IntelliCode IDE', files = [] } = body;
      if (!owner || !repo) {
        return sendJson(res, 400, { success: false, error: 'Repository owner and name are required' });
      }
      const pushed = await pushFilesViaGitHubApi({ token: activeToken, owner, repo, branch, message, files });
      return sendJson(res, pushed.status || 200, pushed);
    }

    if (url === '/api/git/publish') {
      const activeToken = getActiveGitHubToken();
      const { repoName, description = '', isPrivate = true, commitMessage = 'Initial commit from IntelliCode IDE', files = [] } = body;
      if (!activeToken || !repoName) {
        return sendJson(res, activeToken ? 400 : 401, {
          success: false,
          unauthorized: !activeToken,
          error: activeToken ? 'Repository name is required' : 'GitHub authentication required',
        });
      }

      const gh = await githubApiFetch('/user/repos', activeToken, {
        method: 'POST',
        body: { name: repoName.trim(), description, private: !!isPrivate, auto_init: false },
      });
      if (!gh.ok) {
        if (gh.status === 401) clearHttpOnlyCookie(req, res, GH_COOKIE_NAME);
        return sendJson(res, gh.status, {
          success: false,
          unauthorized: gh.status === 401,
          error: sanitizeCredentialText(
            gh.data?.errors?.[0]?.message || gh.data?.message || 'Failed to create GitHub repository',
            activeToken
          ),
        });
      }

      const ownerLogin = gh.data.owner?.login || ghCookie?.user?.login || '';
      const defaultBranch = gh.data.default_branch || 'main';
      const pushed = await pushFilesViaGitHubApi({
        token: activeToken,
        owner: ownerLogin,
        repo: gh.data.name,
        branch: defaultBranch,
        message: commitMessage,
        files,
      });

      if (!pushed.success) {
        return sendJson(res, 200, {
          success: false,
          error: pushed.error || 'Created repo on GitHub, but failed to push files',
        });
      }

      return sendJson(res, 200, {
        success: true,
        cloudMode: true,
        branch: pushed.branch || defaultBranch,
        remoteUrl: gh.data.clone_url,
        repo: {
          id: gh.data.id,
          name: gh.data.name,
          fullName: gh.data.full_name,
          private: !!gh.data.private,
          description: gh.data.description || '',
          htmlUrl: gh.data.html_url,
          cloneUrl: gh.data.clone_url,
          defaultBranch,
          updatedAt: gh.data.updated_at,
          language: gh.data.language || '',
          owner: ownerLogin,
        },
      });
    }

    if (url.startsWith('/api/git') || url.startsWith('/api/workspace') || url.startsWith('/api/terminal')) {
      return sendJson(res, 200, {
        success: false,
        cloudMode: true,
        isGit: false,
        error: 'Host filesystem/terminal CLI operations run only on localhost; GitHub cloud API sync is active.',
      });
    }

    return sendJson(res, 404, { success: false, error: `Unknown API route: ${url}` });
  } catch (err) {
    console.error('Vercel API error:', err);
    return sendJson(res, 500, { success: false, error: err?.message || 'Internal server error' });
  }
}
