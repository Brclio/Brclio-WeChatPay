# 部署与商户配置

本文件是部署与维护操作说明。当前 `paywc.bornforthis.cn` 已接通并部署，线上启用 Native；已验证预支付及未付款查询/关单，没有执行扣款。实际部署记录见 [发布状态](release-status.md)，首个产品的真实付款通知与权益开通仍待验收。

## 域名方案

统一收银台使用 `https://paywc.bornforthis.cn`。`brclio.com` 和子域名负责产品界面及自身后端，支付中心通过固定签名 Webhook 传回结果。Native 二维码使用已关联的小程序 AppID，无须将每个产品域名登记为微信 H5 域名。[微信 Native 下单](https://pay.wechatpay.cn/doc/v3/merchant/4012791877)

保留 `bornforthis.cn` 在阿里云的现有权威 DNS，采用 **Cloudflare Pages 子域名入口 → Service binding → 支付 Worker**。Pages 官方支持外部 DNS 的自定义子域名，不需要将整个域名 NS 迁移到 Cloudflare。必须先在 Pages 项目的 Custom domains 注册 `paywc.bornforthis.cn`，再在阿里云添加 `paywc` 的 CNAME 指向实际 `<项目名>.pages.dev`。只添加 CNAME、没有 Pages 域名关联会报 522。HTTPS 证书生效和 CAA 限制需实测核对。[Pages 自定义子域名](https://developers.cloudflare.com/pages/configuration/custom-domains/)

Pages 网关与核心 Worker 分开配置：网关仅处理 HTTP 转发，商户凭据、加密存储和每分钟补偿任务仍在核心 Worker。Pages 使用 Advanced mode 的 `_worker.js`；示意代码：

```js
export default {
  fetch(request, env) {
    return env.PAYMENT_CENTER.fetch(request);
  },
};
```

独立网关 Wrangler 配置示意（实际路径与项目名以仓库的 `gateway/` 为准）：

```json
{
  "name": "brclio-wechatpay-gateway",
  "pages_build_output_dir": "./public",
  "compatibility_date": "2026-10-01",
  "services": [{ "binding": "PAYMENT_CENTER", "service": "brclio-wechatpay" }]
}
```

Pages 配置不使用 Workers 的 `main` 字段。Service binding 必须指向同账户已部署的核心 Worker，改绑定后重新发布网关；保留原始请求正文、路径和签名 Header。`PUBLIC_BASE_URL` 使用最终收银台域名。Pages 网关不复制商户密钥，也不增加任何数据库存储。[Pages Service bindings](https://developers.cloudflare.com/pages/functions/bindings/)、[Advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/)、[Wrangler 配置](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)

未来修改域名时，若有旧 CNAME/A/AAAA 应先核实用途，不能直接覆盖既有业务。当前方案保留阿里云权威 DNS，无需 Cloudflare Partial DNS 套餐或整域 NS 迁移。页面和 API 可达性、微信真实支付通知及产品权益开通应分别验收；域名激活不代表真实付款验收已通过。

## 微信商户平台需要提供的参数

以下字段以真实商户平台为准，不从示例生成替代：

| 字段 | 来源及处理 |
|---|---|
| `WECHAT_MCH_ID` | 商户号，截图为 `1751349372`，投产前核对 |
| `WECHAT_APP_ID` | 用于 Native/H5 的已关联 AppID，截图小程序为 `wx59aa532fbf6fa540` |
| `WECHAT_SERIAL_NO` | 商户 API 证书序列号，必须对应签名私钥；不是微信支付公钥 ID |
| `WECHAT_PRIVATE_KEY` | 商户 API 私钥 PEM，`BEGIN PRIVATE KEY`，PKCS#8 RSA-2048；绝不写 GitHub |
| `WECHAT_API_V3_KEY` | 商户平台设置的 32 字节 APIv3 密钥，用于通知解密；不是 AppSecret |
| `WECHAT_PUBLIC_KEYS_JSON` | 已从微信支付商户平台获取并信任的公钥表，形式为 `{ "PUB_KEY_ID_数字": "PEM 公钥原文" }`；公钥为 SPKI `BEGIN PUBLIC KEY` |
| `WECHAT_PUBLIC_KEY_ID` | 当前请求使用的已固定公钥 ID，必须存在于公钥表；建议明确设置，未设时使用表中第一个键 |

新接入采用微信支付公钥验签模式。保留多把可信公钥可支持切换期间验签；未知 `Wechatpay-Serial` 不应被自动信任。若原商户已经使用平台证书模式，迁移期间需保留仍会签发应答/回调的旧证书对应公钥，再确认微信侧切换完成。[微信必要参数](https://pay.wechatpay.cn/doc/v3/merchant/4013070756)、[公钥模式](https://pay.wechatpay.cn/doc/v3/merchant/4012153196)、[公钥切换 FAQ](https://pay.wechatpay.cn/doc/v3/merchant/4013038816)

仅 Native 通道时保持 `ENABLED_CHANNELS=native`、每个产品 `channels:["native"]`。v3 支付回调地址通过下单 `notify_url` 明确传入；商户平台界面中的历史 Native 回调配置不能代替本系统的 v3 接口。

微信支付通知接口为 `https://paywc.bornforthis.cn/api/wechat/notify`，必须公网 HTTPS 可达，无登录、验证码、Cloudflare Access 或交互式 WAF 挑战，不能依赖浏览器 Cookie。[通知地址要求](https://pay.wechatpay.cn/doc/v3/merchant/4012075420)

## 其余支付通道的开通前提

| 通道 | 需补齐配置 |
|---|---|
| H5 | 商户平台开通 H5，审核完整支付域名 `paywc.bornforthis.cn`；发起页域名和 `redirect_url` 都必须精确匹配获批域名；下单需要真实用户 IP。ICP备案与主体要求按微信审核执行 |
| 微信内网页 JSAPI | 已认证服务号或政府/媒体公众号 AppID，绑定商户号；设置公众号网页授权域名以获取 OpenID；商户平台登记 `https://paywc.bornforthis.cn/` 支付授权目录；设置 `WECHAT_JSAPI_APP_ID` 与 `WECHAT_JSAPI_CONTEXT=web`。本项目不代办公众号 OAuth 流程，产品后端必须获取该 AppID 的真实 OpenID |
| 小程序 JSAPI | 关联小程序 AppID、JSAPI 权限、由小程序登录获取 OpenID；`WECHAT_JSAPI_CONTEXT=miniprogram`。产品小程序用服务端返回参数调用 `wx.requestPayment`，普通网页不能代替小程序执行 |
| 原生 Android APP | 已认证微信开放平台移动应用 AppID，绑定商户号并开通 APP 支付；设置 `WECHAT_APP_APP_ID`；Android 包名/签名需与开放平台一致，客户端集成微信 OpenSDK |

[H5 域名规则](https://pay.wechatpay.cn/doc/v3/merchant/4013287193)、[H5 跳转规则](https://pay.wechatpay.cn/doc/v3/merchant/4012791845)、[JSAPI 开发准备](https://pay.wechatpay.cn/doc/v3/merchant/4015423216)、[小程序权限](https://pay.wechatpay.cn/doc/v3/merchant/4012791895)、[Android/APP 接入](https://pay.wechatpay.cn/doc/v3/merchant/4015478291)

只有商户平台批准且产品客户端已完成接入后，才把对应通道加入全局和产品允许列表。不要把截图中的已开通 JSAPI 权限解释为“任意微信内网页都能支付”。

## Cloudflare 环境与密钥

非密钥参数放在 `wrangler.jsonc` 的 `vars`：支付模式/开关、公网地址、仓库及分支、商户号与 AppID、允许通道及来源、订单有效期、当前微信支付公钥 ID。`ALLOWED_ORIGINS` 的 CORS 配置不代替服务端请求签名。

以下以 Secrets 保存，不能进入版本控制：

```text
GITHUB_TOKEN
ENCRYPTION_KEY
ORDER_ID_SECRET
CHECKOUT_SECRET
ADMIN_EMAIL
ADMIN_PASSWORD_HASH
ADMIN_SESSION_SECRET
WECHAT_SERIAL_NO
WECHAT_PRIVATE_KEY
WECHAT_API_V3_KEY
WECHAT_PUBLIC_KEYS_JSON
```

`ENCRYPTION_KEY` 是 32 字节随机数的标准 Base64；其他应用密钥使用至少 32 字节随机值，各用途和各产品不得共用。GitHub Token 仅授权指定私有数据仓库的 Contents 读写。原文聊天中提供过的凭据在投产前应替换为专用的新凭据，并由安全输入保存；不要写入源码或部署命令行。

`ADMIN_PASSWORD_HASH` 使用 `pbkdf2-sha256$100000$<32位salt hex>$<64位digest hex>`，salt 为 16 字节原始随机字节，PBKDF2-HMAC-SHA256 迭代 100,000 次、输出 32 字节。仅保存哈希，不保存明文密码；`ADMIN_SESSION_SECRET` 独立随机生成。管理员会话采用 HttpOnly/Secure/SameSite=Strict Cookie，2 小时过期，密码哈希改变后旧会话失效；更改产品配置还需同源及 CSRF 校验。必须配置核心 Worker 的 `AUTH_RATE_LIMITER` 绑定以保护登录，缺少时拒绝登录。具体绑定配置以 `wrangler.jsonc` 为准。

产品首选通过受保护后台注册，配置加密保存到 `config/clients.json`，解密内容为 `{ "version": 1, "clients": [...] }`。`CLIENTS_JSON` 仅作为可选兼容后备 Secret，后台相同 ID 优先。没有登记可用商品前不能认为支付系统已可营业。

本地完成 `.dev.vars` 后，可安全导出仅包含 Secret 字段的上传文件：

```sh
node scripts/export-cloudflare-secrets.mjs --write
```

此命令只创建已忽略且权限为 `0600` 的 `secrets/cloudflare.json`，不会上传、打印或覆盖已有文件。不要直接上传整个 `bootstrap.json`，其中的公开变量会与 `wrangler.jsonc` 配置冲突。

在已确认的 Cloudflare 账户和 Worker 中，显式部署后上传：

```sh
npm run check
npm run deploy
npx wrangler secret bulk secrets/cloudflare.json
```

然后依据 `gateway/` 中的独立 Pages 配置发布网关，在 Pages 登记 `paywc.bornforthis.cn`，按项目生成的准确目标在阿里云添加 CNAME。核心 Worker 先部署并保持收款关闭，再发布网关与绑定；Service binding 目标不得使用临时预览实例。核心 Worker 的 cron 继续负责查单/补投，Pages 网关无需复制计划任务。

首次部署保持收款关闭。上传 Secret 后，核对密钥名称及公有配置；不要通过 tail 原始请求、环境打印或截图确认秘密。管理员登录 `/admin` 后可直接复制通用 Skill，由已经获得产品仓库及部署权限的 AI 通过单产品限时接口登记真实目录、回调与返回域名，并接好产品代码；也可手工登记后复制专属 Skill。[AI 接入说明](ai-integration.md)

正式部署使用：

```sh
npm run deploy:live
```

该命令运行检查，并通过 CLI 明确设置 `PAYMENT_MODE=live`、`PAYMENT_ENABLED=true`。仓库中的默认值仍是 demo/false，普通 `npm run deploy` 会按默认值部署，不能用它无意覆盖正在运行的正式模式。部署命令成功只证明对应版本发布，真实付款及产品开通证据单独记录。

## 上线验收与停用

按以下顺序记录可审计证据：

1. `npm run check` 通过，预检验证配置、公私钥匹配、数据仓库为私有、分支可读；如执行写测试，记录加密测试文件创建/删除提交。
2. 部署返回的 Worker 版本、URL 与生效时间可查；DNS 和 TLS 实测访问的是目标 Worker。
3. 用已登记产品后端创建订单，确认价格来自目录，未授权来源/错误签名/跨产品订单均被拒绝。
4. 商家确认一笔低金额真实测试商品并授权付款后，执行真实付款。不能使用伪造 `SUCCESS` 回调作为通过证据。
5. 验证微信签名及解密、金额/AppID/商户号/订单号校验；GitHub 中只有密文；产品固定 Webhook 经验证后提交权益事务，用户实际获得对应权益。
6. 重放同一事件、重复点击、Webhook 暂时失败、查询补偿及进程重启场景均不重复开通。浏览器回跳与 Android SDK 回调不直接开通。

若需暂停新下单，保留 `PAYMENT_MODE=live`，将 `PAYMENT_ENABLED=false` 发布生效，并保留有效商户密钥、产品登记和私有存储配置。新下单接口将返回 `PAYMENTS_DISABLED`；既有收银台访问、签名查单、微信付款通知、管理员查单/关单和每分钟补偿任务继续运行。暂停不会立即撤销已经发出的支付参数，需要取消既有未付款订单时执行关单。不要用 `PAYMENT_MODE=demo` 代替暂停，它会同时停用微信维护接口和计划任务。

暂停后的已支付订单仍需依据微信商户平台和保存的订单记录对账处理；关闭下单不能替代退款或对账。恢复前修复配置并确认未投递通知，不能仅凭页面恢复可访问就宣称收款恢复。

## 本仓库当前线上维护命令

线上 Native 已按发布记录单独启用。更新线上服务使用 `npm run deploy:live`，该命令显式设置 live/启用标志并执行检查；普通 `npm run deploy` 保持仓库默认的演示/关闭配置。Pages 入口更新使用 `npm run deploy:gateway`，其工作目录为 `gateway/`。

若要用本地密钥文件核验线上同等模式，可执行 `PAYMENT_MODE=live PAYMENT_ENABLED=true npm run preflight -- --certificate secrets/apiclient_cert.pem`；尚未登记真实产品时，REGISTERED_PRODUCTS 检查仍会失败，需先通过管理台 Skill 为首个产品完成接入。最终上线证据见 [发布记录](release-status.md)。
