import type { AgentTypeKey } from "@/types/agent";
import { getToolIconPath } from "@features/agent/message/tools";

export const ICON_STOP_PATH =
  "M216,56V200a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V56A16,16,0,0,1,56,40H200A16,16,0,0,1,216,56Z";

const ICON_CHEVRON_UP_PATH = "M6 15l6-6 6 6";
const ICON_CHEVRON_DOWN_PATH = "M6 9l6 6 6-6";
const ICON_CHEVRON_RIGHT_PATH = "M9 6l6 6-6 6";
const ICON_CHECK_PATH = "M20 6 9 17 4 12";
const ICON_TRASH_PATH =
  "M216,48H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM192,208H64V64H192ZM80,24a8,8,0,0,1,8-8h80a8,8,0,0,1,0,16H88A8,8,0,0,1,80,24Z";
const ICON_FULLSCREEN_PATH =
  "M40,96a8,8,0,0,1-8-8V48A16,16,0,0,1,48,32H88a8,8,0,0,1,0,16H48V88A8,8,0,0,1,40,96ZM208,32H168a8,8,0,0,0,0,16h40V88a8,8,0,0,0,16,0V48A16,16,0,0,0,208,32ZM88,208H48V168a8,8,0,0,0-16,0v40a16,16,0,0,0,16,16H88a8,8,0,0,0,0-16Zm128-48a8,8,0,0,0-8,8v40H168a8,8,0,0,0,0,16h40a16,16,0,0,0,16-16V168A8,8,0,0,0,216,160Z";
const ICON_FULLSCREEN_EXIT_PATH =
  "M96,40V80A16,16,0,0,1,80,96H40a8,8,0,0,1,0-16H80V40a8,8,0,0,1,16,0Zm120,40H176V40a8,8,0,0,0-16,0V80a16,16,0,0,0,16,16h40a8,8,0,0,0,0-16ZM80,176v40a8,8,0,0,0,16,0V176a16,16,0,0,0-16-16H40a8,8,0,0,0,0,16Zm136-16H176a16,16,0,0,0-16,16v40a8,8,0,0,0,16,0V176h40a8,8,0,0,0,0-16Z";
const ICON_FOLDER_PATH =
  "M216,72H131.31L104,44.69A15.86,15.86,0,0,0,92.69,40H40A16,16,0,0,0,24,56V200.89A15.13,15.13,0,0,0,39.11,216H216.89A15.13,15.13,0,0,0,232,200.89V88A16,16,0,0,0,216,72ZM40,56H92.69l16,16H40ZM216,200H40V88H216Z";
const ICON_LAPTOP_PATH =
  "M232,168h-8V72a24,24,0,0,0-24-24H56A24,24,0,0,0,32,72v96H24a8,8,0,0,0-8,8v16a24,24,0,0,0,24,24H216a24,24,0,0,0,24-24V176A8,8,0,0,0,232,168ZM48,72a8,8,0,0,1,8-8H200a8,8,0,0,1,8,8v96H48ZM224,192a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8v-8H224ZM152,88a8,8,0,0,1-8,8H112a8,8,0,0,1,0-16h32A8,8,0,0,1,152,88Z";
const ICON_PLUS_PATH = "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z";
const ICON_ALERT_PATH =
  "M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z";
const ICON_LOADER_PATH = "M21 12a9 9 0 1 1-6.219-8.56";

function createSvg(viewBox: string, className: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add(className);
  return svg;
}

function appendFillPath(svg: SVGSVGElement, pathData: string): SVGSVGElement {
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathData);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

function appendStrokePath(svg: SVGSVGElement, pathData: string): SVGSVGElement {
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathData);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

export function createChevronIcon(
  direction: "up" | "down" | "right",
): SVGSVGElement {
  const pathData =
    direction === "up"
      ? ICON_CHEVRON_UP_PATH
      : direction === "right"
        ? ICON_CHEVRON_RIGHT_PATH
        : ICON_CHEVRON_DOWN_PATH;
  return appendStrokePath(
    createSvg("0 0 24 24", "agent-thread-card__chevron-icon"),
    pathData,
  );
}

export function createCheckIcon(): SVGSVGElement {
  return appendStrokePath(
    createSvg("0 0 24 24", "agent-thread-card__copy-icon"),
    ICON_CHECK_PATH,
  );
}

export function createTrashIcon(): SVGSVGElement {
  return appendFillPath(
    createSvg("0 0 256 256", "agent-thread-card__trash-icon"),
    ICON_TRASH_PATH,
  );
}

export function createFullscreenIcon(kind: "enter" | "exit"): SVGSVGElement {
  return appendFillPath(
    createSvg("0 0 256 256", "agent-thread-card__fullscreen-icon"),
    kind === "exit" ? ICON_FULLSCREEN_EXIT_PATH : ICON_FULLSCREEN_PATH,
  );
}

export function createToolIcon(
  toolName?: string,
  agentType?: AgentTypeKey,
): SVGSVGElement {
  return appendFillPath(
    createSvg("0 0 256 256", "agent-thread-card__message-tool-icon"),
    getToolIconPath({ agentType, toolName }),
  );
}

export function createFolderIcon(): SVGSVGElement {
  return appendFillPath(
    createSvg("0 0 256 256", "agent-thread-card__access-row-icon"),
    ICON_FOLDER_PATH,
  );
}

export function createLaptopIcon(): SVGSVGElement {
  return appendFillPath(
    createSvg("0 0 256 256", "agent-thread-card__access-workspace-icon"),
    ICON_LAPTOP_PATH,
  );
}

export function createPlusIcon(): SVGSVGElement {
  return appendFillPath(
    createSvg("0 0 24 24", "agent-thread-card__access-add-icon"),
    ICON_PLUS_PATH,
  );
}

export function createComposerRoleEmptyIcon(): SVGSVGElement {
  const svg = createSvg(
    "0 0 24 24",
    "agent-thread-card__composer-role-icon-empty",
  );
  return appendFillPath(svg, ICON_PLUS_PATH);
}

export function createAlertIcon(): SVGSVGElement {
  return appendStrokePath(
    createSvg("0 0 24 24", "agent-thread-card__access-alert-icon"),
    ICON_ALERT_PATH,
  );
}

export function createRoleOptionsLoadingIcon(): SVGSVGElement {
  return appendStrokePath(
    createSvg("0 0 24 24", "agent-thread-card__composer-role-popover-spinner"),
    ICON_LOADER_PATH,
  );
}
