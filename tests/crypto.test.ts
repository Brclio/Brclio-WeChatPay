import assert from 'node:assert/strict';
import test from 'node:test';
import { base64ToBytes, bytesToBase64, constantTimeEqual, decryptJson, decryptResource, encryptJson, hmac, randomHex, rsaSign, rsaVerify, sha256 } from '../src/crypto.js';

const key = bytesToBase64(new Uint8Array(32).fill(17));

test('SHA-256 and HMAC match published fixed test vectors', async () => {
  assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await hmac('key', 'The quick brown fox jumps over the lazy dog'), 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  assert.equal(constantTimeEqual('123abc', '123abc'), true);
  assert.equal(constantTimeEqual('123abc', '123abd'), false);
  assert.equal(constantTimeEqual('123abc', '123abc\0'), false);
  assert.equal(constantTimeEqual('', ''), true);
  assert.match(randomHex(), /^[0-9a-f]{32}$/);
  assert.throws(() => randomHex(0));
});

test('at-rest encryption roundtrips Unicode and binds records to their path', async () => {
  const payload = { order: '测试订单', amount: 123, paid: false };
  const encrypted = await encryptJson(key, payload, 'repo:orders/order1.json');
  assert.equal(JSON.stringify(encrypted).includes('测试'), false);
  assert.deepEqual(await decryptJson(key, encrypted, 'repo:orders/order1.json'), payload);
  await assert.rejects(decryptJson(key, encrypted, 'repo:orders/order2.json'));
  assert.notEqual(encrypted.iv, (await encryptJson(key, payload)).iv);
});

test('AES-GCM rejects ciphertext changes, wrong keys, and malformed encryption keys', async () => {
  const encrypted = await encryptJson(key, { paid: false });
  const bytes = base64ToBytes(encrypted.ciphertext);
  bytes[0] = bytes[0]! ^ 1;
  await assert.rejects(decryptJson(key, { ...encrypted, ciphertext: bytesToBase64(bytes) }));
  await assert.rejects(decryptJson(bytesToBase64(new Uint8Array(32).fill(18)), encrypted));
  await assert.rejects(encryptJson(bytesToBase64(new Uint8Array(31)), {}));
  await assert.rejects(encryptJson('invalid', {}));
  assert.throws(() => base64ToBytes('AB=='), /Invalid base64/);
});

test('RSA signing and verification authenticate the exact signed message', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const privatePem = `-----BEGIN PRIVATE KEY-----\n${bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer))}\n-----END PRIVATE KEY-----`;
  const publicPem = `-----BEGIN PUBLIC KEY-----\n${bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey) as ArrayBuffer))}\n-----END PUBLIC KEY-----`;
  const message = 'POST\n/v3/pay/transactions/native\n1234567890\nnonce\n{}\n';
  const signature = await rsaSign(privatePem, message);
  assert.equal(await rsaVerify(publicPem, message, signature), true);
  assert.equal(await rsaVerify(publicPem, `${message}tampered`, signature), false);
  assert.equal(await rsaVerify(publicPem, message, 'invalid signature'), false);
});

test('WeChat resource decryption authenticates APIv3 key, nonce, and associated data', async () => {
  const apiV3Key = '0123456789abcdef0123456789abcdef';
  const nonce = '0123456789ab';
  const associatedData = 'transaction';
  const payload = { trade_state: 'SUCCESS', amount: { total: 100, currency: 'CNY' } };
  const aesKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(apiV3Key), 'AES-GCM', false, ['encrypt']);
  const ciphertext = bytesToBase64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new TextEncoder().encode(nonce), additionalData: new TextEncoder().encode(associatedData), tagLength: 128 }, aesKey, new TextEncoder().encode(JSON.stringify(payload)))));
  const resource = { algorithm: 'AEAD_AES_256_GCM', nonce, associated_data: associatedData, ciphertext };
  assert.deepEqual(await decryptResource(apiV3Key, resource), payload);
  await assert.rejects(decryptResource(apiV3Key, { ...resource, associated_data: 'changed' }));
  await assert.rejects(decryptResource(apiV3Key, { ...resource, algorithm: 'AES-CBC' }));
});
