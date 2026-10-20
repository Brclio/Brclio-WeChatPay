import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {BrclioPayClient,verifyWebhook} from '../examples/brclio-pay.mjs';
const apiKey='api-'.repeat(16),webhookSecret='hook-'.repeat(16);
test('portable SDK signs exactly the body and canonical LF bytes consumed by the service',async()=>{
  const client=new BrclioPayClient({baseUrl:'https://paywc.bornforthis.cn',clientId:'sdk-test',apiKey,fetchImpl:async(url,init)=>{
    const headers=new Headers(init.headers),parsed=new URL(url);
    const canonical=[init.method,parsed.pathname+parsed.search,headers.get('X-Brclio-Timestamp'),headers.get('X-Brclio-Nonce'),init.body||'',''].join(String.fromCharCode(10));
    assert.equal(headers.get('X-Brclio-Signature'),createHmac('sha256',apiKey).update(canonical).digest('hex'));
    return Response.json({id:'f'.repeat(32),status:'PENDING'});
  }});
  assert.equal((await client.createOrder({merchantOrderId:'sdk-1',sku:'monthly',channel:'native'})).status,'PENDING');
  await client.getOrder('f'.repeat(32));
  await client.refreshOrder('f'.repeat(32));
});
test('SDK verifies actual service-style callback bytes and rejects altered amount, timestamp, or product',()=>{
  const orderId='a'.repeat(32),eventId='payment.success.'+orderId,timestamp=String(Math.floor(Date.now()/1000)),nonce='e'.repeat(32);
  const event={eventId,type:'payment.success',orderId,clientId:'sdk-test',merchantOrderId:'business-1',sku:'monthly',quantity:1,total:1,currency:'CNY',transactionId:'420000000000000000000000001',paidAt:new Date().toISOString()};
  const rawBody=JSON.stringify(event);
  const signature=createHmac('sha256',webhookSecret).update([timestamp,nonce,rawBody,''].join(String.fromCharCode(10))).digest('hex');
  const headers={'X-Brclio-Timestamp':timestamp,'X-Brclio-Nonce':nonce,'X-Brclio-Event':eventId,'X-Brclio-Signature':signature};
  assert.deepEqual(verifyWebhook({rawBody,headers,webhookSecret,expectedClientId:'sdk-test'}),event);
  assert.throws(()=>verifyWebhook({rawBody:rawBody.replace('"total":1','"total":2'),headers,webhookSecret}));
  assert.throws(()=>verifyWebhook({rawBody,headers,webhookSecret,expectedClientId:'another-product'}));
  assert.throws(()=>verifyWebhook({rawBody,headers,webhookSecret,now:Number(timestamp)+301}));
});
