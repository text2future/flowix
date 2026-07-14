export function createThreadCacheSkeleton(label: string): HTMLDivElement {
  const skeleton = document.createElement("div");
  skeleton.className = "agent-thread-card__skeleton";
  skeleton.setAttribute("aria-label", label);
  skeleton.setAttribute("role", "status");

  skeleton.append(createSkeletonItem("user", ["short"]));
  skeleton.append(createSkeletonItem("assistant", ["medium"]));
  const tailUser = createSkeletonItem("user", ["medium"]);
  tailUser.classList.add("agent-thread-card__skeleton-item--left");
  skeleton.append(tailUser);

  return skeleton;
}

function createSkeletonItem(
  kind: "assistant" | "user",
  widths: Array<"short" | "medium" | "long">,
): HTMLDivElement {
  const item = document.createElement("div");
  item.className = `agent-thread-card__skeleton-item agent-thread-card__skeleton-item--${kind}`;

  const lines = document.createElement("div");
  lines.className = "agent-thread-card__skeleton-lines";
  for (const width of widths) {
    const line = document.createElement("span");
    line.className = `agent-thread-card__skeleton-line agent-thread-card__skeleton-line--${width}`;
    lines.append(line);
  }
  item.append(lines);
  return item;
}
