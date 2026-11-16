# files/ 覆盖层说明

本仓库根目录的 `files/` 会在编译时被 workflow 拷进源码树，最终覆盖进固件 rootfs。
这里放的都是**上游没有、或上游有 bug** 的东西，升级上游时留意下面几条。

## 内容清单

| 路径 | 来历 | 注意事项 |
| --- | --- | --- |
| `usr/share/rpcd/ucode/luci.traffic` | 自建流量页后端（读 `/sys/class/net` 计数器 + 调 vnstat） | 与 `www/.../view/traffic/overview16.js` 配套，改协议要两边一起改 |
| `usr/share/rpcd/acl.d/luci-app-traffic.json` | 流量页 ACL | 新增 rpc 方法必须同步加进 `luci.traffic` 数组，否则浏览器端调不通 |
| `usr/share/luci/menu.d/luci-app-traffic.json` | 状态 → 网络流量 | 菜单 order 91 |
| `www/luci-static/resources/view/traffic/overview16.js` | 流量页前端 | 文件名改版是为了绕 LuCI 的 JS 缓存，改动时**换新文件名**并同步菜单 |
| `usr/share/rpcd/acl.d/luci-app-pon-status.json` | 给 PON 卡片开放 `/usr/bin/pondctl status --line *`（VLAN 行要用） | 覆盖上游同名 ACL；上游给这个 role 加新权限时要把我们加的那条带过去 |
| `usr/share/rpcd/ucode/luci.upnp` | 修 miniupnpd 2.3.11 的端口映射列表为空 | 上游 luci-app-upnp 修好后，`diy-part2.sh` 会自动删掉这份覆盖 |
| `www/.../view/status/include/15_pon.js` | 概览页 PON 卡片：收窄到 460px，并在卡片底部显示 **OLT 下发的 VLAN**（读 `pondctl status --line`）与注册状态/CTC 版本 | 属于 luci-app-pon-status，跟上游版本走，升级该包时重新比对 |
| `www/.../view/vnstat2/graphs2.js` + `usr/share/luci/menu.d/luci-app-vnstat2.json` | 自带 vnStat 图表页改文本表格版：vnstati PNG 换成 `vnstat --json` 渲染的可复制表格（7 个标签页，含"复制本表"按钮） | 基于上游 a5ec60d483 改写，覆盖上游文件；上游升级 graphs.js 后需重新对位 |
| `etc/config/vnstat` | 默认监控接口列表 | 只在新装/恢复出厂时作为默认值 |
| `etc/uci-defaults/98-vnstat-persist` | vnstat 库挪到 `/etc/vnstat` + 写 sysupgrade 保留列表 | 不整份覆盖 `vnstat.conf`，只 sed 两行 |
| `etc/init.d/vnstat` | 覆盖包自带的 init，加**开机时钟门闸**：无 RTC 开机时钟没被 NTP 校准（库时间在未来）时不启动 vnstatd，超过 30 分钟兜底强启 | 与 `usr/bin/vnstat-watch`（开机负责拉起）配套 |
| `usr/bin/vnstat-watch` + `etc/init.d/vnstat-watch` | vnstatd 看门狗：开机等时钟追上库后拉起 vnstat；运行中库停止更新/跑到未来就自动重启 | 之前吃过的亏：overlay 权限位变 644 导致 procd exec 失败，init 里已改用 `/bin/sh` 显式执行 |
| `usr/bin/fix-luci-upnp.sh` | 同上 UPnP 修复的独立脚本 | 老固件上可手动跑，幂等 |

## 几个坑（都踩过了）

- `/var/lib/vnstat` 是 tmpfs，重启即丢。库必须放 `/etc/vnstat`，并且写进 `/etc/sysupgrade.conf`。
- `vnstat.conf` 默认 `MaxBandwidth 1000`（Mbit）。这台 PON 峰值超过 1Gbps，vnstatd 会判定 "Traffic rate higher than set maximum"，
  每轮都在 syncing、不记账。要改成 `2500`。
- ucode 的正则是 ERE，**不支持 `(?:...)`**，写了会让 rpcd 报 `Unknown error`。
- LuCI 前端 JS 用 `L.require()` 固定 URL、没有版本号，改了内容必须换文件名。

## EPON VLAN 记录（OLT 下发）

OLT 通过 CTC OAM 的 leaf `0x0021` 下发 VLAN，**每个 object instance 一条规则**（常见是 4 条：业务 VLAN、TR069 用的 130、以及 4092 这类通配）。
上游 `airola-pon-daemons` 只保留最后一条 Set，所以 `vlan_ids` 永远只显示一个值；我们打补丁改成按 instance 累积。

| 位置 | 作用 |
| --- | --- |
| `.github/pond-patches/0001-oam-ctc-keep-every-OLT-provisioned-VLAN-object-instance.patch` | `ctc.rs`：`vlan: Option<..>` → `BTreeMap<u32, VlanConfiguration>`，同 instance 重复 Set 只替换该条；snapshot 输出所有 instance 去重后的 `vlan_ids`，标量字段仍取最后一条 |
| `diy-part1.sh`（第 ~359 行起） | 编译时 `patch -p1 --batch --forward -d feeds/pon_userspace` 应用，打完用 `BTreeMap<u32, VlanConfiguration>` 做标记校验；打不上直接 `exit 1`，不会静默产出没补丁的固件 |

**验证**

```sh
pondctl status --line line0 | grep -o '"vlan_ids":[^,]*,[^,]*'   # 期望 [140,4092]
```

概览页 PON 卡片底部会显示 `OLT VLAN  140 · 4092  [Tagged]`，右侧是 `CTC 48 · 已注册`。

**维护提醒**

- 上游改 `airola-pon-daemons/src/src/oam/ctc.rs` 后，补丁要重新对位（`git apply --3way` 或手工 rebase），否则整机构建会在这里失败。
- 未注册（`authentication_status` 不是 `accepted`）时 OLT 不下发 VLAN，卡片会显示「未下发」，这是正常现象。
