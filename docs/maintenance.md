# Xray Panel 维护指南

## 模块与数据流

| 位置 | 职责 |
| --- | --- |
| `web/` | React 管理界面和客户端 provider 配置，`web/api.ts` 封装管理 API |
| `server/app.mjs`、`server/index.mjs`、`server/store.mjs` | 管理、订阅与 Agent 三个入口，任务租约、加密数据及 SQLite |
| `server/monitoring.mjs`、`server/relay-monitoring.mjs` | 网络、SNI 与双向互联的探测计划、告警确认、重试和去重 |
| `shared/` | Panel 预览、部署和导出共用的 Xray 配置编译、地址与订阅字段 |
| `agent/`、`vendor/xray-script/` | 节点主动轮询、上报与部署。复用 Script 的事务和探测模块，安装版本达到捆绑版本时优先使用节点上的模块 |
| `deploy/`、`scripts/` | 安装与升级、Docker 生命周期、源码归档和发布打包 |

保存草稿后由 Agent 校验和部署。设备 UUID 对应的任务确认成功后，订阅入口才下发相应配置。调试时使用 `npm run setup` 生成的本地 `.env` 和独立 SQLite 文件。`npm run dev` 通过 Vite 代理管理 API，三个生产入口、Cloudflare 和现有数据卷的设置见 [1Panel 部署](1panel.md)与 [Cloudflare](cloudflare.md)。

## 开发、测试与打包

使用 Node.js 24.22.1（CI 和 Docker 固定该版本）、Python 3.10+、Bash、tar、jq 和 OpenSSL。真实核心集成使用 Linux x86_64。Windows 可以用 WSL Debian，`XRAY_TEST_WSL` 可指定发行版，并需要 Windows 和 WSL 之间的回环连通。Agent 与部署测试在 Linux/WSL 中执行。

```bash
npm ci
npm test
npm run test:agent
npm run test:deploy
python scripts/fetch-test-tools.py
npm run test:native
npm run test:e2e
npm run test:download
npm run build
npx playwright install chromium webkit
npm run test:ui
npm run package
npm run test:release
docker build -t xray-panel:smoke .
node tests/image-smoke.mjs xray-panel:smoke
```

固定核心下载到 `.local/tools` 并验证官方 SHA-256，当前为 Xray 26.3.27 和 Mihomo 1.19.32。可用 `XRAY_LINUX_BIN` / `MIHOMO_LINUX_BIN` 显式指定其他核心做对照。`test:native` 验证真实 Xray 的配置合并，`test:e2e` 走 Agent 部署、回滚和订阅，`test:download` 检查真实 Mihomo 的加密 provider 下载、代理优先和 DIRECT 回退。失败时检查相应的 Linux 运行日志。API 测试关闭服务后清理临时数据库，设 `PANEL_KEEP_TEST_ARTIFACTS=1` 可保留。真实核心集成保留 `.local/` 下的诊断材料。

定制分路验收运行 `MIHOMO_NAT_BIN=/path/to/custom-mihomo XRAY_NATIVE_BIN=/path/to/xray npm run test:nat`。两个核心应为当前运行系统的原生可执行文件。常规 CI 使用固定官方 Mihomo，定制能力与真机网络仍需另外验证。详见 [NAT 分路与升级记录](nat-entry-review-2026-11-05.md)。

`test:ui` 访问实际生产构建、真实 API 和临时 SQLite 数据库。测试使用桌面 Chromium、Android 触控 Chromium、iPhone 触控 WebKit，每组都以浅色和深色各运行一次。覆盖登录与主题持久化、导航、节点筛选和排序、接入凭据、分流规则的编辑和保存、节点编辑器下拉与任务窗口、设备授权和下行窗口、设置、备份及指南页签。运行 `npm run test:ui -- --project iphone-dark` 可单独复现一组。失败截图和操作轨迹在 `test-results/ui`，可用 `npx playwright show-trace <trace.zip>` 查看。设备配置模拟视口和触控，真机浏览器仍需单独验收。

手机滚动回归预先写入规则，滚动抽屉并改变视口高度，随后按屏幕坐标触摸规则类型、动作和出站策略。检查菜单选项在视野内、打开时滚动位置不变，以及选中后控件仍在视野内。对涉及焦点和滚动的问题保留这类原始触控用例，避免定位器自动滚动遮住问题。

## CI 与发布

`Test and publish` 验证 `main` 推送、PR、`v*` tag 和手动触发。同一 PR 或 `main` 的新提交替代旧验证，普通功能分支通过 PR 或手动触发。工作流缓存 npm 下载、固定测试核心和 Docker 构建层，在打包前运行浏览器 UI 回归，并保留解包及容器冒烟检查。浏览器回归失败时上传截图与轨迹。Docker 缓存未命中时正常构建。

发布前更新 `package.json`、`package-lock.json`、`deploy/bootstrap.sh` 的版本，以及 README、部署教程中的引导命令和两个 Compose 示例的默认镜像。tag 必须等于 `v` 加上包版本。冒烟测试从实际归档读回锁文件、引导脚本和 Compose，核对版本一致性。准备好版本提交后推送对应 tag，验证成功才上传 `linux/amd64` 与 `linux/arm64` GHCR 镜像，然后发布 `xray-panel-<版本>.tar.gz` 及同名 `.sha256`。只有发布作业需要仓库内容和包的写权限。

重跑同名 tag 时，已发布且两份资产齐全则跳过发布。发现同名 Release 资产缺失时，先检查草稿状态、归档和镜像再处理。`main` 手动运行并勾选 `publish_image` 可重建当前版本 GHCR 镜像。排查三端口启动问题时检查 `docker logs` 和 `/api/health`（3000）、`/health`（3001/3002）。升级失败应先核对生命周期日志、原编排和备份，再处理旧卷或配置。

## 历史兼容性

| 变更点 | 回归保护 |
| --- | --- |
| 授权结果可能迟到或重复 | `tests/regressions.test.mjs` 和 `tests/server.test.mjs` 检查修订版本、租约、重复回执及撤销重试。 |
| 安装更新可能触碰已有卷和 SQLite WAL | `deploy/tests/test_lifecycle.py` 检查原服务、卷及凭据保留和回滚，`tests/lifecycle-snapshot.test.mjs` 检查大数据库快照。 |
| NAT 公开入口与内部互联使用不同的 Vision 及凭据策略 | `tests/nat-entry.test.mjs` 和 `test:nat` 检查旧配置迁移、公开入口无 Vision、独立上下行和零 RTT 恢复。[分路记录](nat-entry-review-2026-11-05.md)列出具体原因、边界和部署顺序。 |
| Script 配置被人工修改后部署可能覆盖新状态 | `test:e2e` 模拟部署前并发变动并验证锁内拒绝。升级捆绑 Script 时保留 `PANEL_UNATTENDED` 并更新[来源记录](../THIRD_PARTY_NOTICES.md)。 |
| 手机滚动节点编辑器后，下拉选项可能无法点击，重复选择当前项也可能清空必选值 | 下拉定位以视口为基准，单选保持当前值。`tests/ui/panel.spec.mjs` 通过触控验证选择、长规则编辑和保存，并检查 Escape 分别关闭下拉和预览窗口。 |

[历史验证记录](test-report.md)和[审查修复记录](review-v1.3.0.md)用于追溯已有版本的证据。
