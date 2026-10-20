import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { verifyWebhook } from './brclio-pay.mjs';

/**
 * Adapter contract: fulfillInTransaction(event) MUST open a durable transaction,
 * lock the application's pending purchase, validate its user/SKU/quantity/amount,
 * insert a UNIQUE eventId and grant the entitlement atomically. It returns
 * {status:'fulfilled'} or {status:'duplicate'} only after committing.
 * Never implement this with a Set, an in-memory Map, or a JSON file.
 */
export function createWebhookServer({ clientId, webhookSecret, fulfillInTransaction }) {
  if (!clientId || !webhookSecret || typeof fulfillInTransaction !== 'function') throw new TypeError('A real transactional fulfillment adapter and webhook credentials are required');
  return createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/api/payments/wechat/webhook') {
      response.writeHead(404).end(); return;
    }
    let rawBody;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65_536) { response.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      rawBody = Buffer.concat(chunks);
    } catch { response.writeHead(400).end(); return; }
    let event;
    try { event = verifyWebhook({ rawBody, headers: request.headers, webhookSecret, expectedClientId: clientId }); }
    catch { response.writeHead(401).end(); return; }
    try {
      const result = await fulfillInTransaction(event);
      if (!result || !['fulfilled', 'duplicate'].includes(result.status)) throw new Error('Adapter did not confirm a committed transaction');
      response.writeHead(204).end();
    } catch {
      // No success acknowledgment before the business transaction commits.
      // Do not log secrets, raw request bodies, or checkout URL tokens.
      response.writeHead(500).end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { BRCLIO_PAY_CLIENT_ID, BRCLIO_PAY_WEBHOOK_SECRET, FULFILLMENT_ADAPTER_MODULE } = process.env;
  if (!BRCLIO_PAY_CLIENT_ID || !BRCLIO_PAY_WEBHOOK_SECRET || !FULFILLMENT_ADAPTER_MODULE) {
    process.stderr.write('Set BRCLIO_PAY_CLIENT_ID, BRCLIO_PAY_WEBHOOK_SECRET, and FULFILLMENT_ADAPTER_MODULE. Implement the durable adapter described in docs/integration.md before starting.\n');
    process.exitCode = 1;
  } else {
    try {
      const adapter = await import(pathToFileURL(resolve(FULFILLMENT_ADAPTER_MODULE)).href);
      const server = createWebhookServer({ clientId: BRCLIO_PAY_CLIENT_ID, webhookSecret: BRCLIO_PAY_WEBHOOK_SECRET, fulfillInTransaction: adapter.fulfillInTransaction });
      const port = Number(process.env.PORT || 8788);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
      server.listen(port, '127.0.0.1', () => process.stdout.write('Webhook receiver listening on loopback. Publish through your HTTPS application proxy.\n'));
    } catch {
      process.stderr.write('Webhook receiver could not start. Check the adapter export and configuration.\n');
      process.exitCode = 1;
    }
  }
}
