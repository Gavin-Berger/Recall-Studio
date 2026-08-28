import { describe, expect, it } from "vitest";
import { mapKeyAction, type MapNavState } from "./mapKeys";

/** Five points drawn left to right, the third one focused. */
const map: MapNavState = { index: 2, count: 5 };

function at(index: number): MapNavState {
  return { ...map, index };
}

describe("mapKeyAction · moving between points", () => {
  it("steps right and left", () => {
    expect(mapKeyAction({ key: "ArrowRight" }, at(2))).toEqual({ kind: "focus", index: 3 });
    expect(mapKeyAction({ key: "ArrowLeft" }, at(2))).toEqual({ kind: "focus", index: 1 });
  });

  it("stops at the ends instead of wrapping", () => {
    // The ends of a map are the oldest and newest work, not positions on a
    // carousel. Wrapping there is disorienting.
    expect(mapKeyAction({ key: "ArrowLeft" }, at(0))).toEqual({ kind: "focus", index: 0 });
    expect(mapKeyAction({ key: "ArrowRight" }, at(4))).toEqual({ kind: "focus", index: 4 });
  });

  it("jumps to the oldest and newest work", () => {
    // Time runs left to right, so Home is where the song started.
    expect(mapKeyAction({ key: "Home" }, at(3))).toEqual({ kind: "focus", index: 0 });
    expect(mapKeyAction({ key: "End" }, at(1))).toEqual({ kind: "focus", index: 4 });
  });

  it("lands on a point rather than stepping past one when nothing is focused", () => {
    // Otherwise the first arrow press skips a point and the producer wonders
    // what they missed.
    const none = { ...map, index: -1 };
    expect(mapKeyAction({ key: "ArrowRight" }, none)).toEqual({ kind: "focus", index: 0 });
    expect(mapKeyAction({ key: "ArrowLeft" }, none)).toEqual({ kind: "focus", index: 0 });
  });
});

describe("mapKeyAction · opening and scaling", () => {
  it("opens what is focused", () => {
    expect(mapKeyAction({ key: "Enter" }, at(2))).toEqual({ kind: "open", index: 2 });
    expect(mapKeyAction({ key: " " }, at(2))).toEqual({ kind: "open", index: 2 });
  });

  it("opens nothing when nothing is focused", () => {
    expect(mapKeyAction({ key: "Enter" }, { ...map, index: -1 })).toEqual({ kind: "none" });
  });

  it("scales with plus and minus, and fits with zero", () => {
    // The same three the scale controls offer, so the map answers the keys a
    // producer would try without hunting for the buttons.
    expect(mapKeyAction({ key: "+" }, at(2))).toEqual({ kind: "zoomIn" });
    expect(mapKeyAction({ key: "=" }, at(2))).toEqual({ kind: "zoomIn" });
    expect(mapKeyAction({ key: "-" }, at(2))).toEqual({ kind: "zoomOut" });
    expect(mapKeyAction({ key: "0" }, at(2))).toEqual({ kind: "fit" });
  });
});

describe("mapKeyAction · staying out of the way", () => {
  it("ignores keys it does not handle", () => {
    expect(mapKeyAction({ key: "q" }, at(2))).toEqual({ kind: "none" });
    expect(mapKeyAction({ key: "Tab" }, at(2))).toEqual({ kind: "none" });
  });

  it("leaves the browser's own zoom alone", () => {
    // Ctrl/Cmd +/- is the browser zooming the whole app. Taking it would be
    // surprising and there is no way to give it back.
    expect(mapKeyAction({ key: "+", ctrlKey: true }, at(2))).toEqual({ kind: "none" });
    expect(mapKeyAction({ key: "-", metaKey: true }, at(2))).toEqual({ kind: "none" });
  });

  it("leaves the app's surface shortcuts alone", () => {
    // Alt+3 reaches this screen. Swallowing it would strand the producer here.
    expect(mapKeyAction({ key: "ArrowRight", altKey: true }, at(2))).toEqual({ kind: "none" });
  });

  it("does nothing on an empty map", () => {
    const empty: MapNavState = { index: -1, count: 0 };
    expect(mapKeyAction({ key: "ArrowRight" }, empty)).toEqual({ kind: "none" });
    expect(mapKeyAction({ key: "0" }, empty)).toEqual({ kind: "none" });
  });
});
