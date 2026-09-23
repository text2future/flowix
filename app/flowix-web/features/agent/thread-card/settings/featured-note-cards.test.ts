// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoItem } from "@/types/memo-item";

// 筛选条件现在存在笔记本文件夹的 `.flowix/system.json` (后端 IPC), 不再用
// localStorage。这里 mock 掉客户端边界, 只验证本模块的归一化与回落行为。
const { getFeaturedNoteFilter, setFeaturedNoteFilter } = vi.hoisted(() => ({
  getFeaturedNoteFilter: vi.fn(),
  setFeaturedNoteFilter: vi.fn(),
}));

vi.mock("@platform/tauri/client", () => ({
  system: { getFeaturedNoteFilter, setFeaturedNoteFilter },
}));

import {
  DEFAULT_FEATURED_NOTE_ICON,
  FEATURED_NOTE_MOBILE_PAGE_SIZE,
  appendFeaturedNoteIconContent,
  getFeaturedNoteCards,
  getFeaturedNotePage,
  getFeaturedNotePageCount,
  getFeaturedNotePageCountForSize,
  loadAllFeaturedNoteCards,
  readFeaturedNoteFilter,
  writeFeaturedNoteFilter,
} from "./featured-note-cards";

function memo(overrides: Partial<MemoItem>): MemoItem {
  return {
    id: "memo-1",
    filename: "Getting started.md",
    preview: "Fallback preview",
    thumbnail: null,
    tags: [],
    todos: [],
    agents: [],
    createdAt: 1,
    updatedAt: 1,
    favorited: false,
    icon: null,
    colors: [],
    properties: {},
    ...overrides,
  };
}

describe("featured note cards", () => {
  beforeEach(() => {
    getFeaturedNoteFilter.mockReset();
    setFeaturedNoteFilter.mockReset();
    setFeaturedNoteFilter.mockResolvedValue(undefined);
  });

  it("uses type=skill by default and supports a custom property filter", () => {
    const memos = [
      memo({ properties: { type: "skill", name: "Writing", desc: "Draft clearly", icon: "🖋️" } }),
      memo({ id: "memo-2", filename: "Pinned.md", properties: { pin: true } }),
      memo({ id: "memo-3", filename: "Hidden.md", properties: { type: "reference" } }),
    ];
    const cards = getFeaturedNoteCards(memos);

    expect(cards).toEqual([
      {
        id: "memo-1",
        icon: "🖋️",
        name: "Writing",
        title: "Getting started",
        description: "Draft clearly",
      },
    ]);
    expect(getFeaturedNoteCards(
      memos,
      { conditions: [{ key: "pin", operator: "equals", value: "true" }] },
    ).map((card) => card.id))
      .toEqual(["memo-2"]);
    expect(getFeaturedNoteCards(
      memos,
      { conditions: [{ key: "type", operator: "contains", value: "feren" }] },
    ).map((card) => card.id))
      .toEqual(["memo-3"]);
    expect(getFeaturedNoteCards(
      memos,
      { conditions: [{ key: "type", operator: "excludes", value: "skill" }] },
    ).map((card) => card.id))
      .toEqual(["memo-3"]);
  });

  it("persists and restores the condition list through the notebook store", async () => {
    getFeaturedNoteFilter.mockResolvedValue({ conditions: [] });

    // 后端对"未配置"返回空条件列表, 前端回落到默认条件。
    await expect(readFeaturedNoteFilter("nb-1"))
      .resolves.toEqual({ conditions: [{ key: "type", operator: "equals", value: "skill" }] });
    expect(getFeaturedNoteFilter).toHaveBeenCalledWith("nb-1");

    // 写入前逐条归一化 (trim + operator 白名单), 落盘内容始终合法。
    await expect(writeFeaturedNoteFilter("nb-1", {
      conditions: [{ key: " pin ", operator: "equals", value: " true " }],
    })).resolves.toEqual({
      conditions: [{ key: "pin", operator: "equals", value: "true" }],
    });
    expect(setFeaturedNoteFilter).toHaveBeenCalledWith("nb-1", {
      conditions: [{ key: "pin", operator: "equals", value: "true" }],
    });

    // 回读走同一份存储。
    getFeaturedNoteFilter.mockResolvedValue({
      conditions: [{ key: "pin", operator: "equals", value: "true" }],
    });
    await expect(readFeaturedNoteFilter("nb-1"))
      .resolves.toEqual({ conditions: [{ key: "pin", operator: "equals", value: "true" }] });
  });

  it("drops incomplete conditions and falls back when none remain", async () => {
    // 只是点了"添加条件"却没填完 → 丢弃该行, 保留有效行。
    await expect(writeFeaturedNoteFilter("nb-1", {
      conditions: [
        { key: "pin", operator: "equals", value: "true" },
        { key: "  ", operator: "equals", value: "true" },
        { key: "type", operator: "contains", value: "   " },
      ],
    })).resolves.toEqual({
      conditions: [{ key: "pin", operator: "equals", value: "true" }],
    });

    // 全部无效 → 回落默认, 否则"常用笔记"会永远为空。
    await expect(writeFeaturedNoteFilter("nb-1", {
      conditions: [{ key: "", operator: "equals", value: "" }],
    })).resolves.toEqual({
      conditions: [{ key: "type", operator: "equals", value: "skill" }],
    });
  });

  it("falls back to the default filter when the notebook store is unavailable", async () => {
    // 常用笔记只是空状态的增强: 读失败不能阻断对话面板。
    getFeaturedNoteFilter.mockRejectedValue(new Error("notebook not found"));
    await expect(readFeaturedNoteFilter("missing"))
      .resolves.toEqual({ conditions: [{ key: "type", operator: "equals", value: "skill" }] });
  });

  it("surfaces write failures instead of silently dropping the change", async () => {
    // 静默吞掉写失败会让用户以为已保存, 因此这里要求向调用方抛出。
    setFeaturedNoteFilter.mockRejectedValue(new Error("unsupported operator"));
    await expect(writeFeaturedNoteFilter("nb-1", {
      conditions: [{ key: "pin", operator: "equals", value: "true" }],
    })).rejects.toThrow("unsupported operator");
  });

  it("unions multiple conditions instead of intersecting them", () => {
    // 并集语义: 命中任意一条即入选。若误写成交集, memo-1 / memo-2 会一起被排除。
    const memos = [
      memo({ id: "memo-1", filename: "Skill.md", properties: { type: "skill" } }),
      memo({ id: "memo-2", filename: "Pinned.md", properties: { pin: true } }),
      memo({ id: "memo-3", filename: "Other.md", properties: { type: "reference" } }),
    ];
    const cards = getFeaturedNoteCards(memos, {
      conditions: [
        { key: "type", operator: "equals", value: "skill" },
        { key: "pin", operator: "equals", value: "true" },
      ],
    });

    expect(cards.map((card) => card.id)).toEqual(["memo-1", "memo-2"]);
  });

  it("matches array-valued YAML keys element by element", () => {
    // YAML 里 tags 这类多值字段解析成数组 (见后端 frontmatter.rs: 统一成
    // Value::Array<String>)。逐元素比较才能用 equals / contains 命中。
    const memos = [
      memo({ id: "ai", filename: "AI.md", properties: { tags: ["AI", "AI/flowix"] } }),
      memo({ id: "cloud", filename: "Cloud.md", properties: { tags: ["云存储"] } }),
      memo({ id: "none", filename: "None.md", properties: { tags: [] } }),
      memo({ id: "scalar", filename: "Scalar.md", properties: { tags: "AI" } }),
    ];

    // equals: 任一元素完全相等即命中。
    expect(getFeaturedNoteCards(memos, {
      conditions: [{ key: "tags", operator: "equals", value: "AI" }],
    }).map((card) => card.id)).toEqual(["ai", "scalar"]);

    // contains: 任一元素包含子串即命中 (含路径形式的标签)。
    expect(getFeaturedNoteCards(memos, {
      conditions: [{ key: "tags", operator: "contains", value: "flowix" }],
    }).map((card) => card.id)).toEqual(["ai"]);

    // 空数组不命中任何条件。
    expect(getFeaturedNoteCards(memos, {
      conditions: [{ key: "tags", operator: "contains", value: "AI" }],
    }).map((card) => card.id)).toEqual(["ai", "scalar"]);
  });

  it("treats excludes on arrays as no element matching", () => {
    // excludes 的数组语义是「没有任何元素匹配」, 而不是「存在某个元素不匹配」——
    // 后者会让任何多值字段几乎永远满足 excludes。
    const memos = [
      memo({ id: "ai", filename: "AI.md", properties: { tags: ["AI", "AI/flowix"] } }),
      memo({ id: "cloud", filename: "Cloud.md", properties: { tags: ["云存储"] } }),
    ];

    expect(getFeaturedNoteCards(memos, {
      conditions: [{ key: "tags", operator: "excludes", value: "AI" }],
    }).map((card) => card.id)).toEqual(["cloud"]);
  });

  it("paginates after three cards and clamps invalid page indexes", () => {
    const notes = getFeaturedNoteCards([
      memo({ id: "1", filename: "One.md", properties: { pin: true } }),
      memo({ id: "2", filename: "Two.md", properties: { pin: true } }),
      memo({ id: "3", filename: "Three.md", properties: { pin: true } }),
      memo({ id: "4", filename: "Four.md", properties: { pin: true } }),
      memo({ id: "5", filename: "Five.md", properties: { pin: true } }),
      memo({ id: "6", filename: "Six.md", properties: { pin: true } }),
      memo({ id: "7", filename: "Seven.md", properties: { pin: true } }),
    ], { conditions: [{ key: "pin", operator: "equals", value: "true" }] });

    expect(getFeaturedNotePageCount(3)).toBe(1);
    expect(getFeaturedNotePageCount(4)).toBe(2);
    expect(getFeaturedNotePageCount(notes.length)).toBe(3);
    expect(getFeaturedNotePage(notes, 0).map((item) => item.id)).toEqual(["1", "2", "3"]);
    expect(getFeaturedNotePage(notes, 1).map((item) => item.id)).toEqual(["4", "5", "6"]);
    expect(getFeaturedNotePage(notes, 99).map((item) => item.id)).toEqual(["7"]);
  });

  it("keeps the narrow layout to three cards per page", () => {
    const notes = Array.from({ length: 6 }, (_, index) => ({
      id: String(index + 1),
      icon: "✦",
      name: "",
      title: `Note ${index + 1}`,
      description: "",
    }));

    expect(getFeaturedNotePageCountForSize(notes.length, FEATURED_NOTE_MOBILE_PAGE_SIZE)).toBe(2);
    expect(getFeaturedNotePage(notes, 0, FEATURED_NOTE_MOBILE_PAGE_SIZE)).toHaveLength(3);
    expect(getFeaturedNotePage(notes, 1, FEATURED_NOTE_MOBILE_PAGE_SIZE)).toHaveLength(3);
  });

  it("loads and filters every memo page", async () => {
    const loadPage = vi.fn(async (cursor?: string) => cursor
      ? {
          memos: [memo({ id: "skill-2", properties: { type: "skill" } })],
          nextCursor: null,
          hasMore: false,
        }
      : {
          memos: [memo({ id: "hidden", properties: {} }), memo({ id: "skill-1", properties: { type: "skill" } })],
          nextCursor: "page-2",
          hasMore: true,
        });

    const cards = await loadAllFeaturedNoteCards(loadPage);

    expect(loadPage).toHaveBeenNthCalledWith(1, undefined);
    expect(loadPage).toHaveBeenNthCalledWith(2, "page-2");
    expect(cards.map((item) => item.id)).toEqual(["skill-1", "skill-2"]);
  });
});

describe("featured note icon rendering", () => {
  function render(icon: string): HTMLElement {
    const target = document.createElement("span");
    appendFeaturedNoteIconContent(target, icon);
    return target;
  }

  /** 图标 id 是否被渲染成图形元素 (而不是把 id 当可见文本铺出来)。 */
  function renderedGraphicTag(target: HTMLElement): string | null {
    if (target.childElementCount !== 1) return null;
    const tag = target.firstElementChild?.tagName.toLowerCase() ?? null;
    return tag === "img" || tag === "svg" ? tag : null;
  }

  it("renders a property icon id as an <img>, not as literal text", () => {
    // `flowix_icon: avocado` 这类属性图标 id 之前会被原样塞进 textContent,
    // 显示成字面量 "avocado" —— 看起来就像图标加载失败。
    expect(renderedGraphicTag(render("avocado"))).toBe("img");
  });

  it("renders a notebook icon id as inline svg, not as literal text", () => {
    expect(renderedGraphicTag(render("board_fill"))).toBe("svg");
  });

  it("keeps emoji and plain text as text", () => {
    // emoji / 单个字符不属于任何图标库, 应原样作为文本显示。
    expect(render("🖋️").textContent).toBe("🖋️");
    expect(render("✦").textContent).toBe("✦");
    expect(render("✦").childElementCount).toBe(0);
  });

  it("leaves the target empty for an empty icon value", () => {
    expect(render("   ").childNodes).toHaveLength(0);
  });

  it("falls back to the default icon when a note has no icon of its own", () => {
    // 默认图标是一个真实的图标 id (不再是被当文本显示的 "✦"), 因此会解析成
    // 内联 SVG; 解析失败时才会退化成字面量文本。
    const cards = getFeaturedNoteCards([
      memo({ id: "plain", filename: "Plain.md", properties: { type: "skill" }, icon: null }),
    ]);
    expect(cards[0]?.icon).toBe(DEFAULT_FEATURED_NOTE_ICON);

    const target = render(cards[0]?.icon ?? "");
    expect(target.querySelector("svg")).not.toBeNull();
    // 注意: 图标 SVG 自带 <title>, 因此 textContent 不为空; 这里断言的是
    // "没有把 id 当作可见文本直接铺在容器里" —— 直接子节点只有那个 svg。
    expect(target.childElementCount).toBe(1);
    expect(target.firstElementChild?.tagName.toLowerCase()).toBe("svg");
  });
});
