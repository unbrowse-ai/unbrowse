// Draws the Unbrowse U-magnet (unbrowse-landing/public/favicon.svg) as PNGs, in the SVG's own 64-unit geometry.
// usage: swift render.swift <tile|square|macos> <pixels> <out.png>
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
let variant = args[1]
let px = Int(args[2])!
let out = URL(fileURLWithPath: args[3])

let night = CGColor(srgbRed: 0x04 / 255.0, green: 0x06 / 255.0, blue: 0x0E / 255.0, alpha: 1)
let blue = CGColor(srgbRed: 0x1F / 255.0, green: 0x5E / 255.0, blue: 0xFF / 255.0, alpha: 1)
let paper = CGColor(srgbRed: 0xF4 / 255.0, green: 0xF6 / 255.0, blue: 0xFB / 255.0, alpha: 1)

let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.setShouldAntialias(true)
ctx.interpolationQuality = .high
// SVG units, y down.
let k = CGFloat(px) / 64
ctx.translateBy(x: 0, y: CGFloat(px))
ctx.scaleBy(x: k, y: -k)

// The ground: where it sits in the 64-unit box, and how round.
let (inset, side, radius): (CGFloat, CGFloat, CGFloat) = switch variant {
case "tile": (0, 64, 14)
case "square": (0, 64, 0)
case "macos": (64 * 100 / 1024, 64 * 824 / 1024, 64 * 185.4 / 1024) // Apple's icon grid: 824 of 1024, corner 185.4
default: fatalError("variant: tile, square or macos")
}
ctx.addPath(CGPath(roundedRect: CGRect(x: inset, y: inset, width: side, height: side), cornerWidth: radius, cornerHeight: radius, transform: nil))
ctx.setFillColor(night)
ctx.fillPath()

// The mark inside the ground at 80%, as favicon.svg places it (translate 6.4, scale .8 on a 64 ground).
ctx.translateBy(x: inset + side * 0.1, y: inset + side * 0.1)
ctx.scaleBy(x: side / 64 * 0.8, y: side / 64 * 0.8)

// M12 19V37a20 20 0 0 0 40 0V19H40v18a8 8 0 0 1-16 0V19Z: the body, outer arc through the bottom, inner arc back.
let body = CGMutablePath()
body.move(to: CGPoint(x: 12, y: 19))
body.addLine(to: CGPoint(x: 12, y: 37))
let steps = 720
for i in 0...steps {
    let t = Double.pi * (1 - Double(i) / Double(steps)) // pi -> 0, through pi/2 (the bottom, y down)
    body.addLine(to: CGPoint(x: 32 + 20 * cos(t), y: 37 + 20 * sin(t)))
}
body.addLine(to: CGPoint(x: 52, y: 19))
body.addLine(to: CGPoint(x: 40, y: 19))
body.addLine(to: CGPoint(x: 40, y: 37))
for i in 0...steps {
    let t = Double.pi * Double(i) / Double(steps) // 0 -> pi
    body.addLine(to: CGPoint(x: 32 + 8 * cos(t), y: 37 + 8 * sin(t)))
}
body.addLine(to: CGPoint(x: 24, y: 19))
body.closeSubpath()
ctx.addPath(body)
ctx.setFillColor(blue)
ctx.fillPath()

// M12 7h12v10H12zM40 7h12v10H40z: the bare pole tips, a 2-unit gap above the body.
ctx.addRect(CGRect(x: 12, y: 7, width: 12, height: 10))
ctx.addRect(CGRect(x: 40, y: 7, width: 12, height: 10))
ctx.setFillColor(paper)
ctx.fillPath()

let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("couldn't write \(out.path)") }
