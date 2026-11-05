import { createLogger } from "@/lib/logger";
import { agent } from "@platform/tauri/client/agent";

const logger = createLogger("notebook-skill-display-names");

/** Enrich discovered skills by source path; never add or enable runtime skills. */
export async function withNotebookSkillDisplayNames<T extends { path?: string; displayName?: string }>(
  cwd: string,
  skills: readonly T[],
): Promise<readonly T[]> {
  if (!cwd.trim() || !skills.length) return skills;
  try {
    const localSkills = await agent.readNotebookAgentSkills(cwd);
    const normalizePath = (path: string): string => path.replace(/\\/g, "/").replace(/\/$/, "");
    const root = normalizePath(cwd);
    const localByPath = new Map(localSkills.map((skill) => [
      `${root}/${normalizePath(skill.path)}`,
      skill.frontmatter["display-name"]?.trim(),
    ]));
    return skills.map((skill) => {
      if (!skill.path) return skill;
      const path = normalizePath(skill.path);
      const displayName = localByPath.get(path.startsWith(".agents/") ? `${root}/${path}` : path);
      return displayName ? { ...skill, displayName } : skill;
    });
  } catch (error) {
    logger.warn("Failed to read notebook Skill display names", { error });
    return skills;
  }
}
