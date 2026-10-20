import { base64ToBytes, bytesToBase64, decryptJson, encryptJson, type EncryptedEnvelope } from './crypto.js';

export class StoreError extends Error {
  constructor(public readonly code: string, public readonly status: number, message = 'Payment data storage is temporarily unavailable') {
    super(message);
    this.name = 'StoreError';
  }
}

export interface GithubStoreOptions {
  token: string;
  repo: string;
  branch?: string;
  encryptionKey: string;
  fetcher?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface StoredValue<T> { value: T; sha: string }
export interface GithubEntry { name: string; path: string; type: 'file' | 'dir' }
interface ApiResult { status: number; body: unknown }

const MAX_ATTEMPTS = 6;
const MAX_RESPONSE_LENGTH = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

function validPath(path: string, allowEmpty = false): void {
  if (allowEmpty && path === '') return;
  if (typeof path !== 'string' || path.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(path)) {
    throw new StoreError('INVALID_STORAGE_PATH', 400, 'Invalid payment data storage path');
  }
}

function validBranch(branch: string): void {
  if (!branch || branch.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.')) {
    throw new StoreError('INVALID_STORAGE_BRANCH', 500, 'Invalid payment data storage branch');
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** An encrypted, optimistic-concurrency store backed by GitHub's Contents API.
 * Mutators must be pure: a concurrent writer can cause a mutator to run again.
 * A null mutator result aborts the update and never deletes an existing record.
 */
export class GithubStore {
  private readonly token: string;
  private readonly repo: string;
  private readonly encryptionKey: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private branch: string;
  private readonly explicitBranch: boolean;
  private privateVerifiedUntil = 0;

  constructor(options: GithubStoreOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(options.repo)) throw new StoreError('INVALID_STORAGE_REPOSITORY', 500, 'Invalid payment data repository');
    if (!options.token || /[\r\n]/.test(options.token)) throw new StoreError('INVALID_STORAGE_CREDENTIALS', 500);
    this.token = options.token;
    this.repo = options.repo;
    this.encryptionKey = options.encryptionKey;
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
    this.branch = options.branch ?? 'main';
    this.explicitBranch = options.branch !== undefined;
    validBranch(this.branch);
    this.timeoutMs = options.requestTimeoutMs ?? 4_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) throw new StoreError('INVALID_STORAGE_TIMEOUT', 500);
  }

  async inspect(): Promise<{ private: boolean; default_branch: string }> {
    const result = await this.request('GET', this.repositoryUrl());
    this.expectSuccess(result);
    if (!object(result.body) || typeof result.body.private !== 'boolean' || typeof result.body.default_branch !== 'string') throw new StoreError('GITHUB_INVALID_RESPONSE', 502);
    validBranch(result.body.default_branch);
    if (!this.explicitBranch) this.branch = result.body.default_branch;
    this.privateVerifiedUntil = result.body.private ? Date.now() + 30_000 : 0;
    return { private: result.body.private, default_branch: result.body.default_branch };
  }

  async read<T>(path: string): Promise<StoredValue<T> | null> {
    validPath(path);
    const result = await this.request('GET', this.contentsUrl(path, true));
    if (result.status === 404) return null;
    this.expectSuccess(result);
    if (!object(result.body) || result.body.type !== 'file' || result.body.encoding !== 'base64' || typeof result.body.content !== 'string' || typeof result.body.sha !== 'string' || !/^[a-f0-9]{40,64}$/.test(result.body.sha)) {
      throw new StoreError('GITHUB_INVALID_RESPONSE', 502);
    }
    try {
      const envelope = JSON.parse(decoder.decode(base64ToBytes(result.body.content.replace(/\s/g, '')))) as EncryptedEnvelope;
      return { value: await decryptJson<T>(this.encryptionKey, envelope, `${this.repo}:${path}`), sha: result.body.sha };
    } catch {
      throw new StoreError('STORAGE_DECRYPTION_FAILED', 500, 'Payment data could not be authenticated');
    }
  }

  async create<T>(path: string, value: T): Promise<boolean> {
    validPath(path);
    await this.requirePrivate();
    const result = await this.write(path, value);
    if (result.status === 409 || result.status === 422) return false;
    this.expectSuccess(result);
    return true;
  }

  async update<T>(path: string, mutator: (value: T | null) => T | null): Promise<T | null> {
    validPath(path);
    await this.requirePrivate();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const current = await this.read<T>(path);
      const next = mutator(current?.value ?? null);
      if (next === null) return null;
      const result = await this.write(path, next, current?.sha);
      if (result.status === 409 || result.status === 422) continue;
      this.expectSuccess(result);
      return next;
    }
    throw new StoreError('GITHUB_CONFLICT', 409, 'Payment data changed concurrently; retry the operation');
  }

  async list(dir: string): Promise<GithubEntry[]> {
    validPath(dir, true);
    const result = await this.request('GET', this.contentsUrl(dir, true));
    if (result.status === 404) return [];
    this.expectSuccess(result);
    if (!Array.isArray(result.body)) throw new StoreError('GITHUB_INVALID_RESPONSE', 502);
    // GitHub silently truncates this endpoint at 1,000 items. Never return a partial ledger.
    if (result.body.length >= 1_000) throw new StoreError('GITHUB_DIRECTORY_LIMIT', 503, 'Payment data directory requires additional partitioning');
    return result.body.map((entry: unknown) => {
      if (!object(entry) || typeof entry.name !== 'string' || typeof entry.path !== 'string' || (entry.type !== 'file' && entry.type !== 'dir')) throw new StoreError('GITHUB_INVALID_RESPONSE', 502);
      validPath(entry.path);
      if (entry.path !== (dir ? `${dir}/` : '') + entry.name) throw new StoreError('GITHUB_INVALID_RESPONSE', 502);
      return { name: entry.name, path: entry.path, type: entry.type };
    });
  }

  /** Only transient work-index entries can be deleted; permanent orders cannot be removed. */
  async remove(path: string): Promise<void> {
    validPath(path);
    if (!/^work\/[A-Za-z0-9][A-Za-z0-9_-]*\.json$/.test(path)) throw new StoreError('STORAGE_DELETE_FORBIDDEN', 400, 'Only active payment work entries can be removed');
    await this.requirePrivate();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const current = await this.read<unknown>(path);
      if (!current) return;
      const result = await this.request('DELETE', this.contentsUrl(path), { message: 'Remove completed encrypted payment work entry', branch: this.branch, sha: current.sha });
      if (result.status === 404) return;
      if (result.status === 409 || result.status === 422) continue;
      this.expectSuccess(result);
      return;
    }
    throw new StoreError('GITHUB_CONFLICT', 409, 'Payment data changed concurrently; retry the operation');
  }

  private async requirePrivate(): Promise<void> {
    if (this.privateVerifiedUntil > Date.now()) return;
    if (!(await this.inspect()).private) throw new StoreError('REPOSITORY_NOT_PRIVATE', 503, 'Payment data repository must be private');
  }

  private repositoryUrl(): string {
    return `https://api.github.com/repos/${this.repo.split('/').map(encodeURIComponent).join('/')}`;
  }

  private contentsUrl(path: string, includeRef = false): string {
    return `${this.repositoryUrl()}/contents/${path.split('/').map(encodeURIComponent).join('/')}${includeRef ? `?ref=${encodeURIComponent(this.branch)}` : ''}`;
  }

  private async write<T>(path: string, value: T, sha?: string): Promise<ApiResult> {
    let content: string;
    try {
      content = bytesToBase64(encoder.encode(JSON.stringify(await encryptJson(this.encryptionKey, value, `${this.repo}:${path}`))));
    } catch {
      throw new StoreError('STORAGE_ENCRYPTION_FAILED', 500, 'Payment data could not be encrypted');
    }
    return this.request('PUT', this.contentsUrl(path), { message: 'Update encrypted payment data', branch: this.branch, content, ...(sha ? { sha } : {}) });
  }

  private expectSuccess(result: ApiResult): void {
    if (result.status >= 200 && result.status < 300) return;
    if (result.status === 401 || result.status === 403) throw new StoreError('GITHUB_ACCESS_DENIED', 503);
    if (result.status === 429) throw new StoreError('GITHUB_RATE_LIMITED', 503);
    throw new StoreError('GITHUB_REQUEST_FAILED', result.status === 404 ? 503 : 502);
  }

  private async request(method: 'GET' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<ApiResult> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new StoreError('GITHUB_TIMEOUT', 503));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([expired, (async () => {
        const response = await this.fetcher(url, {
          method,
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Brclio-WeChatPay', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
          redirect: 'error',
        });
        if (!response.ok) {
          // Upstream messages can contain repository names and request metadata.
          await response.body?.cancel();
          return { status: response.status, body: null };
        }
        const text = await response.text();
        if (text.length > MAX_RESPONSE_LENGTH) throw new StoreError('GITHUB_RESPONSE_TOO_LARGE', 502);
        let parsed: unknown;
        try { parsed = text ? JSON.parse(text) : null; } catch { throw new StoreError('GITHUB_INVALID_RESPONSE', 502); }
        return { status: response.status, body: parsed };
      })()]);
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new StoreError(controller.signal.aborted ? 'GITHUB_TIMEOUT' : 'GITHUB_NETWORK_ERROR', 503);
    } finally {
      clearTimeout(timeout);
    }
  }
}
