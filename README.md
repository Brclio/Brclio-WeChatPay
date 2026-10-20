# Brclio 微信支付中心

统一的 Cloudflare Workers 支付入口，供 `brclio.com`、子域名及桌面/Android 产品后端接入。业务系统创建订单，用户进入 `paywc.bornforthis.cn` 收银台；支付中心验证微信回调和查询结果，通过签名通知将付款结果交给业务系统。

代码包含微信支付 APIv3、Native 二维码收银台、邮箱/密码保护的产品管理后台、按产品生成凭据与 AI 接入 Skill、服务端商品定价、业务订单幂等、签名查单、支付通知、通知重试与补偿查询、加密 GitHub 数据存储及 Node.js 接入 SDK。H5、JSAPI/小程序和 APP 通道已提供接口适配，启用仍需各自的产品权限、AppID、域名或客户端配置。退款、订阅自动扣款、发票和多商户代收不在当前接口范围。

**当前不能据此认定已经部署或可以真实收款。** 默认 `PAYMENT_MODE=demo`、`PAYMENT_ENABLED=false`，真实收款关闭。需确认商户密钥与公钥配置、完成 `paywc.bornforthis.cn` 域名接入、在管理后台登记真实商品与开通接口，再完成真实付款验收。商户证书和 APIv3 密钥只从安全本地/Cloudflare Secrets 读取。

管理入口为 `/admin`。管理员登录后可注册产品、登记商品、固定 Webhook 和回跳域名、复制该产品专属的 AI 接入 Skill，并在需要时显式读取或轮换接入凭据；无需手工维护 `CLIENTS_JSON`。后台配置也加密保存在指定 GitHub 私有仓库，真实支付关闭时仍可完成产品配置。

## 开发与检查

需要 Node.js 22 或更新版本。

```sh
npm install
npm run dev
```

开发页面可预览收银台；演示状态不会产生虚假的已付款记录。校验代码与 Worker 打包：

```sh
npm run check
```

首次生成本地应用密钥（不包含微信密钥与 GitHub Token）：

```sh
npm run secrets:generate -- --write
```

生成文件为已忽略的 `secrets/bootstrap.json`，权限 `0600`。只有显式附加 `--write-dev-vars` 才同时创建 `.dev.vars`；已有文件一律不覆盖。`.dev.vars.example` 为无密钥样例。不要输出 `.dev.vars`、把密钥放到前端、APK、桌面包、截图或 Git 仓库。

完成配置后运行：

```sh
npm run preflight
```

默认校验本地格式并只读检查数据仓库的私有属性及分支访问，不部署、不付款、不写 GitHub。`--offline` 只检查本地；`--certificate secrets/apiclient_cert.pem` 额外检查商户证书序列号、有效期和私钥匹配；显式 `--write-check` 才创建并删除一个加密测试文件，留下两次 Git 提交。

## 接入与部署

- [产品接入文档](docs/integration.md)：签名协议、Node.js SDK、Webhook 验签、幂等开通及补偿。
- [部署文档](docs/deployment.md)：Cloudflare 密钥、域名、商户平台配置和真实支付验收。
- [架构与运行边界](docs/architecture.md)：GitHub 写入限制、恢复流程、密钥与数据保留。
- [Node.js SDK](examples/brclio-pay.mjs) 与 [Webhook 服务器示例](examples/webhook-server.mjs)。示例必须接入真实的事务性业务存储，才会开通用户权益。

电脑端优先使用当前已开通的 Native 扫码支付。手机微信外浏览器要同机调起微信，需要审核开通 H5；微信内网页需要公众号 JSAPI 配置；原生 Android 支付需要微信开放平台移动应用 AppID、APP 支付权限与 OpenSDK。Native 二维码不支持长按和相册识别，不能用它宣称已覆盖同手机支付。[微信 Native 常见问题](https://pay.wechatpay.cn/doc/v3/merchant/4012791890)

数据只写入指定的私有仓库 `BrclioData/Brclio-WeChatPay-Data`，订单、工作索引及产品配置使用 AES-256-GCM 加密。不依赖 Cloudflare D1、KV、R2、Durable Objects 或队列作为业务存储；Cloudflare Workers/Pages 自身使用量仍受账户套餐与平台限制。公网使用 Pages 子域名入口，经 Service binding 转发到支付 Worker，阿里云 DNS 只需配置对应子域名的 CNAME。
