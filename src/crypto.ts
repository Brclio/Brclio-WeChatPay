/** Web Crypto primitives shared by the Worker and server-side integrations. */
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const STORAGE_AAD = encoder.encode('Brclio-WeChatPay:encrypted-json:v1');

export interface EncryptedEnvelope {
  version: 1;
  algorithm: 'AES-256-GCM';
  iv: string;
  ciphertext: string;
}

export interface WechatEncryptedResource {
  ciphertext: string;
  nonce: string;
  associated_data?: string;
  algorithm?: string;
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  // Avoid spreading large payloads into a single function invocation.
  for (let index = 0; index < bytes.length; index += 0x8000) {
    result += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(result);
}

export function base64ToBytes(value: string): Uint8Array {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid base64 encoding');
  }
  const binary = atob(value);
  const result = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytesToBase64(result) !== value) throw new Error('Invalid base64 encoding');
  return result;
}

export async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

export async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

/** Constant-work comparison for fixed-length authentication digests. */
export function constantTimeEqual(a: string, b: string): boolean {
  let different = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    different |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return different === 0;
}

export function randomHex(bytes = 16): string {
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > 65_536) throw new Error('Invalid random byte length');
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function pemBytes(value: string, kind: 'PRIVATE KEY' | 'PUBLIC KEY'): Uint8Array {
  const match = value.trim().match(new RegExp(`^-----BEGIN ${kind}-----\\s+([A-Za-z0-9+/=\\s]+)\\s+-----END ${kind}-----$`));
  if (!match) throw new Error(`Expected a PEM ${kind.toLowerCase()}`);
  return base64ToBytes(match[1]!.replace(/\s/g, ''));
}

export async function rsaSign(privatePem: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('pkcs8', pemBytes(privatePem, 'PRIVATE KEY'), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(message))));
}

export async function rsaVerify(publicPem: string, message: string, signatureBase64: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('spki', pemBytes(publicPem, 'PUBLIC KEY'), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  let signature: Uint8Array;
  try { signature = base64ToBytes(signatureBase64); } catch { return false; }
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, encoder.encode(message));
}

export async function decryptResource(apiV3Key: string, resource: WechatEncryptedResource): Promise<unknown> {
  if (resource.algorithm !== undefined && resource.algorithm !== 'AEAD_AES_256_GCM') throw new Error('Unsupported WeChat resource algorithm');
  const rawKey = encoder.encode(apiV3Key);
  if (rawKey.byteLength !== 32 || typeof resource.nonce !== 'string' || encoder.encode(resource.nonce).byteLength !== 12) {
    throw new Error('Invalid WeChat resource encryption parameters');
  }
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: encoder.encode(resource.nonce), additionalData: encoder.encode(resource.associated_data ?? ''), tagLength: 128 }, key, base64ToBytes(resource.ciphertext));
  return JSON.parse(decoder.decode(plaintext));
}

async function storageKey(keyBase64: string, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const raw = base64ToBytes(keyBase64);
  if (raw.byteLength !== 32) throw new Error('ENCRYPTION_KEY must contain 32 bytes encoded as base64');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [usage]);
}

function storageAdditionalData(context: string): Uint8Array {
  return context ? encoder.encode(`${decoder.decode(STORAGE_AAD)}\n${context}`) : STORAGE_AAD;
}

export async function encryptJson(keyBase64: string, value: unknown, context = ''): Promise<EncryptedEnvelope> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Value cannot be represented as JSON');
  const key = await storageKey(keyBase64, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: storageAdditionalData(context), tagLength: 128 }, key, encoder.encode(serialized));
  return { version: 1, algorithm: 'AES-256-GCM', iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

export async function decryptJson<T = unknown>(keyBase64: string, envelope: EncryptedEnvelope, context = ''): Promise<T> {
  if (!envelope || envelope.version !== 1 || envelope.algorithm !== 'AES-256-GCM') throw new Error('Unsupported encrypted data format');
  const iv = base64ToBytes(envelope.iv);
  if (iv.byteLength !== 12) throw new Error('Invalid encrypted data nonce');
  const key = await storageKey(keyBase64, 'decrypt');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: storageAdditionalData(context), tagLength: 128 }, key, base64ToBytes(envelope.ciphertext));
  return JSON.parse(decoder.decode(plaintext)) as T;
}
