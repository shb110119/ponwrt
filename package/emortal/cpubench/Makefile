include $(TOPDIR)/rules.mk

PKG_NAME:=cpubench
PKG_VERSION:=1.0
PKG_RELEASE:=1

include $(INCLUDE_DIR)/package.mk

define Package/cpubench
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=CPU benchmark for LuCI status page
  DEPENDS:=+openssl-util
endef

define Package/cpubench/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./files/cpubench $(1)/usr/bin/
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/99-cpubench $(1)/etc/uci-defaults/
endef

$(eval $(call BuildPackage,cpubench))
