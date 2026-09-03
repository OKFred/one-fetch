<script setup lang="ts">
import { LockKeyhole } from "@lucide/vue";
import { useControlStore } from "../store";

defineEmits<{ auth: [] }>();
const store = useControlStore();
</script>

<template>
  <slot v-if="store.authenticated" />
  <section v-else class="panel placeholder">
    <LockKeyhole :size="42" />
    <h2>{{ $t("signIn") }}</h2>
    <p>{{ $t("authenticate") }}</p>
    <button
      class="primary"
      type="button"
      :disabled="!store.profile"
      @click="$emit('auth')"
    >
      {{ $t("signIn") }}
    </button>
  </section>
</template>
