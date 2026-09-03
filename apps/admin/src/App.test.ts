import { mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import {
  createMemoryHistory,
  createRouter,
  type RouteRecordRaw,
} from "vue-router";
import { beforeEach, describe, expect, it } from "vitest";
import App from "./App.vue";

const names = ["overview", "policy", "tokens", "audit", "alerts", "backup"];
const routes: RouteRecordRaw[] = names.map((name, index) => ({
  path: index === 0 ? "/" : `/${name}`,
  name,
  component: { template: `<div>${name}</div>` },
}));

describe("admin shell", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("opens the instance dialog when no profile exists", async () => {
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push("/");
    await router.isReady();
    const wrapper = mount(App, {
      global: {
        plugins: [
          createPinia(),
          createI18n({
            legacy: false,
            locale: "en",
            messages: {
              en: {
                ...Object.fromEntries(names.map((name) => [name, name])),
                product: "one-fetch",
                preview: "Preview",
                connect: "Connect",
                disconnected: "Disconnected",
                refresh: "Refresh",
                signIn: "Sign in",
                cancel: "Cancel",
                common: { name: "Name" },
                profileUi: {
                  title: "Instance profiles",
                  eyebrow: "CONTROL ORIGIN",
                  new: "+ New",
                  url: "Control URL",
                  hint: "Profile hint",
                  remove: "Delete profile",
                },
              },
            },
          }),
          router,
        ],
      },
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("Instance profiles");
    expect(wrapper.text()).toContain("Control URL");
  });
});
