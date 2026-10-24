# Xray Panel

为 [Xray Script](https://github.com/Chen017/Xray) 提供的轻量 Web 集中管理面板。通过主动连接的 Agent 管理多台 VPS，并向 Mihomo / Clash Verge Rev 分发按设备授权的加密订阅。

**Web 修改 → Agent 校验与部署 → 成功后发布订阅 → Mihomo 自动更新。** 控制中心离线时，各 VPS 继续运行已有配置。

界面默认跟随系统切换深色 / 浅色，右上角可手动选择。Telegram 检测复用 Script 的国内三网 / Cloudflare 自检，不需要额外测点 Agent；仅提示出站连通异常，详见 [告警配置](docs/telegram.md)。

## 可以做什么

- 管理节点、导入现有配置，修改 SNI、端口、UUID、REALITY、XHTTP、分流规则和完整 JSON。
- 配置线路 / 多落地互联、NAT 端口和故障转移；关联落地的地址变化自动排队部署。
- 查看任务、日志、防火墙快照，执行服务控制、诊断、更新及脚本运维操作。
- 每设备独立 Token、age 公钥和节点 / 出口 UUID，支持授权、撤销与轮换。
- 检查 SNI / TLS，复用节点本机的国内三网 / Cloudflare 自检并发送 Telegram 告警，无需额外测点。

界面精简自 Remnawave 前端，后端和 Agent 专门适配本脚本；无需 Remnawave 后端、PostgreSQL 或 Redis，不包含套餐与计费系统。功能对应位置见 [功能对照](docs/feature-coverage.md)。

## 先看哪份教程

| 你要做的事 | 教程 |
| --- | --- |
| 在 1Panel 部署并打开网站 | [1Panel 部署](docs/1panel.md) |
| 配置三个域名的 Zero Trust、源站保护 | [Cloudflare 配置](docs/cloudflare.md) |
| 接入已有 Xray VPS | 见下方「接入已有 Xray VPS」 |
| 保留本地规则，只自动更新节点 | [Mihomo 订阅](docs/mihomo.md) |
| 配置通知和节点自检 | [Telegram 告警](docs/telegram.md) |

## 安装 Panel

建站 VPS 使用 **Debian / Ubuntu、root、systemd、Python ≥ 3.10**，可访问 GitHub 和 GHCR。安装器会补齐缺少的依赖，拉取已发布的 amd64 / arm64 Docker 镜像；不用上传项目或在 VPS 编译前端。

在该 VPS 的 Bash 终端执行，选择「安装 Panel」，按提示输入三个 HTTPS 域名：

```bash
(set -e; w=$(mktemp); trap 'rm -f "$w"' EXIT; curl -fLsS --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 60 https://raw.githubusercontent.com/Chen017/Xray-Panel/v1.3.2/deploy/bootstrap.sh -o "$w"; bash "$w")
```

一个容器提供三个独立入口，共用加密 SQLite 数据库：

| 入口示例 | 1Panel 反向代理到 | Cloudflare Access |
| --- | --- | --- |
| `panel.example.com` | `http://127.0.0.1:3000` | 管理员身份登录 |
| `sub.example.com` | `http://127.0.0.1:3001` | 设备 Service Auth |
| `agent.example.com` | `http://127.0.0.1:3002` | VPS Service Auth |

三个域名都可开橙云。域名、证书、反向代理与 Access 需按 [1Panel 教程](docs/1panel.md) 配置；安装器不修改这些设置。3000–3002 只监听本机，不需开放到公网。

新装的初始密码位于 `/opt/xray-panel/.env` 的 `PANEL_ADMIN_PASSWORD`；旧部署迁移可能使用 `/opt/xray-panel-manager/panel.env`，实际路径见 `/opt/xray-panel-manager/panel.json`。初始密码仅在创建数据库时生效。

## 接入已有 Xray VPS

1. 在面板添加节点；客户端地址可自动检测，NAT / DDNS 可手动填写。
2. 在接入窗口填写该 VPS 的 Cloudflare Service Token，复制完整安装脚本，在目标 VPS 的 root Bash 终端执行。**可独立安装 Agent，不要求先安装 Xray Script。**
3. 等待在线并导入当前配置。接入本身不会重装 Xray，也不需要先点「保存并部署」。
4. 修改时先看预览，再部署；校验、服务或防火墙应用失败时，沿用脚本事务回滚。只保存草稿不改变 VPS。

已有 `xray-panel` 命令也可运行 `xray-panel agent install`，粘贴面板生成的一段接入信息。Script v2.7.10 起还可使用「杂项管理 → 集中管理 / Panel Agent」或 `xray agent install`；入口会先检查本地 Agent，保留身份及已有凭据。

通过 SSH / Script 修改过配置后，先在面板「导入 VPS 当前配置」，再编辑部署；不要同时从两处修改。自动地址检测失败保留最后有效地址；客户端地址更新本身不会重启 Xray，关联落地变化则走正常部署任务。

## 开始使用订阅

在「设备与订阅」为设备生成 age 密钥，选择节点、出口与连接模式，保存仅显示一次的 Token / 私钥配置。**设备授权会触发独立 UUID 的自动部署**；任务成功后，再把生成的 `proxy-providers` 合并到本地 Mihomo 配置。

每台设备的「节点命名」可分别设置各出口、模式和配置文件的完整显示名称；保存后刷新客户端订阅即可，留空沿用默认名称，无需重新部署 Xray。

本地 DNS、策略组与分流规则继续保留。完整例子见 [Mihomo 教程](docs/mihomo.md)。设备 Token 撤销立即阻止拉取；VPS 上的 UUID 删除需等待 Agent 同步，离线节点不会立即生效。

## 安装、更新与卸载

完成引导后输入 `xray-panel` 打开菜单，或直接执行：

| 操作 | Panel（建站 VPS） | Agent（每台节点 VPS） |
| --- | --- | --- |
| 安装 / 重新接入 | `xray-panel panel install` | `xray-panel agent install` |
| 更新 | `xray-panel panel update` | `xray-panel agent update` |
| 状态 | `xray-panel panel status` | `xray-panel agent status` |
| 日志 | `xray-panel panel logs` | `xray-panel agent logs` |
| 卸载 | `xray-panel panel uninstall` | `xray-panel agent uninstall` |

更新默认获取最新正式 Release，可加 `--version 1.3.2` 指定版本。Panel 更新前备份数据库和配置，失败恢复；沿用已有 Compose 项目、数据卷和密钥，不要在 1Panel 重建第二套项目。生成的编排是 `/opt/xray-panel-manager/panel.compose.yaml`。

Panel 与 Agent 分别更新。Agent 重装 / 更新保留相同节点身份、CF 凭据及自定义目录，拒绝覆盖不同节点 ID；轮换 Agent Token 后，重新运行安装并粘贴同节点的新接入信息即可。

默认卸载保留数据；Agent 卸载保留 Xray。只有确实需要删除保留数据时，才使用：

```bash
xray-panel panel uninstall --purge --confirm DELETE-PANEL-DATA
xray-panel agent uninstall --purge --confirm DELETE-AGENT-DATA
```

Panel 清除当前数据库与环境配置，历史备份仍保留；Agent 清除默认凭据与默认状态目录，自定义目录需自行处理。

## 备份与安全

定期在「安全与设置」导出加密备份，并**单独保存 `PANEL_MASTER_KEY`**。丢失密钥无法解密数据库；不要通过改密钥来轮换凭据。恢复会覆盖面板记录并注销会话，不会让 VPS 配置自动倒退；恢复后先同步核对。

Access、面板 Token 和 age 密钥各自独立。源站还需按 [Cloudflare 教程](docs/cloudflare.md#origin) 防止绕过 Access；安装脚本、客户端 YAML 和 `.env` 均含凭据，不应公开。

## 本地开发与验证

要求 Node.js ≥ 24.13.0：

```bash
git clone https://github.com/Chen017/Xray-Panel.git
cd Xray-Panel
npm ci
npm run setup
npm run build
npm start
```

打开 `http://127.0.0.1:3000`，初始密码见本地 `.env`。开发模式运行 `npm run dev`，访问 `http://127.0.0.1:5173`。

可运行 `npm test` 与 `npm run test:agent`。真实核心集成测试先用 `python scripts/fetch-test-tools.py` 获取工具，再运行 `npm run test:e2e`；Windows 需 WSL Debian（可用 `XRAY_TEST_WSL` 指定发行版），Linux 直接运行。结果与验证边界见 [测试记录](docs/test-report.md)，v1.3.0 修复见 [审查报告](docs/review-v1.3.0.md)。

## 开源来源

许可证为 [AGPL-3.0-only](LICENSE)，来源与修改记录见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。面板和订阅入口提供对应源码下载；对外提供服务时保持源码可获取。
