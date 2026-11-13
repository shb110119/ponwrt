# files/ 覆盖层说明

本仓库根目录的 `files/` 会在编译时被 workflow 拷进源码树，最终覆盖进固件 rootfs。
这里放的都是**上游没有、或上游有 bug** 的东西，升级上游时留意下面几条。

## 内容清单

| 路径 | 来历 | 注意事项 |
| --- | --- | --- |
| `usr/share/rpcd/ucode/luci.traffic` | 自建流量页后端（读 `/sys/class/net` 计数器 + 调 vnstat） | 与 `www/.../view/traffic/overview11.js` 配套，改协议要两边一起改 |
| `usr/share/rpcd/acl.d/luci-app-traffic.json` | 流量页 ACL | 新增 rpc 方法必须同步加进 `luci.traffic` 数组，否则浏览器端调不通 |
| `usr/share/luci/menu.d/luci-app-traffic.json` | 状态 → 网络流量 | 菜单 order 91 |
| `www/luci-static/resources/view/traffic/overview11.js` | 流量页前端 | 文件名改版是为了绕 LuCI 的 JS 缓存，改动时**换新文件名**并同步菜单 |
| `usr/share/rpcd/ucode/luci.upnp` | 修 miniupnpd 2.3.11 的端口映射列表为空 | 上游 luci-app-upnp 修好后，`diy-part2.sh` 会自动删掉这份覆盖 |
| `www/.../view/status/include/15_pon.js` | 概览页 PON 卡片收窄（460px） | 属于 luci-app-pon-status，跟上游版本走，升级该包时重新比对 |
| `etc/config/vnstat` | 默认监控接口列表 | 只在新装/恢复出厂时作为默认值 |
| `etc/uci-defaults/98-vnstat-persist` | vnstat 库挪到 `/etc/vnstat` + 写 sysupgrade 保留列表 | 不整份覆盖 `vnstat.conf`，只 sed 两行 |
| `usr/bin/fix-luci-upnp.sh` | 同上 UPnP 修复的独立脚本 | 老固件上可手动跑，幂等 |

## 几个坑（都踩过了）

- `/var/lib/vnstat` 是 tmpfs，重启即丢。库必须放 `/etc/vnstat`，并且写进 `/etc/sysupgrade.conf`。
- `vnstat.conf` 默认 `MaxBandwidth 1000`（Mbit）。这台 PON 峰值超过 1Gbps，vnstatd 会判定 "Traffic rate higher than set maximum"，
  每轮都在 syncing、不记账。要改成 `2500`。
- ucode 的正则是 ERE，**不支持 `(?:...)`**，写了会让 rpcd 报 `Unknown error`。
- LuCI 前端 JS 用 `L.require()` 固定 URL、没有版本号，改了内容必须换文件名。
