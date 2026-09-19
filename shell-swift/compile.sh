#!/bin/sh
# 编译原生壳。**这是唯一知道「用什么架构、什么部署目标、什么链接参数」的地方** ——
# build.sh（开发）与 make-app.sh（打包）都调它，别再各自写一遍 swiftc。
#
# 用法：
#   ./shell-swift/compile.sh <输出路径>              # 只编本机架构（开发用，快）
#   CURSIVE_UNIVERSAL=1 ./shell-swift/compile.sh <路径>  # arm64 + x86_64 合成 universal
set -e
cd "$(dirname "$0")/.."

OUT="$1"
[ -n "$OUT" ] || { echo "用法: compile.sh <输出路径>" >&2; exit 2; }

# **部署目标必须写死**（2026-09-15 修）。不写的话跟着工具链的默认值走，而那个值
# 会随系统升级而变：升到 macOS 27 之后，同一套 CLT 给出的默认 minos 跳到了 **28.0**
# —— 比正在跑的系统还高。裸跑二进制没事（不经 LaunchServices），但双击 .app 会被
# LaunchServices 以 `-10825`（kLSIncompatibleSystemVersionErr）直接拒掉，
# 表现就是「命令行能跑，双击打不开」。
#
# 12.0 这个数不是随便挑的：它必须与 `make-app.sh` 写进 Info.plist 的
# `LSMinimumSystemVersion` 和 README 的「需要 macOS 12 或更新」**对上**。
DEPLOY=12.0

# ---- x86_64 为什么要多一个链接参数（0.3.0 T1，实测出来的）----
#
# macOS 27 的 Command Line Tools 里，Swift 的**回退兼容库一片 x86_64 都没有**：
#   $ lipo -archs /Library/Developer/CommandLineTools/usr/lib/swift/macosx/libswiftCompatibility56.a
#   arm64 arm64e
# 六个 libswiftCompatibility*.a 全是这样。于是交叉编 x86_64 时链接器找不到
# `__swift_FORCE_LOAD_$_swiftCompatibility56`，整条链接失败 —— 报错长得像代码问题，
# 其实是工具链自己缺片。装 Xcode.app 可能有，但「不需要装 Xcode.app」是这个项目写在
# README 里的承诺，不为一个链接参数收回去。
#
# `-runtime-compatibility-version none` = 不链这批回退库。**在这份代码上它是安全的，
# 而且理由是可验证的**：那批库回退的是 Swift 并发运行时与更老运行时的 bug 修复，
# 而 main.swift 里一处 Swift 并发都没有（`async func` / `actor` / `@MainActor` /
# `Task {` 全为零，满屏的 async 是 `DispatchQueue.*.async` 和 JS 字符串里的 await）。
# 部署目标又钉在 macOS 12，50/51 那两片本来就够不着。
#
# **下面那道 guard 就是守这个前提的**：哪天真往壳里写了 Swift 并发，这条理由当场不成立，
# 而表现会极其隐蔽 —— arm64 一切正常，只有 Intel 机器上出问题，而这儿没有 Intel 机器。
X86_FLAGS="-runtime-compatibility-version none"

# 这条正则量过：对着现在的 main.swift 命中 0 行，对着 13 种真并发写法全中（见下面两条注释）。
#
# **不能用 `await` 来找** —— main.swift 往 webview 里注入的 JS 字符串里全是 await
# （探针脚本、导出取数），一搜一大片假阳性。同理不能用裸 `async`：
# 满屏的 `DispatchQueue.*.async` 是 GCD，JS 那边还有 `const f = async (q) =>`。
#
# 所以只认**JS 写不出来的形状**：Swift 的 `func … async`（JS 是 `async function`，
# 而 `\bfunc\b` 不匹配 `function`）、`actor` 声明、`@MainActor`、`Task {`/`Task(`、
# 续体与任务组、`for await`、`AsyncStream`。
#
# 踩过一次：第一版写的是 `async func` —— 那是**错的语序**，Swift 写的是 `func f() async`，
# 于是 `func probeGuard() async { }` 从 guard 底下整个溜过去了。
SWIFT_CONCURRENCY_RE='\bfunc\b[^/]*\basync\b|\binit\b[^/]*\basync\b|^[[:space:]]*(public |private |internal |final |@[A-Za-z]+ )*actor[[:space:]]|@MainActor|@globalActor|\bTask[[:space:]]*[{(]|\bTask\.detached\b|withCheckedContinuation|withCheckedThrowingContinuation|withTaskGroup|\bAsyncStream\b|\bAsyncSequence\b|for[[:space:]]+await\b'

guard_no_swift_concurrency() {
    hits=$(grep -nE "$SWIFT_CONCURRENCY_RE" shell-swift/main.swift || true)
    [ -z "$hits" ] && return 0
    cat >&2 <<MSG
错误：main.swift 里出现了 Swift 并发构件，而 x86_64 那一片是用
     \`-runtime-compatibility-version none\` 编的（CLT 没有 x86_64 的回退兼容库）。
     这条豁免的前提是「壳里没有 Swift 并发」，现在不成立了：
$hits
     两条路选一条：① 把这段改回 GCD（DispatchQueue）；
     ② 换一条给 x86_64 拿到兼容库的路（装 Xcode.app / 在 Intel runner 上编那一片），
        并把 compile.sh 这段注释一起改掉。
MSG
    exit 1
}

if [ "${CURSIVE_UNIVERSAL:-0}" = "1" ]; then
    guard_no_swift_concurrency
    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT
    swiftc -O -swift-version 5 -target "arm64-apple-macos$DEPLOY"  shell-swift/main.swift -o "$TMP/arm64"
    # shellcheck disable=SC2086
    swiftc -O -swift-version 5 -target "x86_64-apple-macos$DEPLOY" $X86_FLAGS shell-swift/main.swift -o "$TMP/x86_64"
    mkdir -p "$(dirname "$OUT")"
    lipo -create "$TMP/arm64" "$TMP/x86_64" -output "$OUT"
    # 合完立刻验一次。**这条断言不能省**：lipo 对着一份单架构输入也会"成功"，
    # 而一个只有 arm64 的包在 Intel 机器上的表现是「双击没反应」，出包时看不出来
    archs=$(lipo -archs "$OUT")
    case "$archs" in
        *x86_64*) case "$archs" in *arm64*) ;; *) echo "错误：缺 arm64 片（${archs}）" >&2; exit 1 ;; esac ;;
        *) echo "错误：缺 x86_64 片（${archs}）" >&2; exit 1 ;;
    esac
else
    # 开发只编**本机**这一片：省一半时间，而 E2E 本来也只跑本机那一片。
    # 用 `uname -m` 而不是写死 —— 写死 arm64 的话，Intel 机器上 `build.sh` 出来的
    # 二进制自己都跑不起来（这正是 0.3.0 T1 之前的样子）
    HOST=$(uname -m)
    [ "$HOST" = "x86_64" ] && guard_no_swift_concurrency
    FLAGS=""
    [ "$HOST" = "x86_64" ] && FLAGS="$X86_FLAGS"
    mkdir -p "$(dirname "$OUT")"
    # shellcheck disable=SC2086
    swiftc -O -swift-version 5 -target "$HOST-apple-macos$DEPLOY" $FLAGS shell-swift/main.swift -o "$OUT"
fi
