import type { Client } from './types';
export function integrationSkill(client:Client,baseUrl:string,access?:{token:string;expiresAt:string}):string {
  const environment={BRCLIO_PAY_BASE_URL:baseUrl,BRCLIO_PAY_CLIENT_ID:client.id,BRCLIO_PAY_API_KEY:client.apiKey,BRCLIO_PAY_WEBHOOK_SECRET:client.webhookSecret,...(access?{BRCLIO_PAY_INTEGRATION_TOKEN:access.token}:{})};
  return `---
name: brclio-pay-integration
description: 为已有产品接入 Brclio 微信支付，检测现有支付流程并兼容已有渠道，完成签名下单、验签通知和幂等权益开通。
---

# ${client.name} 接入 Brclio 微信支付

这是经账号登录取得的本产品接入包。包含本产品的服务端密钥；只在当前授权产品的服务端密钥配置中使用，禁止放入浏览器、Android/桌面安装包、公开代码、日志或截图。商户私钥、支付 APIv3 密钥、管理员凭据和 GitHub Token 不在本接入包内。

## 当前登记

- 支付中心：${baseUrl}
- 产品标识：${client.id}
- 固定支付结果回调：${client.webhookUrl}
- 支付渠道：${client.channels.join(', ')}
- 允许返回来源：${client.returnOrigins.join(', ')}
- 产品是否暂停新订单：${client.disabled?'是':'否'}

商品目录（金额单位为人民币分，不接受浏览器自报金额）：

${JSON.stringify(client.products,null,2)}
## 检测与兼容接入

先检查当前仓库的 AGENTS.md、框架、运行平台、登录会话、商品价格、订单存储、支付入口、现有微信/支付宝等支付适配器、webhook 和权益开通代码。告诉用户检测结果并按已授权范围直接完成必要的兼容修改。产品已有支付时，新增 Brclio 微信渠道，复用原订单与权益流程，保留原渠道、路由和历史订单；不改动其他站点或其他产品。若已有微信渠道，基于当前接口评估并完成适配，避免并行创建两笔收款。

没有可信后端的静态网站或纯客户端，需要增加最小后端处理认证、价格/用户绑定、签名下单、查单、验签及权益发放。产品 API 密钥不能进入客户端。前端以当前登录用户请求产品后端，产品后端先持久化待支付业务订单并绑定用户、SKU、数量、预期金额，再调用支付中心。merchantOrderId 必须唯一，重试使用同一订单号及完全相同的商品参数，不要因网络超时生成另一笔付款。

将以下配置写入当前产品的服务端 Secret/私有环境文件，并确保不被 Git 跟踪，不打印值：

${JSON.stringify(environment,null,2)}
${access?`## 支付中心的单产品接入管理权限

此临时管理授权截至 ${access.expiresAt}，只能读取/修改产品 ${client.id} 的名称、回调地址、返回来源、开放渠道和商品价格。目标项目的源码及部署操作仍须使用 AI 已有的工作区与用户授权，此 Skill 不会自动取得第三方账号权限。接入完成后移除临时管理 Token，常驻业务仅保留上面的四项支付配置。

以 Authorization: Bearer 加 BRCLIO_PAY_INTEGRATION_TOKEN 调用 GET ${baseUrl}/api/integration/clients/${client.id} 读取当前配置和本产品凭据。PUT 同一地址可更新 name、webhookUrl、returnOrigins、channels、products；商品目录按 SKU 新增或更新并保留其他 SKU；删除商品须由管理员在后台执行。保留不需修改的配置，不能改产品 ID、管理员暂停状态、其他产品或全局设置。商品按项目现有真实价格配置为整数人民币分，不自行编造或改变用户售价。管理令牌不可作为下单签名密钥，过期或撤销后须登录重新复制；产品密钥轮换会撤销旧授权。

`:''}## 服务端 API 协议

POST /api/v1/orders，JSON 字段：{merchantOrderId,sku,quantity:1,channel:'native',expectedTotal,returnUrl?}。jsapi 另需当前关联 AppID 下的 payerOpenid；h5 另需真实用户 clientIp。expectedTotal 由产品后端填写业务订单预期的整数分金额，仅用于校验，不能覆盖中心定价；配置传播期间价格不匹配时在下单前拒绝，不能展示金额不符的二维码。仅使用控制台登记、商户已开通的渠道。返回包含 id、status、checkoutUrl（含片段凭证）和 payment；先将返回的中心订单 id 持久化绑定到自己的业务订单，再将 checkoutUrl 交给用户浏览器或客户端打开，避免日志记录整条链接。中心订单 id 与交易流水 transactionId 各自使用唯一约束，避免一笔收款关联多个业务订单。

所有请求包括四个头：X-Brclio-Client、X-Brclio-Timestamp（Unix 秒）、X-Brclio-Nonce（16字节随机十六进制）、X-Brclio-Signature（小写十六进制 HMAC-SHA256）。签名密钥为 BRCLIO_PAY_API_KEY，原文准确为：

METHOD + LF + pathnameAndQuery + LF + timestamp + LF + nonce + LF + rawBody + LF

LF 是 U+000A 换行字符；先序列化 JSON 并对同一份字节签名/发送。时间偏差须小于5分钟。GET 无正文，使用空字符串。重放窗口内的下单依赖业务订单号幂等，不代表请求只执行一次。

GET /api/v1/orders/:id 读取本产品的订单；POST /api/v1/orders/:id/refresh 主动向微信核验；POST /api/v1/orders/:id/retry-notification 可重试未成功送达的支付通知。均使用同一签名方式。已成功送达的通知不会被此接口重新发送。

## 支付通知和开通

固定回调只接受 POST，读取原始正文后验签，禁止先重新序列化 JSON。头部 X-Brclio-Timestamp、X-Brclio-Nonce、X-Brclio-Signature 的签名原文是 timestamp + LF + nonce + LF + rawBody + LF，使用 BRCLIO_PAY_WEBHOOK_SECRET，常量时间比较，并限制时间偏差5分钟。X-Brclio-Event 必须等于正文 eventId。正文形状：{eventId,type:'payment.success',orderId,clientId,merchantOrderId,sku,quantity,total,currency:'CNY',transactionId,paidAt}。

校验 clientId 为当前产品、type 为 payment.success，找到自己的待支付订单，核对中心 orderId、merchantOrderId、SKU、数量、金额、币种及预先绑定的用户；eventId 必须准确等于 payment.success. 加中心 orderId。若通知先于下单响应落库到达，暂时返回非 2xx，待绑定完成后由中心重试，不得绕过绑定校验开通。用数据库唯一约束/原子事务，将 eventId 去重、待支付状态变为已支付、开通对应用户权益一起提交；事务成功后才返回2xx。回调和人工查单共用同一个幂等发放函数。中心采用至少一次通知，重复和乱序必须安全处理；没有可靠数据库时明确实现持久化原子去重，不能用内存 Set 或本地浏览器状态冒充。

浏览器返回 URL、二维码显示、JSBridge/App SDK 的成功回调、客户端传来的 paid=true 都不能直接开通权益。网页回跳后调用产品后端，后端读取本产品订单，必要时对中心签名查单，再核对金额与用户并幂等开通。

## 通道与验证

Native 适合电脑展示二维码，用另一台设备微信扫码。不能把保存图片/长按识别说成同手机付款方案。H5 需单独开通并批准 ${new URL(baseUrl).hostname}，微信内网页 JSAPI 需公众号 AppID 和 OpenID，小程序支付参数应由 wx.requestPayment 消费，安卓原生 APP 需移动应用 AppID、包名/签名和 OpenSDK。不可默认为未开通通道已可用。

按实际框架完成接入，复用现有组件与测试；验证匿名下单被拒、前端篡改金额无效、跨产品查单被拒、相同业务单重试不创建两笔、金额/用户不匹配拒绝开通、伪造回调被拒、重复通知只开通一次、返回原产品后读取真实订单结果，确认原支付宝等渠道仍工作。报告修改文件、验证证据及仍需配置项；不得将演示或本地测试称为真实支付验收。正式部署遵循当前会话授权，真实付款由用户完成。
`;
}
