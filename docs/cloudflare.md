# Cloudflare Zero Trust：保护后台，同时允许 Agent 与订阅自动拉取

推荐使用三个域名、三个 Access 应用和同一条 Tunnel。后台使用人类登录，Agent 与 Mihomo 使用 Service Token；不要让自动拉取经过浏览器验证码或邮件登录页面。

## 1. 配置 Tunnel

在 Cloudflare One 控制台的 Networks → Connectors → Cloudflare Tunnels 创建 Tunnel，在建站 VPS 按官方给出的命令安装 cloudflared。具体菜单名称可能随控制台改版调整。

为该 Tunnel 添加三个 Published application routes：

| Public hostname | Service |
| --- | --- |
| panel.example.com | http://127.0.0.1:3000 |
| sub.example.com | http://127.0.0.1:3001 |
| agent.example.com | http://127.0.0.1:3002 |

上述地址适用于 cloudflared 在宿主机运行。若 cloudflared 也在 Docker 中，容器内的 127.0.0.1 指向自身；让它与 panel 加入同一 Docker 网络，改为 http://panel:3000、:3001、:3002，且无需把这些端口发布到公网。

本地管理的 Tunnel 配置样例在 deploy/cloudflared.example.yml。不要关闭源站 TLS 校验来解决错误；这里 cloudflared 到本机是 loopback HTTP，客户端到 Cloudflare 仍使用 HTTPS。

面板 .env：

```dotenv
PANEL_ADMIN_ORIGIN=https://panel.example.com
PANEL_SUBSCRIPTION_ORIGIN=https://sub.example.com
PANEL_AGENT_ORIGIN=https://agent.example.com
PANEL_SECURE_COOKIE=true
```

修改后重启 panel。建议在 VPS 防火墙继续拒绝外部访问 3000、3001、3002；compose 默认仅绑定 loopback。关闭直连源站的入口可以避免绕过 Access。

## 2. 管理后台 Access 应用

在 Access → Applications 添加 Self-hosted 应用，完整覆盖 panel.example.com 全部路径。

- Policy action：Allow。
- Include：仅你的邮箱或受信任的 IdP 账号 / 组。
- 在 IdP 上启用 MFA；根据 IdP 能力配置 Access MFA 要求。
- 不添加 Everyone 的 Allow / Bypass。
- 管理应用不要放入设备订阅的 Service Token。

经过 Access 后，面板仍要求自己的管理员密码。这保护没有直接验证 Access JWT 的本地 HTTP 服务：安全边界是不可从公网直连的源站 + Tunnel + Access + 面板会话认证。不要仅信任客户端能自行发送的 CF-Access-* 或用户邮箱头。

## 3. Mihomo 订阅 Access 应用

在 Access → Service credentials / Service Auth → Service Tokens 为每台设备建立独立 Service Token，复制 Client ID 与 Client Secret。设置有效期，并在到期前更新本地配置。

新建 Self-hosted 应用，覆盖 sub.example.com 全部路径：

- Policy action 必须选 Service Auth。
- Include：Service Token，选择相应设备的 Token。
- 不要求浏览器登录，不使用只适用于人类登录的 Allow 邮箱策略。
- 不使用 Bypass / Everyone 来解决拉取失败。

Mihomo 的请求头同时包含两层凭据：

```yaml
header:
  Authorization:
    - "Bearer 面板生成的该设备TOKEN"
  CF-Access-Client-Id:
    - "Cloudflare生成的该设备CLIENT_ID.access"
  CF-Access-Client-Secret:
    - "Cloudflare生成的该设备CLIENT_SECRET"
```

Cloudflare 使用 CF-Access-* 两个头；面板使用 Authorization。保留各自的头可避免互相覆盖。无需把 Token 放进 URL，也不需要把 age 私钥发到网络。

在 Cloudflare Cache Rules 对 sub.example.com 的订阅路径设置 Bypass cache，且不要启用会对该路径触发交互验证的 WAF / Bot challenge。保留 Service Auth 检查。应用也返回 Cache-Control / CDN-Cache-Control: no-store，避免不同设备共用缓存密文。

最小暴露方案也可以只创建 subscription 精确路径应用，但本项目推荐整个订阅域名 Service Auth，避免未来新增订阅路由漏保护。

## 4. VPS Agent Access 应用

另建 Self-hosted 应用，覆盖 agent.example.com：

- Policy action：Service Auth。
- 每台 VPS 使用独立的 Cloudflare Service Token。
- 在该 VPS 的 Agent 配置 JSON 添加 CF-Access-Client-Id 与 CF-Access-Client-Secret。
- Authorization 中的面板 Agent Token 保持原值。

这样设备订阅凭据无法管理节点，Agent 凭据也不能访问管理 API；三者由独立监听端口和认证逻辑隔离。

## 5. 验证是否正确

1. 访问后台，应先出现 Access 登录，再出现面板密码页。
2. 不带 CF Service Token 请求订阅，应被 Access 拒绝。
3. 只带有效 CF Service Token、不带有效 Bearer，应由面板返回 401。
4. 两层 Token 都有效，且设备 UUID 已部署，应返回 200，正文以 `-----BEGIN AGE ENCRYPTED FILE-----` 开头。
5. 有效凭据但尚无已部署节点，面板返回 503；等待 Agent 部署完成再刷新。
6. 撤销面板设备授权后，即使 CF Token 仍有效，也应返回 401。

302 / HTML 登录页通常表示 Service Auth 策略或域名匹配错误；403 通常需要区分是 Cloudflare 拒绝还是面板的 CSRF / 权限拒绝。Agent 主动拒绝重定向，不会把 Bearer Token 跟随到登录页面。

服务令牌和面板令牌需要分别管理：从面板撤销设备不会替你删除 Cloudflare Service Token。可以在两边分别撤销，以便审计。

Cloudflare Tunnel 仅承载后台、管理任务和订阅文件。真实 VLESS REALITY / XHTTP 代理连接继续直达线路 VPS；不要把其 IP 域名经这条 Tunnel 代理。

官方参考（2026-10-23 核对）：

- https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-local-tunnel/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/self-hosted-apps/
