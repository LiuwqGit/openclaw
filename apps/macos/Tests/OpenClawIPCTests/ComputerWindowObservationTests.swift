import CoreGraphics
import Foundation
import OpenClawKit
import PeekabooAutomationKit
import Testing
@testable import OpenClaw

@MainActor
struct ComputerWindowObservationTests {
    @Test func `window executor rejects screenshot omission before capture`() async {
        let service = ComputerWindowActionExecutor()
        do {
            _ = try await service.perform(
                OpenClawComputerActParams(action: .getWindowState, windowRef: "window-1", includeScreenshot: false),
                lifecycleGeneration: 0,
                checkExecutionAllowed: {})
            Issue.record("Expected unsupported screenshot omission")
        } catch {
            #expect(error.localizedDescription.contains("includeScreenshot:false is unsupported by Peekaboo"))
        }
    }

    /// Regression test for #153622: `get_window_state` must run its observation through
    /// Peekaboo's owned snapshot reservation/publication lifecycle. A detection-only
    /// request yields a transient correlation UUID that the snapshot manager rejects
    /// with `Invalid snapshot reference ... expected ps1_ ...` when the consumer tries
    /// to store it, so the request has to ask the provider to save the snapshot itself.
    @Test func `window state observation requests an owned snapshot`() {
        let request = ComputerWindowActionExecutor.windowStateObservationRequest(
            windowID: 42,
            limits: (depth: 8, maxElements: 250))

        #expect(request.output.saveSnapshot)
        #expect(request.output.snapshotID == nil)
        #expect(request.target == .windowID(42))
        #expect(request.capture.focus == .background)
        #expect(request.detection.mode == .accessibility)
        #expect(request.detection.traversalBudget.maxDepth == 8)
        #expect(request.detection.traversalBudget.maxElementCount == 250)
        #expect(request.detection.traversalBudget.maxChildrenPerNode == AXTraversalBudget.defaultMaxChildrenPerNode)
    }

    /// The owned-snapshot flow persists raw observation screenshots on disk; the
    /// executor's snapshot manager must delete those artifacts on eviction/cleanup
    /// so window captures do not accumulate in the temp directory (#153622 review).
    @Test func `window snapshot manager owns artifact cleanup`() async throws {
        let options = ComputerWindowActionExecutor.windowSnapshotManagerOptions
        #expect(options.deleteArtifactsOnCleanup)

        let manager = InMemorySnapshotManager(options: options)
        let artifactURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-window-state-artifact-\(UUID().uuidString).png")
        try Data([0x89, 0x50]).write(to: artifactURL)
        defer { try? FileManager.default.removeItem(at: artifactURL) }
        #expect(FileManager.default.fileExists(atPath: artifactURL.path))

        let snapshotID = try await manager.createSnapshot(pendingAt: Date())
        try await manager.storeScreenshot(SnapshotScreenshotRequest(
            snapshotId: snapshotID,
            screenshotPath: artifactURL.path,
            applicationBundleId: nil,
            applicationProcessId: nil,
            applicationName: nil,
            windowTitle: "Cleanup Contract",
            windowBounds: CGRect(x: 0, y: 0, width: 100, height: 100)))
        try await manager.cleanSnapshot(snapshotId: snapshotID)
        #expect(!FileManager.default.fileExists(atPath: artifactURL.path))
    }

    /// Regression coverage for the artifact-retention finding (#153622 review): the
    /// manager's 25-entry LRU limit must delete an evicted snapshot's screenshot
    /// file together with its record, not leave the window capture on disk.
    @Test func `window snapshot eviction removes evicted artifact files`() async throws {
        let manager = InMemorySnapshotManager(options: ComputerWindowActionExecutor.windowSnapshotManagerOptions)
        var artifactPaths: [String] = []
        defer {
            for path in artifactPaths {
                try? FileManager.default.removeItem(atPath: path)
            }
        }

        for index in 0...25 {
            let artifactURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("openclaw-window-state-eviction-\(index)-\(UUID().uuidString).png")
            try Data([0x89, 0x50]).write(to: artifactURL)
            artifactPaths.append(artifactURL.path)

            let snapshotID = try await manager.createSnapshot(pendingAt: Date())
            try await manager.storeScreenshot(SnapshotScreenshotRequest(
                snapshotId: snapshotID,
                screenshotPath: artifactURL.path,
                applicationBundleId: nil,
                applicationProcessId: nil,
                applicationName: nil,
                windowTitle: "Eviction \(index)",
                windowBounds: CGRect(x: 0, y: 0, width: 100, height: 100)))
        }

        #expect(artifactPaths.count == 26)
        // The earliest snapshot was evicted by the LRU limit; its artifact must be gone.
        #expect(!FileManager.default.fileExists(atPath: artifactPaths[0]))
        // The most recent snapshots survive with their artifacts still readable.
        #expect(FileManager.default.fileExists(atPath: artifactPaths[25]))
    }
}
