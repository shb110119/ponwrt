#!/bin/sh
# fix-luci-upnp.sh —— 修复 LuCI「当前没有生效的端口映射」为空的问题
# 原因：miniupnpd 2.3.11 生成的 nft 规则带 counter，luci-app-upnp 的解析正则匹配不上
# 用法：复制到路由器上执行  sh fix-luci-upnp.sh   （5585F-1 / 5585F-2 通用，可重复执行）

F=/usr/share/rpcd/ucode/luci.upnp

[ -f "$F" ] || { echo "[x] 找不到 $F，请确认已安装 luci-app-upnp"; exit 1; }

# 已经修过就不再动（用 -F 精确匹配字面量，避免 grep 通配符误判）
if grep -qF ').*dnat ip to (' "$F"; then
    echo "[=] 已经修复过，无需重复操作"
else
    # 只在第一次打补丁时留备份
    [ -f "$F.bak" ] || cp -a "$F" "$F.bak"

    # 1) 若曾被塞过不兼容的 (?:...) 非捕获组（会导致 rpc 报 Unknown error），先还原
    sed -i 's|(?: counter packets \[0-9\]+ bytes \[0-9\]+)? dnat ip to|dnat ip to|' "$F"

    # 2) 允许 dport 与 dnat 之间出现 counter 等任意内容（ucode 正则是 ERE，用 .* 最稳）
    sed -i 's|) dnat ip to (|).*dnat ip to (|' "$F"

    if grep -qF ').*dnat ip to (' "$F"; then
        /etc/init.d/rpcd restart
        sleep 2
        echo "[ok] 补丁已应用，rpcd 已重启"
    else
        echo "[x] 补丁应用失败，已从备份还原"
        cp -a "$F.bak" "$F"
        /etc/init.d/rpcd restart
        exit 1
    fi
fi

# 验证：nft 实际规则数 vs rpc 返回的规则数
NFT_N=$(nft --handle list chain inet fw4 upnp_prerouting 2>/dev/null | grep -c 'dnat ip to')
RPC_N=$(ubus call luci.upnp get_status 2>/dev/null | grep -c '"num"')
echo "    nft 实际规则: $NFT_N 条"
echo "    LuCI 读到的: $RPC_N 条"
if [ "$RPC_N" = "$NFT_N" ] && [ "$NFT_N" -gt 0 ]; then
    echo "[ok] 修复成功，刷新 LuCI 页面即可看到端口映射"
elif [ "$NFT_N" = "0" ]; then
    echo "[i] 当前本来就没有 UPnP 端口映射，修复已生效，等有客户端申请后再看"
else
    echo "[!] 数量不一致，把上面输出发给助手排查"
fi
