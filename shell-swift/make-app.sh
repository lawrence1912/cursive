#!/bin/sh
# 打包 Cursive.app（+ 可选 DMG）：原生壳 + out/renderer 全部塞进标准 bundle
#
# 用法：
#   ./shell-swift/make-app.sh            # 产出 dist/Cursive.app
#   CURSIVE_DMG=1 ./shell-swift/make-app.sh  # 额外产出 dist/Cursive-<version>.dmg
set -e
cd "$(dirname "$0")/.."

# 架构 / 部署目标 / 链接参数全在 `compile.sh` 一处（0.3.0 T1 起）。**打包永远出 universal**：
# 开发可以只编本机那一片，交出去的那份不能挑机器。

VERSION=$(python3 -c "import json; print(json.load(open('package.json'))['version'])" 2>/dev/null || echo "0.1.0")
APP="dist/Cursive.app"
# 改名前的产物留在 dist 里会变成第二个图标，顺手清掉
rm -rf dist/cursive.app

echo "==> 构建 renderer"
npm run build --silent

echo "==> 组装 $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/renderer"

# 二进制（arm64 + x86_64，compile.sh 里合完就断言过两片都在）
CURSIVE_UNIVERSAL=1 ./shell-swift/compile.sh "$APP/Contents/MacOS/Cursive"

# renderer 资源（壳经 Bundle.main.resourceURL 找到这里）
ditto out/renderer "$APP/Contents/Resources/renderer"

# 图标
[ -f build/icon.icns ] && cp build/icon.icns "$APP/Contents/Resources/AppIcon.icns"

# Info.plist：.md 关联 rank=Default（装上即接管 md 默认打开方式）+ 导入 markdown UTI 补全 mdown/mkd 扩展名
#
# **本地化要声明**（0.5.1 之后补的）。界面文案是渲染层与壳自己那两张双语表，可「系统那一层」——
# 保存 / 打开面板的按钮、AppKit 自己往菜单里加的 Start Dictation… / Emoji & Symbols / Close All、
# NSError 给的原因（「写入失败：……」的后半句）—— 认的是 bundle 声明了哪些本地化。一个都不声明时
# 只剩开发语言 en，中文系统上照样是 Save / Open / The folder “x” doesn’t exist.（0.5.1 实测）。
# 声明 en + zh-Hans 之后跟系统语言走；**不跟应用里的语言开关走**，那个开关只管我们自己的文案。
# 开发语言写 en：系统语言两样都不是时，渲染层的默认界面也是英文（i18n 的 `systemLang`）。
# 裸跑的 `cursive-shell` 不读这份 plist —— 所以 release.sh 在包里那个二进制上验（[4+]）
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>					<string>Cursive</string>
	<key>CFBundleDisplayName</key>			<string>Cursive</string>
	<key>CFBundleExecutable</key>			<string>Cursive</string>
	<key>CFBundleIdentifier</key>			<string>dev.lawrence.cursive</string>
	<key>CFBundleDevelopmentRegion</key>	<string>en</string>
	<key>CFBundleLocalizations</key>
	<array>
		<string>en</string>
		<string>zh-Hans</string>
	</array>
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
echo "==> 完成：$APP ($SIZE, $(lipo -archs "$APP/Contents/MacOS/Cursive"))"
