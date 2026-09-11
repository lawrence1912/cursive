#!/bin/sh
# 打包 typmd.app（+ 可选 DMG）：原生壳 + out/renderer 全部塞进标准 bundle
#
# 用法：
#   ./shell-swift/make-app.sh            # 产出 dist/typmd.app
#   TYPMD_DMG=1 ./shell-swift/make-app.sh  # 额外产出 dist/typmd-<version>.dmg
set -e
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json; print(json.load(open('package.json'))['version'])" 2>/dev/null || echo "0.1.0")
APP="dist/typmd.app"

echo "==> 构建 renderer"
npm run build --silent

echo "==> 组装 $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/renderer"

# 二进制
swiftc -O -swift-version 5 shell-swift/main.swift -o "$APP/Contents/MacOS/typmd"

# renderer 资源（壳经 Bundle.main.resourceURL 找到这里）
ditto out/renderer "$APP/Contents/Resources/renderer"

# 图标
[ -f build/icon.icns ] && cp build/icon.icns "$APP/Contents/Resources/AppIcon.icns"

# Info.plist：.md 关联 rank=Alternate（出现在「打开方式」里，不抢默认，与 Electron 版一致）
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>					<string>typmd</string>
	<key>CFBundleDisplayName</key>			<string>typmd</string>
	<key>CFBundleExecutable</key>			<string>typmd</string>
	<key>CFBundleIdentifier</key>			<string>dev.lawrence.typmd</string>
	<key>CFBundleVersion</key>				<string>$VERSION</string>
	<key>CFBundleShortVersionString</key>	<string>$VERSION</string>
	<key>CFBundlePackageType</key>			<string>APPL</string>
	<key>CFBundleInfoDictionaryVersion</key>	<string>6.0</string>
	<key>CFBundleIconFile</key>				<string>AppIcon</string>
	<key>LSMinimumSystemVersion</key>		<string>12.0</string>
	<key>LSApplicationCategoryType</key>	<string>public.app-category.productivity</string>
	<key>NSHighResolutionCapable</key>		<true/>
	<key>NSPrincipalClass</key>				<string>NSApplication</string>
	<key>NSHumanReadableCopyright</key>		<string>Copyright © 2026 Lawrence</string>
	<key>CFBundleDocumentTypes</key>
	<array>
		<dict>
			<key>CFBundleTypeName</key>			<string>Markdown 文档</string>
			<key>CFBundleTypeRole</key>			<string>Editor</string>
			<key>LSHandlerRank</key>			<string>Alternate</string>
			<key>LSItemContentTypes</key>
			<array>
				<string>net.daringfireball.markdown</string>
			</array>
			<key>CFBundleTypeExtensions</key>
			<array>
				<string>md</string>
				<string>markdown</string>
				<string>mdown</string>
				<string>mkd</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
PLIST

echo "==> ad-hoc 签名"
codesign --force --deep --sign - "$APP"
codesign --verify --strict "$APP" && echo "    签名校验通过"

if [ "${TYPMD_DMG:-0}" = "1" ]; then
    DMG="dist/typmd-$VERSION.dmg"
    echo "==> 打 DMG $DMG"
    rm -f "$DMG"
    hdiutil create -volname typmd -srcfolder "$APP" -ov -format UDZO "$DMG" | tail -1
fi

SIZE=$(du -sh "$APP" | cut -f1 | tr -d ' ')
echo "==> 完成：$APP ($SIZE)"
