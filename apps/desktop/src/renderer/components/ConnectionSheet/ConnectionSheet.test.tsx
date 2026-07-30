// @vitest-environment jsdom

import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopError } from "../../../shared/errors.js";
import type { RuntimeSnapshot, StudioCatalogRow } from "../../../shared/domain.js";
import type { PluginInspectionView } from "../../../shared/protocol.js";
import { project, snapshot } from "../../test/fixtures.js";
import { ConnectionSheet, type ConnectionSheetActions, type ConnectionSheetProps } from "./ConnectionSheet.js";

afterEach(cleanup);

const digest = `01234567${"a".repeat(48)}89abcdef`;

function row(overrides: Partial<StudioCatalogRow> = {}): StudioCatalogRow {
  return {
    instanceId: "studio-instance-a",
    role: "edit",
    placeId: 101,
    placeName: "Deepwater",
    dataModelName: "Deepwater",
    pluginVersion: "2.22.5",
    pluginVariant: "main",
    serverVersion: "2.22.5",
    versionMismatch: false,
    connectedAt: 1,
    lastActivity: 2,
    eligible: true,
    warningRequired: false,
    ...overrides,
  };
}

function runtime(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    ...snapshot().runtimeByProject["project-a"]!,
    state: "studio-selection-required",
    detail: "Choose the exact open Studio instance.",
    activeProject: {
      revision: 4,
      canonicalProjectFile: "/projects/deepwater/default.project.json",
      relativeProjectFile: "default.project.json",
      configDigest: digest,
    },
    rojo: {
      port: 34_872,
      generation: 3,
      executablePath: "/tools/rojo",
      version: "7.8.0",
    },
    broker: {
      state: "ready",
      primaryPort: 58_741,
      legacyPort: 3_002,
      legacyStatus: "listening",
      brokerEpoch: "broker-epoch-a",
    },
    catalog: [row()],
    catalogRevision: 7,
    ...overrides,
  };
}

function inspection(
  state: PluginInspectionView["state"] = "installed",
  overrides: Partial<PluginInspectionView> = {},
): PluginInspectionView {
  return {
    state,
    sourcePath: "/app/MCPPlugin.rbxmx",
    destinationPath: "/plugins/MCPPlugin.rbxmx",
    restartRequired: false,
    detail: `${state} detail`,
    ...overrides,
  };
}

function actionSpies(): ConnectionSheetActions {
  return {
    acknowledgeStudioRestart: vi.fn(),
    chooseRojo: vi.fn(),
    confirmRojoHandoff: vi.fn(async () => true),
    copyMcpUrl: vi.fn(),
    copyProjectFile: vi.fn(),
    copyRojoAddress: vi.fn(),
    disconnect: vi.fn(),
    inspectPlugin: vi.fn(),
    installPlugin: vi.fn(),
    reconnect: vi.fn(),
    refreshCatalog: vi.fn(),
    saveMcpPort: vi.fn(),
    selectStudio: vi.fn(async () => true),
    showPluginFolder: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function renderSheet(overrides: Partial<ConnectionSheetProps> = {}) {
  const actions = overrides.actions ?? actionSpies();
  const props: ConnectionSheetProps = {
    actions,
    busy: {},
    mcpPortChangeAllowed: true,
    onDismiss: vi.fn(),
    open: true,
    pluginInspection: inspection(),
    preferredMcpPort: 58_741,
    project: project(),
    restartRecommended: false,
    runtime: runtime(),
    ...overrides,
  };
  return { ...render(<ConnectionSheet {...props} />), actions, props };
}

describe("ConnectionSheet project, Rojo, and MCP steps", () => {
  it("renders one accessible six-step sequence from the host active identity", async () => {
    const { actions } = renderSheet();
    for (const heading of ["1 Project", "2 Rojo", "3 Studio MCP", "4 Studio place", "5 Rojo handoff", "6 Confirm"]) {
      expect(screen.getByRole("heading", { name: heading })).not.toBeNull();
    }
    expect(screen.getByText("/projects/deepwater/default.project.json")).not.toBeNull();
    expect(screen.getByText("default.project.json")).not.toBeNull();
    expect(screen.getByText("01234567…89abcdef")).not.toBeNull();
    expect(screen.getByText(digest).closest("details")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Copy project file" }));
    expect(actions.copyProjectFile).toHaveBeenCalledWith();
  });

  it("does not fabricate a Rojo version before connection and exposes only the host picker", async () => {
    const { actions } = renderSheet({
      runtime: runtime({
        state: "needs-reconnect",
        rojo: undefined,
        broker: undefined,
        catalog: [],
        catalogRevision: undefined,
      }),
    });
    expect(screen.getByText("Resolved when connecting")).not.toBeNull();
    expect(screen.queryByText("7.8.0")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Choose Rojo executable" }));
    expect(actions.chooseRojo).toHaveBeenCalledWith();
  });

  it("keeps the absolute Rojo executable path in technical disclosure", () => {
    renderSheet();
    expect(screen.getByText("/tools/rojo").closest("details")).not.toBeNull();
  });

  it("shows the exact manual Rojo address and uses controller-derived copy actions", async () => {
    const { actions } = renderSheet();
    expect(
      screen.getByText("Connect the Rojo Studio plugin in the selected Studio window to 127.0.0.1:34872"),
    ).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Copy Rojo address" }));
    await userEvent.click(screen.getByRole("button", { name: "Copy MCP URL" }));
    expect(actions.copyRojoAddress).toHaveBeenCalledWith();
    expect(actions.copyMcpUrl).toHaveBeenCalledWith();
    expect(document.body.textContent).not.toMatch(/Rojo connected|Rojo verified/i);
  });

  it.each([
    ["missing", "Install Studio plugin"],
    ["installed", "Studio plugin installed"],
    ["inspector-conflict", "Show Plugins folder"],
    ["error", "Inspect Studio plugin"],
  ] as const)("renders the closed %s plugin state with its fixed action", (state, expected) => {
    renderSheet({ pluginInspection: inspection(state) });
    expect(screen.getByText(expected) ?? screen.getByRole("button", { name: expected })).not.toBeNull();
  });

  it("requires explicit replacement confirmation and keeps a changed-install restart recommendation visible", async () => {
    const { actions, rerender, props } = renderSheet({
      pluginInspection: inspection("replace-required"),
    });
    const replace = screen.getByRole<HTMLButtonElement>("button", { name: "Replace Studio plugin" });
    expect(replace.disabled).toBe(true);
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: "Back up and replace the existing Studio plugin",
      }),
    );
    expect(replace.disabled).toBe(false);
    await userEvent.click(replace);
    expect(actions.installPlugin).toHaveBeenCalledWith(true);

    rerender(
      <ConnectionSheet
        {...props}
        pluginInspection={inspection("installed", { restartRequired: false })}
        restartRecommended
      />,
    );
    expect(screen.getByText("Restart Studio before continuing.")).not.toBeNull();
    expect(screen.queryByText(/loaded the plugin/i)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Studio restarted" }));
    expect(actions.acknowledgeStudioRestart).toHaveBeenCalledWith();
  });

  it("renders the exact audited Studio MCP server version supplied by the host", () => {
    renderSheet({
      runtime: runtime({
        broker: undefined,
        catalog: [],
        catalogRevision: undefined,
        rojo: undefined,
        state: "needs-reconnect",
        studioMcp: { serverVersion: "2.22.5" },
      }),
    });
    expect(screen.getByText("Studio MCP 2.22.5")).not.toBeNull();
  });

  it("validates and saves a preferred port explicitly, and disables it for any project broker lease", async () => {
    const { actions, rerender, props } = renderSheet();
    const input = screen.getByRole<HTMLInputElement>("spinbutton", { name: "Preferred MCP port" });
    await userEvent.clear(input);
    await userEvent.type(input, "1000");
    expect(screen.getByText("Enter an integer from 1024 to 65535.")).not.toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save MCP port" }).disabled).toBe(true);

    await userEvent.clear(input);
    await userEvent.type(input, "60000");
    await userEvent.click(screen.getByRole("button", { name: "Save MCP port" }));
    expect(actions.saveMcpPort).toHaveBeenCalledWith(60_000);
    expect(screen.getByText("Applies to the next broker start.")).not.toBeNull();
    expect(screen.getByText(/Legacy port 3002/).closest("details")).not.toBeNull();

    rerender(<ConnectionSheet {...props} mcpPortChangeAllowed={false} />);
    expect(screen.getByRole<HTMLInputElement>("spinbutton", { name: "Preferred MCP port" }).disabled).toBe(true);
    expect(screen.getByText("Disconnect every project using Studio MCP before changing this port.")).not.toBeNull();
  });

  it.each(["", "1023", "65536", "1024.5"])("rejects the invalid MCP port boundary %j", (value) => {
    renderSheet();
    const input = screen.getByRole<HTMLInputElement>("spinbutton", { name: "Preferred MCP port" });
    fireEvent.change(input, { target: { value } });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save MCP port" }).disabled).toBe(true);
    if (value !== "") {
      expect(screen.getByText("Enter an integer from 1024 to 65535.")).not.toBeNull();
    }
  });

  it.each(["1024", "65535"])("accepts the valid MCP port boundary %s", async (value) => {
    const { actions } = renderSheet();
    const input = screen.getByRole<HTMLInputElement>("spinbutton", { name: "Preferred MCP port" });
    fireEvent.change(input, { target: { value } });
    await userEvent.click(screen.getByRole("button", { name: "Save MCP port" }));
    expect(actions.saveMcpPort).toHaveBeenCalledWith(Number(value));
  });
});

describe("ConnectionSheet Studio selection and handoff", () => {
  it("keeps empty and sole-instance catalogs explicitly unselected", async () => {
    const empty = renderSheet({ runtime: runtime({ catalog: [], catalogRevision: 8 }) });
    expect(screen.getByText("No Studio places reported.")).not.toBeNull();
    empty.unmount();

    const { actions } = renderSheet();
    const radio = screen.getByRole<HTMLInputElement>("radio", { name: /Deepwater.*101/ });
    expect(radio.checked).toBe(false);
    expect(actions.selectStudio).not.toHaveBeenCalled();
    await userEvent.click(radio);
    expect(actions.selectStudio).toHaveBeenCalledWith({
      projectId: "project-a",
      instanceId: "studio-instance-a",
      catalogRevision: 7,
      warningAccepted: false,
    });
  });

  it("distinguishes equal names by visible place ID and submits the exact opaque instance ID", async () => {
    const actions = actionSpies();
    renderSheet({
      actions,
      runtime: runtime({
        catalog: [
          row({ instanceId: "studio-one", placeName: "Shared", placeId: 101 }),
          row({ instanceId: "studio-two", placeName: "Shared", placeId: 202 }),
        ],
      }),
    });
    await userEvent.click(screen.getByRole("radio", { name: /Shared.*202/ }));
    expect(actions.selectStudio).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "studio-two", warningAccepted: false }),
    );
  });

  it.each([
    ["role", "Unavailable: Studio role must be Edit."],
    ["plugin-variant", "Unavailable: use the main Studio MCP plugin."],
    ["plugin-version", "Unavailable: Studio plugin version does not match."],
    ["server-version", "Unavailable: Studio MCP server version does not match."],
    ["version-mismatch", "Unavailable: Studio reported a plugin/server version mismatch."],
    ["stale", "Unavailable: Studio metadata is stale. Refresh the list."],
    ["project-mismatch", "Unavailable: place ID does not match this project."],
    ["catalog-ambiguous", "Unavailable: multiple Studio instances report the same published place."],
  ] as const)("maps blocked reason %s to fixed human copy", (reason, copy) => {
    renderSheet({
      runtime: runtime({
        catalog: [
          row({
            eligible: false,
            eligibilityReason: reason,
            instanceId: `blocked-${reason}`,
            placeName: reason,
          }),
        ],
      }),
    });
    expect(screen.getByText(copy)).not.toBeNull();
    expect(screen.getByRole<HTMLInputElement>("radio").disabled).toBe(true);
  });

  it("fails closed on missing or defensive unknown metadata and displays empty versions as Not reported", () => {
    renderSheet({
      runtime: runtime({
        catalog: [
          row({
            eligible: false,
            eligibilityReason: "defensive-unknown" as StudioCatalogRow["eligibilityReason"],
            instanceId: "unknown-row",
            pluginVersion: "",
            serverVersion: "",
          }),
        ],
      }),
    });
    expect(screen.getByText("Unavailable: unrecognized Studio metadata.")).not.toBeNull();
    expect(document.body.textContent?.match(/Not reported/g)).toHaveLength(2);
    expect(screen.getByRole<HTMLInputElement>("radio").disabled).toBe(true);
  });

  it("renders the ECMAScript Date boundary and fails closed on oversized Studio timestamps", () => {
    const maxDateTimestamp = 8_640_000_000_000_000;
    const boundaryRuntime = runtime({
      catalog: [row({ connectedAt: maxDateTimestamp, lastActivity: maxDateTimestamp })],
    });
    const rendered = renderSheet({ runtime: boundaryRuntime });

    expect(screen.getByText("Last activity +275760-09-13T00:00:00.000Z")).not.toBeNull();
    expect(screen.getByText("+275760-09-13T00:00:00.000Z")).not.toBeNull();

    rendered.rerender(
      <ConnectionSheet
        {...rendered.props}
        runtime={{
          ...boundaryRuntime,
          catalog: [row({ connectedAt: maxDateTimestamp + 1, lastActivity: maxDateTimestamp + 1 })],
        }}
      />,
    );
    expect(document.body.textContent?.match(/Not reported/g)).toHaveLength(2);
  });

  it.each([
    {
      eligibilityReason: "future-reason" as StudioCatalogRow["eligibilityReason"],
    },
    {
      warningRequired: true,
      warningKind: "future-warning" as StudioCatalogRow["warningKind"],
    },
  ])("fails closed when an otherwise eligible row carries defensive unknown host metadata", (metadata) => {
    renderSheet({
      runtime: runtime({
        catalog: [row(metadata)],
      }),
    });
    expect(screen.getByText("Unavailable: unrecognized Studio metadata.")).not.toBeNull();
    expect(screen.getByRole<HTMLInputElement>("radio").disabled).toBe(true);
  });

  it.each([
    ["unknown-place", "I understand this project does not declare a published place ID."],
    ["unpublished-place", "I understand this Studio place is unpublished."],
  ] as const)("keeps %s selection local until one acknowledged submit", async (warningKind, warningCopy) => {
    const actions = actionSpies();
    renderSheet({
      actions,
      runtime: runtime({
        catalog: [
          row({
            placeId: warningKind === "unpublished-place" ? 0 : 101,
            warningRequired: true,
            warningKind,
          }),
        ],
      }),
    });
    await userEvent.click(screen.getByRole("radio"));
    expect(actions.selectStudio).not.toHaveBeenCalled();
    const acknowledgement = screen.getByRole("checkbox", { name: warningCopy });
    await userEvent.click(acknowledgement);
    expect(actions.selectStudio).toHaveBeenCalledTimes(1);
    expect(actions.selectStudio).toHaveBeenCalledWith({
      projectId: "project-a",
      instanceId: "studio-instance-a",
      catalogRevision: 7,
      warningAccepted: true,
    });
    await userEvent.click(acknowledgement);
    expect(actions.selectStudio).toHaveBeenCalledTimes(1);
  });

  it("derives the selected row and binding revision from host pending state, then suppresses duplicate binds", async () => {
    const actions = actionSpies();
    renderSheet({
      actions,
      runtime: runtime({
        pending: {
          instanceId: "studio-instance-a",
          catalogRevision: 7,
          bindingRevision: 23,
          rojoHandoffRequired: true,
        },
      }),
    });
    expect(screen.getByRole<HTMLInputElement>("radio").checked).toBe(true);
    const bind = screen.getByRole<HTMLButtonElement>("button", { name: "Bind Studio" });
    expect(bind.disabled).toBe(true);
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: "I connected this Studio window to the Rojo server above",
      }),
    );
    expect(bind.disabled).toBe(false);
    await userEvent.click(bind);
    await userEvent.click(bind);
    expect(actions.confirmRojoHandoff).toHaveBeenCalledTimes(1);
    expect(actions.confirmRojoHandoff).toHaveBeenCalledWith({
      projectId: "project-a",
      bindingRevision: 23,
    });
  });

  it("allows the exact same Studio selection to retry after a failed same-snapshot submission", async () => {
    const selection = deferred<boolean>();
    const actions = actionSpies();
    actions.selectStudio = vi.fn(() => selection.promise);
    renderSheet({ actions });
    const radio = screen.getByRole("radio");

    await userEvent.click(radio);
    await userEvent.click(radio);
    expect(actions.selectStudio).toHaveBeenCalledTimes(1);

    await act(async () => selection.resolve(false));
    await userEvent.click(radio);
    expect(actions.selectStudio).toHaveBeenCalledTimes(2);
  });

  it("allows the exact same pending handoff to retry after a failed same-snapshot bind", async () => {
    const binding = deferred<boolean>();
    const actions = actionSpies();
    actions.confirmRojoHandoff = vi.fn(() => binding.promise);
    renderSheet({
      actions,
      runtime: runtime({
        pending: {
          instanceId: "studio-instance-a",
          catalogRevision: 7,
          bindingRevision: 23,
          rojoHandoffRequired: true,
        },
      }),
    });
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: "I connected this Studio window to the Rojo server above",
      }),
    );
    const bind = screen.getByRole<HTMLButtonElement>("button", { name: "Bind Studio" });

    await userEvent.click(bind);
    await userEvent.click(bind);
    expect(actions.confirmRojoHandoff).toHaveBeenCalledTimes(1);

    await act(async () => binding.resolve(false));
    expect(bind.disabled).toBe(false);
    await userEvent.click(bind);
    expect(actions.confirmRojoHandoff).toHaveBeenCalledTimes(2);
  });

  it("clears local warning and handoff state when the exact host tuple or eligibility changes", async () => {
    const warningRuntime = runtime({
      catalog: [row({ warningRequired: true, warningKind: "unknown-place" })],
    });
    const rendered = renderSheet({ runtime: warningRuntime });
    await userEvent.click(screen.getByRole("radio"));
    expect(screen.getByRole<HTMLInputElement>("radio").checked).toBe(true);
    rendered.rerender(
      <ConnectionSheet
        {...rendered.props}
        runtime={{
          ...warningRuntime,
          rojo: { ...warningRuntime.rojo!, generation: 4 },
        }}
      />,
    );
    expect(screen.getByRole<HTMLInputElement>("radio").checked).toBe(false);

    const pendingRuntime = runtime({
      pending: {
        instanceId: "studio-instance-a",
        catalogRevision: 7,
        bindingRevision: 23,
        rojoHandoffRequired: true,
      },
    });
    rendered.rerender(<ConnectionSheet {...rendered.props} runtime={pendingRuntime} />);
    const handoff = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "I connected this Studio window to the Rojo server above",
    });
    await userEvent.click(handoff);
    expect(handoff.checked).toBe(true);
    rendered.rerender(
      <ConnectionSheet
        {...rendered.props}
        runtime={{
          ...pendingRuntime,
          catalog: [row({ eligible: false, eligibilityReason: "stale" })],
          catalogRevision: 8,
        }}
      />,
    );
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", {
        name: "I connected this Studio window to the Rojo server above",
      }).checked,
    ).toBe(false);
  });

  it.each([
    ["project ID", "project"],
    ["Rojo generation", "generation"],
    ["Rojo port", "port"],
    ["broker epoch", "epoch"],
    ["catalog revision", "catalog"],
    ["active project revision", "active-revision"],
    ["active canonical project path", "active-canonical-path"],
    ["active relative project path", "active-relative-path"],
    ["active project digest", "active-digest"],
  ] as const)("clears renderer-local warning state when %s changes", async (_label, change) => {
    const warningRuntime = runtime({
      catalog: [row({ warningRequired: true, warningKind: "unknown-place" })],
    });
    const rendered = renderSheet({ runtime: warningRuntime });
    await userEvent.click(screen.getByRole("radio"));
    expect(screen.getByRole<HTMLInputElement>("radio").checked).toBe(true);
    const nextProject = change === "project" ? { ...rendered.props.project, id: "project-b" } : rendered.props.project;
    let nextRuntime: RuntimeSnapshot = warningRuntime;
    if (change === "generation") {
      nextRuntime = { ...warningRuntime, rojo: { ...warningRuntime.rojo!, generation: 4 } };
    } else if (change === "port") {
      nextRuntime = { ...warningRuntime, rojo: { ...warningRuntime.rojo!, port: 34_873 } };
    } else if (change === "epoch") {
      nextRuntime = {
        ...warningRuntime,
        broker: { ...warningRuntime.broker!, brokerEpoch: "broker-epoch-b" },
      };
    } else if (change === "catalog") {
      nextRuntime = { ...warningRuntime, catalogRevision: 8 };
    } else if (change === "active-revision") {
      nextRuntime = {
        ...warningRuntime,
        activeProject: { ...warningRuntime.activeProject, revision: 5 },
      };
    } else if (change === "active-canonical-path") {
      nextRuntime = {
        ...warningRuntime,
        activeProject: {
          ...warningRuntime.activeProject,
          canonicalProjectFile: "/projects/deepwater/alternate.project.json",
        },
      };
    } else if (change === "active-relative-path") {
      nextRuntime = {
        ...warningRuntime,
        activeProject: {
          ...warningRuntime.activeProject,
          relativeProjectFile: "alternate.project.json",
        },
      };
    } else if (change === "active-digest") {
      nextRuntime = {
        ...warningRuntime,
        activeProject: { ...warningRuntime.activeProject, configDigest: "digest-b" },
      };
    }
    rendered.rerender(<ConnectionSheet {...rendered.props} project={nextProject} runtime={nextRuntime} />);
    expect(screen.getByRole<HTMLInputElement>("radio").checked).toBe(false);
  });

  it.each(["pending instance", "pending revision", "eligibility"] as const)(
    "clears renderer-local handoff state when %s changes",
    async (change) => {
      const pendingRuntime = runtime({
        catalog: [row(), row({ instanceId: "studio-instance-b", placeId: 202, placeName: "Deepwater Beta" })],
        pending: {
          instanceId: "studio-instance-a",
          catalogRevision: 7,
          bindingRevision: 23,
          rojoHandoffRequired: true,
        },
      });
      const rendered = renderSheet({ runtime: pendingRuntime });
      const handoff = screen.getByRole<HTMLInputElement>("checkbox", {
        name: "I connected this Studio window to the Rojo server above",
      });
      await userEvent.click(handoff);
      expect(handoff.checked).toBe(true);
      const nextRuntime: RuntimeSnapshot =
        change === "pending instance"
          ? {
              ...pendingRuntime,
              pending: { ...pendingRuntime.pending!, instanceId: "studio-instance-b" },
            }
          : change === "pending revision"
            ? {
                ...pendingRuntime,
                pending: { ...pendingRuntime.pending!, bindingRevision: 24 },
              }
            : {
                ...pendingRuntime,
                catalog: [
                  row({ eligible: false, eligibilityReason: "stale" }),
                  row({ instanceId: "studio-instance-b", placeId: 202, placeName: "Deepwater Beta" }),
                ],
              };
      rendered.rerender(<ConnectionSheet {...rendered.props} runtime={nextRuntime} />);
      expect(
        screen.getByRole<HTMLInputElement>("checkbox", {
          name: "I connected this Studio window to the Rojo server above",
        }).checked,
      ).toBe(false);
    },
  );

  it("always shows the exact same-published-place limitation before bind", () => {
    renderSheet();
    expect(
      screen.getByText(
        "RbxForge cannot detect or distinguish two Studio edit windows for the same published place. Keep only one such window open before binding.",
      ),
    ).not.toBeNull();
  });
});

describe("ConnectionSheet modal and recovery contract", () => {
  it("uses Connect for a disconnected project and retains Disconnect only as a secondary sheet action", async () => {
    const { actions } = renderSheet({
      runtime: runtime({
        state: "disconnected",
        rojo: undefined,
        broker: undefined,
        catalog: [],
        catalogRevision: undefined,
      }),
    });
    expect(screen.getByRole("button", { name: "Connect" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(actions.reconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps Disconnect as a secondary action inside a connected sheet", async () => {
    const { actions } = renderSheet();
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(actions.disconnect).toHaveBeenCalledTimes(1);
  });

  it("supplies a first-position close control, internal scroll region, sticky footer, and exact focus restoration", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open connection</button>
          <ConnectionSheet
            actions={actionSpies()}
            busy={{}}
            mcpPortChangeAllowed
            onDismiss={() => setOpen(false)}
            open={open}
            pluginInspection={inspection()}
            preferredMcpPort={58_741}
            project={project()}
            restartRecommended={false}
            runtime={runtime()}
          />
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open connection" });
    await userEvent.click(opener);
    const close = screen.getByRole("button", { name: "Close connection setup" });
    expect(document.activeElement).toBe(close);
    const scrollRegion = document.querySelector("[data-sheet-scroll-region='true']");
    const footer = document.querySelector("footer[data-sticky-action-footer='true']");
    expect(scrollRegion).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(scrollRegion?.contains(footer)).toBe(false);
    await userEvent.click(close);
    expect(screen.queryByRole("dialog", { name: "Connection setup" })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("keeps raw instance, broker epoch, generation, and pending revision inside details", () => {
    renderSheet({
      runtime: runtime({
        pending: {
          instanceId: "studio-instance-a",
          catalogRevision: 7,
          bindingRevision: 23,
          rojoHandoffRequired: true,
        },
      }),
    });
    for (const raw of ["studio-instance-a", "broker-epoch-a", "Generation 3", "Revision 23"]) {
      expect(screen.getByText(raw).closest("details")).not.toBeNull();
    }
  });

  it("fails closed on an arbitrary error recovery label and renders only the fixed recovery map", () => {
    const error: DesktopError = {
      layer: "studio",
      code: "unexpected",
      message: "Studio metadata changed.",
      recovery: { action: "erase-everything" as never, label: "Erase everything" },
    };
    renderSheet({ error });
    expect(screen.getByText("Studio metadata changed.")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Erase everything" })).toBeNull();
    expect(within(screen.getByRole("alert")).getByRole("button", { name: "Refresh Studio list" })).not.toBeNull();
  });

  it.each([
    runtime({ state: "studio-selection-required" }),
    runtime({
      state: "rojo-server-ready",
      pending: {
        instanceId: "studio-instance-a",
        catalogRevision: 7,
        bindingRevision: 23,
        rojoHandoffRequired: true,
      },
    }),
  ])("maps same-snapshot selection and handoff failures to refresh/reselect recovery", (failedRuntime) => {
    const error: DesktopError = {
      layer: "app",
      code: "operation-failed",
      message: "The desktop operation could not be completed.",
      recovery: { action: "retry", label: "Retry" },
    };
    renderSheet({ error, runtime: failedRuntime });

    const alert = within(screen.getByRole("alert"));
    expect(alert.getByRole("button", { name: "Refresh Studio list" })).not.toBeNull();
    expect(alert.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });
});
