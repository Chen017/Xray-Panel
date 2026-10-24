# 1Panel 部署：从安装到打开网站

适用于 Debian / Ubuntu 建站 VPS，使用现有 1Panel、Cloudflare DNS / 橙云及 HTTPS 证书。域名在哪家注册商购买不影响操作，不需要 Cloudflare Tunnel。

以下 `example.com` 全部换成自己的域名。三个域名分别建立网站，不能作为同一网站的附加域名共用一个代理。

| 用途 | 域名示例 | 根路径 `/` 的代理地址 |
| --- | --- | --- |
| 管理面板 | `panel.example.com` | `http://127.0.0.1:3000` |
| Mihomo 订阅 | `sub.example.com` | `http://127.0.0.1:3001` |
| VPS Agent | `agent.example.com` | `http://127.0.0.1:3002` |

## 1. 准备 DNS 和证书

在 Cloudflare 为三个域名添加指向**建站 VPS 公网 IP** 的 A 记录，开启橙云；只有源站 IPv6 可用时才添加 AAAA。不要指向线路机或落地机。

在 1Panel 申请或选择覆盖这三个完整域名的证书。已正常使用的域名与证书直接保留；缺少的网站仍需创建，申请证书不会自动创建网站。Cloudflare SSL/TLS 选择 **Full (strict)**，源站使用 HTTPS。

## 2. 一键安装程序

在 1Panel 的本机 root Bash 终端执行：

```bash
(set -e; w=$(mktemp); trap 'rm -f "$w"' EXIT; curl -fLsS --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 60 https://raw.githubusercontent.com/Chen017/Xray-Panel/v1.3.5/deploy/bootstrap.sh -o "$w"; bash "$w")
```

选择「安装 Panel」，依次输入管理、订阅、Agent 的 HTTPS 域名。程序拉取预构建 Docker 镜像并启动，不需要上传源码、安装 Node 运行环境或手动构建镜像。

安装后检查本机服务：

```bash
xray-panel panel status
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS http://127.0.0.1:3001/health
curl -fsS http://127.0.0.1:3002/health
```

三个请求应返回 `ok: true`，`service` 依次是 `admin`、`subscription`、`agent`。失败时先运行 `xray-panel panel logs`，无需开放公网 3000–3002 端口。

## 3. 配置 Cloudflare 保护

先按 [Cloudflare 指南](cloudflare.md) 完成三个 Access 应用、源站请求头规则和缓存设置，再把网站连到程序：

- 管理域名：Allow，仅管理员邮箱 / 身份账号。
- 订阅域名：Service Auth，仅设备令牌。
- Agent 域名：Service Auth，仅 VPS 令牌。

订阅与 Agent 不使用浏览器验证码登录，否则自动拉取会收到登录页。

## 4. 创建三个反向代理网站

在 1Panel「网站 → 创建网站」选择 **反向代理**，分别填写上表的主域名和代理地址，启用 HTTPS 并选择对应证书。已有站点直接编辑其根代理，不要重复添加 `location /` 或覆盖该域名原有业务。

每个站点检查以下字段：

| 字段 | 内容 |
| --- | --- |
| 代理目录 | `/` |
| 目标地址 | 上表对应的本机 HTTP 地址 |
| 发送域名 / Host | `$host` 或该站点的完整域名 |
| 代理缓存 | 关闭 |

按 [源站保护步骤](cloudflare.md#origin)，在三个网站的 `server` 内检查私密请求头，在根代理内清除该头。通过 1Panel 配置校验后保存、重载，保留原证书设置。

这些本机地址适用于 OpenResty 使用 host 网络的部署；若自定义成桥接网络，容器里的 `127.0.0.1` 指向容器自身，需要另行配置容器互通。

## 5. 打开与验收

在浏览器访问 `https://panel.example.com`，不带 `:3000`。应先完成 Cloudflare 登录，再看到 Xray Panel 密码页；到这里网站部署完成。

新装初始密码在 `/opt/xray-panel/.env` 的 `PANEL_ADMIN_PASSWORD`。旧项目迁移的环境文件可能是 `/opt/xray-panel-manager/panel.env`，实际路径记录在 `/opt/xray-panel-manager/panel.json`。只在首次创建数据库时使用该初始密码。

再按 [Cloudflare 验收](cloudflare.md#verify) 确认机器令牌与源站限制。接下来接入节点见 [节点接入与管理](nodes.md)，客户端配置见 [Mihomo 指南](mihomo.md)。

## 更新与 1Panel 编排

```bash
xray-panel panel update
```

管理器沿用原 Compose 项目、数据卷与加密密钥，更新前备份，健康检查失败恢复。网站、证书和 Cloudflare 不需要重做；各节点 Agent 需分别更新。

生成的 Compose 文件是 `/opt/xray-panel-manager/panel.compose.yaml`。如果在 1Panel 导入管理，**沿用原项目名称并使用该文件内容**，不要再建立第二个项目。项目名、卷名和实际配置路径可查看 `/opt/xray-panel-manager/panel.json`。

## 常见问题

| 现象 | 先检查 |
| --- | --- |
| 本机健康接口失败 | 容器日志、镜像下载、端口占用 |
| 本机正常，网站 502 | 代理端口是否正确、是否误填 HTTPS、OpenResty 网络模式 |
| 仍是默认页面 | 是否编辑了正确域名的根代理 |
| 525 / 526 或重定向循环 | 源站证书、443、Full (strict)，不要使用 Flexible |
| 登录提示来源不匹配 | 环境文件中 `PANEL_ADMIN_ORIGIN` 必须与浏览器 HTTPS 域名一致且不带尾部 `/` |
| 403 / 1010 / Access 登录页 | 按 [Cloudflare 排错](cloudflare.md#troubleshoot) 区分来源 |

改域名时，同时更新三个 `PANEL_*_ORIGIN`、网站与 Access。编辑实际环境文件后，在**原 Compose 项目重新创建容器**才能载入；单纯重启无效，保留 `PANEL_MASTER_KEY` 和数据卷。

参考：[1Panel 创建反向代理网站](https://1panel.pro/docs/v2/user_manual/websites/website_create/)、[Cloudflare Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)。
