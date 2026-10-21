import { constantTimeEqual, hmac, sha256 } from './crypto';
import { orderExpiresAt, orderPath, validId, type OrderStore } from './service';
import { HttpError, type Order, type OrderEvent, type OrderStatus } from './types';

type LedgerStore = Pick<OrderStore, 'read' | 'list'>;
type LedgerKind = 'orders' | 'payments';
interface Filters { clientId:string; status:string; deliveryStatus:string; query:string; from:number|null; to:number|null }
interface Cursor { v:1; bucket:string; after:string; filter:string }
const SCAN_LIMIT=20, BUCKET_LIMIT=8;
const statuses:OrderStatus[]=['CREATING','PENDING','SUCCESS','CLOSED','PAYERROR'];
const invalid=()=>new HttpError(400,'LEDGER_FILTER_INVALID','请检查订单筛选条件、时间范围和每页数量（1 至 20）');
const invalidCursor=()=>new HttpError(400,'LEDGER_CURSOR_INVALID','分页凭证已失效，请重新查询');

function dateFilter(value:string|null,end:boolean):number|null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) throw invalid();
  const calendarDay=value.slice(0,10),calendarDate=Date.parse(calendarDay+'T00:00:00.000Z');
  if (!Number.isFinite(calendarDate) || new Date(calendarDate).toISOString().slice(0,10)!==calendarDay) throw invalid();
  // Date controls describe the merchant's China business day. Explicit ISO offsets retain their exact instant.
  const date=Date.parse(value.length===10?value+'T00:00:00+08:00':value);
  if (!Number.isFinite(date)) throw invalid();
  return date+(end && value.length===10?86400000-1:0);
}
function filters(params:URLSearchParams):{value:Filters;limit:number} {
  for (const key of params.keys()) if (!['clientId','status','deliveryStatus','query','from','to','cursor','limit'].includes(key) || params.getAll(key).length!==1) throw invalid();
  const value:Filters={clientId:params.get('clientId')||'',status:params.get('status')||'',deliveryStatus:params.get('deliveryStatus')||'',query:(params.get('query')||'').trim().toLowerCase(),from:dateFilter(params.get('from'),false),to:dateFilter(params.get('to'),true)};
  const rawLimit=params.get('limit')||'20',limit=Number(rawLimit);
  if ((value.clientId && !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(value.clientId)) || (value.status && !statuses.includes(value.status as OrderStatus)) || (value.deliveryStatus && !['pending','delivered','manual','none'].includes(value.deliveryStatus)) || value.query.length>128 || /[\u0000-\u001f\u007f]/.test(value.query) || (value.from!==null && value.to!==null && value.from>value.to) || !/^(?:[1-9]|1[0-9]|20)$/.test(rawLimit) || !Number.isInteger(limit) || limit<1 || limit>20) throw invalid();
  return {value,limit};
}
function matches(order:Order,filter:Filters,kind:LedgerKind):boolean {
  if (kind==='payments' && order.status!=='SUCCESS') return false;
  if (filter.clientId && order.clientId!==filter.clientId) return false;
  if (filter.status && order.status!==filter.status) return false;
  if (filter.deliveryStatus && (order.delivery?.status||'none')!==filter.deliveryStatus) return false;
  const date=Date.parse(kind==='payments'?order.paidAt||'':order.createdAt);
  if ((filter.from!==null && (!Number.isFinite(date) || date<filter.from)) || (filter.to!==null && (!Number.isFinite(date) || date>filter.to))) return false;
  if (filter.query && ![order.id,order.clientId,order.clientName,order.merchantOrderId,order.sku,order.description,order.transactionId].some(value=>typeof value==='string' && value.toLowerCase().includes(filter.query))) return false;
  return true;
}
function safeEvent(entry:OrderEvent):OrderEvent {
  return {id:entry.id,at:entry.at,type:entry.type,...(entry.actor!==undefined?{actor:entry.actor}:{}),...(entry.reason!==undefined?{reason:entry.reason}:{}),...(entry.fromStatus!==undefined?{fromStatus:entry.fromStatus}:{}),...(entry.toStatus!==undefined?{toStatus:entry.toStatus}:{}),...(entry.outcome!==undefined?{outcome:entry.outcome}:{}),...(entry.code!==undefined?{code:entry.code}:{})};
}
/** All admin order responses use this allowlist; payment credentials and customer identifiers never leave storage. */
export function adminOrder(order:Order):Record<string,unknown> {
  const delivery=order.delivery;
  const close=order.closeRequested;
  return {
    id:order.id,clientId:order.clientId,clientName:order.clientName,merchantOrderId:order.merchantOrderId,
    sku:order.sku,quantity:order.quantity,description:order.description,total:order.total,currency:order.currency,
    channel:order.channel,status:order.status,createdAt:order.createdAt,expiresAt:orderExpiresAt(order),
    transactionId:order.transactionId,paidAt:order.paidAt,updatedAt:order.updatedAt,lastQueryAt:order.lastQueryAt,
    closedAt:order.closedAt,closeReason:order.closeReason,
    closeRequested:close?{at:close.at,source:close.source,actor:close.actor,reason:close.reason}:undefined,
    delivery:delivery?{status:delivery.status,attempts:delivery.attempts,nextAt:delivery.nextAt,deliveredAt:delivery.deliveredAt}:null,
    history:(order.history||[]).map(safeEvent),
  };
}

/** Scans permanent hashed order files, including records created before the ledger existed.
 * Results are ordered by ID, not date. Both file reads and directory reads are bounded.
 * A sparse/empty page is not the end: callers must follow nextCursor until hasMore=false.
 */
export class OrderLedger {
  constructor(private store:LedgerStore,private cursorSecret:string) {}
  async read(id:string):Promise<Order> {
    if (!validId(id)) throw new HttpError(404,'ORDER_NOT_FOUND','未找到该订单');
    const stored=await this.store.read<Order>(orderPath(id));
    if (!stored) throw new HttpError(404,'ORDER_NOT_FOUND','未找到该订单');
    if (stored.value.version!==1 || stored.value.id!==id) throw new HttpError(503,'LEDGER_RECORD_INVALID','订单记录读取失败');
    return stored.value;
  }
  async list(kind:LedgerKind,params:URLSearchParams):Promise<Record<string,unknown>> {
    const {value:filter,limit}=filters(params),fingerprint=await sha256(JSON.stringify({kind,...filter}));
    let position:Cursor={v:1,bucket:'00',after:'',filter:fingerprint};
    const rawCursor=params.get('cursor');
    if (rawCursor) position=await this.decodeCursor(rawCursor,fingerprint);
    // At most 256 buckets exist. GithubStore fails explicitly if Contents returns its 1,000-entry cap.
    const buckets=(await this.store.list('orders')).filter(entry=>entry.type==='dir' && /^[a-f0-9]{2}$/.test(entry.name)).map(entry=>entry.name).sort().filter(bucket=>bucket>=position.bucket);
    const records:Record<string,unknown>[]=[];
    let scanned=0,bucketReads=0,next:Cursor|null=null;
    outer: for (let bucketIndex=0;bucketIndex<buckets.length;bucketIndex++) {
      const bucket=buckets[bucketIndex];
      if (bucketReads>=BUCKET_LIMIT) {next={v:1,bucket,after:'',filter:fingerprint};break;}
      bucketReads++;
      const entries=(await this.store.list(`orders/${bucket}`)).filter(entry=>entry.type==='file' && /^[a-f0-9]{32}\.json$/.test(entry.name) && entry.name.startsWith(bucket)).map(entry=>entry.name.slice(0,-5)).sort().filter(id=>bucket!==position.bucket || id>position.after);
      for (let index=0;index<entries.length;index++) {
        const id=entries[index];
        const order=await this.read(id);scanned++;
        if (matches(order,filter,kind)) records.push(adminOrder(order));
        if (scanned>=SCAN_LIMIT || records.length>=limit) {
          if (index+1<entries.length) next={v:1,bucket,after:id,filter:fingerprint};
          else if (bucketIndex+1<buckets.length) next={v:1,bucket:buckets[bucketIndex+1],after:'',filter:fingerprint};
          break outer;
        }
      }
    }
    return {[kind]:records,nextCursor:next?await this.encodeCursor(next):null,scanned,hasMore:next!==null,sort:'id-asc',scanLimit:SCAN_LIMIT};
  }
  private async encodeCursor(value:Cursor):Promise<string> {
    const payload=btoa(JSON.stringify(value)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    return payload+'.'+await hmac(this.cursorSecret,`ledger:${payload}`);
  }
  private async decodeCursor(raw:string,filter:string):Promise<Cursor> {
    if (raw.length>1024 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(raw)) throw invalidCursor();
    const [payload,signature]=raw.split('.');
    if (!constantTimeEqual(await hmac(this.cursorSecret,`ledger:${payload}`),signature)) throw invalidCursor();
    try {
      const value:Cursor=JSON.parse(atob(payload.replace(/-/g,'+').replace(/_/g,'/')));
      if (value.v!==1 || !/^[a-f0-9]{2}$/.test(value.bucket) || typeof value.after!=='string' || (value.after!=='' && (!validId(value.after) || !value.after.startsWith(value.bucket))) || value.filter!==filter) throw Error();
      return value;
    } catch {throw invalidCursor();}
  }
}
