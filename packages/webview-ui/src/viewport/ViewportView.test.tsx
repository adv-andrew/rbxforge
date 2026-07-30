import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { ViewportView } from "./ViewportView.js";

afterEach(() => vi.restoreAllMocks());

test("labels native viewport metadata and revokes replaced blob URLs", async () => {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValueOnce("blob:first").mockReturnValueOnce("blob:second");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const { rerender, unmount } = render(
    <ViewportView
      capture={{
        captureId: "one",
        capturedAt: 10,
        freshness: "fresh",
        target: "client-1",
        width: 640,
        height: 480,
        format: "jpeg",
        quality: 92,
        mimeType: "image/jpeg",
        data: "AQID",
      }}
    />,
  );
  expect(((await screen.findByAltText("Roblox viewport capture")) as HTMLImageElement).src).toBe("blob:first");
  expect(screen.getByText(/640 × 480 native/i)).toBeTruthy();
  expect(screen.getByText(/client-1/i)).toBeTruthy();

  await act(async () =>
    rerender(
      <ViewportView
        capture={{
          captureId: "one",
          capturedAt: 10,
          freshness: "stale",
          target: "client-1",
          width: 640,
          height: 480,
          format: "jpeg",
          quality: 92,
          mimeType: "image/jpeg",
          data: "AQID",
        }}
      />,
    ),
  );
  expect(create).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/stale capture/i)).toBeTruthy();

  await act(async () =>
    rerender(
      <ViewportView
        capture={{
          captureId: "two",
          capturedAt: 20,
          freshness: "stale",
          target: "auto",
          format: "png",
          mimeType: "image/png",
          data: "BAUG",
        }}
      />,
    ),
  );
  expect(create).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/stale/i)).toBeTruthy();
  unmount();
  expect(revoke).toHaveBeenCalledWith("blob:first");
  expect(revoke).toHaveBeenCalledWith("blob:second");
});
