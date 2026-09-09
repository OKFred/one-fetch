<script setup lang="ts">
import { LogOut, RefreshCw } from "@lucide/vue";
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { useControlStore } from "../store";

defineEmits<{ auth: [] }>();
const store = useControlStore();
const route = useRoute();
const { locale, t } = useI18n();
const title = computed(() => t(String(route.name ?? "overview")));
</script>

<template>
  <header>
    <div>
      <p class="eyebrow">CONTROL PLANE</p>
      <h1>{{ title }}</h1>
    </div>
    <div class="header-actions">
      <button
        class="ghost"
        type="button"
        @click="locale = locale === 'en' ? 'zh-CN' : 'en'"
      >
        {{ locale === "en" ? "中文" : "EN" }}
      </button>
      <button
        class="ghost"
        type="button"
        :disabled="store.busy || !store.profile"
        @click="store.refreshPublic"
      >
        <RefreshCw :size="16" />{{ t("refresh") }}
      </button>
      <button
        v-if="!store.authenticated"
        class="primary"
        type="button"
        :disabled="!store.profile"
        @click="$emit('auth')"
      >
        {{ t("signIn") }}
      </button>
      <button v-else class="ghost" type="button" @click="store.logout">
        <LogOut :size="16" />{{ t("signOut") }}
      </button>
    </div>
  </header>
</template>
