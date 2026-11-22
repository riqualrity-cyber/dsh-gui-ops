// gui-ops helper: the boring, reliable half of GUI automation on macOS.
//
// Subcommands (JSON on stdout):
//   screen                      display size in points + pixel scale
//   front                       frontmost application
//   ocr   <png> [x0 y0 x1 y1]   text lines with CENTER coordinates in points
//   boxes <png> <x0> <x1> [y0 y1]
//                               checkbox/radio rows in a vertical strip, on/off
//   click <x> <y> [hold_ms]     synthetic click with a hold (many web buttons
//                               ignore a 60 ms down/up pair)
//   move  <x> <y>
//   window <app> <x> <y> <w> <h>
//                               AX window bounds + read-back verification
//
// All coordinates are points in the global top-left origin space, which is what
// CGEvent expects. Vision returns bottom-left normalized boxes; they are
// converted here so callers never do that math again.
import Foundation
import AppKit
import Vision
import ImageIO
import CoreGraphics

// MARK: - output

func emit(_ dict: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    exit(0)
}

func fail(_ message: String) -> Never {
    emit(["ok": false, "error": message])
}

func num(_ v: Any?) -> Double? {
    if let d = v as? Double { return d }
    if let i = v as? Int { return Double(i) }
    if let n = v as? NSNumber { return n.doubleValue }
    return nil
}

// MARK: - screen geometry

let mainDisplay = CGMainDisplayID()
let displayBounds = CGDisplayBounds(mainDisplay) // top-left origin, points
let displayW = Double(displayBounds.width)
let displayH = Double(displayBounds.height)

// MARK: - raster access

struct Raster {
    let width: Int
    let height: Int
    var pixels: [UInt8]

    init?(path: String) {
        guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
        width = img.width
        height = img.height
        pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let ctx = CGContext(data: &pixels, width: width, height: height,
                                  bitsPerComponent: 8, bytesPerRow: width * 4,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: width, height: height))
    }

    func rgb(_ x: Int, _ y: Int) -> (Int, Int, Int) {
        let i = (y * width + x) * 4
        return (Int(pixels[i]), Int(pixels[i + 1]), Int(pixels[i + 2]))
    }
}

/// Points-per-pixel for a screenshot of the main display.
func scale(for raster: Raster) -> Double {
    displayW > 0 ? displayW / Double(raster.width) : 1
}

// MARK: - ocr

func runOCR(_ raster: Raster, filter: CGRect?) {
    guard let src = CGImageSourceCreateWithURL(
        URL(fileURLWithPath: CommandLine.arguments[2]) as CFURL, nil),
        let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail("cannot load image") }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: img, options: [:])
    do { try handler.perform([request]) } catch { fail("vision failed: \(error)") }

    let s = scale(for: raster)
    var lines: [[String: Any]] = []
    for obs in request.results ?? [] {
        guard let cand = obs.topCandidates(1).first else { continue }
        let bb = obs.boundingBox // normalized, origin bottom-left
        // center in points, top-left origin
        let cx = (bb.origin.x + bb.width / 2) * displayW
        let cy = (1 - (bb.origin.y + bb.height / 2)) * displayH
        let wPt = bb.width * displayW
        let hPt = bb.height * displayH
        if let f = filter, !f.contains(CGPoint(x: cx, y: cy)) { continue }
        lines.append([
            "text": cand.string,
            "x": (cx * 10).rounded() / 10,
            "y": (cy * 10).rounded() / 10,
            "w": (wPt * 10).rounded() / 10,
            "h": (hPt * 10).rounded() / 10,
            "conf": Double((cand.confidence * 1000).rounded() / 1000)
        ])
    }
    lines.sort { (a, b) in
        let ay = num(a["y"])!, by = num(b["y"])!
        if abs(ay - by) > 4 { return ay < by }
        return num(a["x"])! < num(b["x"])!
    }
    emit(["ok": true, "width_pt": displayW, "height_pt": displayH,
          "scale": s, "count": lines.count, "lines": lines])
}

// MARK: - checkbox column scan

func runBoxes(_ raster: Raster, x0: Double, x1: Double, y0: Double, y1: Double) {
    let s = scale(for: raster)
    let px0 = max(0, Int(x0 / s)), px1 = min(raster.width - 1, Int(x1 / s))
    let py0 = max(0, Int(y0 / s)), py1 = min(raster.height - 1, Int(y1 / s))
    if px1 <= px0 || py1 <= py0 { fail("empty scan region") }

    var rows: [Int] = []
    for yy in py0...py1 {
        var hit = false
        for xx in px0...px1 {
            let (r, g, b) = raster.rgb(xx, yy)
            if !(r > 244 && g > 244 && b > 244) { hit = true; break }
        }
        rows.append(hit ? 1 : 0)
    }

    var runs: [(Int, Int)] = []
    var start: Int? = nil
    for (i, v) in rows.enumerated() {
        if v == 1 { if start == nil { start = i } }
        else if let st = start { if i - st >= 5 { runs.append((st, i - 1)) }; start = nil }
    }
    if let st = start, rows.count - st >= 5 { runs.append((st, rows.count - 1)) }

    var out: [[String: Any]] = []
    for (a, b) in runs {
        var green = 0
        for yy in (py0 + a)...(py0 + b) {
            for xx in px0...px1 {
                let (r, g, bl) = raster.rgb(xx, yy)
                if g > 120 && g - r > 40 && g - bl > 15 { green += 1 }
            }
        }
        let cy = (Double(py0 + a) + Double(py0 + b)) / 2 * s
        out.append(["y": (cy * 10).rounded() / 10, "on": green > 12, "green": green])
    }
    emit(["ok": true, "x0": x0, "x1": x1, "count": out.count, "rows": out])
}

// MARK: - synthetic input

func postClick(_ p: CGPoint, holdMs: Int) {
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?
        .post(tap: .cghidEventTap)
    usleep(120_000)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)?
        .post(tap: .cghidEventTap)
    usleep(useconds_t(max(20, holdMs)) * 1000)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)?
        .post(tap: .cghidEventTap)
}

// MARK: - window bounds

func appWindows(_ appName: String) -> [AXUIElement] {
    guard let app = NSWorkspace.shared.runningApplications.first(where: {
        $0.localizedName == appName || $0.bundleIdentifier == appName
    }) else { return [] }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &value) == .success,
          let windows = value as? [AXUIElement] else { return [] }
    return windows
}

func readBounds(_ win: AXUIElement) -> CGRect? {
    var posRef: CFTypeRef?, sizeRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(win, kAXPositionAttribute as CFString, &posRef) == .success,
          AXUIElementCopyAttributeValue(win, kAXSizeAttribute as CFString, &sizeRef) == .success
    else { return nil }
    var p = CGPoint.zero, sz = CGSize.zero
    AXValueGetValue(posRef as! AXValue, .cgPoint, &p)
    AXValueGetValue(sizeRef as! AXValue, .cgSize, &sz)
    return CGRect(origin: p, size: sz)
}

func runWindow(_ appName: String, _ rect: CGRect) {
    guard !appWindows(appName).isEmpty else { fail("no window for \(appName)") }
    guard let win = appWindows(appName).first else { fail("no window") }
    var p = rect.origin
    var sz = rect.size
    AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &p)!)
    AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &sz)!)
    // The window server may retile asynchronously; report what actually happened.
    usleep(450_000)
    let after = readBounds(win) ?? .zero
    emit(["ok": true,
          "requested": ["x": rect.origin.x, "y": rect.origin.y, "w": rect.size.width, "h": rect.size.height],
          "actual": ["x": after.origin.x, "y": after.origin.y, "w": after.size.width, "h": after.size.height],
          "matched": abs(after.height - rect.height) < 2 && abs(after.width - rect.width) < 2])
}

// MARK: - dispatch

let args = CommandLine.arguments
guard args.count > 1 else { fail("usage: gui-ops <subcommand> ...") }

switch args[1] {
case "screen":
    emit(["ok": true, "width_pt": displayW, "height_pt": displayH])

case "front":
    let app = NSWorkspace.shared.frontmostApplication
    emit(["ok": true, "app": app?.localizedName ?? "", "bundle": app?.bundleIdentifier ?? ""])

case "ocr":
    guard args.count > 2, let raster = Raster(path: args[2]) else { fail("cannot load image") }
    var filter: CGRect? = nil
    if args.count >= 7, let x0 = Double(args[3]), let y0 = Double(args[4]),
       let x1 = Double(args[5]), let y1 = Double(args[6]) {
        filter = CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
    }
    runOCR(raster, filter: filter)

case "boxes":
    guard args.count >= 5, let raster = Raster(path: args[2]),
          let x0 = Double(args[3]), let x1 = Double(args[4]) else { fail("usage: boxes <png> <x0> <x1> [y0 y1]") }
    let y0 = args.count >= 7 ? (Double(args[5]) ?? 0) : 0
    let y1 = args.count >= 7 ? (Double(args[6]) ?? displayH) : displayH
    runBoxes(raster, x0: x0, x1: x1, y0: y0, y1: y1)

case "click":
    guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else { fail("usage: click <x> <y> [hold_ms]") }
    let hold = args.count >= 5 ? (Int(args[4]) ?? 150) : 150
    postClick(CGPoint(x: x, y: y), holdMs: hold)
    emit(["ok": true, "x": x, "y": y, "hold_ms": hold])

case "move":
    guard args.count >= 4, let x = Double(args[2]), let y = Double(args[3]) else { fail("usage: move <x> <y>") }
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)?
        .post(tap: .cghidEventTap)
    emit(["ok": true, "x": x, "y": y])

case "window":
    guard args.count >= 7, let x = Double(args[3]), let y = Double(args[4]),
          let w = Double(args[5]), let h = Double(args[6]) else {
        fail("usage: window <app> <x> <y> <w> <h>")
    }
    runWindow(args[2], CGRect(x: x, y: y, width: w, height: h))

default:
    fail("unknown subcommand \(args[1])")
}
