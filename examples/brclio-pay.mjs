import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const CHANNELS = new Set(['native', 'h5', 'jsapi', 'app']);
const encoder = new TextEncoder();

function secret(value, name) {
  if (typeof value !== 'string' || encoder.encode(value).length < 32) throw new TypeError(`${name} must contain at least 32 bytes`);
  return value;
}

function digest(key, value) {
  return createHmac('sha256', key).update(value).digest('hex');
}

function header(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name) || '';
  const key = Object.keys(headers || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key === undefined ? undefined : headers[key];
  return typeof value === 'string' ? value : '';
}

function orderPath(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new TypeError('Invalid payment order ID');
  return `/api/v1/orders/${encodeURIComponent(id)}`;
}

export class BrclioPayError extends Error {
  constructor(status, code) {
    super(`Payment API request failed (${status}, ${code})`);
    this.name = 'BrclioPayError';
    this.status = status;
    this.code = code;
  }
}

/** Server-side only. Never ship apiKey to a browser, desktop app, or APK. */
export class BrclioPayClient {
  constructor({ baseUrl, clientId, apiKey, fetchImpl = globalThis.fetch }) {
    const url = new URL(baseUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new TypeError('baseUrl must be an HTTPS origin (HTTP is allowed only for localhost development)');
    }
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(clientId)) throw new TypeError('Invalid clientId');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
    this.baseUrl = url.origin;
    this.clientId = clientId;
    this.apiKey = secret(apiKey, 'apiKey');
    this.fetchImpl = fetchImpl;
  }

  async request(method, path, input) {
    const url = new URL(path, `${this.baseUrl}/`);
    if (url.origin !== this.baseUrl || !url.pathname.startsWith('/api/v1/')) throw new TypeError('Invalid API path');
    const rawBody = input === undefined ? '' : JSON.stringify(input);
    if (encoder.encode(rawBody).length > 16_384) throw new TypeError('Payment API request is too large');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const canonical = `${method}\n${url.pathname}${url.search}\n${timestamp}\n${nonce}\n${rawBody}\n`;
    const response = await this.fetchImpl(url.href, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Brclio-Client': this.clientId,
        'X-Brclio-Timestamp': timestamp,
        'X-Brclio-Nonce': nonce,
        'X-Brclio-Signature': digest(this.apiKey, canonical),
      },
      body: rawBody || undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    let result;
    try { result = await response.json(); } catch { throw new BrclioPayError(response.status, 'INVALID_API_RESPONSE'); }
    if (!response.ok) {
      const code = result?.error?.code || result?.code;
      throw new BrclioPayError(response.status, typeof code === 'string' && /^[A-Z0-9_]{1,100}$/.test(code) ? code : 'REQUEST_FAILED');
    }
    return result;
  }

  createOrder(input) {
    if (!input || typeof input.merchantOrderId !== 'string' || !input.merchantOrderId || typeof input.sku !== 'string' || !input.sku || !CHANNELS.has(input.channel)) throw new TypeError('merchantOrderId, sku, and a supported channel are required');
    if (input.quantity !== undefined && (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 100)) throw new TypeError('Invalid quantity');
    return this.request('POST', '/api/v1/orders', input);
  }

  getOrder(id) { return this.request('GET', orderPath(id)); }
  refreshOrder(id) { return this.request('POST', `${orderPath(id)}/refresh`); }
}

export function createClient(options) { return new BrclioPayClient(options); }

/**
 * Verify exact raw bytes before JSON parsing. Returns an authenticated event.
 * This does not deduplicate events or grant entitlements. The receiver must do
 * both inside its own durable database transaction; see docs/integration.md.
 */
export function verifyWebhook({ rawBody, headers, webhookSecret, expectedClientId, now = Math.floor(Date.now() / 1000), toleranceSeconds = 300 }) {
  secret(webhookSecret, 'webhookSecret');
  if (!(typeof rawBody === 'string' || Buffer.isBuffer(rawBody) || rawBody instanceof Uint8Array)) throw new TypeError('rawBody must be the unmodified request bytes');
  if (!Number.isFinite(now) || !Number.isFinite(toleranceSeconds) || toleranceSeconds < 0 || toleranceSeconds > 300) throw new TypeError('Invalid webhook clock configuration');
  const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  if (bytes.length === 0 || bytes.length > 65_536) throw new Error('Invalid webhook');
  const timestamp = header(headers, 'X-Brclio-Timestamp');
  const nonce = header(headers, 'X-Brclio-Nonce');
  const signature = header(headers, 'X-Brclio-Signature');
  const eventId = header(headers, 'X-Brclio-Event');
  if (!/^\d{10}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > toleranceSeconds || !/^[a-zA-Z0-9_-]{16,128}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) throw new Error('Invalid webhook');
  const expected = createHmac('sha256', webhookSecret).update(`${timestamp}\n${nonce}\n`).update(bytes).update('\n').digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new Error('Invalid webhook');
  let event;
  try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('Invalid webhook'); }
  if (!event || event.type !== 'payment.success' || typeof event.orderId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(event.orderId) || eventId !== `payment.success.${event.orderId}` || event.eventId !== eventId || typeof event.clientId !== 'string' || !event.clientId || (expectedClientId !== undefined && event.clientId !== expectedClientId) || typeof event.merchantOrderId !== 'string' || !event.merchantOrderId || typeof event.sku !== 'string' || !event.sku || !Number.isSafeInteger(event.quantity) || event.quantity < 1 || !Number.isSafeInteger(event.total) || event.total < 1 || event.currency !== 'CNY' || typeof event.transactionId !== 'string' || !event.transactionId || typeof event.paidAt !== 'string' || !Number.isFinite(Date.parse(event.paidAt))) throw new Error('Invalid webhook');
  return event;
}
