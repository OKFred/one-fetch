<script setup lang="ts">
import { Clock3, Pause, Play, ShieldCheck } from "@lucide/vue";
import { computed } from "vue";
import CapabilityWarnings from "../components/CapabilityWarnings.vue";
import { useControlStore } from "../store";

const emit = defineEmits<{ auth: [] }>();
const store = useControlStore();
const emptyAllowlist = computed(
  () =>
    store.capabilities?.policyMode === "allowlist" &&
    (store.configuration?.policy.rules.length ?? 0) === 0,
);
const configDate = computed(() => {
  const value =
    store.configuration?.updatedAt ?? store.capabilities?.configUpdatedAt;
  return value ? new Date(value).toLocaleString() : "—";
});
</script>

<template>
  <section class="content">
    <div class="hero-card">
      <div>
        <p class="eyebrow">{{ $t("overviewUi.eyebrow") }}</p>
        <h2>{{ $t("overviewUi.title") }}</h2>
        <p>{{ $t("overviewUi.subtitle") }}</p>
      </div>
      <ShieldCheck :size="72" />
    </div>
    <div v-if="emptyAllowlist" class="inline-warning">
      <ShieldCheck :size="18" />{{ $t("overviewUi.empty") }}
    </div>
    <div class="metrics">
      <article>
        <span>{{ $t("overviewUi.adapter") }}</span
        ><strong>{{ store.capabilities?.provider ?? "—" }}</strong
        ><small>{{ store.capabilities?.buildVersion ?? "—" }}</small>
      </article>
      <article>
        <span>{{ $t("overviewUi.configuration") }}</span
        ><strong class="version-text">{{
          store.configuration?.version ??
          store.capabilities?.configVersion ??
          "—"
        }}</strong
        ><small>{{ configDate }}</small>
      </article>
      <article>
        <span>{{ $t("overviewUi.policy") }}</span
        ><strong>{{
          store.configuration?.policy.mode ??
          store.capabilities?.policyMode ??
          "allowlist"
        }}</strong
        ><small>{{ store.configuration?.policy.rules.length ?? 0 }}</small>
      </article>
      <article>
        <span>{{ $t("overviewUi.audit") }}</span
        ><strong>{{ store.capabilities?.audit.state ?? "unknown" }}</strong
        ><small>30d · 180d · 400d</small>
      </article>
    </div>
    <div class="grid-two">
      <article class="panel">
        <h3>{{ $t("overviewUi.gateway") }}</h3>
        <div class="risk-row">
          <component :is="store.configuration?.gatewayPaused ? Pause : Play" />
          <div>
            <strong>{{
              store.configuration?.gatewayPaused
                ? $t("overviewUi.paused")
                : $t("overviewUi.available")
            }}</strong>
            <p>{{ $t("overviewUi.failClosed") }}</p>
          </div>
        </div>
        <div v-if="store.authenticated" class="button-row panel-actions">
          <button
            class="ghost"
            :disabled="store.busy"
            @click="store.setGatewayPaused(!store.configuration?.gatewayPaused)"
          >
            {{
              store.configuration?.gatewayPaused
                ? $t("overviewUi.resume")
                : $t("overviewUi.pause")
            }}
          </button>
          <small v-if="store.features['gateway-pause']?.available === false">{{
            store.features["gateway-pause"]?.detail
          }}</small>
        </div>
        <button v-else class="ghost panel-actions" @click="$emit('auth')">
          {{ $t("signIn") }}
        </button>
      </article>
      <article class="panel">
        <h3><Clock3 :size="18" /> {{ $t("overviewUi.timing") }}</h3>
        <p>{{ $t("overviewUi.timingText") }}</p>
      </article>
    </div>
    <CapabilityWarnings />
  </section>
</template>
