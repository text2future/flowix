import type { AgentTypeKey } from "@/types/agent";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArrowUpRightIcon } from "@phosphor-icons/react";
import { getToolIconPath } from "@features/agent/message/tools";

export const ICON_STOP_PATH =
  "M216,68V188a28,28,0,0,1-28,28H68a28,28,0,0,1-28-28V68a28,28,0,0,1,28-28H188a28,28,0,0,1,28,28Z";

const ICON_CHEVRON_UP_PATH = "M6 15l6-6 6 6";
const ICON_CHEVRON_DOWN_PATH = "M6 9l6 6 6-6";
const ICON_CHEVRON_RIGHT_PATH = "M9 6l6 6-6 6";
const ICON_CHEVRON_LEFT_PATH = "M15 6l-6 6 6 6";
const ICON_CHECK_PATH = "M20 6 9 17 4 12";
const ICON_ARROW_DOWN_PATH = "M12 5v14m-7-7 7 7 7-7";
// Phosphor ArrowBendDownRight, regular weight.
const ICON_ARROW_BEND_DOWN_RIGHT_PATH =
  "M229.66,157.66l-48,48a8,8,0,0,1-11.32-11.32L204.69,160H128A104.11,104.11,0,0,1,24,56a8,8,0,0,1,16,0,88.1,88.1,0,0,0,88,88h76.69l-34.35-34.34a8,8,0,0,1,11.32-11.32l48,48A8,8,0,0,1,229.66,157.66Z";
const ICON_TRASH_PATH =
  "M216,48H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM192,208H64V64H192ZM80,24a8,8,0,0,1,8-8h80a8,8,0,0,1,0,16H88A8,8,0,0,1,80,24Z";
const ICON_FULLSCREEN_PATH =
  "M40,96a8,8,0,0,1-8-8V48A16,16,0,0,1,48,32H88a8,8,0,0,1,0,16H48V88A8,8,0,0,1,40,96ZM208,32H168a8,8,0,0,0,0,16h40V88a8,8,0,0,0,16,0V48A16,16,0,0,0,208,32ZM88,208H48V168a8,8,0,0,0-16,0v40a16,16,0,0,0,16,16H88a8,8,0,0,0,0-16Zm128-48a8,8,0,0,0-8,8v40H168a8,8,0,0,0,0,16h40a16,16,0,0,0,16-16V168A8,8,0,0,0,216,160Z";
export const ICON_FULLSCREEN_EXIT_PATH =
  "M96,40V80A16,16,0,0,1,80,96H40a8,8,0,0,1,0-16H80V40a8,8,0,0,1,16,0Zm120,40H176V40a8,8,0,0,0-16,0V80a16,16,0,0,0,16,16h40a8,8,0,0,0,0-16ZM80,176v40a8,8,0,0,0,16,0V176a16,16,0,0,0-16-16H40a8,8,0,0,0,0,16Zm136-16H176a16,16,0,0,0-16,16v40a8,8,0,0,0,16,0V176h40a8,8,0,0,0,0-16Z";
const ICON_PLUS_PATH = "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z";
const ICON_LOADER_PATH = "M21 12a9 9 0 1 1-6.219-8.56";

function createSvg(viewBox: string, ...classNames: string[]): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add(...classNames);
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
  direction: "up" | "down" | "right" | "left",
): SVGSVGElement {
  const pathData =
    direction === "up"
      ? ICON_CHEVRON_UP_PATH
      : direction === "left"
        ? ICON_CHEVRON_LEFT_PATH
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

export function createArrowDownIcon(): SVGSVGElement {
  return appendStrokePath(
    createSvg("0 0 24 24", "agent-composer__scroll-to-latest-icon"),
    ICON_ARROW_DOWN_PATH,
  );
}

export function createArrowBendDownRightIcon(): SVGSVGElement {
  return appendFillPath(
    createSvg("0 0 256 256", "agent-background-terminals__queue-mark-icon"),
    ICON_ARROW_BEND_DOWN_RIGHT_PATH,
  );
}

export function createTrashIcon(): SVGSVGElement {
  return appendFillPath(
    createSvg("0 0 256 256", "agent-icon__trash"),
    ICON_TRASH_PATH,
  );
}

export function createOpenInColumnIcon(): SVGSVGElement {
  const template = document.createElement("template");
  template.innerHTML = renderToStaticMarkup(
    createElement(ArrowUpRightIcon, {
      size: 14,
      weight: "regular",
      "aria-hidden": true,
    }),
  );
  const icon = template.content.firstElementChild;
  if (!(icon instanceof SVGSVGElement)) {
    throw new Error("Failed to render ArrowUpRightIcon");
  }
  icon.classList.add("agent-thread-card__open-icon");
  return icon;
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

export function createPlusIcon(): SVGSVGElement {
  return appendFillPath(
    createSvg("0 0 24 24", "agent-composer__access-add-icon"),
    ICON_PLUS_PATH,
  );
}

export function createComposerAddIcon(): SVGSVGElement {
  return appendFillPath(
    createSvg("0 0 24 24", "agent-composer__add-button-empty"),
    ICON_PLUS_PATH,
  );
}

export function createToolRunningLoadingIcon(): SVGSVGElement {
  return appendStrokePath(
    createSvg(
      "0 0 24 24",
      "agent-thread-card__tool-group-running-loading-icon",
      "flowix-spin",
    ),
    ICON_LOADER_PATH,
  );
}
