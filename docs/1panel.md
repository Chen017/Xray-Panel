# 1Panel 部署：从 GitHub 拉取，到打开面板登录页

本文适用于你的现有环境：域名已绑定到 1Panel 网站，Cloudflare 已负责 DNS / 代理，网站证书和 HTTPS 已配置完成。域名在哪家注册商购买不影响本流程。这里不创建 Cloudflare Tunnel、不重新申请证书，也不需要手动上传项目文件。

完成后的请求路径：浏览器 HTTPS → Cloudflare 代理 → 1Panel 网站 HTTPS / OpenResty → 本机 HTTP 127.0.0.1:3000 → Xray Panel 容器。

以下把你已经绑定的域名写作 `panel.yourdomain.com`。实际操作时，换成你自己的完整域名。使用域名根路径访问，例如 `https://panel.yourdomain.com`，不要安装到 `/xray/` 这样的子目录。

## 第 1 步：在 1Panel 终端拉取项目

打开建站 VPS 的 1Panel，进入「终端」，连接本机终端。下面的命令在服务器执行，不是在自己电脑执行。使用 root 终端；已经配置好的 Docker 和 OpenResty 不需要重装。

先确认工具：

```bash
git --version
openssl version
docker compose version
```

如果 Debian / Ubuntu 缺少 Git 或 OpenSSL：

```bash
apt-get update
apt-get install -y git openssl
```

如果没有 Docker / Compose，先到 1Panel「容器」页面完成容器引擎安装。服务器还需要能访问 GitHub、Docker Hub 和 npm；本项目首次启动会构建镜像。

拉取公开仓库：

```bash
cd /opt
git clone https://github.com/Chen017/Xray-Panel.git xray-panel
cd /opt/xray-panel
```

成功后，在 1Panel「文件」中打开 `/opt/xray-panel`，应能看到 `Dockerfile`、`package.json`、`deploy` 等文件。Git 会自动检出仓库的默认分支，不用手动填写分支名。

如果提示目录已存在，先检查目录内容；已经克隆过的项目在该目录执行 `git pull --ff-only` 即可，不要再次覆盖或删除目录。

## 第 2 步：创建服务器自己的配置

在同一个终端执行：

```bash
cd /opt/xray-panel
cp -n .env.example .env
chmod 600 .env
openssl rand -hex 32
openssl rand -hex 24
```

最后两条命令分别生成：

1. 第一行 64 位随机值：数据库加密密钥。
2. 第二行 48 位随机值：首次登录管理员密码。

在 1Panel「文件」中打开 `/opt/xray-panel/.env`，启用显示隐藏文件。编辑以下四项；不要把 `＜…＞` 说明文字也填进去：

```dotenv
PANEL_MASTER_KEY=＜第一行随机值＞
PANEL_ADMIN_PASSWORD=＜第二行随机值＞
PANEL_ADMIN_ORIGIN=https://panel.yourdomain.com
PANEL_SECURE_COOKIE=true
```

注意：

- `PANEL_ADMIN_ORIGIN` 换成你已绑定的域名，使用 `https://`，末尾不加 `/`，不加路径。
- 其余行先保留模板默认值。订阅和 Agent 域名不是本次打开管理网站所需的配置，本文不展开。
- 不要上传 `.env` 到 GitHub。它已经被项目的 Git 忽略规则排除。
- 保存好第一行密钥和第二行密码。以后更新项目保留此 `.env`；重新生成密钥会导致旧数据库无法解密。

这里不需要安装 Node.js，也不需要在宿主机执行 `npm install`，镜像构建会完成这些工作。

## 第 3 步：在 1Panel 创建容器编排

1. 进入「容器 → 编排」。
2. 点击「创建编排」。
3. 名称填写 `xray-panel`。
4. 选择「路径选择」。
5. 选择服务器上的文件：

   ```text
   /opt/xray-panel/deploy/1panel/docker-compose.yml
   ```

6. 确认创建并启动，等待构建结束。名称类似“立即启动”的选项如果存在，保持勾选。
7. 在该编排的容器列表中，确认 `panel` 服务对应的容器处于运行状态；稍后健康状态应为 `healthy`。

如果版本中的路径选择控件不能选中该文件，可在 1Panel 文件管理器复制这个文件的全部内容，再在「创建编排 → 编辑」中粘贴。使用的仍是 `deploy/1panel/docker-compose.yml`，不要把项目根目录里的相对路径版本直接粘贴进去。

专用编排使用绝对源码路径和绝对 `.env` 路径，避免 1Panel 的编排目录影响镜像构建。数据存储在固定名称的 Docker 卷 `xray-panel_panel-data` 中，重建容器不会删除它。

已经部署过旧版本时，先检查旧容器挂载的数据卷名称。若不是 `xray-panel_panel-data`，把专用编排底部 `name:` 改成现有卷名，避免误接到一个空数据库。本步骤面向首次部署，不创建第二份运行中的面板。

首次构建需要下载基础镜像和依赖，通常比后续启动慢。若失败，先在编排日志中找到第一条失败原因，不要重复创建多个同名编排。

## 第 4 步：确认网站程序已正常运行

回到 1Panel 终端执行：

```bash
curl -fsS http://127.0.0.1:3000/api/health
```

预期结果：

```json
{"ok":true,"service":"admin"}
```

这一步成功说明程序已在服务器本机运行。3000、3001、3002 都只绑定到本机地址，无需给它们开放公网防火墙端口。

如果不是这个结果，先检查 1Panel 的容器日志，常见原因是 `.env` 密钥格式不对、密码少于 16 字符、端口已被其他程序占用或首次构建没有成功。此时先不要修改已正常工作的证书和 DNS。

## 第 5 步：把现有网站反向代理到面板

在 1Panel 中找到你已经为 Xray Panel 绑定好域名、配置好 HTTPS 的那个网站：

1. 进入「网站 → 对应网站 → 配置」。
2. 找到「反向代理」。
3. 新建或编辑该网站的根路径代理，填写：

   | 项目 | 填写内容 |
   | --- | --- |
   | 名称 | `xray-panel` |
   | 代理目录 / 匹配路径 | `/` |
   | 目标地址 / 代理地址 | `http://127.0.0.1:3000` |
   | 发送域名 / Host（如果有） | `$host`，或你绑定的完整域名 |
   | 缓存 | 关闭 |

4. 保存并应用配置；保留你已经配置好的 HTTPS 和证书。

不同 1Panel 版本可能把它显示为“目标 URL”“代理地址”或“目标地址”，核心值就是 `http://127.0.0.1:3000`。它是本机容器的 HTTP 服务，不要写成 `https://127.0.0.1:3000`，也不要写服务器公网 IP。

这里要代理整个 `/`，因此原网站在这个域名下的内容会由 Xray Panel 接管。若该站点已有其他业务，不要覆盖它，应给 Xray Panel 单独使用一个站点域名。已有根路径代理时编辑它，不要叠加两个 `location /`。

如果当前站点类型没有反向代理入口，不要删除现有站点和证书。在其配置文件中让已有的根 `location /` 使用下面的内容，并通过 1Panel 配置校验后重载；其余 HTTPS / 证书配置保留：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

以上本机地址适用于 1Panel OpenResty 使用 host 网络的部署。若你曾自定义过 OpenResty 的 Docker 网络，出现“本机健康检查成功，但网站 502”时，先在 1Panel 容器详情检查 OpenResty 的网络模式：桥接容器中的 `127.0.0.1` 是容器自身。这种自定义网络需要单独配置容器间网络，不能靠把面板端口公开到 `0.0.0.0` 来解决。

## 第 6 步：直接打开网站

在自己的浏览器访问：

```text
https://panel.yourdomain.com
```

换成你的真实域名，不带 `:3000`。正常应该看到 **Xray Panel** 的管理员密码登录页。

初始密码是第 2 步保存到 `.env` 的 `PANEL_ADMIN_PASSWORD`。到这里部署教程结束，不需要先接入 VPS 节点、创建订阅或配置 Mihomo，网站就能打开。

## 打不开时，对照现象检查

| 现象 | 检查位置 |
| --- | --- |
| `127.0.0.1:3000/api/health` 访问失败 | 1Panel 编排构建日志、容器日志和容器状态；先解决程序启动问题 |
| 健康检查成功，域名显示 502 | 网站代理地址、OpenResty 网络模式，是否误填 HTTPS 上游 |
| 仍显示 1Panel 默认页 / 原网站 | 根路径代理是否生效，是否编辑了正确域名的站点；清理已有的站点缓存 |
| 页面能打开，登录提示“请求来源不匹配” | `.env` 中 `PANEL_ADMIN_ORIGIN` 必须与浏览器协议和域名一致；修改后需重建容器以载入新环境变量，单纯重启不够 |
| HTTPS 重定向循环 | 保留源站 HTTPS；Cloudflare SSL/TLS 使用与源站证书匹配的 Full (strict)，避免 Flexible 与源站强制 HTTPS 冲突 |
| Cloudflare 525 / 526 | 检查现有源站 443、站点证书及证书链，和应用内部 3000 端口不是一回事 |

修改 `.env` 后，在原编排中执行重新创建 / 重建容器，保留数据卷；不要仅点击“重启”，也不要另外创建第二个编排。不同版本按钮名称可能为“重建”或“更新”，目标是让 Compose 用新环境变量重新创建原服务。

保留现有 Cloudflare DNS 记录、橙云代理和 1Panel 证书配置即可。不要给这个管理域名套用“缓存所有内容”的规则；已有规则覆盖此域名时，将其排除。

## 参考与验证范围

已核对 [1Panel 编排](https://1panel.pro/docs/v2/user_manual/containers/composes/)、[1Panel 网站配置](https://docs.fit2cloud.com/en/1panel/user-manual/websites/website-config-basic/)、[Cloudflare Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)。

本项目的服务与登录页已经过本地测试；专用编排已做 YAML 静态校验，包括路径、端口与持久化配置。尚未连接你的 VPS，不能声称已经验证了你这台服务器上的 1Panel、OpenResty、证书和 Cloudflare 设置。
