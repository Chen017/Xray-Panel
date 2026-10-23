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

**域名、Cloudflare DNS / 代理、1Panel HTTPS 证书已经配置好：直接按 [1Panel 逐步部署教程](docs/1panel.md) 操作。教程从 GitHub 拉取代码开始，到浏览器打开登录页结束，无需手动上传项目，无需 Cloudflare Tunnel。**

在 1Panel 的服务器终端拉取：

```bash
cd /opt
git clone https://github.com/Chen017/Xray-Panel.git xray-panel
cd /opt/xray-panel
```

创建 `.env` 后，在「容器 → 编排 → 创建 → 路径选择」使用 `/opt/xray-panel/deploy/1panel/docker-compose.yml`。该文件使用绝对路径，适用于 1Panel 导入；项目根目录的 `compose.yaml` 适用于在项目目录直接执行 Compose。

随后把现有 HTTPS 网站的根路径反向代理到 `http://127.0.0.1:3000`，`.env` 中的 `PANEL_ADMIN_ORIGIN` 必须是浏览器实际使用的 HTTPS 域名，不带尾部 `/`。Cloudflare 现有 DNS 和 1Panel 证书不需要重配。

如果希望使用 Cloudflare Tunnel + Access 的另一种接入方式，可单独参考 docs/cloudflare.md；它不是现有 HTTPS 网站反向代理方案的必需步骤。

三个独立入口：

| 入口 | 宿主机监听 | 用途 |
| --- | --- | --- |
| panel.example.com | 127.0.0.1:3000 | 管理 UI 和管理 API |
| sub.example.com | 127.0.0.1:3001 | 仅设备订阅 API |
| agent.example.com | 127.0.0.1:3002 | 仅 Agent API |

同一个 Node 进程运行三个 HTTP 监听器，路由相互隔离；共享一个加密数据库，不需要额外订阅进程。不要把管理入口代理到订阅域名。

生产 Docker 构建必须能够从 npm / Docker Hub 下载依赖。镜像构建阶段生成静态面板及不含 `.env`、数据库或凭据的 AGPL 源码包；运行阶段使用非 root 用户、只读根目录和独立数据卷。

## 接入每台 VPS

1. 面板「添加节点」，填写客户端直连该 VPS 的 IP / 域名；复制仅显示一次的 Agent JSON。
2. 在该 VPS 通过 `git clone https://github.com/Chen017/Xray-Panel.git /opt/xray-panel` 拉取项目；已存在仓库时使用 `git pull --ff-only`。不复制建站 VPS 的 `.env` 或数据库。
3. 创建 `/etc/xray-panel-agent/config.json`，粘贴专属 JSON；如果 Agent 域名启用了 Cloudflare Service Auth，再添加该 VPS 的 CF-Access-Client-Id / CF-Access-Client-Secret。
4. `chmod 600 /etc/xray-panel-agent/config.json`。
5. `cd /opt/xray-panel && sudo bash deploy/install-agent.sh`。
6. 等待面板显示 Agent 在线，打开「管理」检查自动导入的脚本配置。现有 Xray 不会因 Agent 接入而停止或改变配置。
7. 未安装 Xray 的 VPS：在「运维」选择安装；需要输入节点名确认。纯落地环境先安装不监听中继，随后在互联页配置并部署。

服务检查：

```bash
systemctl status xray-panel-agent --no-pager
journalctl -u xray-panel-agent -n 50 --no-pager
```

Agent 需要 root，因为它必须修改 Xray 系统目录、重启服务、管理防火墙和安装更新。它不监听任何网络端口，不接受任意 Shell 命令，默认只访问 HTTPS；JSON 配置通过文件传递而非拼进命令行。HTTPS 重定向会被拒绝，避免把凭据发往错误地址。正常管理无需开放公网 SSH。

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

更新面板时也应更新每台 VPS 的 agent/，重新运行 deploy/install-agent.sh 并重启 Agent；保留原 Agent 配置、数据库与 PANEL_MASTER_KEY。本次修复后的版本为 1.0.1，Agent 心跳中的 agentVersion 同步更新。

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
