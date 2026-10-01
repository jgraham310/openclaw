import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import {
  applySkillProposal,
  inspectSkillProposal,
  listSkillProposals,
  proposeCreateSkill,
  purgeRejectedSkillProposal,
  rejectSkillProposal,
} from "./service.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

const tempDirs = createTrackedTempDirs();
const stateDirs = createTrackedTempDirs();
let stateDir = "";
let testEnv: NodeJS.ProcessEnv;
const config = {};
const agentId = "main";
const owned = <T extends { workspaceDir: string; agentId?: string }>(input: T) => ({
  ...input,
  config,
  agentId: input.agentId ?? agentId,
  env: testEnv,
});
const makeWorkspace = () => tempDirs.make("openclaw-skill-workshop-purge-");
const workshopSkillsDir = () => resolveWorkshopSkillsDir(config, agentId, testEnv);

beforeAll(async () => {
  stateDir = await stateDirs.make("openclaw-skill-workshop-purge-state-");
  testEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_AGENT_DIR: undefined,
  };
  await listSkillProposals({ config, agentId, env: testEnv });
});
beforeEach(async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
  const database = openOpenClawStateDatabase({ env: testEnv });
  database.db.exec(
    "DELETE FROM skill_workshop_proposal_events; DELETE FROM skill_workshop_proposal_rollbacks; DELETE FROM skill_workshop_proposals;",
  );
  await fs.rm(path.join(stateDir, "skill-workshop"), { recursive: true, force: true });
  await fs.rm(workshopSkillsDir(), { recursive: true, force: true });
});
afterEach(async () => {
  await tempDirs.cleanup();
});
afterAll(async () => {
  await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(testEnv));
  vi.unstubAllEnvs();
  await stateDirs.cleanup();
});

describe("Skill Workshop rejected proposal purge", () => {
  it("purges only rejected proposals and their retained artifacts", async () => {
    const workspaceDir = await makeWorkspace();
    const pending = await proposeCreateSkill(
      owned({
        workspaceDir,
        name: "Keep Pending",
        description: "Remain pending",
        content: "# Pending\n",
      }),
    );
    const rejected = await proposeCreateSkill(
      owned({
        workspaceDir,
        name: "Discard Rejected",
        description: "Discard after rejection",
        content: "# Rejected\n",
      }),
    );
    const applied = await proposeCreateSkill(
      owned({
        workspaceDir,
        name: "Keep Applied",
        description: "Remain active",
        content: "# Applied\n",
      }),
    );
    await applySkillProposal(owned({ workspaceDir, proposalId: applied.record.id }));
    await expect(
      purgeRejectedSkillProposal(owned({ workspaceDir, proposalId: pending.record.id })),
    ).rejects.toThrow("Only rejected proposals can be purged");
    await expect(
      purgeRejectedSkillProposal(owned({ workspaceDir, proposalId: applied.record.id })),
    ).rejects.toThrow("Only rejected proposals can be purged");
    await rejectSkillProposal(owned({ workspaceDir, proposalId: rejected.record.id }));
    const reviewed = await inspectSkillProposal(rejected.record.id, {
      config,
      agentId,
      env: testEnv,
    });
    expect(reviewed).not.toBeNull();
    await expect(
      purgeRejectedSkillProposal(
        owned({
          workspaceDir,
          proposalId: rejected.record.id,
          expectedRevisionHash: "wrong-revision",
        }),
      ),
    ).rejects.toThrow();
    await expect(
      purgeRejectedSkillProposal(
        owned({
          workspaceDir,
          agentId: "other-agent",
          proposalId: rejected.record.id,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      purgeRejectedSkillProposal(
        owned({
          workspaceDir,
          proposalId: rejected.record.id,
          expectedRevisionHash: reviewed!.revisionHash,
        }),
      ),
    ).resolves.toEqual({ proposalId: rejected.record.id, purged: true });
    expect(
      await inspectSkillProposal(rejected.record.id, { config, agentId, env: testEnv }),
    ).toBeNull();
    expect(
      await inspectSkillProposal(pending.record.id, { config, agentId, env: testEnv }),
    ).not.toBeNull();
    const database = openOpenClawStateDatabase({ env: testEnv });
    const events = database.db
      .prepare("SELECT COUNT(*) AS count FROM skill_workshop_proposal_events WHERE proposal_id = ?")
      .get(rejected.record.id) as { count: number };
    expect(events.count).toBe(0);
    await expect(
      fs.readFile(path.join(workshopSkillsDir(), "keep-applied", "SKILL.md"), "utf8"),
    ).resolves.toContain("# Applied");
    await expect(
      fs.access(path.join(stateDir, "skill-workshop", "proposals", rejected.record.id)),
    ).rejects.toThrow();

    const interrupted = await proposeCreateSkill(
      owned({
        workspaceDir,
        name: "Interrupted Purge",
        description: "Retry artifact removal",
        content: "# Interrupted\n",
      }),
    );
    await rejectSkillProposal(owned({ workspaceDir, proposalId: interrupted.record.id }));
    await fs.rm(path.join(stateDir, "skill-workshop", "proposals", interrupted.record.id), {
      recursive: true,
    });
    await expect(
      purgeRejectedSkillProposal(owned({ workspaceDir, proposalId: interrupted.record.id })),
    ).resolves.toMatchObject({ purged: true });
    expect(
      await inspectSkillProposal(interrupted.record.id, { config, agentId, env: testEnv }),
    ).toBeNull();
  });
});
