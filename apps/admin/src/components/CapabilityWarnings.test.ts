import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import CapabilityWarnings from "./CapabilityWarnings.vue";

const state = vi.hoisted(() => ({
  capabilities: {
    headerMutations: [],
    transports: {
      http: {
        detail:
          "Requires negotiated supabaseOriginalPathV1; unsupported ingress rewrites are rejected.",
      },
    },
  },
}));
vi.mock("../store", () => ({ useControlStore: () => state }));

describe("capability warnings", () => {
  it("shows the HTTP compatibility requirement even without header notices", () => {
    const wrapper = mount(CapabilityWarnings, {
      global: { mocks: { $t: (key: string) => key } },
    });
    expect(wrapper.get('[role="note"]').text()).toContain(
      "supabaseOriginalPathV1",
    );
    expect(wrapper.text()).toContain("unsupported ingress rewrites");
    wrapper.unmount();
  });
});
