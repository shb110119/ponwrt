# =============================================================
# 追加到仓库根 diy-part2.sh 的末尾（.config 已加载、make defconfig 之前）
#
# 这里只做两件事：
#   1) 把自建流量页 / UPnP 修复所需的包固定选上
#   2) 文件本体都在仓库根的 files/ 里，构建时由 workflow 拷进源码树并覆盖进 rootfs
# =============================================================

echo "=========================================="
echo "自建流量页 & 补丁文件校验"
echo "=========================================="

# 防御：老的 workflow 用 cp -r 会多出一层 files/files，清掉免得多余文件进固件
if [ -d files/files ]; then
  rm -rf files/files
  echo "  [!] 清理了多余的 files/files"
fi

ensure_pkg() {
  for p in "$@"; do
    if grep -q "^CONFIG_PACKAGE_${p}=y$" .config 2>/dev/null; then
      echo "  = ${p} 已启用"
    else
      sed -i "/^CONFIG_PACKAGE_${p}=m$/d; /^# CONFIG_PACKAGE_${p} is not set$/d" .config || true
      echo "CONFIG_PACKAGE_${p}=y" >> .config
      echo "  + ${p} 已追加"
    fi
  done
}

# vnstat2：流量页的统计后端；luci-app-upnp + miniupnpd-nftables：UPnP 页面；
# luci-app-pon-status：概览页 PON 卡片
ensure_pkg vnstat2 luci-app-vnstat2 miniupnpd-nftables luci-app-upnp luci-app-pon-status

# 上游 luci-app-upnp 若已自行修好（dport 与 dnat 之间允许任意内容），
# 就丢掉我们这份覆盖，避免压住新版
UPNP_SRC=$(ls -d feeds/luci/applications/luci-app-upnp 2>/dev/null | head -1)
if [ -n "$UPNP_SRC" ] && [ -f "$UPNP_SRC/root/usr/share/rpcd/ucode/luci.upnp" ]; then
  if grep -qF ').*dnat ip to (' "$UPNP_SRC/root/usr/share/rpcd/ucode/luci.upnp"; then
    echo "  [i] 上游 luci-app-upnp 已修复，移除本地覆盖"
    rm -f files/usr/share/rpcd/ucode/luci.upnp
  fi
fi

# files/ 里的可执行位可能被 git 丢掉
[ -x files/usr/share/rpcd/ucode/luci.traffic ] || chmod +x files/usr/share/rpcd/ucode/luci.traffic 2>/dev/null || true
[ -f files/usr/bin/fix-luci-upnp.sh ] && chmod +x files/usr/bin/fix-luci-upnp.sh 2>/dev/null || true
[ -d files/etc/uci-defaults ] && chmod +x files/etc/uci-defaults/* 2>/dev/null || true

echo "---- files/ 注入清单 ----"
for f in \
  files/usr/share/rpcd/ucode/luci.traffic \
  files/usr/share/rpcd/ucode/luci.upnp \
  files/usr/share/rpcd/acl.d/luci-app-traffic.json \
  files/usr/share/luci/menu.d/luci-app-traffic.json \
  files/www/luci-static/resources/view/traffic/overview14.js \
  files/www/luci-static/resources/view/status/include/15_pon.js \
  files/etc/config/vnstat \
  files/etc/uci-defaults/98-vnstat-persist \
  files/usr/bin/fix-luci-upnp.sh
do
  if [ -f "$f" ]; then
    echo "  ok  $f"
  else
    echo "::warning::缺少 $f"
  fi
done
