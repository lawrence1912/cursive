#!/bin/sh
# 构建 Cursive 原生壳（无需 Xcode.app，CLT 即可）
set -e
cd "$(dirname "$0")/.."
swiftc -O -swift-version 5 shell-swift/main.swift -o shell-swift/cursive-shell
echo "built: shell-swift/cursive-shell ($(du -h shell-swift/cursive-shell | cut -f1 | tr -d ' '))"
