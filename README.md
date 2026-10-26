# Xray Panel 轻量集中管理面板

本项目是为 [Xray Script](https://github.com/Chen017/Xray) 配套的 Web 管理面板。通过主动连接的 Agent 管理多台 VPS，统一配置、部署与订阅，并向 Mihomo / Clash Verge Rev 分发**按设备授权的 age 加密订阅**。

**面板修改 → Agent 校验与部署 → 成功后发布订阅 → 客户端自动更新。** 控制中心离线时，各 VPS 继续运行已有配置。

## 🚀 核心功能

- 🌐 节点管理：导入已有配置，编辑 REALITY / XHTTP、分流规则和完整 JSON；支持线路 / 多落地互联、NAT 与故障转移。
- 🔗 统一订阅：节点名称与顺序统一管理，所有设备共用；每台设备拥有独立 Token、age 公钥和节点 / 出口 UUID。
- ⚡ 下行窗口：按设备、订阅节点独立设置 XHTTP 双栈分离的 H2 接收窗口，支持 M 单位输入与字节转换；需要支持该字段的 Mihomo fork。
- 🛠️ 部署运维：配置先校验再应用，失败自动回滚；支持任务、日志、防火墙快照、服务控制与脚本更新。
- 🔔 状态告警：复用 Script 的国内三网 / Cloudflare 自检，支持 Telegram 连续失败、恢复及 SNI 告警，并独立检测中转与落地双向 TCP、落地海外连通；落地不检测国内目标。
- 🎨 界面主题：默认跟随系统，也可手动切换深色 / 浅色。

面板使用 SQLite，不需要 PostgreSQL 或 Redis；不包含套餐与计费系统。功能范围见 [功能对照](docs/feature-coverage.md)。

## 📚 使用教程

| 内容 | 教程 |
| --- | --- |
| 安装程序、配置三个域名与反向代理 | [1Panel 部署](docs/1panel.md) |
| Zero Trust、Service Token 与源站保护 | [Cloudflare 配置](docs/cloudflare.md) |
| 接入 VPS、编辑与部署节点、统一排序 | [节点接入与管理](docs/nodes.md) |
| 设备授权、加密订阅与客户端配置 | [Mihomo / Clash Verge Rev](docs/mihomo.md) |
| 通知、节点自检与排错 | [Telegram 告警](docs/telegram.md) |

## ⚙️ 安装、更新与卸载

Panel 适用于 Debian / Ubuntu 建站 VPS，需要 root、systemd、Python ≥ 3.10，并能访问 GitHub 和 GHCR。安装器补齐依赖，拉取 amd64 / arm64 Docker 镜像。

```bash
(set -e; w=$(mktemp); trap 'rm -f "$w"' EXIT; curl -fLsS --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 60 https://raw.githubusercontent.com/Chen017/Xray-Panel/v1.3.7/deploy/bootstrap.sh -o "$w"; bash "$w")
```

域名、反向代理和 Access 按上方教程配置。

完成引导后输入 `xray-panel` 打开菜单，或直接执行：

| 操作 | Panel（建站 VPS） | Agent（每台节点 VPS） |
| --- | --- | --- |
| 安装 / 重新接入 | `xray-panel panel install` | `xray-panel agent install` |
| 更新 | `xray-panel panel update` | `xray-panel agent update` |
| 状态 | `xray-panel panel status` | `xray-panel agent status` |
| 日志 | `xray-panel panel logs` | `xray-panel agent logs` |
| 卸载 | `xray-panel panel uninstall` | `xray-panel agent uninstall` |

更新默认获取最新正式 Release，可加 `--version 1.3.7` 指定版本。Panel 更新前备份数据库和配置，失败恢复；沿用已有 Compose 项目、数据卷和密钥，不要在 1Panel 重建第二套项目。生成的编排是 `/opt/xray-panel-manager/panel.compose.yaml`。

Panel 与 Agent 分别更新。Agent 重装 / 更新保留相同节点身份、CF 凭据及自定义目录，拒绝覆盖不同节点 ID；轮换 Agent Token 后，重新运行安装并粘贴同节点的新接入信息即可。

默认卸载保留数据；Agent 卸载保留 Xray。只有确实需要删除保留数据时，才使用：

```bash
xray-panel panel uninstall --purge --confirm DELETE-PANEL-DATA
xray-panel agent uninstall --purge --confirm DELETE-AGENT-DATA
```

Panel 清除当前数据库与环境配置，历史备份仍保留；Agent 清除默认凭据与默认状态目录，自定义目录需自行处理。

## 🔒 备份与安全

定期在「安全与设置」导出加密备份，并**单独保存 `PANEL_MASTER_KEY`**。丢失密钥无法解密数据库；不要通过改密钥来轮换凭据。恢复会覆盖面板记录并注销会话，不会让 VPS 配置自动倒退；恢复后先同步核对。

Access、面板 Token 和 age 密钥各自独立。源站还需按 [Cloudflare 教程](docs/cloudflare.md#origin) 防止绕过 Access；安装脚本、客户端 YAML 和 `.env` 均含凭据，不应公开。

## 🧪 本地验证

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

## 🙏 开源来源

感谢 [Remnawave](https://github.com/remnawave) 及其贡献者。本项目的前端主题与侧边栏布局精简、改编自 [Remnawave Frontend](https://github.com/remnawave/frontend)；后端与 Agent 为 Xray Script 的部署和订阅流程单独实现，不依赖 Remnawave 后端。

- [Xray Script](https://github.com/Chen017/Xray)：节点安装管理脚本，以及 Agent 使用的配置、事务回滚和防火墙模块。
- [Xray-core](https://github.com/XTLS/Xray-core)：服务端代理核心。
- [Mihomo](https://github.com/MetaCubeX/mihomo)：客户端核心与 proxy-provider 支持。
- [typage](https://github.com/FiloSottile/typage)：age 加密实现，由 age-encryption 封装使用。

项目许可证为 [AGPL-3.0-only](LICENSE)，具体来源、上游版本与修改记录见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。面板和订阅入口提供对应源码下载。
