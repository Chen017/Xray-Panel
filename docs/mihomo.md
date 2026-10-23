# Mihomo / Clash Verge Rev 订阅

保留现有 DNS、TUN、策略组和分流规则，只添加远程 `proxy-providers` 并在策略组引用它。订阅只提供节点，不会替换本地主配置。

## 1. 准备设备授权

使用支持 XHTTP 和 `age-secret-key` 的 Mihomo；本项目已用 v1.19.32 验证。Clash Verge Rev 的应用版本不等于内置核心版本，应检查实际核心。

在面板「设备与订阅」创建设备，选择节点、出口与模式：

| 模式 | 适用网络 |
| --- | --- |
| `split` | 客户端和节点都能使用 IPv4 + IPv6 |
| `single4` / `vision4` | 仅用 IPv4 |
| `single6` / `vision6` | 仅用 IPv6 |

在浏览器本地生成 age 密钥，保存仅显示一次的配置；私钥不会上传服务器。也可执行 `mihomo age keygen`，将 `age1…` 公钥填入面板，`AGE-SECRET-KEY-1…` 私钥留在客户端。

保存授权会自动部署设备独立 UUID。等有关 Agent 任务成功后再拉取，不需要先把旧配置重新部署一遍。手动生成密钥时，记得自行填入客户端私钥。

## 2. 合并 provider

优先使用面板生成的配置。下面是字段示例，URL、Token、私钥和 CF 凭据均需替换：

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
        - "Bearer 本设备的面板TOKEN"
      CF-Access-Client-Id:
        - "本设备的CF服务令牌Client ID"
      CF-Access-Client-Secret:
        - "本设备的CF服务令牌Secret"
    health-check:
      enable: true
      url: https://www.gstatic.com/generate_204
      interval: 300
```

已有 `proxy-providers` 时，只把 `xray` 子项合并进去，不要重复顶层键；每个 provider 使用独立的缓存路径。

订阅域名开启 Service Auth 时必须保留两个 CF 头，见 [Cloudflare 配置](cloudflare.md)。未启用该层认证才删除这两个头，保留面板的 Authorization。公钥已在面板登记，无需发送 `X-Age-Public-Key`。

`proxy: DIRECT` 避免拉取依赖尚未获取的节点；若所在网络无法直连订阅域名，可改为已有且独立可用的代理策略，不要形成循环依赖。

## 3. 让策略组使用节点

在现有目标策略组的 `use` 列表追加 `xray`，其他成员和本地规则保留。例如：

```yaml
proxy-groups:
  - name: "节点选择"
    type: select
    proxies:
      - DIRECT
    use:
      - xray
```

这是合并示例，不要用它覆盖已有 `proxy-groups`。Clash Verge Rev 中保存到持久化本地配置或 Merge / Script 配置，避免修改生成的临时运行文件。重载后查看 provider 拉取状态；也可用 `mihomo -t -f config.yaml` 检查完整配置。

## 4. 自定义每条节点名称

进入「设备与订阅」→ 对应设备的「节点命名」，按出口、连接模式和配置文件分别填写完整名称，点击「保存名称」，然后刷新客户端订阅。名称仅对当前设备生效，Mihomo provider 与 VLESS 分享链接同步使用；无需部署 Xray 或更新 Agent。

留空恢复默认名称，也可点击「全部恢复默认」后保存。同一设备内名称必须唯一，不能使用 `DIRECT`、`REJECT` 等 Mihomo 保留名称。已有设备无需迁移，未设置时继续使用原来的名称。

策略组用 `use: [xray]` 会自动载入新名称；如果本地规则、策略组或筛选表达式写死了旧节点名称，改名后也要相应修改。

## 更新与排错

provider 默认每小时刷新，节点部署成功后下次拉取生效，也可手动刷新。控制中心故障时，已有 VPS 配置继续运行，客户端使用最后可用缓存；首次导入仍需服务可访问。

| 现象 | 检查 |
| --- | --- |
| 302 / HTML / Access 登录页 | 两个 CF 头、Service Auth 策略及令牌有效期 |
| 403 / 1010 | [Cloudflare 机器请求例外](cloudflare.md#troubleshoot) |
| 面板 JSON 401 | 设备 Token 是否撤销 / 轮换，是否误用 Agent Token |
| 503 / 节点为空 | 设备授权、UUID 部署任务、节点发布开关、所选模式的地址条件 |
| age 解密失败 | 私钥是否对应面板公钥，响应是否确实为 age armor |
| 能拉取但组内无节点 | 策略组是否添加 `use: [xray]` |

轮换面板 Token 后更新 Authorization；轮换 UUID 还需等待 VPS 同步；更换公钥时同步更换本地私钥。设备撤销无法抹除已下载配置，离线 VPS 需恢复在线后才能删除其旧 UUID。

本地 YAML 含真实 Token 和私钥，应作为凭据保管。官方字段说明见 [Mihomo proxy-providers](https://wiki.metacubex.one/config/proxy-providers/)。
