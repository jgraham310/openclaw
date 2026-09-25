import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import {
  normalizeIdentity,
  normalizeWorkerPlacementExecutionMode,
  type WorkerSessionPlacementDispatchIdentity,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaimFacts,
} from "./placement-record.js";
import { preparePlacementTurnClaimPublication } from "./placement-turn-authority.js";

function readDispatchTurnClaim(value: unknown): WorkerSessionTurnClaimFacts["turnClaim"] {
  if (value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    value.owner !== "local" ||
    typeof value.claimId !== "string" ||
    !value.claimId ||
    typeof value.runId !== "string" ||
    !value.runId ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    value.ownerEpoch !== null
  ) {
    throw new Error("Worker placement dispatch commit has an invalid predecessor claim");
  }
  return {
    owner: "local",
    claimId: value.claimId,
    runId: value.runId,
    generation: value.generation,
    ownerEpoch: null,
  };
}

export async function startWorkerPlacementDispatch(
  path: string,
  placement: WorkerSessionPlacementDispatchIdentity,
  nowMs: number,
  assertCurrent?: () => void,
): Promise<WorkerSessionPlacementRecord> {
  const context = captureOpenClawStateWorkerContext({ path });
  const captured = structuredClone(placement);
  const identity = normalizeIdentity(captured);
  const executionMode = normalizeWorkerPlacementExecutionMode(captured.executionMode);
  const check = () => {
    context.admission.assertCurrent();
    assertCurrent?.();
  };
  let admission: SqliteWorkerOperationAdmission | undefined;
  let commitFacts: WorkerSessionTurnClaimFacts | undefined;
  let publish: ReturnType<typeof preparePlacementTurnClaimPublication> | undefined;
  try {
    return await runOpenClawStateWorkerOperation(
      context,
      async (scope) => {
        const result = await scope.execute({
          type: "workerPlacements.startDispatch",
          input: { placement: captured, nowMs },
        });
        publish?.(result);
        return result;
      },
      {
        assertCurrent: check,
        requireStateLifecycle: true,
        createAdmission: () => {
          let stage: "transaction" | "commit" = "transaction";
          admission = createSqliteWorkerOperationAdmission((request, grant) => {
            if (request.stage !== stage) {
              throw new Error("Worker placement dispatch admission is out of order");
            }
            check();
            const facts =
              request.stage === "commit"
                ? {
                    ...identity,
                    state: "requested" as const,
                    executionMode,
                    environmentId: null,
                    activeOwnerEpoch: null,
                    turnClaim: readDispatchTurnClaim(request.facts),
                  }
                : undefined;
            if (!grant()) {
              throw new Error("Worker placement dispatch admission expired");
            }
            if (facts) {
              publish = preparePlacementTurnClaimPublication(
                context.admission.identity,
                identity.sessionId,
              );
            }
            commitFacts = facts;
            stage = "commit";
          });
          return { nativeLocations: [context.admission.databasePath], admission };
        },
      },
    );
  } catch (error) {
    if (admission?.committed ?? admission?.settlement?.committed) {
      publish?.(commitFacts);
    } else if (commitFacts && admission?.settlement?.kind !== "completed") {
      // An uncertain commit cannot leave predecessor authority live or be replayed.
      publish?.(undefined);
    }
    throw error;
  }
}
