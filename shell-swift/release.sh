#!/bin/sh
# 一条龙：构建 → 测试 → E2E → 打包。全绿才出包，任何一步失败立即中止。
#
# 用法：
#   ./shell-swift/release.sh              # 测试 + 打包 dist/typmd.app
#   TYPMD_DMG=1 ./shell-swift/release.sh  # 额外出 dist/typmd-<version>.dmg
set -e
cd "$(dirname "$0")/.."

echo "==> [1/4] 单元测试 + 构建 renderer"
npx vitest run 2>&1 | grep -E "Tests |FAIL" && npm run build --silent

echo "==> [2/4] 编译原生壳"
./shell-swift/build.sh 2>&1 | grep -E "^built|error"

echo "==> [3/4] E2E 三用例（含拖拽条 hitTest 自检）"
FIX=/tmp/typmd-e2e
rm -rf "$FIX"; mkdir -p "$FIX/assets"
cp test/fixtures/kitchen-sink.md test/fixtures/crlf.md "$FIX/"
cp test/fixtures/assets/placeholder.png "$FIX/assets/中文 图.png"
printf '# 图片测试\n\n![中文图](assets/%%E4%%B8%%AD%%E6%%96%%87%%20%%E5%%9B%%BE.png)\n' > "$FIX/img.md"

run_case() {
    rm -f /tmp/typmd-shell-check.json /tmp/typmd-shell-e2e.json
    TYPMD_SMOKE=1 ./shell-swift/typmd-shell "/tmp/typmd-e2e/$1" 2>/dev/null
    python3 - "$1" <<'PY'
import json, sys
c = json.load(open('/tmp/typmd-shell-check.json'))
e = json.load(open('/tmp/typmd-shell-e2e.json'))
r = e['result']; img = r.get('img')
ok = (c['status'] != '未命名' and c['cm'] and c.get('dragStripHit') is True
      and e['bytesEqual'] and (img is None or img['loaded']))
print(('PASS ' if ok else 'FAIL ') + sys.argv[1])
sys.exit(0 if ok else 1)
PY
}
run_case img.md
run_case kitchen-sink.md
run_case crlf.md

echo "==> [4/4] 打包"
./shell-swift/make-app.sh
echo "全部通过，包在 dist/typmd.app"
