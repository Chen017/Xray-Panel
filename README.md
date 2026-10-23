# Xray Panel

面向 Chen017/Xray 脚本的多节点管理与 age 加密 Mihomo 订阅平台。代码全部位于本目录。

前端从 Remnawave 的 Mantine 主题、Sidebar AppShell 布局精简改造；保留原作者许可证与来源记录，删除用户套餐、计费、流量统计、机器人、SSH 终端等模块。后端与主动连接 Agent 为适配当前 Bash 脚本编写，不需要 Remnawave 后端、PostgreSQL 或 Redis。

## 已实现

- 节点增删改、状态心跳、配置导入、批量部署和任务结果。
- 端口、UUID、REALITY 密钥、各栈 SNI / Short IDs、XHTTP 路径和完整 xhttpSettings。
- IPv4 / IPv6 上下行方向、单栈 / Vision / 双栈订阅、出站解析和 Happy Eyeballs。
- 自定义分流规则增删改与排序，支持 DOMAIN / DOMAIN-SUFFIX / DOMAIN-KEYWORD / IP-CIDR / GEOSITE / GEOIP。
- 一条线路绑定多个落地、VLESS 中继链接导入、NAT 内外端口、来源 IPv4 限制、故障转移顺序和探测间隔。
- 完整服务端 JSON 文件集合编辑，包括多入站文件和表单未列出的所有 Xray 参数。
- 服务启停 / 重启 / 自启、配置校验、日志、网络 / SNI 诊断、中继测试、端口开关、BBR、脚本 / 固定版核心 / geodata 更新、维护重装、标准 / 纯落地安装、卸载。
- 每设备独立 Bearer Token、age 公钥、每节点每出口独立 UUID、授权与撤销、Token / UUID 轮换、审计。
- SQLite AES-256-GCM 加密存储、密码 scrypt 哈希、HttpOnly 会话、CSRF、登录限速、加密备份恢复。

## 本地运行

要求 Node.js >= 24.13.0。Agent 要求 Linux、Python >= 3.10、Bash、jq、flock；对现有安装的管理直接使用该 VPS 的脚本模块。

```powershell
cd D:\Code\Xray-Panel
npm ci
npm run setup
npm run build
npm start
```

浏览器打开 http://127.0.0.1:3000 。初始随机密码在自动生成的 `.env` 的 `PANEL_ADMIN_PASSWORD` 中；不会写进源码或页面。开发模式为 `npm run dev`，地址 http://127.0.0.1:5173 。开发进程不会修改生产 `.env` 中的地址。

本地启动默认没有假节点、假在线状态或预置设备。添加实际 Agent 后显示实际状态。

## 1Panel / Docker 部署

**域名、Cloudflare DNS / 代理、1Panel HTTPS 证书已经配置好：直接按 [1Panel + Cloudflare Access 完整部署教程](docs/1panel.md) 操作。包含三个域名的反向代理、后台身份登录、订阅 / Agent 独立服务令牌、源站校验和验收，从 GitHub 拉取到打开登录页，无需手动上传项目或 Cloudflare Tunnel。**

在建站 VPS 的 root 终端执行（不需要安装 Xray Script）：

```bash
(set -e; w=$(mktemp); trap 'rm -f "$w"' EXIT; curl -fLsS --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 60 https://raw.githubusercontent.com/Chen017/Xray-Panel/v1.3.0/deploy/bootstrap.sh -o "$w"; bash "$w")
```

打开编号菜单，选择「安装 Panel」，输入管理、订阅、Agent 三个 HTTPS 域名。管理器自动生成密钥、初始密码和配置，拉取 GHCR 的对应版本镜像并启动；VPS 不构建前端，也不用手动上传源码。以后输入 `xray-panel` 重新打开菜单。

```bash
xray-panel panel install
xray-panel panel update
xray-panel panel status
xray-panel panel logs
xray-panel panel uninstall
```

默认卸载保留数据卷、环境配置和备份。彻底清除需显式执行 `xray-panel panel uninstall --purge --confirm DELETE-PANEL-DATA`，不可恢复当前数据库；历史备份仍保留。管理器检测现有 1Panel 容器并沿用原 Compose 项目、数据卷和运行中的加密密钥，更新前保存一致数据库快照，健康检查失败恢复原镜像和数据库。

管理器生成的编排位于 `/opt/xray-panel-manager/panel.compose.yaml`。已有 1Panel 编排只替换原编排内容，保留原名称；不要重复创建。配置路径见 `/opt/xray-panel-manager/panel.json`，初始新装默认 `.env` 为 `/opt/xray-panel/.env`，旧项目迁移使用 `/opt/xray-panel-manager/panel.env`。勿公开这些文件。

安装要求 Debian / Ubuntu、systemd、Python >= 3.10；首次引导安装缺失依赖。镜像支持 Linux amd64 / arm64。**命令依赖对应版本 GitHub Release 和 GHCR 镜像已发布；发布工作流在测试和镜像上传成功后才创建 Release。** 指定版本可加 `--version 1.3.0`；未发布版本拉取失败不会替换正在运行的容器。

三个 HTTPS 网站分别反向代理到本机 3000 / 3001 / 3002，`.env` 中三个 `ORIGIN` 填对应 HTTPS 域名，不带尾部 `/`。保留已配好的管理域名和证书，为订阅和 Agent 补齐各自站点与证书。

三个域名都开启橙云，各自创建 Access 应用：后台用 Allow 限定管理员身份，订阅和 Agent 用 Service Auth 分别限定设备 / VPS 令牌。源站还需要按教程限制绕过 Cloudflare 的直连访问；凭据字段与机器接入参考 [Cloudflare 认证说明](docs/cloudflare.md)。

三个独立入口：

| 入口 | 宿主机监听 | 用途 |
| --- | --- | --- |
| panel.example.com | 127.0.0.1:3000 | 管理 UI 和管理 API |
| sub.example.com | 127.0.0.1:3001 | 仅设备订阅 API |
| agent.example.com | 127.0.0.1:3002 | 仅 Agent API |

同一个 Node 进程运行三个 HTTP 监听器，路由相互隔离；共享一个加密数据库，不需要额外订阅进程。不要把管理入口代理到订阅域名。

发布工作流在 GitHub 构建镜像，需要访问 npm / Docker Hub；VPS 只需访问 GitHub 和 GHCR。镜像构建阶段生成静态面板及不含 `.env`、数据库或凭据的 AGPL 源码包；运行阶段使用非 root 用户、只读根目录和独立数据卷。

## 接入每台 VPS

1. 在面板添加节点，留空的客户端地址默认自动检测，也可填写手动 IP / 域名。
2. 填写该 VPS 的 CF Access Client ID / Secret，复制「完整安装脚本」，直接粘贴到目标 VPS 的 root Bash 终端执行即可；也可下载脚本执行。**独立一键安装保留，不需要 Xray Script。**
3. 另一种方式是先执行上方不含凭据的管理器命令，再运行 `xray-panel agent install`，一次粘贴面板生成的接入信息；输入隐藏，无需编辑 JSON。
4. 等待面板显示在线并自动导入现有配置。接入只安装 Agent，不会重新安装或部署 Xray。

```bash
xray-panel agent install
xray-panel agent update
xray-panel agent status
xray-panel agent logs
xray-panel agent uninstall
```

安装和更新均先检查 `/etc/xray-panel-agent/config.json` 和旧 systemd 服务。重复安装保留节点身份、CF 凭据、自定义 Xray / 状态目录；不同节点 ID 会拒绝覆盖。轮换 Token 后可重新粘贴同一节点的新接入信息。旧版 `/opt/xray-panel/agent` 会迁移到独立 `/opt/xray-panel-agent`，不会删除共享的 Panel 目录；更新失败恢复旧程序、配置与服务状态。

Xray Script 更新后也可在「杂项管理 → Panel Agent 管理」进入相同菜单，或直接 `xray agent install|update|uninstall|status|logs`。它会先检查本机是否已有 Agent，不经过 Xray 配置迁移或重装流程。

Agent 卸载默认保留接入配置和任务状态；`--purge --confirm DELETE-AGENT-DATA` 才清除默认凭据与状态。无论哪种卸载都保留 Xray。Agent 不监听公网端口，凭据不放到命令参数或 URL；安装脚本内的 Base64 只是传递格式，含真实凭据，请勿分享。首次仍需在每台 VPS 执行一次命令，因为 Panel 没有该 VPS 的登录权限。

## 公网地址与节点操作

节点页分基础参数、分流规则、线路 / 落地、运维、高级五页。UUID、密钥、Short IDs、XHTTP 和完整 JSON 在高级折叠项；常用 SNI、方向、端口和出站策略在基础页。运维点击后直接显示任务窗口，状态和输出来自真实任务回执；关闭窗口不取消任务，可在节点和全局任务历史重新打开。

新版 Agent 每 5 分钟分别探测公网 IPv4 / IPv6，两个独立时间点结果一致且间隔至少 10 秒才采用；支持立即检测。失败保留最后有效地址。旧记录按原手动值迁移；NAT、DDNS 或入站地址与出站公网不同的机器应设置手动覆盖。节点页显示当前有效值、来源、时间和待确认状态。仅改变客户端地址更新订阅，不重启 Xray。

线路可关联面板中的落地节点，之后跟随该落地的有效地址和公网映射端口，通过正常校验、部署与回滚任务更新线路出站。未接入面板的外部落地仍可手动配置；NAT 映射本身需在宿主机或云平台配置。

运维防火墙显示实际 iptables / ip6tables / nftables 规则快照（地址族、协议、来源、端口、动作和原始表达式），与 Xray 自动端口、手动附加开关策略分开。权限不足或缺少工具明确显示不可读取；没列出的端口不能据此判断为关闭，本机规则也不能证明云防火墙或 NAT 后公网可达。

## 使用顺序

1. 接入落地机，生成互联参数，填写公网 IP / NAT 映射端口并部署。
2. 在线路机的互联页导入落地链接，设置别名、多个出口和可选故障转移，保存并部署。
3. 授权设备：填写或在浏览器本地生成 age 公钥，勾选节点、出口及连接方式。私钥仅在浏览器本地生成，不发给服务器。
4. Agent 自动把设备的独立 UUID 部署到有关节点，任务成功后订阅才可用。
5. 将仅显示一次的 provider 配置合并到本地 Mihomo 主配置。DNS、策略组、规则由本地文件继续维护，详见 docs/mihomo.md。

保存草稿不会改变 VPS。点击「保存并部署」后，Agent 在现有脚本 `.operation.lock` 内检查配置是否被外部修改，在 staging 目录写入文件，调用真实 Xray `run -test`，校验成功后应用；防火墙或服务重启失败则按原脚本事务恢复。停止的服务在普通配置部署后保持停止。

保存、预览和部署会包含所有页签的未保存修改。若同时编辑完整配置与表单，面板会要求选择保留一种编辑方式，避免互相覆盖；另一页面修改草稿时，本地编辑会保留，并提示核对后重新载入。

面板订阅仅使用部署成功回执对应的配置；失败部署不会发布新参数。控制中心离线时，节点继续运行现有配置，Mihomo 继续使用已有缓存。

通过原脚本或 SSH 修改过配置后，应先查看当前配置、再「导入 VPS 当前配置」。面板使用文件内容哈希阻止覆盖未导入的外部变化。请避免面板与交互脚本同时修改同一节点。

## 凭据撤销与轮换

- 撤销设备：订阅 Token 立即失效，Agent 随后删除该设备 UUID。离线 VPS 必须等 Agent 恢复后才撤掉服务器上的 UUID。
- 仅轮换 Token：立即失效旧 Token，不改变 UUID；在本地替换 Authorization 请求头即可。
- 轮换 UUID：同时生成新 Token 和 UUID，等待任务完成，再更新本地 Token；age 私钥保持原值。
- 更换 age 公钥：在设备编辑页替换，本地同步替换 `age-secret-key`。服务器从不通过订阅请求头接受可任意替换的公钥。
- 轮换 Agent Token 后，需在该 VPS 配置文件中同步新 Token 并重启 Agent。
- 已经建立的 Xray 连接可能持续到连接关闭；移除 UUID 主要阻止之后的新认证。

授权同步只有在对应版本部署成功后才确认完成。失败或取消任务后仍保留“待同步设备授权”，Agent 在线时从 5 秒起重试，逐步退避至最长 5 分钟；任务执行期间产生的新授权变更会继续同步。

若 Agent 无法解析配置 JSON，它仍会上报心跳和错误，日志与诊断任务仍可领取。配置不可读期间暂停自动部署，避免用旧快照覆盖文件；修复配置文件后恢复正常同步。重试已执行任务时会重新读取当前配置，旧回执不会重新发布已经改变的参数。

## 备份与恢复

面板安全设置可以导出加密备份。必须另外安全保存 PANEL_MASTER_KEY；失去它将无法解密数据库、恢复备份或重新派生原设备 UUID。不要直接修改此密钥来做轮换。

恢复会覆盖面板记录，并注销全部管理会话；需要原 master key。包含正在执行任务的备份应在 Agent 完成后再导出，以免恢复后需要核查不确定的任务状态。VPS 的运行配置不随数据库恢复自动倒退，恢复后先同步检查。

加密 JSON 备份和恢复支持最大 64 MiB、100,000 条记录；导出前检查相同上限，避免生成无法恢复的文件。较大的恢复正文只有通过管理员会话、Origin 和 CSRF 验证后才解析，其他接口仍保留 2 MiB 限制。

Panel 和 Agent 分别使用 `xray-panel panel update`、`xray-panel agent update` 更新。旧 Agent 仍能连接新版 Panel；公网探测和防火墙快照需要在对应 VPS 单独更新 Agent，不会由 Panel 更新自动改动所有 VPS。始终保留原加密密钥和身份。

## 本地测试

```powershell
npm test
npm run test:agent
npm run build
npm run test:e2e
npm run package
npm run test:release
```

首次在其他机器运行 E2E 前，执行 `python scripts/fetch-test-tools.py` 下载带校验的固定测试核心到 .local/tools。Windows 要求 WSL Debian；可通过 XRAY_TEST_WSL 改为其他发行版。Linux 可直接运行，要求主机 Node.js >= 24.13.0。也可以用 XRAY_LINUX_BIN / MIHOMO_LINUX_BIN 指定已有 Linux 二进制。

测试范围与实测环境见 docs/test-report.md。Linux 事务测试使用真实 Xray v26.3.27 和 Mihomo v1.19.32；系统服务和防火墙以隔离驱动注入失败，避免触碰开发机器或真实 VPS。

## 源码与来源

详见 THIRD_PARTY_NOTICES.md、docs/feature-coverage.md。前端页面底部提供源代码下载。此项目遵循所保留上游 AGPL-3.0-only 许可证；对外提供网络服务时也应保持相应源码可获取。

## Telegram 告警（v1.2.0）

在「安全与设置 → Telegram 与网络告警」配置 Bot、Chat ID 和测点。支持 SNI / TLS 检查、国内/境外 TCP 对照、连续失败确认、恢复通知、去重与发送重试。没有真实大陆测点时不判断国内封锁；详细原理、配置和待人工验收步骤见 [Telegram 告警指南](docs/telegram.md)。本版默认关闭，不会修改 Xray 或自动更换 IP / SNI。
