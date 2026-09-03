<script setup lang="ts">
import {
  Activity,
  ArchiveRestore,
  BellRing,
  BookOpenCheck,
  KeyRound,
  ServerCog,
  ShieldCheck,
} from "@lucide/vue";
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useControlStore, type ControlPage } from "../store";

defineEmits<{ profile: [] }>();
const store = useControlStore();
const route = useRoute();
const router = useRouter();
const { t } = useI18n();

const items = computed(() => [
  { id: "overview" as const, path: "/", label: t("overview"), icon: Activity },
  {
    id: "policy" as const,
    path: "/policy",
    label: t("policy"),
    icon: ShieldCheck,
  },
  {
    id: "tokens" as const,
    path: "/tokens",
    label: t("tokens"),
    icon: KeyRound,
  },
  {
    id: "audit" as const,
    path: "/audit",
    label: t("audit"),
    icon: BookOpenCheck,
  },
  {
    id: "alerts" as const,
    path: "/alerts",
    label: t("alerts"),
    icon: BellRing,
  },
  {
    id: "backup" as const,
    path: "/backup",
    label: t("backup"),
    icon: ArchiveRestore,
  },
]);

const current = computed(() => (route.name ?? "overview") as ControlPage);

async function selectProfile(event: Event): Promise<void> {
  store.selectProfile((event.target as HTMLSelectElement).value);
  await store.initialize();
  await router.push("/");
}
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-mark"><ServerCog :size="22" /></div>
      <div>
        <strong>{{ t("product") }}</strong
        ><span>{{ t("preview") }}</span>
      </div>
    </div>
    <nav aria-label="Primary navigation">
      <RouterLink
        v-for="item in items"
        :key="item.id"
        :to="item.path"
        :class="{ active: current === item.id }"
      >
        <component :is="item.icon" :size="18" /><span>{{ item.label }}</span>
      </RouterLink>
    </nav>
    <div class="sidebar-foot">
      <select
        v-if="store.profiles.length > 1"
        class="profile-select"
        :value="store.activeProfileId ?? ''"
        aria-label="Active instance"
        @change="selectProfile"
      >
        <option v-for="item in store.profiles" :key="item.id" :value="item.id">
          {{ item.name }}
        </option>
      </select>
      <button class="instance" type="button" @click="$emit('profile')">
        <span :class="['status-dot', store.connected ? 'ok' : '']"></span>
        <span
          ><strong>{{ store.profile?.name ?? t("connect") }}</strong
          ><small>{{
            store.capabilities?.provider ?? t("disconnected")
          }}</small></span
        >
      </button>
    </div>
  </aside>
</template>
