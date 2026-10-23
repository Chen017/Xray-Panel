# Cloudflare Zero Trust：三个入口分别认证

完整的 GitHub 拉取、1Panel 容器编排、三个 HTTPS 站点、Access、源站限制和验收步骤见 **[1Panel + Cloudflare Access 完整部署教程](1panel.md)**。该方案使用你已有的 Cloudflare DNS / 橙云代理和 1Panel 证书，不需要 Cloudflare Tunnel 或 WARP。

本文是认证与凭据字段的参考，便于在后续客户端接入时查阅。

## 1. 三个入口如何分开

| 入口示例 | 1Panel 反向代理目标 | 橙云 | Access 应用和策略 | 面板自己的认证 |
| --- | --- | --- | --- | --- |
| `panel.example.com` | `http://127.0.0.1:3000` | 开启 | 独立应用，Allow，仅管理员邮箱 / 身份账号 | 管理员密码、会话和 CSRF |
| `sub.example.com` | `http://127.0.0.1:3001` | 开启 | 独立应用，Service Auth，仅订阅设备令牌 | 设备 Bearer Token；正文 age 加密 |
| `agent.example.com` | `http://127.0.0.1:3002` | 开启 | 独立应用，Service Auth，仅 VPS Agent 令牌 | Agent Bearer Token 和 X-Node-ID |

三个应用都匹配完整域名、Path 留空。机器入口不使用邮箱 Allow、Everyone / Bypass 或 Any Access Service Token；订阅和 Agent 的 CF 令牌不能互相授权，也不加入后台应用。后台使用身份提供商，支持时启用 MFA；使用 One-time PIN 时先在 Integrations → Identity providers 中添加它。

控制中心 `.env` 中三个 `ORIGIN` 要和实际 HTTPS 域名一致，不带路径和尾部 `/`。修改后在原编排重新创建容器，单纯重启不会更新容器环境变量；保留数据库密钥和数据卷。

## 2. 为机器建立独立令牌

1. 进入 Zero Trust / Cloudflare One「Access controls → Service credentials → Service Tokens」。旧版菜单可能叫「Access → Service Auth」。
2. 每个客户端设备一个令牌，例如 `sub-laptop`；每台 VPS 一个令牌，例如 `agent-vps-01`。
3. 设置有效期，生成后保存 Client ID 和只显示一次的 Client Secret，提前安排到期更新。按控制台原值保存，不自行添加后缀或限定 Secret 格式。
4. 在订阅应用的 Service Auth 策略中只选择设备令牌；Agent 应用的策略中只选择 VPS 令牌。

CF 凭据不会由面板自动生成或撤销；它与面板的 Token 是两套授权。撤销设备时可分别撤销两套凭据，轮换其中一套时更新持有它的客户端。

## 3. Mihomo 请求头

下面片段合并到已有的对应 `proxy-providers` 条目，不是另一份完整主配置：

```yaml
header:
  Authorization:
    - "Bearer 面板生成的该设备TOKEN"
  CF-Access-Client-Id:
    - "该设备Cloudflare服务令牌的Client ID原值"
  CF-Access-Client-Secret:
    - "该设备Cloudflare服务令牌的Client Secret原值"
```

Cloudflare 检查 `CF-Access-Client-Id` 和 `CF-Access-Client-Secret`；面板检查 `Authorization`，因此不要把 Access 改成读取同一个 Authorization 头。每次自动更新都携带两套凭据，不依赖浏览器的 Access Cookie。设备 age 私钥只留在本地，用于解密，不作为请求头发到服务器。

完整 Mihomo 字段及主配置合并方式仍见 [mihomo.md](mihomo.md)。

## 4. Agent JSON 字段

在该 VPS 已有 `/etc/xray-panel-agent/config.json` 对象内增加或更新以下两个属性，保留原本的 nodeId、url、token 等字段：

```json
{
  "CF-Access-Client-Id": "该VPS的Cloudflare服务令牌Client ID原值",
  "CF-Access-Client-Secret": "该VPS的Cloudflare服务令牌Client Secret原值"
}
```

上面仅展示新增字段，不能用它覆盖整个配置文件。url 使用 Agent 的 HTTPS 域名；token 仍是面板生成的 Agent Token。Agent 已实现自动附加 CF 两个请求头。修改 JSON 后保持 `chmod 600 /etc/xray-panel-agent/config.json`，重启对应 Agent 服务载入配置。

## 5. 源站、缓存和自动请求

Access 只在 Cloudflare 边缘验证。当前 Node 服务不验证 Access JWT；必须另外限制绕过 Cloudflare 的源站访问。完整教程的 [源站校验](1panel.md#origin) 使用 Cloudflare Request Header Transform Rule 设置一个独立随机密钥、三个 1Panel 站点在 server 级检查，并在转发给程序前清除该头。

这个源站密钥由 Cloudflare 与 1Panel 保存，不给浏览器、Mihomo 或 VPS Agent，不复用面板数据库密钥；它阻止不知道密钥的直接 HTTP 请求，不代替 Access 或面板认证。不能把“带有任意 CF 邮箱头”当作有效登录。

三个域名使用 Bypass cache。订阅和 Agent 不经过交互式质询；若现有 WAF / Bot 规则误拦，精确处理对应规则，保留 Service Auth，不通过 Access Bypass 放开。免费 Bot Fight Mode 不能用普通 WAF Skip 规则绕过。

真实 VLESS REALITY 代理连接使用线路 VPS 的直连 IP / 灰云域名，不属于这三个 HTTP 管理入口。

## 6. 验证预期

完整命令见 [部署验收](1panel.md#verify)。部署阶段不需要先在面板中添加节点或设备：

| 测试 | 预期 |
| --- | --- |
| 无身份访问后台 | Access 登录或拒绝；认证后才出现面板密码页 |
| 无 CF 凭据请求订阅 / Agent `/health` | Access 拒绝或旧配置跳转，不能返回应用健康 JSON |
| 订阅 CF 凭据请求订阅 `/health` | 200，service 为 subscription |
| Agent CF 凭据请求 Agent `/health` | 200，service 为 agent |
| 两类 CF 凭据交叉访问对方的 `/health` | Access 拒绝 |
| CF 凭据有效，但订阅 / Agent 的面板 Bearer 缺失 | 业务路由返回面板 JSON 401，说明第二层认证仍在 |
| 绕过 Cloudflare 连接源站，不带私密源站头 | 403 或已有防火墙拒绝；不能返回健康 JSON |

实际开始提供订阅后，两套有效凭据、已授权且已部署的节点齐备时，订阅正文才返回 200 和 age armor。没有已部署节点时可能返回 503。302 / HTML 通常要排查 Service Auth 匹配、令牌或交互质询；403 则需区分是 Access、源站校验还是面板本身拒绝。

官方参考（2026-10-23 核对）：

- [Self-hosted 应用](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
- [One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)
- [Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [请求头转换规则](https://developers.cloudflare.com/rules/transform/request-header-modification/create-dashboard/)
- [Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)

## Agent HTTP 403 / Cloudflare 1010

若新版 Agent 日志显示 `HTTP 403 / CF 1010`，这是 Cloudflare Browser Integrity Check 对机器请求的拦截，不代表 Service Token 一定错误。在域名「Rules → Configuration Rules」只匹配 Agent / 订阅机器域名并关闭该规则的 Browser Integrity Check；保留 Service Auth 和源站校验。不要把管理后台一起放开，也不要设置 Access Bypass。先用带 CF 两个请求头的 `/health` 验证到达正确入口，再检查面板 Node ID 和 Bearer Token。
