# Script feature mapping

| 脚本入口 / 功能 | 面板位置 / Agent action |
| --- | --- |
| 更改端口、路径、UUID、密钥、SNI、Short IDs | 节点 → 基础参数 |
| 双栈上行方向 | 基础参数 → 双栈分离方向 |
| 全部 XHTTP 参数 | 节点 → XHTTP 原生 JSON + 完整配置 |
| 出站 IP 解析 / Happy Eyeballs | 基础参数 → 出站策略 |
| 自定义规则增删改、排序 | 分流规则 |
| XHTTP 双栈 / 单栈 / Vision 客户端导出 | 设备授权 → 连接方式 → Proxy Provider |
| 查看客户端配置 | 设备卡片 → 查看已发布节点 |
| 完整服务端配置（所有文件） | 完整配置 + 预览部署；Agent 导入当前文件 |
| 线路多个落地、备注、独立出口 | 线路 / 落地 → 线路机 + VLESS 链接 / 面板落地导入 |
| 纯落地 / NAT 映射 / 来源 IPv4 | 线路 / 落地 → 落地机 |
| 中继密钥与分享链接 | VPS 生成互联参数 → 读取参数 → 复制链接 |
| 故障转移排序与探测间隔 | 线路机 → 故障转移 |
| 中继测试 | 运维 → relay-test；非交互测试全部落地 |
| 启动 / 停止 / 重启 / 自启 | 运维 → start / stop / restart / enable / disable |
| 运行状态 | Agent report + 节点列表 |
| 当前配置校验 | validate |
| 综合日志 | logs → journalctl + access.log / error.log 尾部 |
| 日志等级 | 基础参数，纯落地也可完整 JSON 编辑 |
| 端口放行 / 关闭 | 运维 → firewall_ports.json → 保存并部署 |
| 更新核心（固定 v26.3.27） | update-core |
| 更新脚本 / geodata / 维护任务 | update-script / update-geodata / maintenance |
| BBR | bbr |
| 网络 / SNI / CDN 自检 | diagnostics |
| 标准 / 纯落地安装 | install-standard / install-landing |
| 卸载 Xray | uninstall，输入节点名确认 |
| 配置校验及失败回滚 | 原脚本 config_transaction + validate_config + firewall_sync |

完整文件编辑允许设置未单独做表单的脚本 / Xray JSON 参数。低层配置由 VPS 的真实核心最终校验。UI 的日志为按需读取快照，不是无限 tail；管理任务的输出在任务页保留。

订阅导出提供 Mihomo Proxy Provider；互联页保留脚本 VLESS 中继分享链接。设备卡片还可以导出已发布普通节点的 VLESS 分享链接；主要自动分发渠道是加密在线 Mihomo provider。
