<script setup lang="ts">
import { BellRing, Send, Webhook } from "@lucide/vue";
import { onMounted, ref } from "vue";
import AuthGate from "../components/AuthGate.vue";
import { useControlStore } from "../store";

interface AlertRow {
  id: string;
  occurredAt: string;
  severity: string;
  type: string;
  summary: string;
}

interface WebhookRow {
  id: string;
  url: string;
  enabled: boolean;
  lastDeliveryAt?: string;
}

const emit = defineEmits<{ auth: [] }>();
const store = useControlStore();
const alerts = ref<AlertRow[]>([]);
const webhooks = ref<WebhookRow[]>([]);
const url = ref("");
const secret = ref("");

function records(value: unknown, key: string): Record<string, unknown>[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && key in value
      ? (value as Record<string, unknown>)[key]
      : [];
  return Array.isArray(list)
    ? list.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null,
      )
    : [];
}

async function load(): Promise<void> {
  const [alertPayload, webhookPayload] = await Promise.all([
    store.invokeFeature("alerts", "/api/v1/alerts?limit=50"),
    store.invokeFeature("webhooks", "/api/v1/webhooks"),
  ]);
  alerts.value = records(alertPayload, "events").map((item, index) => ({
    id: String(item.alertId ?? item.id ?? index),
    occurredAt: String(item.occurredAt ?? ""),
    severity: String(item.severity ?? "unknown"),
    type: String(item.type ?? "unknown"),
    summary: String(item.summary ?? ""),
  }));
  webhooks.value = records(webhookPayload, "webhooks").map((item, index) => ({
    id: String(item.id ?? index),
    url: String(item.url ?? ""),
    enabled: item.enabled === true,
    ...(typeof item.lastDeliveryAt === "string"
      ? { lastDeliveryAt: item.lastDeliveryAt }
      : {}),
  }));
}

async function addWebhook(): Promise<void> {
  const result = await store.invokeFeature("webhooks", "/api/v1/webhooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: url.value,
      secret: secret.value,
      enabled: true,
    }),
  });
  secret.value = "";
  if (result !== null) await load();
}

async function testWebhook(id: string): Promise<void> {
  await store.invokeFeature(
    "webhooks",
    `/api/v1/webhooks/${encodeURIComponent(id)}/test`,
    { method: "POST" },
  );
}

onMounted(async () => {
  if (store.authenticated) await load();
});
</script>

<template>
  <section class="content">
    <AuthGate @auth="$emit('auth')">
      <div class="grid-two">
        <article class="panel">
          <div class="panel-title">
            <div>
              <h3><BellRing :size="18" /> {{ $t("alertUi.title") }}</h3>
              <p>{{ $t("alertUi.hint") }}</p>
            </div>
            <button
              class="ghost"
              :disabled="
                store.busy ||
                (store.features.alerts?.available === false &&
                  store.features.webhooks?.available === false)
              "
              @click="load"
            >
              {{ $t("common.reload") }}
            </button>
          </div>
          <div
            v-if="store.features.alerts?.available === false"
            class="unsupported-box"
          >
            {{ store.features.alerts.detail }}
          </div>
          <div class="event-list">
            <div v-for="alert in alerts" :key="alert.id" class="event-row">
              <span
                :class="['pill', alert.severity === 'critical' ? 'deny' : '']"
                >{{ alert.severity }}</span
              >
              <div>
                <strong>{{ alert.type }}</strong>
                <p>{{ alert.summary }}</p>
                <small>{{
                  alert.occurredAt
                    ? new Date(alert.occurredAt).toLocaleString()
                    : "—"
                }}</small>
              </div>
            </div>
            <p v-if="alerts.length === 0" class="empty">
              {{ $t("alertUi.empty") }}
            </p>
          </div>
        </article>
        <article class="panel">
          <h3><Webhook :size="18" /> {{ $t("alertUi.webhook") }}</h3>
          <p>{{ $t("alertUi.webhookHint") }}</p>
          <div
            v-if="store.features.webhooks?.available === false"
            class="unsupported-box"
          >
            {{ store.features.webhooks.detail }}
          </div>
          <form class="stack-form" @submit.prevent="addWebhook">
            <label
              >{{ $t("alertUi.endpoint")
              }}<input
                v-model="url"
                type="url"
                :disabled="store.features.webhooks?.available === false"
                required
                placeholder="https://alerts.example.com/one-fetch" /></label
            ><label
              >{{ $t("alertUi.secret")
              }}<input
                v-model="secret"
                type="password"
                :disabled="store.features.webhooks?.available === false"
                minlength="32"
                autocomplete="new-password"
                required /></label
            ><button
              class="primary"
              :disabled="
                store.busy || store.features.webhooks?.available === false
              "
            >
              {{ $t("alertUi.add") }}
            </button>
          </form>
          <div class="event-list">
            <div v-for="item in webhooks" :key="item.id" class="event-row">
              <span :class="['status-dot', item.enabled ? 'ok' : '']"></span>
              <div>
                <strong>{{ item.url }}</strong
                ><small>{{ item.lastDeliveryAt ?? "—" }}</small>
              </div>
              <button
                class="ghost"
                :disabled="
                  store.busy || store.features.webhooks?.available === false
                "
                @click="testWebhook(item.id)"
              >
                <Send :size="14" />{{ $t("alertUi.test") }}
              </button>
            </div>
          </div>
        </article>
      </div>
    </AuthGate>
  </section>
</template>
