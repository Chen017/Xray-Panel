# Mihomo 与 Clash Verge Rev 本地订阅配置

保留你现有的主配置，包括 DNS、TUN、rules、rule-providers 和策略组。只增加一个远程 proxy-provider，并让需要使用这些节点的策略组引用它。

## 1. 检查实际核心能力

使用支持 XHTTP 和 `age-secret-key` 的 Mihomo。本项目针对本地 v1.19.32 测试；Clash Verge Rev 的应用版本不等于内置核心版本，请在应用信息页或运行 `mihomo -v` 检查。

可通过 `mihomo age keygen` 验证 age CLI 是否存在；正式使用前对完整配置执行 `mihomo -t -f config.yaml`。如果提示未知命令 / 字段，更新到具备相应能力的正式核心。

## 2. 创建设备

在面板「设备与订阅 → 授权设备」输入名称，选择：

- 允许使用的节点。
- 每个节点允许的出口（本机直出或指定落地）。
- 客户端连接模式：split / single4 / single6 / vision4 / vision6。

split 要求节点同时填写可达的 IPv4 和 IPv6 地址，并且客户端网络能使用这两个地址族。客户端无 IPv6 时选择 single4 或 vision4。不满足地址条件的模式不会发布。

在浏览器本地生成密钥，或在客户端执行：

```bash
mihomo age keygen
```

把输出的 age1... 公钥填入面板；AGE-SECRET-KEY-1... 私钥只保存在自己的设备。面板只接受设备登记时保存的公钥，不信任订阅请求中可随意修改的公钥。

保存后等待 Agent 的 device-sync 任务成功。面板显示的首次配置含 Token 和本地生成的私钥，请马上保存；关闭后不能找回 Token。若自行在本机生成密钥，首次配置中的私钥位置需要自己填写。

## 3. 合并 proxy-provider

以下是占位示例；实际 URL 和 Authorization 值由面板生成。

```yaml
proxy-providers:
  xray:
    type: http
    url: "https://sub.example.com/v1/subscriptions/设备ID"
    path: ./proxy_providers/xray.yaml
    interval: 3600
    proxy: DIRECT
    age-secret-key: "AGE-SECRET-KEY-1本设备私钥"
    header:
      Authorization:
        - "Bearer 面板设备TOKEN"
      CF-Access-Client-Id:
        - "本设备的CF服务令牌ID.access"
      CF-Access-Client-Secret:
        - "本设备的CF服务令牌SECRET"
    health-check:
      enable: true
      url: https://www.gstatic.com/generate_204
      interval: 300
      timeout: 5000
      lazy: true
```

没有对订阅域名启用 Cloudflare Service Auth 时，移除两个 CF-Access-* 头。其他字段保持不变。推荐按 docs/cloudflare.md 开启 Service Auth。

`proxy: DIRECT` 让订阅通过直连获取，避免订阅更新依赖订阅里的节点所造成的启动循环。如果你的网络不能直连该订阅域名，指定已有且独立可用的代理策略，并验证它不会依赖这个 provider。

如果已有 proxy-providers，请把 xray 项合并进去，不要再写第二个同名顶层键。路径应在 Mihomo 配置目录内，每个 provider 路径唯一。

## 4. 引用本地策略组

在你现有的目标策略组里增加 `use: [xray]`；保留原有的 proxies 成员、DNS 和分流规则。一个最小例子：

```yaml
proxy-groups:
  - name: "节点选择"
    type: select
    proxies:
      - DIRECT
    use:
      - xray

rules:
  - MATCH,节点选择
```

上述 rules 只用于全新最小配置。已有本地规则时继续使用自己的 rules，不要整体替换。其他 url-test / fallback / load-balance 策略组也可以按需添加 use。

Clash Verge Rev 中应把修改保存在持久化本地配置或 Merge / Script 配置里，避免编辑应用生成的临时配置。选择该本地配置并重新载入，在 provider 页面检查拉取和健康检查结果。

## 5. 实际分发内容

订阅服务生成的明文结构仅为：

```yaml
proxies:
  - name: "线路 01 · 落地 A · split"
    type: vless
    # 其余字段按已部署配置生成
```

服务端用登记的公钥进行 age 加密，并输出 ASCII armor。Mihomo 使用本地 `age-secret-key` 解密。不会下发 DNS、策略组或 rules；不会把服务器 REALITY 私钥、中继 decryption 或设备 age 私钥写入订阅。

同一设备的每节点、每出口 UUID 独立；原脚本的主 UUID 和中继 transport_uuid 不作为设备订阅凭据。

## 6. 更新、撤销及排错

- 修改节点后部署成功：Mihomo 在下次 interval 拉取时得到新节点；也可在应用中手动刷新该 provider。
- 401：设备 Token 已撤销 / 轮换，或者错误使用了 Agent Token；替换本设备 Authorization。
- 302、HTML 或 Access 登录页：Cloudflare Service Auth 配错，检查两个 CF 请求头与策略。
- 503：还没有此设备可用的已部署 UUID，或者选择的模式缺少地址；检查任务结果、节点发布开关和地址。
- age 解密失败：客户端私钥与面板登记公钥不匹配，或响应不是 age armor；不要通过关闭 TLS 验证解决。
- 节点为空：检查本设备是否授权正确出口、已部署 UUID，以及 IPv4 / IPv6 地址是否满足所选模式。
- 控制中心暂时故障：已有节点继续运行；provider 更新失败时继续使用最后可用缓存。首次导入仍需要控制中心可访问。
- 轮换 UUID 后等待 VPS 同步；离线节点的旧 UUID 需要恢复在线后才能移除。撤销订阅 Token 不能远程抹除设备已持有的旧配置。

本地配置含 Token 和 age 私钥，请按个人凭据保护，不要提交到公共 Git 仓库。

官方字段参考（2026-10-23 核对）：https://wiki.metacubex.one/en/config/proxy-providers/
