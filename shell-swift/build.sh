#!/bin/sh
# 构建 typmd 原生壳（无需 Xcode.app，CLT 即可）
set -e
cd "$(dirname "$0")/.."
swiftc -O -swift-version 5 shell-swift/main.swift -o shell-swift/typmd-shell
echo "built: shell-swift/typmd-shell ($(du -h shell-swift/typmd-shell | cut -f1 | tr -d ' '))"
