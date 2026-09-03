<script setup lang="ts">
import { Info, TriangleAlert } from "@lucide/vue";
import { computed } from "vue";
import { useControlStore } from "../store";

const store = useControlStore();
const mutations = computed(() => store.capabilities?.headerMutations ?? []);
</script>

<template>
  <article class="panel warning-panel">
    <div class="risk-row">
      <TriangleAlert :size="22" />
      <div>
        <strong>{{ $t("fidelityUi.title") }}</strong>
        <p>{{ $t("fidelityUi.text") }}</p>
      </div>
    </div>
    <details v-if="mutations.length">
      <summary>
        <Info :size="15" />{{ mutations.length }} {{ $t("fidelityUi.notices") }}
      </summary>
      <ul class="compact-list">
        <li
          v-for="(item, index) in mutations"
          :key="`${item.side}-${item.name}-${index}`"
        >
          <code>{{ item.side }} · {{ item.name }}</code> — {{ item.actor }}
          {{ item.operation }}: {{ item.detail }}
        </li>
      </ul>
    </details>
  </article>
</template>
