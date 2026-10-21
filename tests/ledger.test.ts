import assert from 'node:assert/strict';
import test from 'node:test';
import { adminOrder, OrderLedger } from '../src/ledger.js';
import { orderPath } from '../src/service.js';
import { HttpError, type Order } from '../src/types.js';

const secret='fixture-ledger-cursor-secret'.repeat(3);
function order(id:string,extra:Partial<Order>={}):Order {
  return {version:1,id,clientId:'product-one',clientName:'历史产品',merchantOrderId:`business-${id}`,sku:'year',quantity:1,description:'年度会员',total:12900,currency:'CNY',appId:'wx0123456789abcdef',channel:'native',status:'PENDING',createdAt:'2026-10-01T12:00:00.000Z',expiresAt:'2026-10-01T12:15:00.000Z',requestHash:'SECRET_HASH',delivery:null,...extra};
}
class LedgerStore {
  values=new Map<string,Order>();
  reads=0;listings=0;
  constructor(orders:Order[]) {for (const value of orders) this.values.set(orderPath(value.id),value);}
  async read<T>(path:string):Promise<{value:T;sha:string}|null> {this.reads++;return this.values.has(path)?{value:structuredClone(this.values.get(path)) as T,sha:'a'.repeat(40)}:null;}
  async list(dir:string):Promise<Array<{name:string;path:string;type:'file'|'dir'}>> {
    this.listings++;
    const entries=new Map<string,{name:string;path:string;type:'file'|'dir'}>();
    for (const path of this.values.keys()) {
      if (!path.startsWith(dir+'/')) continue;
      const rest=path.slice(dir.length+1),name=rest.split('/')[0];
      entries.set(name,{name,path:dir+'/'+name,type:rest.includes('/')?'dir':'file'});
    }
    return [...entries.values()].reverse(); // GitHub order is not a stable pagination contract.
  }
}
function rejected(code:string) {return (error:unknown)=>error instanceof HttpError && error.status===400 && error.code===code;}

test('permanent historical orders paginate without work-index entries, duplicates, or missing records',async()=>{
  const orders=Array.from({length:47},(_,i)=>order(i.toString(16).padStart(32,'0')));
  const store=new LedgerStore(orders),ledger=new OrderLedger(store,secret),seen:string[]=[];
  let cursor:string|null=null,pages=0;
  do {
    const params=new URLSearchParams({limit:'7'});if (cursor) params.set('cursor',cursor);
    const result=await ledger.list('orders',params) as {orders:Array<{id:string}>;nextCursor:string|null;hasMore:boolean;scanned:number};
    seen.push(...result.orders.map(value=>value.id));
    assert.equal(result.hasMore,result.nextCursor!==null);assert.ok(result.scanned<=20);
    cursor=result.nextCursor;pages++;
  }while(cursor);
  assert.equal(pages,7);assert.deepEqual(seen,orders.map(value=>value.id));assert.equal(new Set(seen).size,orders.length);
});

test('filtered pages expose continuation even when no result matches the bounded scan',async()=>{
  const values=Array.from({length:25},(_,i)=>order(i.toString(16).padStart(32,'0'),i===24?{status:'SUCCESS',transactionId:'420000000000000000000024',paidAt:'2026-10-03T02:00:00.000Z',delivery:{status:'manual',attempts:20,nextAt:'2026-10-03T03:00:00.000Z'}}:{}));
  const store=new LedgerStore(values),ledger=new OrderLedger(store,secret),params=new URLSearchParams({status:'SUCCESS',deliveryStatus:'manual'});
  const first=await ledger.list('orders',params) as {orders:unknown[];scanned:number;hasMore:boolean;nextCursor:string};
  assert.deepEqual(first.orders,[]);assert.equal(first.scanned,20);assert.equal(first.hasMore,true);assert.equal(store.reads,20);
  params.set('cursor',first.nextCursor);
  const second=await ledger.list('orders',params) as {orders:Array<{id:string}>;hasMore:boolean};
  assert.deepEqual(second.orders.map(value=>value.id),[values[24].id]);assert.equal(second.hasMore,false);
});

test('directory traversal is bounded and continuation crosses empty matching batches',async()=>{
  const values=Array.from({length:21},(_,i)=>order(i.toString(16).padStart(2,'0')+'0'.repeat(30)));
  const store=new LedgerStore(values),ledger=new OrderLedger(store,secret);
  const params=new URLSearchParams({query:'never-match'});
  let cursor:string|null=null,total=0,pages=0;
  do {
    if (cursor) params.set('cursor',cursor);
    const before=store.listings;
    const result=await ledger.list('orders',params) as {orders:unknown[];scanned:number;nextCursor:string|null};
    assert.ok(store.listings-before<=9);assert.deepEqual(result.orders,[]);
    total+=result.scanned;cursor=result.nextCursor;pages++;
  }while(cursor);
  assert.equal(total,21);assert.equal(pages,3);
});

test('order dates use creation time while payment dates use settlement time and include entire selected end date',async()=>{
  const paid=order('0'.repeat(32),{status:'SUCCESS',clientId:'other-product',paidAt:'2026-10-03T15:59:59.999Z',transactionId:'420000000000000000000001'});
  const unpaid=order('0'.repeat(31)+'1',{createdAt:'2026-10-03T15:00:00.000Z'});
  const ledger=new OrderLedger(new LedgerStore([paid,unpaid]),secret);
  const range={from:'2026-10-03',to:'2026-10-03'};
  const orders=await ledger.list('orders',new URLSearchParams(range)) as {orders:Array<{id:string}>};
  const payments=await ledger.list('payments',new URLSearchParams({...range,clientId:'other-product',query:'0000000000000000000001'})) as {payments:Array<{id:string}>};
  assert.deepEqual(orders.orders.map(value=>value.id),[unpaid.id]);assert.deepEqual(payments.payments.map(value=>value.id),[paid.id]);
  const empty=await ledger.list('orders',new URLSearchParams({deliveryStatus:'delivered'})) as {orders:unknown[]};assert.deepEqual(empty.orders,[]);
  const noDelivery=await ledger.list('orders',new URLSearchParams({deliveryStatus:'none'})) as {orders:unknown[]};assert.equal(noDelivery.orders.length,2);
});

test('date-only ranges follow China business days across UTC midnight and ISO offsets preserve exact instants',async()=>{
  const dates=['2026-10-02T15:59:59.999Z','2026-10-02T16:00:00.000Z','2026-10-03T15:59:59.999Z','2026-10-03T16:00:00.000Z'];
  const values=dates.map((createdAt,index)=>order(index.toString(16).padStart(32,'0'),{createdAt,status:'SUCCESS',paidAt:createdAt}));
  const ledger=new OrderLedger(new LedgerStore(values),secret);
  for (const kind of ['orders','payments'] as const) {
    const result=await ledger.list(kind,new URLSearchParams({from:'2026-10-03',to:'2026-10-03'})) as Record<typeof kind,Array<{id:string}>>;
    assert.deepEqual(result[kind].map(value=>value.id),[values[1].id,values[2].id]);
    const explicit=await ledger.list(kind,new URLSearchParams({from:'2026-10-03T00:00:00+08:00',to:'2026-10-03T15:59:59.999Z'})) as Record<typeof kind,Array<{id:string}>>;
    assert.deepEqual(explicit[kind].map(value=>value.id),[values[1].id,values[2].id]);
  }
});

test('filter validation and signed cursors prevent arbitrary paths, tampering, and filter changes',async()=>{
  const ledger=new OrderLedger(new LedgerStore([order('0'.repeat(32)),order('0'.repeat(31)+'1')]),secret);
  for (const params of ['limit=0','limit=21','limit=Infinity','limit=1.5','limit=01','limit=1&limit=2','status=REFUNDED','clientId=../secrets','deliveryStatus=unknown','from=2026-02-30','from=2026-02-30T12%3A00%3A00Z','to=garbage','from=2026-10-10&to=2026-10-01','unknown=1']) {
    await assert.rejects(ledger.list('orders',new URLSearchParams(params)),rejected('LEDGER_FILTER_INVALID'));
  }
  const first=await ledger.list('orders',new URLSearchParams({limit:'1'})) as {nextCursor:string};
  for (const cursor of ['../secret',first.nextCursor.slice(0,-1)+(first.nextCursor.endsWith('a')?'b':'a')]) await assert.rejects(ledger.list('orders',new URLSearchParams({cursor})),rejected('LEDGER_CURSOR_INVALID'));
  await assert.rejects(ledger.list('orders',new URLSearchParams({cursor:first.nextCursor,query:'different'})),rejected('LEDGER_CURSOR_INVALID'));
  await assert.rejects(ledger.list('payments',new URLSearchParams({cursor:first.nextCursor})),rejected('LEDGER_CURSOR_INVALID'));
});

test('safe order projection strips payment tokens and customer identifiers including unknown nested fields',()=>{
  const value=order('a'.repeat(32),{payerOpenid:'SECRET_OPENID',clientIp:'SECRET_IP',returnUrl:'https://example.com/#SECRET_RETURN',payment:{channel:'native',codeUrl:'weixin://SECRET_PAYMENT'},closeRequested:{at:'2026-10-01T12:10:00.000Z',source:'admin',actor:'admin@example.com',reason:'人工关单'},history:[{id:'event-id',at:'2026-10-01T12:10:00.000Z',type:'admin_close',actor:'admin@example.com',reason:'人工关单',secret:'SECRET_EVENT'} as never],delivery:{status:'pending',attempts:2,nextAt:'2026-10-01T12:12:00.000Z',secret:'SECRET_DELIVERY'} as never});
  const projected=adminOrder(value),serialized=JSON.stringify(projected);
  for (const marker of ['SECRET_HASH','SECRET_OPENID','SECRET_IP','SECRET_RETURN','SECRET_PAYMENT','SECRET_EVENT','SECRET_DELIVERY']) assert.equal(serialized.includes(marker),false);
  assert.equal(projected.expiresAt,'2026-10-01T12:05:00.000Z');assert.equal((projected.closeRequested as {actor:string}).actor,'admin@example.com');
  assert.equal(adminOrder({...value,channel:'h5'}).expiresAt,'2026-10-01T12:05:00.000Z');
});

test('missing order IDs and storage corruption do not become fabricated ledger entries',async()=>{
  const store=new LedgerStore([]),ledger=new OrderLedger(store,secret);
  for (const id of ['../secrets','a'.repeat(32)]) await assert.rejects(ledger.read(id),(error:unknown)=>error instanceof HttpError && error.status===404);
  store.values.set(orderPath('a'.repeat(32)),order('b'.repeat(32)));
  await assert.rejects(ledger.read('a'.repeat(32)),(error:unknown)=>error instanceof HttpError && error.code==='LEDGER_RECORD_INVALID');
});
