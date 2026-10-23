# Cloudflare：保护后台，不影响自动拉取

本指南与 [1Panel 部署](1panel.md) 配合使用。三个域名都开橙云，分别建 Access 应用；无需 Tunnel 或 WARP。所有 `example.com` 换成真实域名。

| 入口 | Access 策略 | 客户端提供的凭据 |
| --- | --- | --- |
| `panel.example.com` | Allow，仅管理员身份 | 浏览器登录，再输入面板密码 |
| `sub.example.com` | Service Auth，仅设备令牌 | CF 两个头 + 设备 Bearer Token |
| `agent.example.com` | Service Auth，仅 VPS 令牌 | CF 两个头 + Agent Bearer Token、节点 ID |

实际 VLESS / REALITY 连接仍直达线路 VPS 的 IP 或灰云域名，不走这三个 HTTP 管理入口。

## 1. 创建 Access 应用

进入 Cloudflare One / Zero Trust 的「Access controls → Applications」，新增 **Self-hosted / Self-hosted and private → Public DNS / Public hostname** 应用。界面名称可能略有不同，使用公开域名入口。

每个应用填写独立名称及上表对应域名，Path 留空。域名分栏时，例如 `panel.example.com`：Subdomain 填 `panel`，Domain 选 `example.com`。

- **后台**：添加 Allow 策略，Include 选择自己的完整邮箱或受信任身份组。选用 One-time PIN 时，先在 Identity providers 添加该登录方式；已有身份提供商可直接使用。
- **机器入口**：先在「Service credentials → Service Tokens」为每台设备 / VPS 分别创建服务令牌，保存 Client ID 和只显示一次的 Secret；再添加 Service Auth 策略，只选择该入口允许的令牌。

订阅令牌和 VPS 令牌分开，不互相授权。不要用通配邮箱应用覆盖三个入口，不使用 Everyone、Any Access Service Token 或 Bypass 来解决拉取失败。服务令牌有有效期，按控制台原值保存并在到期前更换。

## 2. 让客户端携带两层认证

Mihomo 的 provider 添加以下请求头，完整配置见 [Mihomo 教程](mihomo.md)：

```yaml
header:
  Authorization:
    - "Bearer 面板设备TOKEN"
  CF-Access-Client-Id:
    - "本设备的CF服务令牌Client ID"
  CF-Access-Client-Secret:
    - "本设备的CF服务令牌Secret"
```

Agent 安装窗口填写该 VPS 的 Client ID / Secret，生成的脚本会自动配置。已有 Agent 优先重新粘贴同节点的接入信息；手动修改时，仅在 `/etc/xray-panel-agent/config.json` 增改下面两项，保留其他字段，之后重启 Agent：

```json
{
  "CF-Access-Client-Id": "本VPS的CF服务令牌Client ID",
  "CF-Access-Client-Secret": "本VPS的CF服务令牌Secret"
}
```

```bash
chmod 600 /etc/xray-panel-agent/config.json
systemctl restart xray-panel-agent
```

CF 检查自己的两个头，面板检查 `Authorization`；不要把 Access 改成占用同一个 Authorization 头。age 私钥只用于本地解密，不发送给服务器。撤销面板 Token 不会自动撤销 CF 令牌，两套凭据分别管理。

<a id="origin"></a>

## 3. 阻止绕过 Cloudflare 直连源站

当前程序不验证 Access JWT，需要在源站另加限制。以下方案使用一个仅 Cloudflare 和 1Panel 持有的随机密钥，不代替 Access 或面板认证。

**① 在 VPS 生成独立密钥：**

```bash
openssl rand -hex 32
```

**② 在 Cloudflare 站点控制台创建 Request Header Transform Rule：**

点 **Edit expression**，直接填写下面的表达式；不要粘到 URI Full / wildcard 的 Value 栏：

```text
http.host in {"panel.example.com" "sub.example.com" "agent.example.com"}
```

动作选择 **Set static**，请求头名称 `X-Xray-Panel-Origin`，值为刚生成的密钥，然后部署。必须修改**请求头**，不要创建响应头规则或回显该值。

**③ 在三个 1Panel 网站的配置文件分别添加：**

放入对应 `server { ... }` 内，所有 `location` 外，并在其他 `return` / `rewrite` 前：

```nginx
if ($http_x_xray_panel_origin != "替换为刚生成的源站密钥") {
    return 403;
}
```

在已有根代理 `location / { ... }` 内增加：

```nginx
proxy_set_header X-Xray-Panel-Origin "";
```

通过 1Panel 配置校验后重载。所有能代理到这三个服务的 HTTP / HTTPS server 都需保护；仅做 HTTPS 跳转的 server 不提供程序入口。密钥不要放入客户端、Agent、响应头或公共仓库，也不要复用 `PANEL_MASTER_KEY`。

本方案适用于 Cloudflare DNS 验证证书；若使用 HTTP 文件验证，需另行处理验证路径。也可使用已有的源站防火墙限制方案，但必须实际验证无法绕过 Access。

## 4. 缓存与机器请求

在「Caching → Cache Rules」用相同三个域名表达式设置 **Bypass cache**，确认后续规则没有重新启用缓存；1Panel 代理缓存也关闭。

若 Agent / Mihomo 被交互式 WAF 或 Bot 质询拦截，只调整误拦机器域名的那条规则，保留 Service Auth。免费 Bot Fight Mode 无法用普通 WAF Skip 豁免；误拦时需关闭该模式或改用支持例外的方案。

遇到 **HTTP 403 / error code: 1010**，在「Rules → Configuration Rules」创建精确匹配下列机器域名的规则，把 **Browser Integrity Check** 设为 Off；后台不加入例外：

```text
http.host in {"sub.example.com" "agent.example.com"}
```

<a id="verify"></a>

## 5. 验收

在 VPS Bash 中用一台 Agent 的 CF 令牌检查，不跟随重定向：

```bash
read -r -p 'CF Client ID: ' CF_CLIENT_ID
read -r -s -p 'CF Client Secret: ' CF_CLIENT_SECRET
printf '\n'
curl -i --max-time 20 \
  -H "CF-Access-Client-Id: $CF_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_CLIENT_SECRET" \
  https://agent.example.com/health
unset CF_CLIENT_ID CF_CLIENT_SECRET
```

应返回 200，JSON 的 `service` 为 `agent`。订阅入口换成自己的设备 CF 令牌和 `sub.example.com/health`，应得到 `subscription`。

| 额外检查 | 预期 |
| --- | --- |
| 无身份访问后台 | Access 登录 / 拒绝，认证后才显示面板密码页 |
| 不带 CF 头访问机器入口 `/health` | Access 拒绝，不能返回健康 JSON |
| 设备 / VPS 的 CF 凭据交叉访问另一入口 | Access 拒绝 |
| CF 有效但业务请求不带面板 Bearer | 面板返回 JSON 401；不等于 CF 配置失败 |

在 VPS **以外**的终端测试源站，域名和示例 IP 均需替换；订阅 / Agent 域名也分别测试：

```bash
curl -i --max-time 20 --resolve panel.example.com:443:203.0.113.10 https://panel.example.com/api/health
```

应返回源站 403，或被已有防火墙拒绝；不能返回健康 JSON。源站有 IPv6 时同样测试。若使用 Origin CA，先按[官方说明](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)配置 `--cacert`；证书不受信任本身不能证明 HTTP 请求被拒绝。

<a id="troubleshoot"></a>

## 排错

| 现象 | 检查 |
| --- | --- |
| 302 / HTML 登录页 | 是否误用邮箱 Allow、CF 两个头是否完整、令牌是否过期 |
| 403 / 1010 | BIC 机器域名例外；不要撤掉 Access |
| 403，凭据看起来正确 | 区分 Access 拒绝、WAF 拦截和源站头不匹配；看响应与 CF 安全事件 |
| Access 通过但源站 403 | 请求头规则是否匹配真实域名、是否误选响应头、密钥是否一致 |
| 面板 JSON 401 | 已到业务服务，检查设备 Token 或 Agent Token / Node ID |
| 直连源站返回 200 | 站点校验遗漏或内部服务端口暴露，检查三个站点与监听地址 |

官方参考：[Access 应用](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)、[Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)、[请求头规则](https://developers.cloudflare.com/rules/transform/request-header-modification/create-dashboard/)、[BIC 设置](https://developers.cloudflare.com/rules/configuration-rules/settings/#browser-integrity-check)、[Bot Fight Mode 限制](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/#limitations)。
