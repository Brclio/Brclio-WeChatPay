export type Channel = 'native' | 'h5' | 'jsapi' | 'app';
export type OrderStatus = 'CREATING' | 'PENDING' | 'SUCCESS' | 'CLOSED' | 'PAYERROR';
export interface Product { description: string; amount: number; maxQuantity?: number }
export interface Client {
  id: string; name: string; apiKey: string; webhookSecret: string;
  webhookUrl: string; returnOrigins: string[]; channels: Channel[];
  products: Record<string, Product>; disabled?: boolean; lastUpdated?: string;
}
export interface Env {
  ASSETS: Fetcher; AUTH_RATE_LIMITER?: RateLimit;
  ADMIN_EMAIL?: string; ADMIN_PASSWORD_HASH?: string; ADMIN_SESSION_SECRET?: string;
  PAYMENT_MODE?: string; PAYMENT_ENABLED?: string; PUBLIC_BASE_URL: string;
  GITHUB_DATA_REPO: string; GITHUB_DATA_BRANCH?: string; GITHUB_TOKEN?: string;
  ENCRYPTION_KEY?: string; ORDER_ID_SECRET?: string; CHECKOUT_SECRET?: string; CLIENTS_JSON?: string;
  WECHAT_MCH_ID?: string; WECHAT_APP_ID?: string; WECHAT_JSAPI_APP_ID?: string;
  WECHAT_JSAPI_CONTEXT?: 'web' | 'miniprogram'; WECHAT_APP_APP_ID?: string;
  WECHAT_SERIAL_NO?: string; WECHAT_PRIVATE_KEY?: string; WECHAT_API_V3_KEY?: string;
  WECHAT_PUBLIC_KEYS_JSON?: string; WECHAT_PUBLIC_KEY_ID?: string; ENABLED_CHANNELS?: string; ALLOWED_ORIGINS?: string;
  ORDER_TTL_MINUTES?: string;
}
export interface Payment {
  channel: Channel; codeUrl?: string; h5Url?: string;
  jsapi?: { appId:string; timeStamp:string; nonceStr:string; package:string; signType:'RSA'; paySign:string };
  context?: 'web' | 'miniprogram';
  app?: { appid:string; partnerid:string; prepayid:string; package:string; noncestr:string; timestamp:string; sign:string };
}
export interface Order {
  version: 1; id: string; clientId: string; clientName: string; merchantOrderId: string;
  sku: string; quantity: number; description: string; total: number; currency: 'CNY';
  appId: string; channel: Channel; status: OrderStatus; createdAt: string; expiresAt: string;
  returnUrl?: string; payerOpenid?: string; clientIp?: string;
  payment?: Payment; requestHash: string; transactionId?: string; paidAt?: string;
  lastQueryAt?: string; queryLeaseUntil?: string;
  delivery: { status: 'pending' | 'delivered' | 'manual'; attempts: number; nextAt: string; deliveredAt?: string; leaseUntil?: string } | null;
}
export interface WechatTransaction {
  appid: string; mchid: string; out_trade_no: string; transaction_id?: string;
  trade_state: 'SUCCESS' | 'REFUND' | 'NOTPAY' | 'CLOSED' | 'REVOKED' | 'USERPAYING' | 'PAYERROR';
  trade_type?: string; success_time?: string; amount: { total:number; currency?:string };
}
export class HttpError extends Error {
  constructor(public status:number, public code:string, message:string) { super(message); this.name='HttpError'; }
}
