import { describe, expect, it } from "vitest";
import { handlesKey, historyKeyAction, type HistoryNavState } from "./historyKeys";

/**
 * A five-row history that forks.
 *
 * Row 1 is a branch tip whose parent is row 4 — three rows further down and on
 * another lane. That gap is the whole reason `p` exists: stepping down the page
 * from row 1 lands on row 2, which belongs to a different lineage entirely.
 */
const forked: HistoryNavState = {
  index: 0,
  count: 5,
  parentRows: [4, 2, 3, 4, null],
};

function at(index: number): HistoryNavState {
  return { ...forked, index };
}

describe("historyKeyAction · moving", () => {
  it("steps down with the arrow key and with j", () => {
    expect(historyKeyAction({ key: "ArrowDown" }, at(1))).toEqual({ kind: "select", index: 2 });
    expect(historyKeyAction({ key: "j" }, at(1))).toEqual({ kind: "select", index: 2 });
  });

  it("steps up with the arrow key and with k", () => {
    expect(historyKeyAction({ key: "ArrowUp" }, at(3))).toEqual({ kind: "select", index: 2 });
    expect(historyKeyAction({ key: "k" }, at(3))).toEqual({ kind: "select", index: 2 });
  });

  it("stops at the ends instead of wrapping", () => {
    // Wrapping in a history is disorienting: the top and the bottom are the
    // newest and oldest work, not positions on a carousel.
    expect(historyKeyAction({ key: "ArrowUp" }, at(0))).toEqual({ kind: "select", index: 0 });
    expect(historyKeyAction({ key: "ArrowDown" }, at(4))).toEqual({ kind: "select", index: 4 });
  });

  it("jumps to the ends", () => {
    expect(historyKeyAction({ key: "Home" }, at(3))).toEqual({ kind: "select", index: 0 });
    expect(historyKeyAction({ key: "End" }, at(1))).toEqual({ kind: "select", index: 4 });
  });

  it("selects the first row when nothing is selected yet", () => {
    const none = { ...forked, index: -1 };
    expect(historyKeyAction({ key: "ArrowDown" }, none)).toEqual({ kind: "select", index: 0 });
    expect(historyKeyAction({ key: "ArrowUp" }, none)).toEqual({ kind: "select", index: 0 });
  });
});

describe("historyKeyAction · following the lineage", () => {
  it("jumps across lanes to the parent, not down the page", () => {
    // Row 1's parent is row 4. Stepping down would land on row 2, which is a
    // different lineage — this is the move a flat list cannot offer.
    expect(historyKeyAction({ key: "p" }, at(1))).toEqual({ kind: "select", index: 2 });
    expect(historyKeyAction({ key: "p" }, at(0))).toEqual({ kind: "select", index: 4 });
  });

  it("does nothing at a root", () => {
    // Row 4 has no parent. Silence beats moving somewhere arbitrary.
    expect(historyKeyAction({ key: "p" }, at(4))).toEqual({ kind: "none" });
  });
});

describe("historyKeyAction · opening", () => {
  it("opens the Report on Enter", () => {
    expect(historyKeyAction({ key: "Enter" }, at(2))).toEqual({ kind: "openReport", index: 2 });
  });

  it("opens the workspace on Shift+Enter", () => {
    expect(historyKeyAction({ key: "Enter", shiftKey: true }, at(2))).toEqual({
      kind: "openWorkspace",
      index: 2,
    });
  });
});

describe("historyKeyAction · staying out of the way", () => {
  it("ignores a key it does not handle", () => {
    expect(historyKeyAction({ key: "q" }, at(1))).toEqual({ kind: "none" });
    expect(historyKeyAction({ key: "Tab" }, at(1))).toEqual({ kind: "none" });
  });

  it("ignores modified keys so the app's own shortcuts survive", () => {
    // Alt+3 reaches this surface. Swallowing it while the list has focus would
    // strand the user here.
    expect(historyKeyAction({ key: "j", altKey: true }, at(1))).toEqual({ kind: "none" });
    expect(historyKeyAction({ key: "ArrowDown", ctrlKey: true }, at(1))).toEqual({ kind: "none" });
    expect(historyKeyAction({ key: "k", metaKey: true }, at(1))).toEqual({ kind: "none" });
  });

  it("does nothing at all in an empty history", () => {
    const empty: HistoryNavState = { index: -1, count: 0, parentRows: [] };
    expect(historyKeyAction({ key: "ArrowDown" }, empty)).toEqual({ kind: "none" });
    expect(historyKeyAction({ key: "Enter" }, empty)).toEqual({ kind: "none" });
  });
});

describe("handlesKey", () => {
  it("claims the keys it acts on and no others", () => {
    expect(handlesKey({ key: "ArrowDown" }, at(1))).toBe(true);
    expect(handlesKey({ key: "p" }, at(1))).toBe(true);
    // A root's `p` is not claimed, so the key is left to the page.
    expect(handlesKey({ key: "p" }, at(4))).toBe(false);
    expect(handlesKey({ key: "q" }, at(1))).toBe(false);
  });
});
