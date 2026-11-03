import OpenClawKit
import SwiftUI
import UIKit
import XCTest
@testable import OpenClaw

/// Rendered-behavior regression for the drawer's active-destination highlight.
///
/// All Sessions, the footer Gateway control, and the Settings gear live outside
/// `destinationButton(_:)`, so nothing but their own `.background(...)` gives them the
/// shared `OpenClawSidebarPalette.selection` treatment the Pages rows already have.
/// Every expectation below reads pixels out of an on-screen render of the real views:
/// selecting a destination must paint the selection background behind that destination's
/// own control, and behind none of the others. A tree without the highlight fails these
/// assertions instead of only failing a source-text search.
@MainActor
final class RootSidebarSelectionRenderTests: XCTestCase {
    private enum Control: String, CaseIterable {
        case allSessions = "all-sessions"
        case gateway
        case settings

        var destination: RootTabs.SidebarDestination {
            switch self {
            case .allSessions: .sessions
            case .gateway: .gateway
            case .settings: .settings
            }
        }
    }

    /// Row-major RGBA bytes of a render, row 0 being the rendered top edge.
    private struct PixelCanvas {
        let width: Int
        let height: Int
        let scale: CGFloat
        let bytes: [UInt8]

        func pixel(x: Int, y: Int) -> (red: Int, green: Int, blue: Int) {
            let clampedX = min(max(x, 0), self.width - 1)
            let clampedY = min(max(y, 0), self.height - 1)
            let index = (clampedY * self.width + clampedX) * 4
            return (
                red: Int(self.bytes[index]),
                green: Int(self.bytes[index + 1]),
                blue: Int(self.bytes[index + 2]))
        }

        /// Share of the rect's pixels matching `target` within `tolerance` per channel.
        func matchFraction(
            in rect: CGRect,
            scale: CGFloat,
            target: (red: Int, green: Int, blue: Int),
            tolerance: Int) -> Double
        {
            let bounds = self.pixelBounds(rect, scale: scale)
            guard let bounds else { return 0 }
            var matches = 0
            var total = 0
            for y in bounds.minY...bounds.maxY {
                for x in bounds.minX...bounds.maxX {
                    total += 1
                    let pixel = self.pixel(x: x, y: y)
                    if abs(pixel.red - target.red) <= tolerance,
                       abs(pixel.green - target.green) <= tolerance,
                       abs(pixel.blue - target.blue) <= tolerance
                    {
                        matches += 1
                    }
                }
            }
            return total == 0 ? 0 : Double(matches) / Double(total)
        }

        /// Pixel mask of the rect, clamped to the canvas; nil when the rect covers no pixel.
        private func pixelBounds(_ rect: CGRect, scale: CGFloat) -> PixelBounds? {
            let minX = max(0, Int((rect.minX * scale).rounded()))
            let minY = max(0, Int((rect.minY * scale).rounded()))
            let maxX = min(self.width - 1, Int((rect.maxX * scale).rounded()))
            let maxY = min(self.height - 1, Int((rect.maxY * scale).rounded()))
            guard maxX > minX, maxY > minY else { return nil }
            return PixelBounds(minX: minX, minY: minY, maxX: maxX, maxY: maxY)
        }
    }

    private struct PixelBounds {
        let minX: Int
        let minY: Int
        let maxX: Int
        let maxY: Int
    }

    /// Pixels whose selection background appeared between two renders of the same sidebar.
    private struct SelectionDelta {
        let width: Int
        let height: Int
        let scale: CGFloat
        let mask: [Bool]
        let count: Int

        var bbox: CGRect? {
            var minX = self.width
            var minY = self.height
            var maxX = -1
            var maxY = -1
            for y in 0..<self.height {
                for x in 0..<self.width where self.mask[y * self.width + x] {
                    minX = min(minX, x)
                    maxX = max(maxX, x)
                    minY = min(minY, y)
                    maxY = max(maxY, y)
                }
            }
            guard maxX >= minX, maxY >= minY else { return nil }
            return CGRect(
                x: CGFloat(minX) / self.scale,
                y: CGFloat(minY) / self.scale,
                width: CGFloat(maxX - minX + 1) / self.scale,
                height: CGFloat(maxY - minY + 1) / self.scale)
        }

        func count(in rect: CGRect) -> Int {
            let minX = max(0, Int((rect.minX * self.scale).rounded()))
            let minY = max(0, Int((rect.minY * self.scale).rounded()))
            let maxX = min(self.width - 1, Int((rect.maxX * self.scale).rounded()))
            let maxY = min(self.height - 1, Int((rect.maxY * self.scale).rounded()))
            guard maxX > minX, maxY > minY else { return 0 }
            var total = 0
            for y in minY...maxY {
                for x in minX...maxX where self.mask[y * self.width + x] {
                    total += 1
                }
            }
            return total
        }
    }

    private struct Render {
        let image: UIImage
        let canvas: PixelCanvas
        let scale: CGFloat
    }

    /// The drawer's own column width, tall enough that every section renders without scrolling.
    private static let sidebarSize = CGSize(width: 316, height: 1200)
    private static let pickerSize = CGSize(width: 296, height: 96)
    /// The footer is ~53pt tall; this band keeps body rows and footer controls unambiguous.
    private static let footerBandHeight: CGFloat = 200
    /// Text and SF Symbols cover part of every control, so a highlighted control is not 100% selection.
    private static let highlightedFloor = 0.25
    private static let clearedCeiling = 0.02
    private static let channelTolerance = 3

    func testPixelCanvasSamplesRowsTopDown() throws {
        let probe = VStack(spacing: 0) {
            Color(red: 0.9, green: 0.1, blue: 0.1).frame(height: 24)
            Color(red: 0.1, green: 0.2, blue: 0.9).frame(height: 24)
        }
        .frame(width: 60, height: 48)
        let render = try self.render(probe, size: CGSize(width: 60, height: 48))
        let top = render.canvas.matchFraction(
            in: CGRect(x: 0, y: 0, width: 60, height: 12),
            scale: render.scale,
            target: render.canvas.pixel(x: Int(10 * render.scale), y: Int(6 * render.scale)),
            tolerance: 2)
        let bottom = render.canvas.matchFraction(
            in: CGRect(x: 0, y: 36, width: 60, height: 12),
            scale: render.scale,
            target: render.canvas.pixel(x: Int(10 * render.scale), y: Int(42 * render.scale)),
            tolerance: 2)
        XCTAssertEqual(top, 1, "The canvas must read the rendered top edge first")
        XCTAssertEqual(bottom, 1, "The canvas must read the rendered bottom edge last")
        let warm = render.canvas.pixel(x: Int(10 * render.scale), y: Int(6 * render.scale))
        let cool = render.canvas.pixel(x: Int(10 * render.scale), y: Int(42 * render.scale))
        XCTAssertGreaterThan(warm.red, warm.blue + 40, "The top probe band must stay warm")
        XCTAssertGreaterThan(cool.blue, cool.red + 40, "The bottom probe band must stay cool")
    }

    func testActiveDestinationControlsCarryTheSharedSelectionBackground() throws {
        let selection = try self.renderedSelectionColor()
        let appModel = NodeAppModel()
        appModel.enterScreenshotFixtureMode()
        let gatewayController = GatewayConnectionController(appModel: appModel, startDiscovery: false)
        let sidebarModel = RootSidebarModel()
        let referenceDestination = RootTabs.SidebarDestination.overview

        let reference = try self.renderSidebar(
            destination: referenceDestination,
            appModel: appModel,
            gatewayController: gatewayController,
            sidebarModel: sidebarModel)
        self.attach(reference.image, named: "sidebar-reference-\(referenceDestination.rawValue)")
        print("[selection-proof] reference(\(referenceDestination.rawValue)) selection share per control:")
        for control in Control.allCases {
            print("[selection-proof]   \(control.rawValue)=\(String(
                format: "%.3f",
                reference.canvas.matchFraction(
                    in: Self.expectedRect(control, size: Self.sidebarSize),
                    scale: reference.scale,
                    target: selection,
                    tolerance: Self.channelTolerance)))")
        }

        for control in Control.allCases {
            let render = try self.renderSidebar(
                destination: control.destination,
                appModel: appModel,
                gatewayController: gatewayController,
                sidebarModel: sidebarModel)
            self.attach(render.image, named: "sidebar-destination-\(control.destination.rawValue)")
            let delta = Self.selectionDelta(reference: reference.canvas, target: render.canvas, matching: selection)
            guard let bbox = delta.bbox else {
                XCTFail(
                    "Selecting \(control.destination.rawValue) painted no \(Self.selectionLabel) background anywhere in the drawer")
                continue
            }
            print("[selection-proof] \(control.rawValue) delta bbox=\(bbox) pixels=\(delta.count)")

            let ownPixels = delta.count(in: Self.expectedRect(control, size: Self.sidebarSize))
            XCTAssertGreaterThan(
                ownPixels,
                0,
                "Selecting \(control.destination.rawValue) must paint the selection background inside the \(control.rawValue) control (delta bbox \(bbox))")
            let share = render.canvas.matchFraction(
                in: bbox,
                scale: render.scale,
                target: selection,
                tolerance: Self.channelTolerance)
            XCTAssertGreaterThan(
                share,
                Self.highlightedFloor,
                "The \(control.rawValue) highlight must be the shared selection background, not an incidental color (rendered \(share))")
            self.attachControl(render, rect: bbox, name: "\(control.destination.rawValue)-\(control.rawValue)-selected")

            for other in Control.allCases where other != control {
                let otherRect = Self.expectedRect(other, size: Self.sidebarSize)
                XCTAssertEqual(
                    delta.count(in: otherRect),
                    0,
                    "Selecting \(control.destination.rawValue) must leave the \(other.rawValue) control without a new selection background")
                self.attachControl(
                    render,
                    rect: otherRect,
                    name: "\(control.destination.rawValue)-\(other.rawValue)-cleared")
            }
        }
    }

    func testSavedGatewayMenuControlCarriesTheSharedSelectionBackground() throws {
        let selection = try self.renderedSelectionColor()
        let entries = [
            Self.registryEntry("gateway-studio", name: "Studio"),
            Self.registryEntry("gateway-home", name: "Home"),
        ]
        let presentation = SidebarGatewayPresentation(
            registry: GatewaySettingsStore.GatewayRegistry(
                activeStableID: entries[0].stableID,
                entries: entries),
            connectionID: entries[0].stableID,
            connectedID: entries[0].stableID,
            state: .connected)

        for isSelected in [true, false] {
            let picker = SidebarGatewayPicker(
                presentation: presentation,
                fallbackName: "OpenClaw",
                isSwitching: false,
                isSelected: isSelected,
                selectGateway: { _ in },
                openSettings: {})
            let render = try self.render(
                picker
                    .frame(width: Self.pickerSize.width)
                    .background(OpenClawSidebarPalette.background)
                    .frame(
                        width: Self.pickerSize.width,
                        height: Self.pickerSize.height,
                        alignment: .center),
                size: Self.pickerSize)
            let share = render.canvas.matchFraction(
                in: CGRect(origin: .zero, size: Self.pickerSize),
                scale: render.scale,
                target: selection,
                tolerance: Self.channelTolerance)
            let state = isSelected ? "selected" : "cleared"
            self.attach(render.image, named: "gateway-menu-\(state)")
            print("[selection-proof] gateway menu \(state) selection share=\(String(format: "%.3f", share))")
            if isSelected {
                XCTAssertGreaterThan(
                    share,
                    Self.highlightedFloor,
                    "The saved-gateway menu control must reuse the selection background while Gateway is displayed (rendered \(share))")
            } else {
                XCTAssertLessThan(
                    share,
                    Self.clearedCeiling,
                    "The saved-gateway menu control must clear the selection background for another destination (rendered \(share))")
            }
        }
    }

    // MARK: - Rendering

    private static var selectionLabel: String {
        "OpenClawSidebarPalette.selection"
    }

    private func renderSidebar(
        destination: RootTabs.SidebarDestination,
        appModel: NodeAppModel,
        gatewayController: GatewayConnectionController,
        sidebarModel: RootSidebarModel) throws -> Render
    {
        let sidebar = RootSidebar(
            model: sidebarModel,
            selectedDestination: destination,
            isDrawerLayout: true,
            // Keeps the animated brand mark paused so two renders of the same destination
            // differ only where the selection background does.
            isDismissButtonEnabled: false,
            selectDestination: { _ in },
            selectSession: { _ in },
            hideSidebar: {})
            .environment(AppAppearanceModel())
            .environment(appModel)
            .environment(appModel.voiceWake)
            .environment(gatewayController)
            .preferredColorScheme(.light)
        return try self.render(sidebar, size: Self.sidebarSize)
    }

    private func render(_ root: some View, size: CGSize) throws -> Render {
        let bounds = CGRect(origin: .zero, size: size)
        let window = UIWindow(frame: bounds)
        window.overrideUserInterfaceStyle = .light
        let controller = UIHostingController(rootView: root)
        controller.overrideUserInterfaceStyle = .light
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.rootViewController = nil
            window.isHidden = true
        }
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: bounds).image { _ in
            controller.view.drawHierarchy(in: bounds, afterScreenUpdates: true)
        }
        return try Render(image: image, canvas: self.makeCanvas(image), scale: image.scale)
    }

    private func makeCanvas(_ image: UIImage) throws -> PixelCanvas {
        let cgImage = try XCTUnwrap(image.cgImage, "The render produced no bitmap")
        let width = cgImage.width
        let height = cgImage.height
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let context = try XCTUnwrap(
            CGContext(
                data: &bytes,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
            "The render bitmap context could not be created")
        // Row 0 must stay the rendered top edge so control geometry maps onto pixels directly.
        context.translateBy(x: 0, y: CGFloat(height))
        context.scaleBy(x: 1, y: -1)
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
        return PixelCanvas(width: width, height: height, scale: image.scale, bytes: bytes)
    }

    /// The selection color as this render pipeline actually paints it, so color management
    /// cannot turn the expectation into a guess.
    private func renderedSelectionColor() throws -> (red: Int, green: Int, blue: Int) {
        let swatchSize = CGSize(width: 24, height: 24)
        let swatch = RoundedRectangle(cornerRadius: OpenClawProMetric.controlRadius, style: .continuous)
            .fill(OpenClawSidebarPalette.selection)
            .frame(width: swatchSize.width, height: swatchSize.height)
        let render = try self.render(swatch, size: swatchSize)
        let center = render.canvas.pixel(
            x: Int(12 * render.scale),
            y: Int(12 * render.scale))
        print("[selection-proof] rendered \(Self.selectionLabel) rgb=\(center)")
        return center
    }

    private static func selectionDelta(
        reference: PixelCanvas,
        target: PixelCanvas,
        matching selection: (red: Int, green: Int, blue: Int)) -> SelectionDelta
    {
        let width = target.width
        let height = target.height
        let tolerance = self.channelTolerance
        var mask = [Bool](repeating: false, count: width * height)
        var count = 0
        func matches(_ canvas: PixelCanvas, _ index: Int) -> Bool {
            let base = index * 4
            return abs(Int(canvas.bytes[base]) - selection.red) <= tolerance &&
                abs(Int(canvas.bytes[base + 1]) - selection.green) <= tolerance &&
                abs(Int(canvas.bytes[base + 2]) - selection.blue) <= tolerance
        }
        guard width == reference.width, height == reference.height else {
            return SelectionDelta(width: width, height: height, scale: target.scale, mask: mask, count: 0)
        }
        for index in 0..<width * height where matches(target, index) && !matches(reference, index) {
            mask[index] = true
            count += 1
        }
        return SelectionDelta(width: width, height: height, scale: target.scale, mask: mask, count: count)
    }

    /// Where each control's selection background has to appear: the gear and the gateway
    /// control own disjoint footer strips, All Sessions owns the scrolling body above them.
    private static func expectedRect(_ control: Control, size: CGSize) -> CGRect {
        let footerTop = size.height - self.footerBandHeight
        switch control {
        case .allSessions:
            return CGRect(x: 0, y: 0, width: size.width, height: footerTop)
        case .gateway:
            // 10pt inset + 4pt spacing + the 40pt gear keep the gateway control left of width - 54.
            return CGRect(x: 0, y: footerTop, width: size.width - 54, height: self.footerBandHeight)
        case .settings:
            return CGRect(x: size.width - 50, y: footerTop, width: 50, height: self.footerBandHeight)
        }
    }

    // MARK: - Attachments and fixtures

    private func attach(_ image: UIImage, named name: String) {
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        self.add(attachment)
    }

    private func attachControl(_ render: Render, rect: CGRect, name: String) {
        // The body band is a whole scroll view; only control-sized regions make a readable crop.
        guard rect.height <= 300, rect.width <= 400 else { return }
        guard let crop = Self.crop(render.image, to: rect, scale: render.scale) else { return }
        self.attach(crop, named: "sidebar-control-\(name)")
    }

    private static func crop(_ image: UIImage, to rect: CGRect, scale: CGFloat) -> UIImage? {
        guard let cgImage = image.cgImage else { return nil }
        let inset: CGFloat = 6
        let x = max(0, (rect.minX - inset) * scale)
        let y = max(0, (rect.minY - inset) * scale)
        let width = min(CGFloat(cgImage.width) - x, (rect.width + inset * 2) * scale)
        let height = min(CGFloat(cgImage.height) - y, (rect.height + inset * 2) * scale)
        guard width > 1, height > 1,
              let cropped = cgImage.cropping(to: CGRect(x: x, y: y, width: width, height: height))
        else { return nil }
        return UIImage(cgImage: cropped, scale: scale, orientation: .up)
    }

    private static func registryEntry(
        _ id: String,
        name: String) -> GatewaySettingsStore.GatewayRegistryEntry
    {
        .init(
            stableID: id,
            kind: .manual,
            name: name,
            host: "gateway.example.com",
            port: 443,
            useTLS: true,
            lastConnectedAtMs: nil)
    }
}
