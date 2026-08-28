// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotesScreen } from "./NotesScreen";

const NOTES_STORAGE_KEY = "recall-studio.notes.v1";

describe("NotesScreen search", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify([
      { id: "lyrics", title: "Verse sketch", body: "Hold the night until the kick returns", created_at_ms: 1, updated_at_ms: 2 },
      { id: "mix", title: "Mix pass", body: "Check the vocal brightness after the break", created_at_ms: 1, updated_at_ms: 1 },
    ]));
  });

  it("finds notes by title or body and lets Escape clear the search", async () => {
    const user = userEvent.setup();
    render(<NotesScreen />);

    const search = screen.getByRole("searchbox", { name: "Find a note" });
    await user.type(search, "kick");
    expect(screen.getByRole("button", { name: /Verse sketch/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mix pass/i })).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "brightness");
    expect(screen.getByRole("button", { name: /Mix pass/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Verse sketch/i })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(screen.getByRole("button", { name: /Verse sketch/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Mix pass/i })).toBeInTheDocument();
  });
});
