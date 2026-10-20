# Brclio 微信支付中心

统一的 Cloudflare Workers 支付入口，供 `brclio.com`、子域名及桌面/Android 产品后端接入。业务系统创建订单，用户进入 `paywc.bornforthis.cn` 收银台；支付中心验证微信回调和查询结果，通过签名通知将付款结果交给业务系统。

代码包含微信支付 APIv3、Native 二维码收银台、邮箱/密码保护的产品管理后台、一键复制的 AI 接入 Skill、单产品限时接入授权、服务端商品定价、业务订单幂等、签名查单、支付通知、通知重试与补偿查询、加密 GitHub 数据存储及 Node.js 接入 SDK。H5、JSAPI/小程序和 APP 通道已提供接口适配，启用仍需各自的产品权限、AppID、域名或客户端配置。退款、订阅自动扣款、发票和多商户代收不在当前接口范围。

支付中心已部署到 [paywc.bornforthis.cn](https://paywc.bornforthis.cn)，线上启用 Native 通道。已验证 0.01 元预支付订单、二维码参数、幂等下单、微信未付款查询与关单；**没有执行实际扣款，首个产品的真实付款通知及权益开通验收仍待完成。** 部署与验证记录见 [发布状态](docs/release-status.md)。源码位于 [Brclio/Brclio-WeChatPay](https://github.com/Brclio/Brclio-WeChatPay)。

在 [管理后台](https://paywc.bornforthis.cn/admin) 登录后，直接复制通用接入 Skill，交给已获得目标产品仓库与部署权限的 AI。无需预先手填产品资料：AI 检查当前产品的框架、登录/订单/开通流程、真实商品价格和域名，通过 Skill 中有效期 24 小时的单产品授权，在支付中心登记该产品，再完成产品代码接入。已有支付宝等支付渠道默认保留。已有产品也可复制对应专属 Skill 继续适配。

复制的 Skill 包含限时产品管理权限，专属包还包含该产品服务端密钥，必须只在授权产品的私有开发会话中使用。它不能授予 AI 对目标 GitHub 仓库、工作区或部署平台的额外权限；仍以该会话已有授权为准。产品配置与密钥加密保存在指定私有 GitHub 数据仓库，无需手工维护 `CLIENTS_JSON`。详见 [AI 接入流程](docs/ai-integration.md)。

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
- [AI 接入流程](docs/ai-integration.md)：登录复制 Skill、24 小时单产品授权、兼容已有支付流程。
- [部署文档](docs/deployment.md)：Cloudflare 密钥、域名、商户平台配置和真实支付验收。
- [架构与运行边界](docs/architecture.md)：GitHub 写入限制、恢复流程、密钥与数据保留。
- [Node.js SDK](examples/brclio-pay.mjs) 与 [Webhook 服务器示例](examples/webhook-server.mjs)。示例必须接入真实的事务性业务存储，才会开通用户权益。

仓库默认 `PAYMENT_MODE=demo`、`PAYMENT_ENABLED=false`，普通 `npm run deploy` 会按此默认配置部署。需要保留正式 Native 收款模式时使用 `npm run deploy:live`，并先核对生产密钥、商品和接入配置；部署成功不等于真实付款及开通验收通过。

电脑端优先使用当前已开通的 Native 扫码支付。手机微信外浏览器要同机调起微信，需要审核开通 H5；微信内网页需要公众号 JSAPI 配置；原生 Android 支付需要微信开放平台移动应用 AppID、APP 支付权限与 OpenSDK。Native 二维码不支持长按和相册识别，不能用它宣称已覆盖同手机支付。[微信 Native 常见问题](https://pay.wechatpay.cn/doc/v3/merchant/4012791890)

数据只写入指定的私有仓库 `BrclioData/Brclio-WeChatPay-Data`，订单、工作索引及产品配置使用 AES-256-GCM 加密。不依赖 Cloudflare D1、KV、R2、Durable Objects 或队列作为业务存储；Cloudflare Workers/Pages 自身使用量仍受账户套餐与平台限制。公网使用 Pages 子域名入口，经 Service binding 转发到支付 Worker，阿里云 DNS 只需配置对应子域名的 CNAME。
