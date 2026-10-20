# 产品接入

每个产品注册独立 `clientId`、API 密钥和 Webhook 密钥。产品后端决定当前登录用户和待购权益，创建自身的待付款业务订单，再向支付中心下单。浏览器、桌面客户端和 APK 只获取该用户自己的收银台链接及付款状态，不能保存 API 密钥。

## 1. 在支付中心登记产品

推荐在 `https://paywc.bornforthis.cn/admin` 使用管理员邮箱/密码登录，直接复制通用 AI 接入 Skill，交给已经获得当前产品工作区、源码和部署权限的 AI。无需先手工登记产品：Skill 预留一个 `p-<随机值>` 产品 ID，并附带有效期 24 小时、仅能登记和修改该产品的 Bearer 授权。AI 检查当前产品，沿用已确认的名称、商品价格、域名、订单及开通流程，通过接入 API 完成支付中心登记，再修改产品代码。已有支付宝等支付流程默认保留。流程详见 [AI 接入说明](ai-integration.md)。

也可手工在后台新增产品，填写名称、固定 HTTPS Webhook、回跳来源、允许支付通道和商品价格。后台生成独立 API/Webhook 凭据，将完整配置加密保存到 GitHub `config/clients.json`。普通产品列表只显示掩码。已有产品的一键复制专属 Skill 包含其真实目录、协议、服务端密钥与该产品的限时接入授权，便于 AI 同时更新支付中心配置和产品代码。

**整份接入包属于秘密**，只在授权产品的私有开发会话中使用，不发布、不提交到仓库、不贴入公开工单或截图。AI 应将长期产品凭据写入该产品后端的 Secret/已忽略环境文件，再完成待购订单、真实 Webhook 事务和权益开通。复制说明不表示业务接入已完成。包内不包含商户私钥、APIv3 密钥、GitHub Token、管理员密码或目标产品的仓库/部署凭据；这些外部权限必须已由用户授权给目标 AI。

后台可在收款关闭时注册产品。产品凭据轮换会使旧 API/Webhook 密钥及该产品旧接入授权失效，先协调产品部署及尚未成功投递的通知。当前没有自动双密钥过渡协议。限时授权到期后需重新登录后台复制，不应保存在产品运行时。

### 限时接入 API

以下接口供接入 Skill 中的 AI 使用，Header 为 `Authorization: Bearer <该产品的限时token>`；不使用产品下单 HMAC，也不能用来管理其他产品。

| 接口 | 行为 |
|---|---|
| `GET /api/integration/clients/:id` | 读取当前授权产品；尚未登记时返回 404 |
| `PUT /api/integration/clients/:id` | 创建或更新同一产品；正文只含名称、固定 Webhook、回跳来源、允许通道及商品目录 |
| `GET /api/integration/clients/:id/skill` | 读取按最新配置生成的专属 Skill，包含真实 SKU 和该产品服务端凭据 |

PUT 请求示意（值必须来自目标产品现有确认配置，不能照抄示例价格）：

```json
{
  "name": "目标产品名称",
  "webhookUrl": "https://product.brclio.com/api/payments/wechat/webhook",
  "returnOrigins": ["https://product.brclio.com"],
  "channels": ["native"],
  "products": {
    "YOUR_CONFIRMED_SKU": {
      "description": "已确认的商品说明",
      "amount": 100,
      "maxQuantity": 1
    }
  }
}
```

读取结果包括 `{client, credentials:{clientId,apiKey,webhookSecret}, channels, expiresAt}`，其中 `client` 是不直接展示秘密的配置。限时授权固定产品 ID，不能改 ID、访问其他产品、修改全局商户配置、轮换凭据或操作退款。长期产品 API 密钥只用于后续签名下单/查单，不能代替限时接入 token 管理目录。

管理员登录会话使用 `GET /api/admin/bootstrap-skill` 取得通用包，结果为 `{filename:'SKILL.md', content, expiresAt}`；`GET /api/admin/clients/:id/skill` 为已有产品生成专属包。管理员 Cookie/密码不应交给目标 AI，也不需要目标 AI再登录管理后台。

兼容原有部署的 `CLIENTS_JSON` 是可选后备配置，格式为以下对象的数组，作为 Cloudflare Secret 保存。后台同 ID 配置优先于后备配置；新产品无需编辑该变量。下面密钥均为占位符，不能直接启用；商品与价格需由商家确认后登记。

```json
[
  {
    "id": "brclio",
    "name": "Brclio",
    "apiKey": "REPLACE_WITH_INDEPENDENT_RANDOM_API_KEY_AT_LEAST_32_BYTES",
    "webhookSecret": "REPLACE_WITH_ANOTHER_RANDOM_WEBHOOK_KEY_AT_LEAST_32_BYTES",
    "webhookUrl": "https://brclio.com/api/payments/wechat/webhook",
    "returnOrigins": ["https://brclio.com", "https://*.brclio.com"],
    "channels": ["native"],
    "products": {
      "REPLACE_WITH_REAL_SKU": {
        "description": "REPLACE_WITH_REAL_DESCRIPTION",
        "amount": 100,
        "maxQuantity": 1
      }
    }
  }
]
```

`amount` 单位是人民币分，必须为正整数。服务端用商品单价 × 数量计算订单金额，不接受前端传入价格。`maxQuantity` 未设置时为 1。`webhookUrl` 是管理员登记的固定公网 HTTPS 地址，不允许下单时任意传入。`returnOrigins` 仅控制完成后的页面返回地址，不代表该域名获得微信 H5/JSAPI 授权。通配符 `https://*.brclio.com` 不包含根域名，需单独登记 `https://brclio.com`。

## 2. 产品后端创建订单

将 `examples/brclio-pay.mjs` 复制到产品服务端项目；需要 Node.js 22 或更新版本，无额外依赖。

```js
import { BrclioPayClient } from './brclio-pay.mjs';

const pay = new BrclioPayClient({
  baseUrl: process.env.BRCLIO_PAY_BASE_URL, // https://paywc.bornforthis.cn
  clientId: process.env.BRCLIO_PAY_CLIENT_ID,
  apiKey: process.env.BRCLIO_PAY_API_KEY,
});

// 必须先在自己的数据库中持久化 pendingPurchase，关联已登录用户、
// SKU、数量、预期金额和币种。id 由服务端生成，不能复用到另一笔购买。
const order = await pay.createOrder({
  merchantOrderId: pendingPurchase.id,
  sku: pendingPurchase.sku,
  quantity: pendingPurchase.quantity,
  channel: 'native',
  returnUrl: 'https://brclio.com/account/billing',
});
// 持久化 pendingPurchase 与 order.id 的对应关系。
// 然后只向该用户返回 order.checkoutUrl；不要记录链接中的 fragment token。
```

下单接口：`POST /api/v1/orders`。请求字段：

| 字段 | 用途 |
|---|---|
| `merchantOrderId` | 产品后端唯一业务订单号，最长 96 字符，允许字母、数字及 `._:-`，首字符为字母或数字 |
| `sku` | 支付中心已登记的商品代码 |
| `quantity` | 正整数，默认 1，不超过商品的 `maxQuantity` |
| `channel` | `native`、`h5`、`jsapi` 或 `app`；必须同时在全局和产品配置中启用 |
| `returnUrl` | 可选；已登记 HTTPS 来源下的回跳页，不能包含 fragment |
| `payerOpenid` | 仅 JSAPI/小程序需要，必须来自该支付 AppID；由可信后端获取 |
| `clientIp` | 仅 H5 需要，由可信产品后端提供真实用户 IPv4/IPv6；不要信任客户端自报 IP |

成功应答直接返回订单对象，包含 `id`、`status`、`amount:{total,currency}`、`merchantOrderId`、`sku`、`quantity`、`checkoutUrl`、`expiresAt` 等字段。待付款时 `payment` 还包含通道参数，例如 `codeUrl`、`h5Url`、`jsapi` 或 `app`。收银台链接通过 URL fragment 携带访问令牌，收银台调用 `GET /api/checkout/:id` 时把令牌放入 Bearer Header；不要将令牌改成查询参数或业务日志。

同一 `clientId + merchantOrderId` 映射到同一支付订单。网络超时可以使用原业务订单号和原请求重试，SDK 会重新生成请求时间戳与 nonce。若 SKU、数量、通道、返回地址等不可变信息改变，会返回 `409 IDEMPOTENCY_CONFLICT`；商品目录价格变更也可能使旧请求冲突。用户明确重新购买时创建新的业务订单号。不要承诺“恰好一次通知”。

## 3. 服务端查询与刷新

```js
const saved = await pay.getOrder(paymentOrderId);
const refreshed = await pay.refreshOrder(paymentOrderId);
```

`GET /api/v1/orders/:id` 读取已持久化的订单；`POST /api/v1/orders/:id/refresh` 主动向微信查询并校验结果。均需要本产品签名，不能查询其他产品订单。刷新会受服务端查询间隔限制，避免连续点击形成微信/GitHub 请求风暴。`SUCCESS` 只代表付款确认；业务权益是否开通，由产品的数据库事务确认。`deliveryStatus=delivered` 代表 Webhook 接收端已返回 2xx，因此接收端必须在权益事务提交后才应答。

`POST /api/v1/orders/:id/retry-notification` 用相同产品签名重试尚未成功送达的已付款通知；已成功送达的通知不会因此重新发送。它可用于修复 Webhook 后的受控补投，不能代替产品自身对账。

页面回跳、`postMessage`、WeixinJSBridge 回调、Android SDK 回调只能提示“正在确认付款”。产品应查询自己的后端状态；不能根据 URL 的 `success=true`、用户传入订单 ID 或前端回调直接开通。

## 4. 验证支付通知并事务性开通

支付中心向固定 `webhookUrl` 发送原始 JSON：

```json
{
  "eventId": "payment.success.PAYMENT_ORDER_ID",
  "type": "payment.success",
  "orderId": "PAYMENT_ORDER_ID",
  "clientId": "brclio",
  "merchantOrderId": "YOUR_PENDING_PURCHASE_ID",
  "sku": "YOUR_REGISTERED_SKU",
  "quantity": 1,
  "total": 100,
  "currency": "CNY",
  "transactionId": "WECHAT_TRANSACTION_ID",
  "paidAt": "2026-10-20T12:00:00+08:00"
}
```

必须在任何 JSON 解析、中间件重排字段之前取得原始请求字节，再验签：

```js
import { verifyWebhook } from './brclio-pay.mjs';

const event = verifyWebhook({
  rawBody, // Buffer/Uint8Array，或未经修改的 UTF-8 原文
  headers: request.headers,
  webhookSecret: process.env.BRCLIO_PAY_WEBHOOK_SECRET,
  expectedClientId: process.env.BRCLIO_PAY_CLIENT_ID,
});
await fulfillInTransaction(event); // 下面的持久化合同必须由产品实现
// 仅在事务成功提交后返回 204；已处理的重复事件也返回 204。
```

`fulfillInTransaction` 的业务合同（以下为伪代码，不是已接好的数据库实现）：

```text
BEGIN TRANSACTION
  使用 merchantOrderId 锁定自己数据库中的待购订单
  从该订单读取 userId，绝不从回调或当前浏览器取开通对象
  校验 clientId、已绑定的支付 orderId、SKU、quantity、total、currency
  如支付订单关联尚未写回，使用自己的唯一 merchantOrderId 对照验证，
    再在同一事务中绑定支付 orderId；不得凭回调任意创建购买
  查询 eventId / payment orderId / transactionId 的唯一付款记录
  已处理且内容一致：提交并返回 duplicate
  已处理但金额或订单冲突：回滚，拒绝并告警
  校验待购状态可开通
  插入带 UNIQUE eventId 和唯一 payment orderId 的付款记录
  为锁定订单所属 userId 开通对应权益
  更新待购订单状态为 fulfilled
COMMIT
返回 fulfilled
```

必须使用能原子提交“事件去重 + 付款记录 + 权益开通”的持久化业务存储；内存 Set、进程变量、客户端存储无法保证重启和并发时的幂等。SDK 验签本身不提供去重或开通。定时补偿任务也要调用相同的事务入口：先用 `refreshOrder` 获取支付中心可信状态，核对商品及金额，再开通，不能绕过去重。

可运行的 HTTP 接收器在 `examples/webhook-server.mjs`。它要求显式提供导出 `fulfillInTransaction(event)` 的真实业务适配模块；没有适配器会拒绝启动。适配函数仅在事务提交后返回 `{status:'fulfilled'}` 或 `{status:'duplicate'}`。启动时将密钥通过现有安全环境注入，不写入命令行：

```sh
node examples/webhook-server.mjs
```

所需环境变量为 `BRCLIO_PAY_CLIENT_ID`、`BRCLIO_PAY_WEBHOOK_SECRET`、`FULFILLMENT_ADAPTER_MODULE`（模块路径），可选 `PORT`。示例只绑定 loopback，生产需由产品自己的 HTTPS 服务反向代理。收到 2xx 即视为投递完成，不能“先返回成功，稍后再尝试开通”。付款中心对失败投递做重试，超出重试次数会进入人工处理状态；产品仍需主动对账补偿。

## 5. 非 Node.js 产品的签名协议

所有调用均使用 UTF-8；签名为小写十六进制 HMAC-SHA256。时间戳为 Unix 秒，允许与服务器相差 300 秒；nonce 建议 16 字节安全随机数编码为 32 位 hex。Header：

```text
X-Brclio-Client: <clientId>
X-Brclio-Timestamp: <timestamp>
X-Brclio-Nonce: <nonce>
X-Brclio-Signature: <signature>
```

API 请求签名串：

```text
UPPERCASE_HTTP_METHOD + "\n" +
URL_PATH_AND_QUERY + "\n" +
TIMESTAMP + "\n" +
NONCE + "\n" +
EXACT_RAW_REQUEST_BODY + "\n"
```

密钥为产品 `apiKey`。无请求体的 GET/刷新 POST 使用空字符串，仍保留最后换行。路径包含原始 query，不能先 decode 或重排序。5 分钟内相同签名可重放，因此创建订单必须依赖业务订单幂等；时间戳与 nonce 不构成“恰好一次”执行保证。

业务 Webhook 签名串：

```text
TIMESTAMP + "\n" + NONCE + "\n" + EXACT_RAW_JSON_BODY + "\n"
```

密钥为该产品 `webhookSecret`。另有 `X-Brclio-Event`，必须等于正文 `eventId`，并等于 `payment.success.<orderId>`。使用恒定时间比较签名。每次重试时间戳、nonce 和签名会变化，稳定的 `eventId` 用于持久化去重。验签通过后还要校验时间、字段和待购订单，不能只检查签名。

商品配置在 Worker 实例间可能需要约 15 秒传播。产品后端下单应携带可选 `expectedTotal`（该业务订单预期的人民币整数分金额），中心仅用它校验服务端目录价格，无法用该字段改变价格；不匹配返回 `409 CATALOG_PRICE_CHANGED` 且不创建订单，避免配置传播期间按错误价格付款。返回金额也应与产品业务订单核对后再展示收银台。
