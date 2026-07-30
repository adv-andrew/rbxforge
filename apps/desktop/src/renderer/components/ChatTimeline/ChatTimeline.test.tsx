// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { message } from "../../test/fixtures.js";
import { ChatTimeline } from "./ChatTimeline.js";

afterEach(cleanup);

it("renders selected-thread messages in snapshot order with user/system roles only", () => {
  render(
    <ChatTimeline
      messages={[
        message({ id: "two", role: "system", content: "Saved locally.", createdAt: 2 }),
        message({ id: "one", content: "First note", createdAt: 1 }),
        message({ id: "other", threadId: "thread-b", content: "Hidden", createdAt: 0 }),
      ]}
      threadId="thread-a"
    />,
  );
  const entries = screen.getAllByRole("article");
  expect(entries.map((entry) => entry.querySelector("p")?.textContent)).toEqual(["Saved locally.", "First note"]);
  expect(screen.queryByText("Hidden")).toBeNull();
  expect(screen.queryByText(/assistant/i)).toBeNull();
});

it("uses the exact honest local-only empty copy", () => {
  render(<ChatTimeline messages={[]} threadId="thread-a" />);
  expect(screen.getByText("Start a local project note or prompt. AI is not connected yet.")).not.toBeNull();
  expect(screen.queryByText(/thinking|generating|model/i)).toBeNull();
});
