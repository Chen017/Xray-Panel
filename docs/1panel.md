# 1Panel + Cloudflare Access 部署：三个入口，到打开面板登录页

本文适用于你的现有环境：管理域名已绑定到 1Panel 网站，Cloudflare 已负责 DNS / 代理，管理站点证书和 HTTPS 已配置完成。域名在哪家注册商购买不影响本流程。保留已有域名和证书，新增订阅 / Agent 域名时仅补齐它们自己的站点与证书，不需要创建 Cloudflare Tunnel 或手动上传项目文件。

完成后的请求路径：访问者 HTTPS → Cloudflare 橙云代理及 Access 认证 → 1Panel 网站 HTTPS / OpenResty → 本机 HTTP 对应端口 → Xray Panel 容器。

本文把三个入口写成下表。全部换成你自己的完整域名；管理后台可以继续使用你已经绑定的那个域名，不必为了示例改名。三个网站都使用根路径 `/`，不要安装到 `/xray/` 这样的子目录。

| 用途 | 示例域名 | 1Panel 反向代理目标 | Cloudflare 代理 | Access 认证 |
| --- | --- | --- | --- | --- |
| 管理后台 | `panel.yourdomain.com` | `http://127.0.0.1:3000` | 橙云 | Allow，仅你的邮箱 / 身份账号 |
| 设备订阅 | `sub.yourdomain.com` | `http://127.0.0.1:3001` | 橙云 | Service Auth，仅设备专属服务令牌 |
| VPS Agent | `agent.yourdomain.com` | `http://127.0.0.1:3002` | 橙云 | Service Auth，仅 VPS 专属服务令牌 |

前端、订阅与 Agent 共用一个容器和一个数据库，不需要启动三个容器。三套 Access 应用与凭据分开。本文包含三个入口的部署、保护和连通性检查，到打开面板登录页结束，不展开登录后添加节点、授权设备或编辑 Mihomo 主配置。

## 第 0 步：确认三个域名和现有证书

1. 在 Cloudflare 的域名「DNS → Records」中，保留管理域名现有记录；为 `sub` 和 `agent` 添加指向建站 VPS 公网 IP 的 A 记录，三个记录的代理状态全部为 Proxied（橙云）。已有正确记录不重复添加。有 AAAA 记录时也要指向可用的源站 IPv6，不能保留错误地址。
2. 在 1Panel「网站」中保留已有管理站点，为订阅和 Agent 分别准备独立站点 / 域名。一个域名对应一个上游端口，不能把三个域名全绑定到管理站点的同一个根代理。
3. 三个网站都启用 HTTPS，分别选择覆盖各自完整域名的现有证书。若当前证书只覆盖管理域名，使用你已经配置的 Cloudflare DNS API 账户，为新增域名申请证书，或使用覆盖这三个名称的 SAN / 泛域名证书。单域名证书不能直接用于另外两个名称；`*.yourdomain.com` 也不覆盖根域名 `yourdomain.com`。
4. Cloudflare「SSL/TLS → Overview」使用 Full (strict)，源站 443 可访问、证书未过期且名称匹配。1Panel 的 HTTP 自动跳转 HTTPS 可以保留。

域名注册商不用更换；Cloudflare DNS API 申请证书、橙云代理和 Zero Trust Access 是不同设置。此处只补齐缺少的两个站点和证书，不重做已经正常工作的管理域名。随后先配置 Access，再将网站代理到程序，避免管理页面在配置期间无 Access 保护。

## 第 1 步：在 1Panel 终端拉取项目

打开建站 VPS 的 1Panel，进入「终端」，连接本机终端。下面的命令在服务器执行，不是在自己电脑执行。使用 root 终端；已经配置好的 Docker 和 OpenResty 不需要重装。

先确认工具：

```bash
git --version
openssl version
docker compose version
```

如果 Debian / Ubuntu 缺少 Git 或 OpenSSL：

```bash
apt-get update
apt-get install -y git openssl
```

如果没有 Docker / Compose，先到 1Panel「容器」页面完成容器引擎安装。服务器还需要能访问 GitHub、Docker Hub 和 npm；本项目首次启动会构建镜像。

拉取公开仓库：

```bash
cd /opt
git clone https://github.com/Chen017/Xray-Panel.git xray-panel
cd /opt/xray-panel
```

成功后，在 1Panel「文件」中打开 `/opt/xray-panel`，应能看到 `Dockerfile`、`package.json`、`deploy` 等文件。Git 会自动检出仓库的默认分支，不用手动填写分支名。

如果提示目录已存在，先检查目录内容；已经克隆过的项目在该目录执行 `git pull --ff-only` 即可，不要再次覆盖或删除目录。

## 第 2 步：创建服务器自己的配置

在同一个终端执行：

```bash
cd /opt/xray-panel
cp -n .env.example .env
chmod 600 .env
openssl rand -hex 32
openssl rand -hex 24
```

最后两条命令分别生成：

1. 第一行 64 位随机值：数据库加密密钥。
2. 第二行 48 位随机值：首次登录管理员密码。

在 1Panel「文件」中打开 `/opt/xray-panel/.env`，启用显示隐藏文件。编辑以下六项；不要把 `＜…＞` 说明文字也填进去：

```dotenv
PANEL_MASTER_KEY=＜第一行随机值＞
PANEL_ADMIN_PASSWORD=＜第二行随机值＞
PANEL_ADMIN_ORIGIN=https://panel.yourdomain.com
PANEL_SUBSCRIPTION_ORIGIN=https://sub.yourdomain.com
PANEL_AGENT_ORIGIN=https://agent.yourdomain.com
PANEL_SECURE_COOKIE=true
```

注意：

- 三个 `ORIGIN` 都换成对应真实域名，使用 `https://`，末尾不加 `/`，不加路径，不加内部端口。
- 其余行保留模板默认值。Cloudflare 服务令牌在后面的步骤创建，不填写进控制中心的 `.env`。
- 不要上传 `.env` 到 GitHub。它已经被项目的 Git 忽略规则排除。
- 保存好第一行密钥和第二行密码。以后更新项目保留此 `.env`；重新生成密钥会导致旧数据库无法解密。

这里不需要安装 Node.js，也不需要在宿主机执行 `npm install`，镜像构建会完成这些工作。

## 第 3 步：在 1Panel 创建容器编排

1. 进入「容器 → 编排」。
2. 点击「创建编排」。
3. 名称填写 `xray-panel`。
4. 选择「路径选择」。
5. 选择服务器上的文件：

   ```text
   /opt/xray-panel/deploy/1panel/docker-compose.yml
   ```

6. 确认创建并启动，等待构建结束。名称类似“立即启动”的选项如果存在，保持勾选。
7. 在该编排的容器列表中，确认 `panel` 服务对应的容器处于运行状态；稍后健康状态应为 `healthy`。

如果版本中的路径选择控件不能选中该文件，可在 1Panel 文件管理器复制这个文件的全部内容，再在「创建编排 → 编辑」中粘贴。使用的仍是 `deploy/1panel/docker-compose.yml`，不要把项目根目录里的相对路径版本直接粘贴进去。

专用编排使用绝对源码路径和绝对 `.env` 路径，避免 1Panel 的编排目录影响镜像构建。数据存储在固定名称的 Docker 卷 `xray-panel_panel-data` 中，重建容器不会删除它。

已经部署过旧版本时，先检查旧容器挂载的数据卷名称。若不是 `xray-panel_panel-data`，把专用编排底部 `name:` 改成现有卷名，避免误接到一个空数据库。本步骤面向首次部署，不创建第二份运行中的面板。

首次构建需要下载基础镜像和依赖，通常比后续启动慢。若失败，先在编排日志中找到第一条失败原因，不要重复创建多个同名编排。

## 第 4 步：确认网站程序已正常运行

回到 1Panel 终端执行：

```bash
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS http://127.0.0.1:3001/health
curl -fsS http://127.0.0.1:3002/health
```

预期结果：

```json
{"ok":true,"service":"admin"}
{"ok":true,"service":"subscription"}
{"ok":true,"service":"agent"}
```

这一步成功说明程序已在服务器本机运行。3000、3001、3002 都只绑定到本机地址，无需给它们开放公网防火墙端口。

如果不是这个结果，先检查 1Panel 的容器日志，常见原因是 `.env` 密钥格式不对、密码少于 16 字符、端口已被其他程序占用或首次构建没有成功。此时先不要修改已正常工作的证书和 DNS。

<a id="access"></a>

## 第 5 步：为三个域名分别创建 Access 应用

进入 Cloudflare Zero Trust / Cloudflare One。首次使用时按控制台提示建立组织和团队名称；本教程使用公开域名的 Access 应用，不要求安装 WARP 或 cloudflared。不同版本菜单可能简写为「Access → Applications」。

### 5.1 管理后台：邮箱验证码或已有身份提供商

如果你准备使用邮箱验证码，先进入「Integrations → Identity providers → Add new identity provider」，添加 **One-time PIN**。新组织未必默认启用它，不能只填邮箱就假设已有此登录方式。已经配置了自己的身份提供商时，也可直接使用，支持 MFA 时启用 MFA。

随后：

1. 进入「Access controls → Applications → Create new application」。
2. 选择 **Self-hosted / Self-hosted and private**，添加 **Public hostname**。
3. 名称填写 `Xray Panel Admin`；Host 填你的管理域名，例如 `panel.yourdomain.com`；Path 留空，覆盖整个域名。
4. 创建策略：名称 `admin-only`，Action 为 **Allow**，Include 选择 **Emails** 并填写你自己的完整邮箱，或选择受信任的身份账号 / 组。不要选择 Everyone，也不要只限制一个所有人都能注册的邮箱后缀。
5. 登录方式选择刚添加的 One-time PIN 或已有身份提供商；会话时长可设置为 12 小时。
6. 保存应用。不要添加 Bypass 策略，也不要让订阅和 Agent 的服务令牌进入后台应用。

最终效果：浏览器先完成 Cloudflare 登录，再看到面板自己的管理员密码页。Cloudflare 登录不会代替面板密码。

### 5.2 订阅入口：每台设备独立服务令牌

1. 进入「Access controls → Service credentials → Service Tokens → Create Service Token」。旧版可能显示为「Access → Service Auth」。
2. 为每台设备分别创建令牌，例如 `sub-laptop`、`sub-phone`，设置有效期，在到期前安排更新客户端配置。
3. 生成后保存 **Client ID** 和 **Client Secret**，Secret 只显示一次。使用控制台给出的原值，不自行补后缀、不按固定长度改写。
4. 再创建一个 Self-hosted 公开应用，名称 `Xray Panel Subscription`，Host 为 `sub.yourdomain.com`，Path 留空。
5. 策略名称 `subscription-devices`，Action 必须为 **Service Auth**；Include 选择 **Service Token**，只加入订阅设备的令牌。
6. 保存应用。不添加邮箱 Allow 或 Everyone / Bypass；不选择 Any Access Service Token。

后续每台设备的 Mihomo 请求同时带 CF 的两个头和面板的设备 Bearer Token。这里先保存 CF 凭据，部署验证阶段不需要先在面板内创建设备。

### 5.3 Agent 入口：每台 VPS 独立服务令牌

1. 在同一 Service Tokens 页面，为各 VPS 分别创建令牌，例如 `agent-vps-01`、`agent-vps-02`。不要复用订阅设备的令牌。
2. 创建第三个 Self-hosted 公开应用，名称 `Xray Panel Agent`，Host 为 `agent.yourdomain.com`，Path 留空。
3. 策略名称 `vps-agents`，Action 为 **Service Auth**；Include 的 **Service Token** 只选择各 VPS 的 Agent 令牌。
4. 保存应用。不添加邮箱登录 / Everyone / Bypass；不选择 Any Access Service Token。

三个应用分别匹配精确域名，不用一个 `*.yourdomain.com` 邮箱登录应用覆盖全部入口。若已有通配应用或账号级 Access 策略，检查最终匹配和允许规则，确保不会额外放行其他身份。

<a id="origin"></a>

## 第 6 步：添加源站校验和缓存规则

### 6.1 由 Cloudflare 添加源站专用请求头

现有 Node 服务不验证 Access JWT。只套 Access 但继续允许任意请求直达 VPS 上的网站，会留下绕过 Cloudflare 这一层认证的入口。本教程保留现有 1Panel HTTPS，通过 Cloudflare 加入一段私密请求头、OpenResty 检查它，阻止不知道该值的直连请求；它不代替 Access、面板密码或 Bearer Token，也不保护源站 IP 免受网络层攻击。

在 VPS 终端生成第三个独立随机值，作为源站密钥；不要复用数据库密钥、管理员密码或任何服务令牌：

```bash
openssl rand -hex 32
```

保存这段 64 位十六进制值。进入 Cloudflare **该域名的站点控制台**，不是 Zero Trust 控制台：

1. 「Rules → Overview → Create rule → Request Header Transform Rule」。旧版入口可能叫「Transform Rules → Modify Request Header」。
2. 名称 `xray-panel-origin`，用表达式编辑器填写下列条件，并替换成三个真实域名：

   ```text
   http.host in {"panel.yourdomain.com" "sub.yourdomain.com" "agent.yourdomain.com"}
   ```

3. 动作选 **Set static**，Header name 填 `X-Xray-Panel-Origin`，Value 填刚生成的源站密钥。
4. 点击 Deploy。必须是修改**请求头**，不是响应头；Set 会覆写访问者自带的同名头。不要配置任何把这个私密值回显给浏览器的规则。

### 6.2 三个入口均绕过 CDN 缓存

在该域名「Caching → Cache Rules → Create rule」使用上面同样的三个域名条件，将 Cache eligibility 设置为 **Bypass cache** 并部署。确认其他后续匹配规则没有再将这些域名改成缓存所有内容。

订阅和 Agent 不能经过交互式 WAF / Bot 验证页面。若你已有规则对这两个域名发起 Managed / Interactive Challenge，将它们从该质询条件中排除，保留 Access Service Auth 和其他适用的防护。免费 Bot Fight Mode 不能通过普通 WAF Skip 规则豁免；若它误拦合法机器请求，需要关闭该模式，或使用支持按请求排除的防护方案，不能用 Access Bypass 冒充解决。

## 第 7 步：把三个 1Panel 网站连接到对应端口

先确认三个 Access 应用和源站请求头规则已启用。在 1Panel 中分别打开管理、订阅、Agent 对应的网站：

1. 进入「网站 → 对应网站 → 配置」。
2. 找到「反向代理」。
3. 新建或编辑该网站的根路径代理，填写：

   | 项目 | 填写内容 |
   | --- | --- |
   | 名称 | 管理站 `xray-panel`；另外两站可用 `xray-sub`、`xray-agent` |
   | 代理目录 / 匹配路径 | `/` |
   | 目标地址 / 代理地址 | 管理站 `http://127.0.0.1:3000`；订阅站 `http://127.0.0.1:3001`；Agent 站 `http://127.0.0.1:3002` |
   | 发送域名 / Host（如果有） | `$host`，或当前站点绑定的完整域名 |
   | 缓存 | 关闭 |

4. 在每个网站的配置文件中，把下面的检查放在对应 `server { ... }` 内、所有 `location` 外，且在该 server 的其他 `return` / `rewrite` 前。将占位文字替换成第 6 步的同一段源站密钥：

   ```nginx
   if ($http_x_xray_panel_origin != "替换成第三个64位随机值") {
       return 403;
   }
   ```

5. 在该网站的已有根代理 `location /` 内增加下面一行，不把源站密钥继续转发给面板程序：

   ```nginx
   proxy_set_header X-Xray-Panel-Origin "";
   ```

6. 通过 1Panel 配置校验后保存并重载；保留现有 HTTPS 和证书。三个站点都执行，不只配置后台。若另有 HTTP / HTTPS server 会将请求代理到这些程序端口，它也必须做同样校验；仅将 HTTP 跳转到 HTTPS 的 server 不提供程序入口。

这是三个站点自己的配置，不改全局 OpenResty 配置，不改其他网站，也不更改 SSH / 1Panel 管理端口的防火墙规则。Cloudflare 使用你现有的 DNS API 做证书验证不受此请求头校验影响；依赖 HTTP 文件验证的其他证书续期不能直接套用本教程。

不同 1Panel 版本可能把它显示为“目标 URL”“代理地址”或“目标地址”，按上表为各站点填写对应的本机端口。它们是本机容器的 HTTP 服务，不要将上游写成 HTTPS，也不要写服务器公网 IP。

这里要代理整个 `/`，因此原网站在这个域名下的内容会由 Xray Panel 接管。若该站点已有其他业务，不要覆盖它，应给 Xray Panel 单独使用一个站点域名。已有根路径代理时编辑它，不要叠加两个 `location /`。

如果当前站点类型没有反向代理入口，不要删除现有站点和证书。在其配置文件中让已有的根 `location /` 使用下面的内容，并通过 1Panel 配置校验后重载；其余 HTTPS / 证书配置保留：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Xray-Panel-Origin "";
}
```

这是管理站的根代理示例，订阅站和 Agent 站分别把 `proxy_pass` 端口改为 3001、3002。源站 `if` 校验仍放在各自 server 内；不要用这段 location 覆盖整个站点配置或证书。

以上本机地址适用于 1Panel OpenResty 使用 host 网络的部署。若你曾自定义过 OpenResty 的 Docker 网络，出现“本机健康检查成功，但网站 502”时，先在 1Panel 容器详情检查 OpenResty 的网络模式：桥接容器中的 `127.0.0.1` 是容器自身。这种自定义网络需要单独配置容器间网络，不能靠把面板端口公开到 `0.0.0.0` 来解决。

<a id="verify"></a>

## 第 8 步：验证三入口认证和源站限制

以下命令仍在 VPS 的 Bash 终端执行，URL 全部换成真实域名。不要添加 `curl -L`，避免跟随到登录页后误以为已访问程序。

### 8.1 不带 Cloudflare 凭据

```bash
curl -i --max-time 20 https://panel.yourdomain.com/api/health
curl -i --max-time 20 https://sub.yourdomain.com/health
curl -i --max-time 20 https://agent.yourdomain.com/health
```

后台应跳转 Cloudflare 登录或被拒绝。订阅 / Agent 应返回 Access 拒绝（常见 401 / 403，部分旧配置为 302），不能返回程序的 `ok:true` 健康 JSON。

### 8.2 订阅凭据只能通过订阅应用

先输入一台订阅设备的 CF 凭据。下面使用隐藏输入读取 Secret，避免将密钥写进命令历史；不要把终端里的凭据发给别人：

```bash
read -r -p "Subscription Client ID: " CF_SUB_ID
read -r -s -p "Subscription Client Secret: " CF_SUB_SECRET
printf '\n'
curl -i --max-time 20 \
  -H "CF-Access-Client-Id: $CF_SUB_ID" \
  -H "CF-Access-Client-Secret: $CF_SUB_SECRET" \
  https://sub.yourdomain.com/health
```

应返回 200 和 `{"ok":true,"service":"subscription"}`。这只验证 Access 与反向代理；health 不需要面板设备 Token。

验证订阅正文仍有第二层认证（这里故意使用不存在的设备 ID，不带面板 Bearer）：

```bash
curl -i --max-time 20 \
  -H "CF-Access-Client-Id: $CF_SUB_ID" \
  -H "CF-Access-Client-Secret: $CF_SUB_SECRET" \
  https://sub.yourdomain.com/v1/subscriptions/00000000-0000-0000-0000-000000000000
```

应由面板返回 **401**，JSON 为 `{"error":"订阅凭据无效"}`。这不是部署失败。

再把同一订阅 CF 凭据用于 Agent 和管理域名：

```bash
curl -i --max-time 20 \
  -H "CF-Access-Client-Id: $CF_SUB_ID" \
  -H "CF-Access-Client-Secret: $CF_SUB_SECRET" \
  https://agent.yourdomain.com/health
curl -i --max-time 20 \
  -H "CF-Access-Client-Id: $CF_SUB_ID" \
  -H "CF-Access-Client-Secret: $CF_SUB_SECRET" \
  https://panel.yourdomain.com/api/health
unset CF_SUB_ID CF_SUB_SECRET
```

两者应被 Access 拒绝或跳到登录，不能返回程序的健康 JSON。否则应用的允许列表没有正确分开。

### 8.3 Agent 凭据与面板认证

```bash
read -r -p "Agent Client ID: " CF_AGENT_ID
read -r -s -p "Agent Client Secret: " CF_AGENT_SECRET
printf '\n'
curl -i --max-time 20 \
  -H "CF-Access-Client-Id: $CF_AGENT_ID" \
  -H "CF-Access-Client-Secret: $CF_AGENT_SECRET" \
  https://agent.yourdomain.com/health
curl -i --max-time 20 \
  -H "CF-Access-Client-Id: $CF_AGENT_ID" \
  -H "CF-Access-Client-Secret: $CF_AGENT_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{}' https://agent.yourdomain.com/v1/agent/poll
```

第一条请求应返回 200 和 `{"ok":true,"service":"agent"}`。第二条故意不带面板 Agent Token / 节点 ID，应返回 **401** 和 `{"error":"Agent 凭据无效"}`。

再确认 Agent CF 凭据不能通过订阅应用，也不能进入后台健康接口：

```bash
curl -i --max-time 20 \
  -H "CF-Access-Client-Id: $CF_AGENT_ID" \
  -H "CF-Access-Client-Secret: $CF_AGENT_SECRET" \
  https://sub.yourdomain.com/health
curl -i --max-time 20 \
  -H "CF-Access-Client-Id: $CF_AGENT_ID" \
  -H "CF-Access-Client-Secret: $CF_AGENT_SECRET" \
  https://panel.yourdomain.com/api/health
unset CF_AGENT_ID CF_AGENT_SECRET
```

两者应被 Access 拒绝或跳到登录，不能返回程序健康 JSON。订阅 CF 凭据也不应授权后台。

### 8.4 防止绕过 Cloudflare 直连源站

本小节改在 **VPS 以外的电脑终端**执行，避免源站公网 IP 回环行为影响判断。Windows PowerShell 使用 `curl.exe` 替代下面的 `curl`。将 `源站公网IPv4` 和域名换成实际值，分别测试三个站点；命令保留域名和 TLS SNI，仅将连接指向源站，不发送私密源站请求头：

```bash
curl -i --max-time 20 --resolve panel.yourdomain.com:443:源站公网IPv4 https://panel.yourdomain.com/api/health
curl -i --max-time 20 --resolve sub.yourdomain.com:443:源站公网IPv4 https://sub.yourdomain.com/health
curl -i --max-time 20 --resolve agent.yourdomain.com:443:源站公网IPv4 https://agent.yourdomain.com/health
```

应由源站返回 **403**；如果防火墙已拒绝非 Cloudflare 来源，也可能连接被拒绝 / 超时。不能返回健康 JSON。仍有源站公网 IPv6 时也要用 `--resolve '域名:443:[实际IPv6]'` 检查该入口。

若源站使用 Cloudflare Origin CA 证书，系统 curl 可能不信任其根证书，此时还未完成 HTTP 检查。按 [Origin CA 官方说明](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)取得对应根证书，使用 `--cacert /根证书绝对路径` 后重试；不要把单纯证书错误当作已验证了 403，也不要关闭生产 TLS 校验。

源站密钥不要放进客户端 YAML、Agent JSON、URL、响应头或公开仓库；客户端只持有自己的 Service Token 和面板 Token。也不要仅凭任意请求中出现了 `CF-Access-*` 或邮箱头就当作已经登录。完整 JWT 校验是另一种源站保护方案，本教程没有声称当前程序已实现它。

## 第 9 步：打开受保护的管理网站

在自己的浏览器访问：

```text
https://panel.yourdomain.com
```

换成你的真实域名，不带 `:3000`。使用无痕窗口验证：先看到 Cloudflare Access 登录，使用被允许的邮箱收取验证码或完成身份登录，通过后才看到 **Xray Panel** 的管理员密码登录页。非允许身份不能进入。

初始密码是第 2 步保存到 `.env` 的 `PANEL_ADMIN_PASSWORD`。到这里部署教程结束，不需要先接入 VPS 节点、创建订阅或配置 Mihomo，网站就能打开。

以后实际连接客户端时，订阅请求需要 CF 的 `CF-Access-Client-Id` / `CF-Access-Client-Secret` 和面板的 `Authorization: Bearer ...`；Agent 在自己的 JSON 中配置对应 CF 两个字段，原面板 Token 保留。两类 CF 令牌不能混用。只需查阅凭据字段时见 [Cloudflare 认证说明](cloudflare.md)；后续面板使用步骤不在本教程范围内。

## 打不开时，对照现象检查

| 现象 | 检查位置 |
| --- | --- |
| `127.0.0.1:3000/api/health` 访问失败 | 1Panel 编排构建日志、容器日志和容器状态；先解决程序启动问题 |
| 健康检查成功，域名显示 502 | 网站代理地址、OpenResty 网络模式，是否误填 HTTPS 上游 |
| 仍显示 1Panel 默认页 / 原网站 | 根路径代理是否生效，是否编辑了正确域名的站点；清理已有的站点缓存 |
| 页面能打开，登录提示“请求来源不匹配” | `.env` 中 `PANEL_ADMIN_ORIGIN` 必须与浏览器协议和域名一致；修改后需重建容器以载入新环境变量，单纯重启不够 |
| HTTPS 重定向循环 | 保留源站 HTTPS；Cloudflare SSL/TLS 使用与源站证书匹配的 Full (strict)，避免 Flexible 与源站强制 HTTPS 冲突 |
| Cloudflare 525 / 526 | 检查现有源站 443、站点证书及证书链，和应用内部 3000 端口不是一回事 |
| 浏览器显示 Access 拒绝 / 不收到邮箱码 | 管理域名应用的 Emails 列表、启用的 One-time PIN / 身份提供商、所用邮箱与日志 |
| CF 凭据请求 `/health` 仍返回 HTML / 302 | 是否使用 Service Auth，是否选中了该令牌，是否过期，是否发全了两个头，是否有质询页面 |
| 合法 CF 凭据访问三个站点均由源站返回 403 | Request Header Transform Rule 是否部署并匹配真实 Host、是否误建成响应头规则；源站密钥是否与三个 server 配置一致 |
| 源站直连仍返回健康 JSON | 三个站点是否都加了 server 级检查、是否有漏掉的 HTTP / HTTPS 代理 server 或公开的内部端口 |
| 一台设备到期后订阅 / Agent 突然中断 | 对应 Cloudflare 服务令牌的有效期；面板 Token 有效并不表示 CF Token 仍有效 |

修改 `.env` 后，在原编排中执行重新创建 / 重建容器，保留数据卷；不要仅点击“重启”，也不要另外创建第二个编排。不同版本按钮名称可能为“重建”或“更新”，目标是让 Compose 用新环境变量重新创建原服务。

更新项目时保留 `.env`、现有数据卷、三个网站配置和 Cloudflare 规则。在 `/opt/xray-panel` 执行 `git pull --ff-only` 后，于原编排重新构建镜像并重新创建原服务；不要删除数据卷。每台设备 / VPS 的 CF 令牌和面板令牌分别撤销和轮换：撤销面板授权不会自动删除 Cloudflare Service Token。

## 参考与验证范围

已核对 [1Panel 编排](https://1panel.pro/docs/v2/user_manual/containers/composes/)、[1Panel 网站配置](https://1panel.pro/docs/v2/user_manual/websites/website_config_basic/)、[Cloudflare Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)。

Access 菜单和凭据以 [Self-hosted 应用](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)、[One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)、[Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) 为准。源站校验组合参考 [请求头转换规则](https://developers.cloudflare.com/rules/transform/request-header-modification/create-dashboard/) 和 [NGINX if / return](https://nginx.org/en/docs/http/ngx_http_rewrite_module.html#if)；机器人验证限制见 [Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)。核对日期：2026-10-23。

本项目服务与登录页的本地测试记录见 [test-report.md](test-report.md)。本次教程更新已检查示例 Bash 语法、YAML / JSON、文档本地链接、编排路径 / 端口 / 数据卷，并用隔离实例实际核对三个健康接口和两类业务路由缺少 Bearer 时的 401 响应。此教程中的 Cloudflare 策略、真实域名证书和 1Panel / OpenResty 配置仍需按第 8、9 步在你的环境验收；没有连接你的 VPS 或 Cloudflare 账户，也没有在本机运行 NGINX，不能声称已验证这些配置的实际部署结果。
