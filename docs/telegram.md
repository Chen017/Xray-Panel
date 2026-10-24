# Telegram 告警

在「安全与设置 → Telegram 与网络告警」配置。Panel 与节点现有 Agent 均更新到 v1.3.2 或更新版本，**不需要新增大陆或境外测点 Agent**。

## 检测方式

各节点复用 Xray Script 的只读 `network_probe.sh`：

- 国内：连接上海移动、联通、电信三个固定目标的 TCP 80，任意一个成功就算可达。
- 境外：ping Cloudflare `1.1.1.1`、`1.0.0.1`；ICMP 不通时尝试 TCP 443，任意一次成功就算可达。
- SNI：节点 Agent 检查对应地址族的 DNS、证书、TLS 1.3 与 h2，不修改 Xray 配置。

| 国内目标 | Cloudflare | 连续失败确认后的通知 |
| --- | --- | --- |
| 全部失败 | 可达 | 疑似国内连通异常 |
| 全部失败 | 不可达 | 节点网络异常 |
| 可达 | 不可达 | 境外对照异常 |
| 可达 | 可达 | 正常；连续恢复确认后发送恢复通知 |

这是从 VPS 发出的连通检测，不能据此确认国内客户端到节点 IP / 端口被墙，也不验证完整代理链路。国内与境外检查并行、限时执行；连续失败默认 3 轮，恢复默认 2 轮，每轮默认间隔 300 秒。

## 配置

1. 向 BotFather 创建 Bot，并先给 Bot 发送 `/start`，或加入允许发消息的群组。通过 [getUpdates](https://core.telegram.org/bots/api#getupdates) 的 `message.chat.id` 获取 Chat ID；话题 ID 可选。
2. 保存 Bot Token、Chat ID、间隔和失败 / 恢复轮数。Token 加密保存、不回显；留空保留已保存值。
3. 点击「向已保存的 Chat 发送测试通知」，确认 Telegram 实际收信，再启用检测。API 成功回执只表示 Telegram 接受请求。
4. 现有节点 Agent 使用 `xray-panel agent update --version 1.3.2` 更新；也可执行 `xray agent update --version 1.3.2`。新接入仍使用面板生成的一键安装脚本。Panel 升级不会代替各 VPS 的 Agent 升级，也无需重装或部署 Xray。

升级时保留原 Bot、Chat 和轮次设置，旧测点选择不再使用。支持检测的节点上线后自动取得计划、回传结果；没有新结果或结果过期时不累计失败。

## 通知规则

同类故障只在确认与恢复时通知；故障类别变化也需重新累计。临时发送失败退避重试，429 遵循 Telegram 等待时间，重启后继续处理队列；延迟通知需重新确认当前证据。回执丢失可能导致重试重复送达。

通知包含节点备注和诊断类型，不含 UUID、REALITY 密钥、订阅 Token 或 age 私钥。SNI 通知还包含目标域名。检测不会自动更换 IP、SNI 或代理配置。

没有结果先检查节点 Agent 版本和在线状态；发送失败检查页面脱敏状态码、Bot Token、Chat ID、话题和群组权限。真实 Bot 收信与公网故障恢复仍需用自己的环境验收，自动化测试范围见 [测试记录](test-report.md)。
