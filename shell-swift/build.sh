#!/bin/sh
# 构建 Cursive 原生壳（无需 Xcode.app，CLT 即可）
#
#   ./shell-swift/build.sh                      # 只编本机架构（开发用，约 10s）
#   CURSIVE_UNIVERSAL=1 ./shell-swift/build.sh  # arm64 + x86_64（CI 用，约 20s）
#
# 架构、部署目标、链接参数**全在 `compile.sh` 一处**，这里只负责摆路径和报数。
set -e
cd "$(dirname "$0")/.."

./shell-swift/compile.sh shell-swift/cursive-shell
echo "built: shell-swift/cursive-shell ($(du -h shell-swift/cursive-shell | cut -f1 | tr -d ' '), $(lipo -archs shell-swift/cursive-shell))"
