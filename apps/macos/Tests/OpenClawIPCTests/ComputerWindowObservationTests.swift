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
}
