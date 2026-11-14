import { defaultRuntime } from "../runtime.js";
import { withOpenClawStateLeaseAsync } from "../state/openclaw-state-lease.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { PersistedTemplateCronRef } from "./cron.js";
import type { AdmittedTemplateAgent } from "./gateway-add-continuation.js";
import type { TemplateAddPlan } from "./types.js";

type BlockedAdmissionRollback = (
  agentId: string,
  expectedAgentConfig: TemplateAddPlan["agent"]["config"],
  expectedCronJobs: PersistedTemplateCronRef[],
) => Promise<void>;

/**
 * Undo the ordinary admission a single Template Add request created after its reviewed plan
 * turned out to be blocked. A blocked plan can never be applied, so keeping the agent would
 * leave an unusable roster entry whose Retry resubmits the same blocked review. Agents that an
 * earlier request already retained keep their documented recovery contract and are never
 * touched here; when the rollback cannot prove the agent is untouched the caller keeps its
 * retained-agent result instead of reporting a clean refusal.
 */
export async function releaseBlockedTemplateAdmission(
  admitted: AdmittedTemplateAgent,
  input: {
    assertCurrent: () => void;
    rollbackNewAgent?: BlockedAdmissionRollback;
    signal?: AbortSignal;
  },
  stateContext: OpenClawStateWorkerContext,
): Promise<boolean> {
  const rollbackNewAgent = input.rollbackNewAgent;
  if (!rollbackNewAgent) {
    return false;
  }
  try {
    await withOpenClawStateLeaseAsync(
      {
        scope: "core:agent-deletion",
        key: admitted.agentId,
        leaseMs: 60_000,
        waitMs: 5_000,
        heartbeat: "worker",
        ...(input.signal ? { signal: input.signal } : {}),
        leaseLabel: "Template blocked plan rollback",
        operationLabel: "template.add.blockedRollback",
      },
      stateContext,
      async (lease) => {
        const assertCurrent = () => {
          input.assertCurrent();
          lease.assertCurrent();
        };
        assertCurrent();
        // The Template never applied, so this request installed no automations.
        // Rollback validates the projected roster entry, which carries the id and workspace.
        await rollbackNewAgent(
          admitted.agentId,
          { id: admitted.agentId, workspace: admitted.workspace, ...admitted.config },
          [],
        );
        assertCurrent();
        await admitted.chat();
      },
    );
  } catch (error) {
    defaultRuntime.log(
      `Template blocked-plan rollback failed; the admitted agent was kept: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
  return true;
}
