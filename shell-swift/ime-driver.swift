// 第八节 17 / 15：向**测试窗口那一个进程**投递真实的键盘与鼠标事件（CGEvent），
// 让系统当前的中文输入法真的接手组字 —— 合成的 CompositionEvent 只推得动 CodeMirror，
// 推不动输入法本身。
//
// 安全边界：**每一个事件**投递之前都确认目标进程就是最前面那个应用，不是就立刻退出
// （退出码 3）—— 人中途切走了窗口，下一个键就不会再发。不切换输入法、不改任何系统设置。
//
// 事件发进 HID 事件流（`.cghidEventTap`，与真键盘同一个入口 —— 输入法就是从这里接手的）。
// 自检默认吞掉一切真实按键，壳要带 `CURSIVE_SMOKE_KEYS=1` 才收得到（check-ime.py / measure.py 会带上）。
//
//   ime-driver front <pid>                    目标是不是最前面的应用（是 → 0，否 → 3）
//   ime-driver type  <pid> <text> [间隔ms]    逐个敲字母 / 数字 / 空格 / = / -（走当前键盘布局）
//   ime-driver key   <pid> <名字> [cmd|ctrl|opt|shift ...]   escape return tab left right up down delete z …
//   ime-driver click <pid> <x> <y>            在屏幕坐标（点，左上为原点）上点一下
//   ime-driver bounds <pid>                   目标最大那个窗口在屏幕上的位置与大小：x y w h（点，左上为原点）
//
// 编译：swiftc -O shell-swift/ime-driver.swift -o <输出>（check-ime.py 会自己编到临时目录）
import AppKit
import ApplicationServices
import Foundation

let KEYS: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
    "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
    "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "o": 31, "u": 32,
    "i": 34, "p": 35, "return": 36, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46, "tab": 48,
    "space": 49, " ": 49, "delete": 51, "escape": 53, "left": 123, "right": 124, "down": 125, "up": 126
]

func fail(_ msg: String, _ code: Int32 = 2) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(code)
}

func pid(_ s: String) -> pid_t {
    guard let n = Int32(s) else { fail("bad pid \(s)") }
    return n
}

/// 目标不在最前面就不投：这是整个工具唯一的一道闸，每一次投递之前都过一遍
func ensureFront(_ target: pid_t) {
    let front = NSWorkspace.shared.frontmostApplication
    guard front?.processIdentifier == target else {
        let who = "\(front?.localizedName ?? "?") (\(front?.processIdentifier ?? -1))"
        fail("target \(target) is not frontmost (\(who) is); refusing to post events", 3)
    }
}

func post(_ target: pid_t, _ code: CGKeyCode, _ flags: CGEventFlags) {
    let src = CGEventSource(stateID: .hidSystemState)
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) else {
        fail("cannot create key event")
    }
    down.flags = flags
    up.flags = flags
    ensureFront(target)
    down.post(tap: .cghidEventTap)
    usleep(12_000)
    up.post(tap: .cghidEventTap)
}

func modifiers(_ names: ArraySlice<String>) -> CGEventFlags {
    var flags: CGEventFlags = []
    for n in names {
        switch n {
        case "cmd": flags.insert(.maskCommand)
        case "ctrl": flags.insert(.maskControl)
        case "opt": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        default: fail("unknown modifier \(n)")
        }
    }
    return flags
}

let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: ime-driver front|type|key|click <pid> …") }
guard AXIsProcessTrusted() else { fail("this process is not trusted for accessibility", 4) }
let target = pid(args[2])

switch args[1] {
case "front":
    ensureFront(target)
case "bounds":
    // 页面坐标换成屏幕坐标要的那个原点。不用页面里的 window.screenX/outerHeight 去推：
    // 全尺寸内容视图下网页从窗口顶边就开始了，拿 outerHeight - innerHeight 当标题栏会整整偏一截
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
    let mine = list.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == target && ($0[kCGWindowLayer as String] as? Int) == 0 }
    let rects = mine.compactMap { w -> CGRect? in
        guard let b = w[kCGWindowBounds as String] as? NSDictionary else { return nil }
        return CGRect(dictionaryRepresentation: b as CFDictionary)
    }
    guard let r = rects.max(by: { $0.width * $0.height < $1.width * $1.height }) else { fail("no window for \(target)") }
    print("\(r.origin.x) \(r.origin.y) \(r.width) \(r.height)")
case "type":
    guard args.count >= 4 else { fail("type needs text") }
    let gap = UInt32((args.count >= 5 ? Int(args[4]) : nil) ?? 35) * 1000
    for ch in args[3] {
        guard let code = KEYS[String(ch)] else { fail("no key for \(ch)") }
        post(target, code, [])
        usleep(gap)
    }
case "key":
    guard args.count >= 4, let code = KEYS[args[3]] else { fail("unknown key") }
    post(target, code, modifiers(args.dropFirst(4)))
case "click":
    guard args.count >= 5, let x = Double(args[3]), let y = Double(args[4]) else { fail("click needs x y") }
    let at = CGPoint(x: x, y: y)
    let src = CGEventSource(stateID: .hidSystemState)
    guard let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: at, mouseButton: .left),
          let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: at, mouseButton: .left) else {
        fail("cannot create mouse event")
    }
    ensureFront(target)
    down.post(tap: .cghidEventTap)
    usleep(40_000)
    ensureFront(target)
    up.post(tap: .cghidEventTap)
default:
    fail("unknown command \(args[1])")
}
