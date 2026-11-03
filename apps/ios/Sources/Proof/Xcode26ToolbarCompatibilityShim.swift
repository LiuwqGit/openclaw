// Evidence-branch compatibility shim for openclaw/openclaw#191474.
//
// Hosted macOS runners ship at most Xcode 26.6 (iOS 26.5 SDK), while the app
// already calls two iOS 27.1 toolbar APIs behind `#available(iOS 27.1, *)`.
// This file declares that missing surface as inert stand-ins so the *unmodified*
// app sources compile and the recovery regression can execute in a simulator.
// It exists only on this evidence branch and is not part of the pull request.
import SwiftUI

/// Stand-in for the iOS 27.1 toolbar axis behaviour.
@available(iOS 27.1, *)
enum ProofToolbarAxisBehavior {
    case verticalPreferred
}

/// Stand-in for the iOS 27.1 toolbar visibility priority.
@available(iOS 27.1, *)
enum ProofToolbarVisibilityPriority {
    case high
}

/// Stand-in for the iOS 27.1 toolbar vertical edge environment value.
@available(iOS 27.1, *)
enum ProofToolbarVerticalEdge {
    case top
    case bottom
}

@available(iOS 27.1, *)
extension EnvironmentValues {
    var toolbarVerticalEdge: ProofToolbarVerticalEdge? {
        nil
    }
}

@available(iOS 27.1, *)
extension ToolbarContent {
    func axisBehavior(_ behavior: ProofToolbarAxisBehavior) -> some ToolbarContent {
        self
    }

    func visibilityPriority(_ priority: ProofToolbarVisibilityPriority) -> some ToolbarContent {
        self
    }
}
