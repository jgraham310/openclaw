import type { Command } from "commander";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { purgeRejectedSkillProposal } from "../skills/workshop/service.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

type ResolvedWorkshop = { agentId: string; config: OpenClawConfig; workspaceDir: string };
type RunWorkshopAction = <T>(
  opts: { agent?: string; json?: boolean },
  command: Command,
  action: (resolved: ResolvedWorkshop) => Promise<T>,
  format: (result: T) => string,
) => Promise<void>;

export function registerWorkshopPurgeCommand(
  workshop: Command,
  runWorkshopAction: RunWorkshopAction,
) {
  workshop
    .command("purge")
    .description("Permanently remove a rejected proposal and its retained history")
    .argument("<proposal-id>", "Rejected proposal id")
    .option("--json", "Output as JSON", false)
    .action((proposalId: string, opts: { json?: boolean; agent?: string }, command: Command) =>
      runWorkshopAction(
        opts,
        command,
        ({ agentId, config, workspaceDir }) =>
          purgeRejectedSkillProposal({
            agentId,
            eventActor: { type: "system", id: "cli" },
            workspaceDir,
            config,
            proposalId,
          }),
        (result) => `Purged ${result.proposalId}\n`,
      ),
    );
  for (const command of workshop.commands) {
    command.option(
      "--agent <id>",
      "Target agent workspace (defaults to cwd-inferred, then default agent)",
    );
  }
  applyParentDefaultHelpAction(workshop);
}
