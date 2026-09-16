#!/bin/sh
# 打包 Cursive.app（+ 可选 DMG）：原生壳 + out/renderer 全部塞进标准 bundle
#
# 用法：
#   ./shell-swift/make-app.sh            # 产出 dist/Cursive.app
#   CURSIVE_DMG=1 ./shell-swift/make-app.sh  # 额外产出 dist/Cursive-<version>.dmg
set -e
cd "$(dirname "$0")/.."

# **部署目标必须写死**（2026-09-15 修）。不写的话跟着工具链的默认值走，而那个值
# 会随系统升级而变：升到 macOS 27 之后，同一套 CLT 给出的默认 minos 跳到了 **28.0**
# —— 比正在跑的系统还高。裸跑二进制没事（不经 LaunchServices），但双击 .app 会被
# LaunchServices 以 `-10825`（kLSIncompatibleSystemVersionErr）直接拒掉，
# 表现就是「命令行能跑，双击打不开」。
#
# 12.0 这个数不是随便挑的：它必须与 `make-app.sh` 写进 Info.plist 的
# `LSMinimumSystemVersion` 和 README 的「需要 macOS 12 或更新」**对上**。
# 两个脚本的 target 也必须一致，否则开发时跑的和打包出去的不是同一个东西。
TARGET=arm64-apple-macos12.0

VERSION=$(python3 -c "import json; print(json.load(open('package.json'))['version'])" 2>/dev/null || echo "0.1.0")
APP="dist/Cursive.app"
# 改名前的产物留在 dist 里会变成第二个图标，顺手清掉
rm -rf dist/cursive.app

echo "==> 构建 renderer"
npm run build --silent

echo "==> 组装 $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/renderer"

# 二进制
swiftc -O -swift-version 5 -target "$TARGET" shell-swift/main.swift -o "$APP/Contents/MacOS/Cursive"

# renderer 资源（壳经 Bundle.main.resourceURL 找到这里）
ditto out/renderer "$APP/Contents/Resources/renderer"

# 图标
[ -f build/icon.icns ] && cp build/icon.icns "$APP/Contents/Resources/AppIcon.icns"

# Info.plist：.md 关联 rank=Default（装上即接管 md 默认打开方式）+ 导入 markdown UTI 补全 mdown/mkd 扩展名
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>					<string>Cursive</string>
	<key>CFBundleDisplayName</key>			<string>Cursive</string>
	<key>CFBundleExecutable</key>			<string>Cursive</string>
	<key>CFBundleIdentifier</key>			<string>dev.lawrence.cursive</string>
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
			<key>LSHandlerRank</key>			<string>Default</string>
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
	<key>UTImportedTypeDeclarations</key>
	<array>
		<dict>
			<key>UTTypeIdentifier</key>			<string>net.daringfireball.markdown</string>
			<key>UTTypeDescription</key>		<string>Markdown 文档</string>
			<key>UTTypeConformsTo</key>
			<array>
				<string>public.plain-text</string>
			</array>
			<key>UTTypeTagSpecification</key>
			<dict>
				<key>public.filename-extension</key>
				<array>
					<string>md</string>
					<string>markdown</string>
					<string>mdown</string>
					<string>mkd</string>
				</array>
				<key>public.mime-type</key>
				<array>
					<string>text/markdown</string>
				</array>
			</dict>
		</dict>
	</array>
</dict>
</plist>
PLIST

echo "==> ad-hoc 签名"
codesign --force --deep --sign - "$APP"
codesign --verify --strict "$APP" && echo "    签名校验通过"

if [ "${CURSIVE_DMG:-0}" = "1" ]; then
    DMG="dist/Cursive-$VERSION.dmg"
    echo "==> 打 DMG $DMG"
    rm -f "$DMG"
    # 暂存目录里摆 app + /Applications 软链，挂载后直接拖过去
    STAGE=$(mktemp -d)
    ditto "$APP" "$STAGE/Cursive.app"
    ln -s /Applications "$STAGE/Applications"
    hdiutil create -volname Cursive -srcfolder "$STAGE" -ov -format UDZO "$DMG" | tail -1
    rm -rf "$STAGE"
fi

SIZE=$(du -sh "$APP" | cut -f1 | tr -d ' ')
echo "==> 完成：$APP ($SIZE)"
