import { listDshSkills } from '@features/agent/services/dsh-command-service';
import { listCodexSkills } from '@features/agent/services/codex-slash-command-service';
import { listPiSkills } from '@features/agent/services/pi-slash-command-service';

/**
 * 输入框「/」菜单的技能列表：三种外部 Agent 各有一套发现逻辑，但只有当前类型的
 * 那一个会真的去读盘，其余立即返回空数组。这段分派原来写在 thread card 的
 * composerOptions 字面量里，把它挪出来，卡片视图只负责接线。
 */
export function composerSkillLoaders({
  typeKey,
  notebookPath,
  ensureDshCommandConversation,
}: {
  typeKey: string;
  notebookPath: string | null;
  ensureDshCommandConversation: (command: string) => Promise<{
    threadId: string;
    runtimeConfig: Parameters<typeof listDshSkills>[0]['runtimeConfig'];
  }>;
}) {
  const path = notebookPath ?? '';
  return {
    listDshSkills: async () => {
      if (typeKey !== 'dsh') return [];
      const ensured = await ensureDshCommandConversation('/skill');
      return listDshSkills({
        threadId: ensured.threadId,
        runtimeConfig: ensured.runtimeConfig,
      });
    },
    listCodexSkills: async () => (typeKey === 'codex' ? listCodexSkills(path) : []),
    listPiSkills: async () => (typeKey === 'pi' ? listPiSkills(path) : []),
  };
}
