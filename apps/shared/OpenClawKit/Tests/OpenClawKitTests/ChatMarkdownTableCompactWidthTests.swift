import CoreGraphics
import Foundation
import SwiftUI
import Testing
#if os(macOS)
import AppKit
#endif
@testable import OpenClawChatUI

/// Rendered coverage for the shared chat table: every case here measures what a reply actually
/// draws, so a layout that clips the reported table or keeps the compact cell size fails.
@MainActor
struct ChatMarkdownTableCompactWidthTests {
    /// The two-column shape reported on an iPhone 15: a medium-length first column and short
    /// phrases in the second, which together are wider than a compact screen but not by much.
    private static let reportedTableMarkdown = """
    | Oil | Best uses |
    | --- | --- |
    | Canola oil (ideally cold-pressed) | Sautéing, roasting, drizzling |
    | Ghee or clarified butter | Baking, stir-fries, all-purpose |
    | Extra virgin olive oil | Dressings, low-heat finishing |
    """

    /// Render scale, so every point is a whole number of pixels.
    private static let renderScale: CGFloat = 2

    @Test func `reported table wraps its cells at compact width instead of one clipped line`() throws {
        Self.pinLightAppearance()
        let image = try Self.renderedImage(of: Self.reply(Self.reportedTableMarkdown), width: 390)
        // A 390 pt reply gives two columns roughly 178 pt each. Every cell then needs two lines, so
        // the table draws at least seven text bands (header plus three rows of two). Cells that keep
        // a single line draw four bands and leave the last column running off the card instead.
        let bands = Self.contentBands(image)
        #expect(bands >= 6)
    }

    @Test func `table cells render at the reply prose size instead of the footnote size`() throws {
        Self.pinLightAppearance()
        let wide: CGFloat = 1200
        let oneRow = try Self.renderedHeight(of: Self.reply(Self.pitchMarkdown(bodyRows: 1)), width: wide)
        let twoRows = try Self.renderedHeight(of: Self.reply(Self.pitchMarkdown(bodyRows: 2)), width: wide)
        let cellPitch = twoRows - oneRow
        let prosePitch = try Self.probePitch(font: ChatMarkdownRenderer.Typography.response.proseFont)
        let footnotePitch = try Self.probePitch(font: OpenClawChatTypography.footnote)
        // One extra body row adds one cell line plus the grid's vertical spacing, and the probes are
        // built with that same spacing, so all three pitches measure the rendered cell line height.
        #expect(prosePitch > footnotePitch + 1.5)
        #expect(abs(cellPitch - prosePitch) <= 1.5)
        #expect(cellPitch > footnotePitch + 1.5)
    }

    /// Cells short enough to stay on one line at any column width, so the height difference between
    /// two row counts is exactly one cell line.
    private static func pitchMarkdown(bodyRows: Int) -> String {
        var lines = ["| A | B |", "| --- | --- |"]
        for index in 0..<bodyRows {
            lines.append("| a\(index) | b\(index) |")
        }
        return lines.joined(separator: "\n")
    }

    private static func reply(_ markdown: String) -> some View {
        ChatMarkdownRenderer(
            text: markdown,
            context: .assistant,
            variant: .standard,
            textColor: OpenClawChatTheme.assistantText)
            .background(Color.white)
            .environment(\.colorScheme, .light)
    }

    /// Plain text rows carrying the grid's own vertical spacing, so their pitch is directly
    /// comparable with a table row's.
    private static func probe(font: Font, lines: Int) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(0..<lines), id: \.self) { _ in
                Text("Extra virgin olive oil")
                    .font(font)
                    .foregroundStyle(Color.black)
            }
        }
        .padding(10)
        .background(Color.white)
    }

    private static func probePitch(font: Font) throws -> CGFloat {
        let wide: CGFloat = 1200
        let single = try Self.renderedHeight(of: Self.probe(font: font, lines: 1), width: wide)
        let double = try Self.renderedHeight(of: Self.probe(font: font, lines: 2), width: wide)
        return double - single
    }

    #if os(macOS)
    /// The chat theme resolves its text colour against the process appearance rather than the
    /// SwiftUI environment, so pin the light one before measuring rendered pixels.
    private static func pinLightAppearance() {
        NSAppearance.current = NSAppearance(named: .aqua)
    }
    #else
    private static func pinLightAppearance() {}
    #endif

    private static func renderedImage(of view: some View, width: CGFloat) throws -> CGImage {
        let renderer = ImageRenderer(content: view.frame(width: width, alignment: .topLeading))
        renderer.scale = Self.renderScale
        renderer.proposedSize = ProposedViewSize(width: width, height: nil)
        return try #require(renderer.cgImage)
    }

    private static func renderedHeight(of view: some View, width: CGFloat) throws -> CGFloat {
        let image = try Self.renderedImage(of: view, width: width)
        return CGFloat(image.height) / Self.renderScale
    }

    /// Rows that carry content instead of the card's own background, grouped into bands. One band is
    /// one rendered text line.
    private static func contentBands(_ image: CGImage) -> Int {
        guard let pixels = Self.pixels(of: image) else { return 0 }
        let width = image.width
        // The card's bottom padding is background in every theme, so it is the reference colour, and
        // the outer few rows are skipped: they hold the card's stroke and its rounded corners.
        let reference = Self.pixel(pixels, x: width / 2, y: 5, width: width)
        var bands = 0
        var inBand = false
        for y in 6..<(image.height - 6) {
            let content = Self.rowHasContent(pixels, y: y, width: width, reference: reference)
            if content, !inBand { bands += 1 }
            inBand = content
        }
        return bands
    }

    private static func rowHasContent(
        _ pixels: [UInt8],
        y: Int,
        width: Int,
        reference: Pixel) -> Bool
    {
        var x = 0
        while x < width {
            if Self.distance(Self.pixel(pixels, x: x, y: y, width: width), reference) > 60 {
                return true
            }
            x += 2
        }
        return false
    }

    private struct Pixel {
        let red: UInt8
        let green: UInt8
        let blue: UInt8
    }

    private static func pixel(_ pixels: [UInt8], x: Int, y: Int, width: Int) -> Pixel {
        let offset = (y * width + x) * 4
        return Pixel(red: pixels[offset], green: pixels[offset + 1], blue: pixels[offset + 2])
    }

    private static func distance(_ lhs: Pixel, _ rhs: Pixel) -> Int {
        abs(Int(lhs.red) - Int(rhs.red))
            + abs(Int(lhs.green) - Int(rhs.green))
            + abs(Int(lhs.blue) - Int(rhs.blue))
    }

    /// The image composited over white, so transparent padding reads as the page behind the card.
    private static func pixels(of image: CGImage) -> [UInt8]? {
        var buffer = [UInt8](repeating: 255, count: image.width * image.height * 4)
        let bounds = CGRect(x: 0, y: 0, width: CGFloat(image.width), height: CGFloat(image.height))
        guard let context = CGContext(
            data: &buffer,
            width: image.width,
            height: image.height,
            bitsPerComponent: 8,
            bytesPerRow: image.width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(bounds)
        context.draw(image, in: bounds)
        return buffer
    }
}
