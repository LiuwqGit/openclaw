// Control UI tests cover the agents identity editor avatar rendering.
import { render } from "lit";
import { expect, it, vi } from "vitest";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createAgentViewTestProps as createProps,
  createIdentityAvatarLoader,
} from "./agents-view.test-helpers.ts";
import { renderAgents } from "./view.ts";

const identityWithAvatar = {
  beta: { agentId: "beta", name: "Fetched Beta", avatar: "/avatar/beta", emoji: "" },
};

it("fetches a persisted identity avatar with the bearer credential when token auth is active", async () => {
  const createObjectURL = vi.fn(() => "blob:agent-avatar");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    },
  );
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    blob: async () => new Blob(["avatar"], { type: "image/png" }),
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  setAvatarGatewayOrigin(globalThis.location.origin, ["tok"]);

  const container = document.createElement("div");
  // The loader re-renders through its host once the blob URL settles.
  const state: { props?: ReturnType<typeof createProps> } = {};
  const props = createProps({
    agentIdentityById: identityWithAvatar,
    identityAvatarLoader: createIdentityAvatarLoader(() => {
      if (state.props) {
        render(renderAgents(state.props), container);
      }
    }),
  });
  state.props = props;
  render(renderAgents(props), container);

  try {
    // The text fallback renders while the authenticated fetch is in flight.
    expect(container.querySelector(".agent-identity-editor__avatar img")).toBeNull();
    expect(container.querySelector(".agent-identity-editor__avatar-text")?.textContent).toBe("F");
    expect(fetchMock).toHaveBeenCalledWith(`${globalThis.location.origin}/avatar/beta`, {
      credentials: "include",
      headers: { Authorization: "Bearer tok" },
      signal: expect.any(AbortSignal),
    });

    await waitForFast(() => {
      expect(
        container
          .querySelector<HTMLImageElement>(".agent-identity-editor__avatar img")
          ?.getAttribute("src"),
      ).toBe("blob:agent-avatar");
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  } finally {
    setAvatarGatewayOrigin(null);
    vi.unstubAllGlobals();
  }
});

it("renders the in-progress upload preview directly without an authenticated fetch", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  setAvatarGatewayOrigin(globalThis.location.origin, ["tok"]);

  const container = document.createElement("div");
  const preview = "data:image/png;base64,cmVwbGFjZW1lbnQ=";
  render(
    renderAgents(
      createProps({
        identityDraft: { name: null, emoji: null, avatar: preview },
        agentIdentityById: identityWithAvatar,
      }),
    ),
    container,
  );

  try {
    expect(
      container
        .querySelector<HTMLImageElement>(".agent-identity-editor__avatar img")
        ?.getAttribute("src"),
    ).toBe(preview);
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    setAvatarGatewayOrigin(null);
    vi.unstubAllGlobals();
  }
});

it("falls back to the identity initial when the authenticated avatar cannot load", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: false,
    status: 404,
    blob: async () => new Blob([], { type: "image/png" }),
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  setAvatarGatewayOrigin(globalThis.location.origin, ["tok"]);

  const container = document.createElement("div");
  render(
    renderAgents(
      createProps({
        agentIdentityById: identityWithAvatar,
      }),
    ),
    container,
  );

  try {
    await waitForFast(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(container.querySelector(".agent-identity-editor__avatar img")).toBeNull();
    expect(container.querySelector(".agent-identity-editor__avatar-text")?.textContent).toBe("F");
  } finally {
    setAvatarGatewayOrigin(null);
    vi.unstubAllGlobals();
  }
});

it("keeps a broken persisted avatar on its text fallback", async () => {
  const container = document.createElement("div");
  // The loader re-renders through its host once the blob URL settles.
  const state: { props?: ReturnType<typeof createProps> } = {};
  const props = createProps({
    agentIdentityById: identityWithAvatar,
    identityAvatarLoader: createIdentityAvatarLoader(() => {
      if (state.props) {
        render(renderAgents(state.props), container);
      }
    }),
  });
  state.props = props;
  render(renderAgents(props), container);

  const image = container.querySelector<HTMLImageElement>(".agent-identity-editor__avatar img");
  expect(image?.getAttribute("src")).toBe("/avatar/beta");
  image?.dispatchEvent(new Event("error"));
  await waitForFast(() => {
    expect(container.querySelector(".agent-identity-editor__avatar img")).toBeNull();
  });
  expect(container.querySelector(".agent-identity-editor__avatar-text")?.textContent).toBe("F");
});
