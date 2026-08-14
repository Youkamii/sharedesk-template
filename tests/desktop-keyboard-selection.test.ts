import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopSpatialLayoutKeys,
  moveDesktopKeyboardSelection,
  nextDesktopLayoutKey,
  reconcileDesktopKeyboardSelection,
  shouldIgnoreDesktopSelectionKeydown,
  toggleDesktopSelectionKey,
  type DesktopKeyboardSelectionState,
  type DesktopSelectableIcon,
} from "../src/lib/client/desktop-keyboard-selection";

function icon(
  layoutKey: string,
  x: number,
  y: number,
  width = 80,
  height = 80,
): DesktopSelectableIcon {
  return { layoutKey, x, y, width, height };
}

const grid = [
  icon("a", 10, 10),
  icon("b", 110, 10),
  icon("c", 210, 10),
  icon("d", 10, 110),
  icon("e", 110, 110),
  icon("f", 210, 110),
];

function selection(
  selectedLayoutKeys: string[],
  anchorLayoutKey: string | null,
  focusLayoutKey: string | null,
): DesktopKeyboardSelectionState {
  return { selectedLayoutKeys, anchorLayoutKey, focusLayoutKey };
}

test("arrow navigation picks the nearest candidate in the requested half-plane", () => {
  assert.equal(nextDesktopLayoutKey(grid, "e", "ArrowLeft"), "d");
  assert.equal(nextDesktopLayoutKey(grid, "e", "ArrowRight"), "f");
  assert.equal(nextDesktopLayoutKey(grid, "e", "ArrowUp"), "b");
  assert.equal(nextDesktopLayoutKey(grid, "e", "ArrowDown"), null);
});

test("direction ranking prefers visual distance over an extreme diagonal", () => {
  const icons = [
    icon("origin", 0, 0),
    icon("extreme-diagonal", 90, 500),
    icon("near-straight", 100, 0),
    icon("same-primary-far", 190, 100),
    icon("same-primary-near", 190, 10),
  ];

  assert.equal(
    nextDesktopLayoutKey(icons, "origin", "ArrowRight"),
    "near-straight",
  );
  assert.equal(
    nextDesktopLayoutKey(
      icons.filter((item) => item.layoutKey !== "near-straight"),
      "origin",
      "ArrowRight",
    ),
    "same-primary-near",
  );
});

test("equal visual distances use primary, secondary, then stable order", () => {
  const icons = [
    icon("origin", 0, 0),
    icon("larger-primary", 80, 60),
    icon("smaller-primary", 60, 80),
    { ...icon("stable-second", 200, 0), order: 2 },
    { ...icon("stable-first", 200, 0), order: 1 },
  ];

  assert.equal(
    nextDesktopLayoutKey(icons, "origin", "ArrowRight"),
    "smaller-primary",
  );
  assert.equal(
    nextDesktopLayoutKey(
      icons.filter(
        (item) =>
          item.layoutKey !== "larger-primary" &&
          item.layoutKey !== "smaller-primary",
      ),
      "origin",
      "ArrowRight",
    ),
    "stable-first",
  );
});

test("icon size participates through its visual center", () => {
  const icons = [
    icon("origin", 0, 0, 100, 100),
    icon("visually-near", 140, 30, 20, 20),
    icon("visually-far", 100, 0, 200, 100),
  ];

  assert.equal(
    nextDesktopLayoutKey(icons, "origin", "ArrowRight"),
    "visually-near",
  );
});

test("shift arrow selects a continuous spatial range and keeps its anchor", () => {
  const first = moveDesktopKeyboardSelection(
    grid,
    selection(["b"], "b", "b"),
    "ArrowRight",
    { extend: true },
  );
  assert.deepEqual(first, selection(["b", "c"], "b", "c"));

  const second = moveDesktopKeyboardSelection(grid, first, "ArrowDown", {
    extend: true,
  });
  assert.deepEqual(second, selection(["b", "c", "d", "e", "f"], "b", "f"));

  const contracted = moveDesktopKeyboardSelection(grid, second, "ArrowLeft", {
    extend: true,
  });
  assert.deepEqual(contracted, selection(["b", "c", "d", "e"], "b", "e"));
});

test("spatial ranges follow visible y then x placement, not input order", () => {
  const shuffled = [grid[4], grid[1], grid[5], grid[0], grid[3], grid[2]];
  assert.deepEqual(desktopSpatialLayoutKeys(shuffled), ["a", "b", "c", "d", "e", "f"]);
});

test("additive shift range keeps ctrl or command toggled items", () => {
  const result = moveDesktopKeyboardSelection(
    grid,
    selection(["a", "e"], "e", "e"),
    "ArrowRight",
    { extend: true, additive: true },
  );
  assert.deepEqual(result, selection(["a", "e", "f"], "e", "f"));
});

test("ctrl or command navigation can move focus without changing selection", () => {
  const result = moveDesktopKeyboardSelection(
    grid,
    selection(["a", "e"], "e", "e"),
    "ArrowRight",
    { preserveSelection: true },
  );
  assert.deepEqual(result, selection(["a", "e"], "e", "f"));
});

test("toggle selection keeps a focus even after toggling the last item off", () => {
  const added = toggleDesktopSelectionKey(
    grid,
    selection(["a"], "a", "a"),
    "e",
  );
  assert.deepEqual(added, selection(["a", "e"], "e", "e"));

  const removed = toggleDesktopSelectionKey(grid, added, "e");
  assert.deepEqual(removed, selection(["a"], "e", "e"));

  const empty = toggleDesktopSelectionKey(
    grid,
    selection(["a"], "a", "a"),
    "a",
  );
  assert.deepEqual(empty, selection([], "a", "a"));
});

test("deleted or invalid selection keys are removed with deterministic fallback", () => {
  assert.deepEqual(
    reconcileDesktopKeyboardSelection(
      grid,
      selection(["deleted", "b", "b"], "deleted", "deleted"),
    ),
    selection(["b"], "b", "b"),
  );

  assert.deepEqual(
    moveDesktopKeyboardSelection(
      grid,
      selection(["deleted"], "deleted", "deleted"),
      "ArrowRight",
    ),
    selection(["a"], "a", "a"),
  );

  assert.deepEqual(
    moveDesktopKeyboardSelection([], null, "ArrowRight"),
    selection([], null, null),
  );
});

test("an unfocused desktop starts arrow navigation from its first spatial icon", () => {
  assert.deepEqual(
    moveDesktopKeyboardSelection(grid, null, "ArrowDown"),
    selection(["a"], "a", "a"),
  );
});

test("a rectangle-only selection continues from its last selected icon", () => {
  const rectangleSelection = selection(["a", "e"], null, null);

  assert.deepEqual(
    moveDesktopKeyboardSelection(grid, rectangleSelection, "ArrowRight"),
    selection(["f"], "f", "f"),
  );
  assert.deepEqual(
    moveDesktopKeyboardSelection(grid, rectangleSelection, "ArrowRight", {
      extend: true,
    }),
    selection(["e", "f"], "e", "f"),
  );
  assert.deepEqual(
    moveDesktopKeyboardSelection(grid, rectangleSelection, "ArrowRight", {
      preserveSelection: true,
    }),
    selection(["a", "e"], "e", "f"),
  );
});

test("text editing controls keep their arrow keys", () => {
  const target = (values: Record<string, unknown>) =>
    values as unknown as EventTarget;

  assert.equal(
    shouldIgnoreDesktopSelectionKeydown(target({ tagName: "INPUT" })),
    true,
  );
  assert.equal(
    shouldIgnoreDesktopSelectionKeydown(target({ tagName: "textarea" })),
    true,
  );
  assert.equal(
    shouldIgnoreDesktopSelectionKeydown(
      target({ tagName: "DIV", isContentEditable: true }),
    ),
    true,
  );
  assert.equal(
    shouldIgnoreDesktopSelectionKeydown(
      target({
        tagName: "SPAN",
        closest: (selector: string) =>
          selector.includes("contenteditable") ? {} : null,
      }),
    ),
    true,
  );
  assert.equal(
    shouldIgnoreDesktopSelectionKeydown(target({ tagName: "BUTTON" })),
    false,
  );
  assert.equal(shouldIgnoreDesktopSelectionKeydown(null), false);
});
