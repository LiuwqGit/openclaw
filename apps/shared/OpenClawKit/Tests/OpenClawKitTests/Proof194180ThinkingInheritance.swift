import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

/// Evidence harness for openclaw/openclaw PR #194180 (issue #194163).
///
/// This file lives only on the fork-local `proof/pr-194180-thinking-inheritance`
/// branch; it is deliberately not part of the pull request diff. Every test here
/// drives shipped `OpenClawChatUI` code (the view model's send resolver, the
/// `chat.send` request builder and the SQLite outbox store) and prints
/// machine-readable `PROOF194180_<KEY>=<value>` lines so the CI log itself is the
/// evidence artifact. The same file is executed twice by the proof workflow:
/// once against the pull request head and once against a behaviour-reverted base
/// (the two fixed sources replaced with upstream main's), so the captured wire
/// payload and durable rows are shown changing for the defect and not for the
/// harness.
///
/// Nothing here references symbols introduced by the fix, so the file compiles
/// unchanged against base sources.
enum Proof194180 {
    static let gatewayID = "gw-proof-194180"
    /// The reporter's model (`anthropic/claude-opus-5-5`) advertises these levels;
    /// `off` is not among them, which is why an injected `off` override is
    /// rejected by the Gateway before the run starts.
    static let advertisedLevels = ["low", "medium", "high", "xhigh", "max", "ultra"]

    /// Durable directory shared by the seed phase (base logic) and the upgrade
    /// phase (head logic) so the second phase reads rows the first one wrote.
    static var durableDirectory: URL {
        if let override = ProcessInfo.processInfo.environment["PROOF_194180_DB_DIR"],
           !override.isEmpty
        {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return FileManager.default.temporaryDirectory
            .appendingPathComponent("proof-194180-durable", isDirectory: true)
    }

    /// Markers go to stdout *and* to `$PROOF_194180_MARKERS` when set, because a
    /// test runner may capture the stdout of a passing test. The file is the
    /// artifact the workflow collects.
    static func emit(_ key: String, _ value: String) {
        let line = "PROOF194180_\(key)=\(value)"
        print(line)
        guard let path = ProcessInfo.processInfo.environment["PROOF_194180_MARKERS"],
              !path.isEmpty,
              let data = (line + "\n").data(using: .utf8)
        else { return }
        let url = URL(fileURLWithPath: path)
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        if FileManager.default.fileExists(atPath: path),
           let handle = try? FileHandle(forWritingTo: url)
        {
            defer { try? handle.close() }
            handle.seekToEndOfFile()
            try? handle.write(contentsOf: data)
            return
        }
        try? data.write(to: url)
    }

    static func quoted(_ value: String) -> String {
        "\"\(value)\""
    }

    static func makeStore() throws -> (
        store: OpenClawChatSQLiteTranscriptCache,
        databases: OpenClawClientDatabases,
        directory: URL
    ) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("proof-194180-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let databases = try OpenClawClientDatabases(directoryURL: directory)
        return (databases.store(gatewayID: "gw-test"), databases, directory)
    }

    static func openDurable() throws -> (OpenClawClientDatabases, OpenClawChatSQLiteTranscriptCache) {
        let directory = Self.durableDirectory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let databases = try OpenClawClientDatabases(directoryURL: directory)
        return (databases, databases.store(gatewayID: Self.gatewayID))
    }

    /// Builds the real `chat.send` request the shipped transport would put on the
    /// wire for a resolved thinking level, plus its deterministic JSON form.
    static func wirePayload(
        thinking: String,
        message: String,
        idempotencyKey: String) throws -> (request: OpenClawChatGatewayRequest, json: String)
    {
        let request = OpenClawChatGatewayRequests.sendMessage(
            sessionKey: "main",
            agentID: "main",
            expectedSessionRoutingContract: "per-sender|main|main",
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: [])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(request.params)
        return (request, String(decoding: data, as: UTF8.self))
    }

    static func command(
        id: String,
        text: String,
        thinking: String,
        createdAt: Double) -> OpenClawChatOutboxCommand
    {
        OpenClawChatOutboxCommand(
            id: id,
            sessionKey: "main",
            routingContract: "per-sender|main|main",
            text: text,
            thinking: thinking,
            expectedSessionSettings: OpenClawChatSessionSettingsExpectation(
                permissionMode: nil,
                toolOverrides: nil),
            createdAt: createdAt,
            status: .queued,
            retryCount: 0,
            lastError: nil)
    }

    static func describe(_ commands: [OpenClawChatOutboxCommand]) -> String {
        commands
            .map { "\($0.id)|thinking=\(Self.quoted($0.thinking))|status=\($0.status.rawValue)" }
            .joined(separator: ",")
    }

    /// Mirrors `makeOutboxViewModel` but can restore an explicit user choice the
    /// way the app does when a previously selected level is handed back in.
    static func viewModel(
        transport: OutboxTestTransport,
        outbox: any OpenClawChatCommandOutbox,
        initialThinkingLevel: String? = nil) async -> OpenClawChatViewModel
    {
        await MainActor.run {
            let vm = OpenClawChatViewModel(
                sessionKey: "main",
                transport: transport,
                activeAgentId: "main",
                sessionRoutingContract: "per-sender|main|main",
                outbox: outbox,
                modelPickerStore: ChatModelPickerStore(
                    defaults: UserDefaults(suiteName: "Proof194180.\(UUID().uuidString)") ?? .standard),
                initialThinkingLevel: initialThinkingLevel)
            vm.outboxRetryDelaysMs = [1, 1]
            return vm
        }
    }

    @MainActor
    static func prepare(_ vm: OpenClawChatViewModel, sessions: [OpenClawChatSessionEntry]) async {
        vm.load()
        vm.sessions = sessions
        vm.syncThinkingLevelOptions()
    }
}

/// Wire-level view of the reporter's cold-launch send: what `chat.send` carries
/// when nobody chose a Thinking level.
struct Proof194180ColdSendWireTests {
    @Test func `proof cold launch send wire payload`() async throws {
        let (store, databases, directory) = try Proof194180.makeStore()
        defer {
            try? databases.close()
            try? FileManager.default.removeItem(at: directory)
        }
        // Cold launch: no live history, sessions or models have arrived yet.
        let transport = OutboxTestTransport(healthy: true, sessions: [])
        let vm = await Proof194180.viewModel(transport: transport, outbox: store)
        await MainActor.run { vm.load() }

        let state = await MainActor.run {
            (
                preferred: vm.preferredThinkingLevel,
                explicit: vm.prefersExplicitThinkingLevel,
                resolved: vm.effectiveThinkingLevelForSend(vm.preferredThinkingLevel)
            )
        }
        let (request, json) = try Proof194180.wirePayload(
            thinking: state.resolved,
            message: "hello before metadata",
            idempotencyKey: "proof-194180-cold")

        Proof194180.emit("COLD_PREFERRED_THINKING", Proof194180.quoted(state.preferred))
        Proof194180.emit("COLD_PREFERS_EXPLICIT", String(state.explicit))
        Proof194180.emit("COLD_RESOLVED_THINKING", Proof194180.quoted(state.resolved))
        Proof194180.emit("COLD_WIRE_CHAT_SEND", json)
        #expect(request.params["thinking"] == nil)
    }

    @Test func `proof unchosen send with advertised profile wire payload`() async throws {
        let (store, databases, directory) = try Proof194180.makeStore()
        defer {
            try? databases.close()
            try? FileManager.default.removeItem(at: directory)
        }
        // The reporter's shape: the session model advertises levels without `off`
        // and the user never picked one.
        let sessions = [
            outboxSessionEntry(key: "main", thinkingLevels: Proof194180.advertisedLevels)
        ]
        let transport = OutboxTestTransport(healthy: true, sessions: sessions)
        let vm = await Proof194180.viewModel(transport: transport, outbox: store)
        await Proof194180.prepare(vm, sessions: sessions)

        let state = await MainActor.run {
            (
                preferred: vm.preferredThinkingLevel,
                explicit: vm.prefersExplicitThinkingLevel,
                resolved: vm.effectiveThinkingLevelForSend(vm.preferredThinkingLevel)
            )
        }
        let (request, json) = try Proof194180.wirePayload(
            thinking: state.resolved,
            message: "hello with metadata but no choice",
            idempotencyKey: "proof-194180-profile")

        Proof194180.emit("PROFILE_ADVERTISED_LEVELS", Proof194180.advertisedLevels.joined(separator: ","))
        Proof194180.emit("PROFILE_PREFERRED_THINKING", Proof194180.quoted(state.preferred))
        Proof194180.emit("PROFILE_PREFERS_EXPLICIT", String(state.explicit))
        Proof194180.emit("PROFILE_RESOLVED_THINKING", Proof194180.quoted(state.resolved))
        Proof194180.emit("PROFILE_WIRE_CHAT_SEND", json)
        #expect(request.params["thinking"] == nil)
    }

    @Test func `proof explicit thinking choice wire payload`() async throws {
        let (store, databases, directory) = try Proof194180.makeStore()
        defer {
            try? databases.close()
            try? FileManager.default.removeItem(at: directory)
        }
        // A level the user actually chose must still reach the wire unchanged.
        let sessions = [
            outboxSessionEntry(key: "main", thinkingLevels: Proof194180.advertisedLevels)
        ]
        let transport = OutboxTestTransport(healthy: true, sessions: sessions)
        let vm = await Proof194180.viewModel(
            transport: transport,
            outbox: store,
            initialThinkingLevel: "high")
        await Proof194180.prepare(vm, sessions: sessions)

        let state = await MainActor.run {
            (
                preferred: vm.preferredThinkingLevel,
                explicit: vm.prefersExplicitThinkingLevel,
                resolved: vm.effectiveThinkingLevelForSend(vm.preferredThinkingLevel)
            )
        }
        let (request, json) = try Proof194180.wirePayload(
            thinking: state.resolved,
            message: "hello with a choice",
            idempotencyKey: "proof-194180-explicit")

        Proof194180.emit("EXPLICIT_PREFERRED_THINKING", Proof194180.quoted(state.preferred))
        Proof194180.emit("EXPLICIT_PREFERS_EXPLICIT", String(state.explicit))
        Proof194180.emit("EXPLICIT_RESOLVED_THINKING", Proof194180.quoted(state.resolved))
        Proof194180.emit("EXPLICIT_WIRE_CHAT_SEND", json)
        #expect(request.params["thinking"]?.value as? String == "high")
    }
}

/// Phase 1 of the durable upgrade proof: write the on-disk outbox exactly the way
/// the previous stable build does. Executed against the behaviour-reverted base
/// sources, so the captured rows are produced by unfixed code.
struct Proof194180LegacySeedTests {
    @Test func `proof previous stable build queues an unchosen off override`() async throws {
        let (databases, store) = try Proof194180.openDurable()
        defer { try? databases.close() }

        // An explicit choice the user made earlier is already durable.
        #expect(await store.enqueueCommand(
            Proof194180.command(
                id: "legacy-explicit-high",
                text: "queued earlier with an explicit choice",
                thinking: "high",
                createdAt: 1_700_000_000)))

        // Cold launch, offline, nothing chosen: this is the row the reporter's
        // build captures and then replays forever.
        let sessions = [
            outboxSessionEntry(key: "main", thinkingLevels: Proof194180.advertisedLevels)
        ]
        let transport = OutboxTestTransport(healthy: false, sessions: sessions)
        let vm = await Proof194180.viewModel(transport: transport, outbox: store)
        await Proof194180.prepare(vm, sessions: sessions)
        await MainActor.run {
            vm.input = "queued while cold"
            vm.send()
        }
        try await waitForOutboxState { !vm.isSubmittingDraft }

        let rows = await store.loadCommands()
        Proof194180.emit("LEGACY_SEED_ROWS", Proof194180.describe(rows))
        Proof194180.emit("LEGACY_SEED_DIRECTORY", Proof194180.durableDirectory.path)
        #expect(rows.count == 2)
        #expect(rows.first?.id == "legacy-explicit-high")
        _ = vm
    }
}

/// Phase 2: the same on-disk rows, read and replayed by the patched build. This
/// is the data-model compatibility evidence — no schema change, no rewrite of
/// stored values, and the captured concrete level of an older row is replayed
/// byte-for-byte.
struct Proof194180UpgradeReplayTests {
    @Test func `proof legacy durable rows load and replay after the upgrade`() async throws {
        let (databases, store) = try Proof194180.openDurable()
        defer { try? databases.close() }

        let legacy = await store.loadCommands()
        Proof194180.emit("UPGRADE_LOADED_ROWS", Proof194180.describe(legacy))
        #expect(legacy.map(\.text) == [
            "queued earlier with an explicit choice",
            "queued while cold",
        ])

        let sessions = [
            outboxSessionEntry(key: "main", thinkingLevels: Proof194180.advertisedLevels)
        ]
        let transport = OutboxTestTransport(healthy: false, sessions: sessions)
        let vm = await Proof194180.viewModel(transport: transport, outbox: store)
        await Proof194180.prepare(vm, sessions: sessions)
        let gate = OutboxTestGate()
        await transport.state.update { $0.sendGate = gate }
        await transport.goOnline()
        try await finishOutboxFlush(vm, at: gate)

        #expect(await store.loadCommands().isEmpty)
        let sent = await transport.state.sentThinkingLevels
        let sentSessionKeys = await transport.state.sentSessionKeys
        Proof194180.emit("UPGRADE_REPLAY_SENT_THINKING", sent.map { Proof194180.quoted($0) }.joined(separator: ","))
        Proof194180.emit("UPGRADE_REPLAY_SENT_SESSION_KEYS", sentSessionKeys.joined(separator: ","))
        for (index, level) in sent.enumerated() {
            let (_, json) = try Proof194180.wirePayload(
                thinking: level,
                message: "replayed after upgrade",
                idempotencyKey: "proof-194180-upgrade-\(index)")
            Proof194180.emit("UPGRADE_REPLAY_WIRE_\(index)", json)
        }
        // Legacy rows keep their captured concrete level: the explicit choice is
        // delivered as chosen, and the older bogus `off` capture is delivered
        // exactly as it was stored (it is still rejected once, which is the
        // documented out-of-scope residue of the reported bug).
        #expect(sent == ["high", "off"])
        _ = vm
    }
}

/// Phase 3: an inherited (unchosen) row written by the patched build survives a
/// full app restart — a fresh database stack over the same on-disk rows — and
/// replays without a `thinking` override on the wire.
struct Proof194180InheritedRestartTests {
    @Test func `proof an inherited queue row survives a restart and replays without an override`()
        async throws
    {
        let (databases, store) = try Proof194180.openDurable()
        let sessions = [
            outboxSessionEntry(key: "main", thinkingLevels: Proof194180.advertisedLevels)
        ]
        let transport = OutboxTestTransport(healthy: false, sessions: sessions)
        let vm = await Proof194180.viewModel(transport: transport, outbox: store)
        await Proof194180.prepare(vm, sessions: sessions)
        await MainActor.run {
            vm.input = "queued cold, then the app was killed"
            vm.send()
        }
        try await waitForOutboxState { !vm.isSubmittingDraft }
        let queued = await store.loadCommands()
        Proof194180.emit("INHERITED_QUEUED_ROWS", Proof194180.describe(queued))
        #expect(queued.count == 1)
        #expect(queued.map(\.thinking) == [""])
        try databases.close()
        _ = vm

        // Simulated restart: new database stack, same on-disk rows.
        let (restarted, restartedStore) = try Proof194180.openDurable()
        defer { try? restarted.close() }
        let reloaded = await restartedStore.loadCommands()
        Proof194180.emit("INHERITED_RESTART_ROWS", Proof194180.describe(reloaded))
        #expect(reloaded.map(\.thinking) == [""])

        let restartTransport = OutboxTestTransport(healthy: false, sessions: sessions)
        let restartViewModel = await Proof194180.viewModel(
            transport: restartTransport,
            outbox: restartedStore)
        await Proof194180.prepare(restartViewModel, sessions: sessions)
        let gate = OutboxTestGate()
        await restartTransport.state.update { $0.sendGate = gate }
        await restartTransport.goOnline()
        try await finishOutboxFlush(restartViewModel, at: gate)

        #expect(await restartedStore.loadCommands().isEmpty)
        let sent = await restartTransport.state.sentThinkingLevels
        Proof194180.emit("INHERITED_REPLAY_SENT_THINKING", sent.map { Proof194180.quoted($0) }.joined(separator: ","))
        for (index, level) in sent.enumerated() {
            let (request, json) = try Proof194180.wirePayload(
                thinking: level,
                message: "replayed after restart",
                idempotencyKey: "proof-194180-restart-\(index)")
            Proof194180.emit("INHERITED_REPLAY_WIRE_\(index)", json)
            #expect(request.params["thinking"] == nil)
        }
        #expect(sent == [""])
        _ = restartViewModel
    }
}
