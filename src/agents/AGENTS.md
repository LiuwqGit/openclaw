<!-- Agent test performance notes for keeping expensive runtime imports out of focused tests. -->

# Agents Test Performance

Agent tests are often import-bound. Treat slow test files as architecture
signals, not just runner noise.

## Guardrails

- Benchmark before and after performance edits. Prefer existing grouped
  artifacts when comparing suites, or use `/usr/bin/time -l pnpm test <file>`
  for a scoped hotspot.
- If a test only needs schema, capability, routing, or static discovery data,
  do not cold-load full bundled plugin/channel/provider runtime. Add or reuse a
  lightweight typed artifact and keep full runtime as a fallback.
- Keep expensive bootstrap, embedded runner, provider, plugin, and channel
  runtime work behind dependency injection or narrow helpers so tests can cover
  behavior without starting the whole runtime.
- Treat channel/plugin lookups inside agent hot paths as suspect. If the code
  only needs target parsing, peer-kind inference, setup hints, or static
  descriptors, use a local pure helper or lightweight public artifact before
  reaching for `getChannelPlugin()` / bundled runtime fallback.
- In spawn/session/requester-origin logic, keep routing and delivery-context
  normalization deterministic and runtime-free. Add explicit parser coverage for
  channel-specific prefixes instead of loading a channel plugin just to classify
  a target.
- If moving coverage out of a slow integration test, preserve the exact
  production composition in a named helper and test that helper. Do not remove
  the behavior proof just because the old proof was slow.
- Avoid broad `importOriginal()` partial mocks and module resets in hot agent
  tests. Use explicit mock factories, one-time imports, and reset only the
  state the test mutates.

## Verification

- For agent performance changes, record seconds and RSS before and after in the
  handoff or benchmark report.
- If the change touches lazy-loading, plugin runtime imports, or bundled
  artifacts, run `pnpm build`.

## Sub-agent Launch Authorization (user-explicit vs. resolved default)

When forwarding a sub-agent model/provider to the gateway `agent` call (or to
any privileged dispatch surface that escalates scope or internal
authorization), gate the escalation on the **user-explicit** trigger, not on
whatever the planner happens to resolve.

Concrete anchors in this area:

- `src/agents/subagent-spawn.ts:1565` — child gateway `agent` launch call.
- `src/agents/subagent-spawn-plan.ts:resolveSubagentModelAndThinkingPlan` —
  always returns a value (default model, inherited override, or explicit user
  input); `resolvedModel` truthiness is not proof of an explicit request.
- `src/gateway/server-methods/agent.ts:1131` — gateway rejects `provider` /
  `model` request overrides unless the caller has admin scope or internal
  `allowModelOverride`.
- `src/gateway/server-plugins.ts:144` — plugin sub-agent path: `allowModelOverride`
  is the same authorization seam from the plugin side.

The trigger that justifies admin scope or a synthetic admin client is the
caller's explicit param (e.g. `params.model?.trim()`, a non-empty
`modelOverride?.trim()` from the tool call, a non-empty CLI flag). Default
model, configured model, or inherited override are **not** explicit. Forward
the planner's `resolvedModel` only when the explicit param was truthy; do not
forward when the planner resolved a default. New launch/override paths in
this directory must follow the same gate — if a path escalates scope or
authorization based on a planner value, name the explicit trigger in the spec's
"证明可行性评估" before opening the PR. The ClawSweeper review will treat
"default spawns receive override authorization" and "in-process dispatch
forces a synthetic admin client" as P1 merge blockers when this gate is on
the planner output.
