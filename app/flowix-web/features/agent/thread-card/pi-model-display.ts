/**
 * Pi 运行身份 (`<provider>/<model>`) → 界面展示名称。
 *
 * Pi 上报的 model_id 是 provider 限定身份, Cloud 模型还会再带一段上游路由
 * (例如 `flowix-cloud-member/flowix-cn-2/deepseek-v4.1-flash-1017`)。
 * 这些内部身份都不该出现在 hover 卡片上: 官方模型的展示名以 Cloud 目录里的
 * title 为准, 目录缺失时也至少要剥掉服务商与上游路由。
 *
 * 目录匹配不看身份的分段数, 而是用「完整身份 / 去掉 provider / 末段」三种候选
 * 去比对目录项, 这样签名用户的原生目录和游客的公共目录都能命中。
 */
import { isFlowixCloudModel } from "@features/agent/config/agent-model-source";
import type { AgentCatalogModel } from "@features/agent/store/agent-data-types";

function splitProvider(model: string): { providerId?: string; route: string } {
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) return { route: model };
  return { providerId: model.slice(0, separator), route: model.slice(separator + 1) };
}

function lastSegment(value: string): string {
  const separator = value.lastIndexOf("/");
  return separator < 0 ? value : value.slice(separator + 1);
}

function matchesIdentity(entry: AgentCatalogModel, identities: ReadonlySet<string>): boolean {
  if (!entry.id) return false;
  if (identities.has(entry.id)) return true;
  return Boolean(entry.providerId && identities.has(`${entry.providerId}/${entry.id}`));
}

/**
 * Display name for a Pi run's model identity.
 *
 * Preference order: the catalog entry that owns the run identity, then any
 * Cloud entry, then the first catalog match. Without a catalog entry the model
 * id itself is the fallback — provider-free for official models.
 */
export function resolvePiModelDisplayName(
  model: string | undefined,
  catalog: readonly AgentCatalogModel[],
): string {
  const raw = model?.trim();
  if (!raw) return "";
  const { providerId, route } = splitProvider(raw);
  const identities = new Set([raw, route, lastSegment(raw)]);
  const matches = catalog.filter((entry) => matchesIdentity(entry, identities));
  const entry = (providerId
    ? matches.find((candidate) => candidate.providerId === providerId)
    : undefined)
    ?? matches.find((candidate) => isFlowixCloudModel(candidate))
    ?? matches[0];
  const label = entry?.label?.trim();
  if (label) return label;
  const official = providerId ? isFlowixCloudModel({ providerId }) : false;
  // Official ids may still carry an upstream route; only its last segment is stable.
  return official ? lastSegment(route) || route : raw;
}
