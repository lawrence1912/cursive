#!/bin/sh
# 构建 Cursive 原生壳（无需 Xcode.app，CLT 即可）
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

swiftc -O -swift-version 5 -target "$TARGET" shell-swift/main.swift -o shell-swift/cursive-shell
echo "built: shell-swift/cursive-shell ($(du -h shell-swift/cursive-shell | cut -f1 | tr -d ' '))"
