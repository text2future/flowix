import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoItem } from "@/types/memo-item";
import {
  FEATURED_NOTE_MOBILE_PAGE_SIZE,
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
  beforeEach(() => localStorage.clear());

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
      { key: "pin", operator: "equals", value: "true" },
    ).map((card) => card.id))
      .toEqual(["memo-2"]);
    expect(getFeaturedNoteCards(
      memos,
      { key: "type", operator: "contains", value: "feren" },
    ).map((card) => card.id))
      .toEqual(["memo-3"]);
    expect(getFeaturedNoteCards(
      memos,
      { key: "type", operator: "excludes", value: "skill" },
    ).map((card) => card.id))
      .toEqual(["memo-3"]);
  });

  it("persists and restores the selected property filter", () => {
    expect(readFeaturedNoteFilter())
      .toEqual({ key: "type", operator: "equals", value: "skill" });
    expect(writeFeaturedNoteFilter({ key: " pin ", operator: "equals", value: " true " }))
      .toEqual({ key: "pin", operator: "equals", value: "true" });
    expect(readFeaturedNoteFilter())
      .toEqual({ key: "pin", operator: "equals", value: "true" });
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
    ], { key: "pin", operator: "equals", value: "true" });

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
