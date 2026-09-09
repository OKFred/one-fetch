<script setup lang="ts">
import { Copy, KeyRound, Plus, Trash2 } from "@lucide/vue";
import type { CreatedExecutionTokenV1, TransportV1 } from "@one-fetch/protocol";
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import AuthGate from "../components/AuthGate.vue";
import BaseDialog from "../components/BaseDialog.vue";
import { useControlStore } from "../store";

const emit = defineEmits<{ auth: [] }>();
const store = useControlStore();
const { t } = useI18n();
const creating = ref(false);
const created = ref<CreatedExecutionTokenV1 | null>(null);
const copied = ref(false);
const name = ref("");
const origins = ref("");
const ports = ref("");
const expiresAt = ref("");
const transports = ref<TransportV1[]>(["http"]);
const requestsPerMinute = ref(60);
const burst = ref(10);
const concurrentHttp = ref(4);
const concurrentTunnels = ref(2);
const bytesPerDay = ref(1_073_741_824);

onMounted(async () => {
  if (store.authenticated) await store.loadTokens();
});

function toggleTransport(value: TransportV1): void {
  transports.value = transports.value.includes(value)
    ? transports.value.filter((item) => item !== value)
    : [...transports.value, value];
}

async function create(): Promise<void> {
  const result = await store.createToken({
    schemaVersion: 1,
    name: name.value,
    scope: {
      transports: transports.value,
      origins: origins.value
        .split(/\r?\n/u)
        .map((item) => item.trim())
        .filter(Boolean),
      ports: ports.value
        .split(/[\s,]+/u)
        .filter(Boolean)
        .map(Number),
    },
    quota: {
      requestsPerMinute: requestsPerMinute.value,
      burst: burst.value,
      concurrentHttp: concurrentHttp.value,
      concurrentTunnels: concurrentTunnels.value,
      bytesPerDay: bytesPerDay.value,
    },
    ...(expiresAt.value
      ? { expiresAt: new Date(expiresAt.value).toISOString() }
      : {}),
  });
  if (result) {
    created.value = result;
    creating.value = false;
    name.value = "";
  }
}

async function copyToken(): Promise<void> {
  if (!created.value) return;
  await navigator.clipboard.writeText(created.value.token);
  copied.value = true;
  window.setTimeout(() => (copied.value = false), 1500);
}

async function revoke(id: string): Promise<void> {
  if (confirm(t("tokenUi.revokeConfirm"))) await store.revokeToken(id);
}
</script>

<template>
  <section class="content">
    <AuthGate @auth="$emit('auth')">
      <article class="panel">
        <div class="panel-title">
          <div>
            <h3>{{ $t("tokenUi.title") }}</h3>
            <p>{{ $t("tokenUi.hint") }}</p>
          </div>
          <button class="primary" @click="creating = true">
            <Plus :size="16" />{{ $t("tokenUi.create") }}
          </button>
        </div>
        <div
          v-if="store.features.tokens?.available === false"
          class="unsupported-box"
        >
          {{ store.features.tokens.detail }}
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{{ $t("common.name") }}</th>
                <th>{{ $t("tokenUi.scope") }}</th>
                <th>{{ $t("tokenUi.quota") }}</th>
                <th>{{ $t("tokenUi.created") }}</th>
                <th>{{ $t("common.status") }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="token in store.tokens" :key="token.id">
                <td>
                  <strong>{{ token.name }}</strong
                  ><small class="block">{{ token.id }}</small>
                </td>
                <td>
                  {{ token.scope.transports.join(", ")
                  }}<small class="block"
                    >{{ token.scope.origins.length }} origins ·
                    {{ token.scope.ports.length }} ports</small
                  >
                </td>
                <td>
                  {{ token.quota.requestsPerMinute }} RPM<small class="block"
                    >{{ token.quota.concurrentHttp }} HTTP ·
                    {{ token.quota.concurrentTunnels }} tunnels</small
                  >
                </td>
                <td>{{ new Date(token.createdAt).toLocaleString() }}</td>
                <td>
                  <span :class="['pill', token.revokedAt ? 'deny' : 'allow']">{{
                    token.revokedAt ? "revoked" : "active"
                  }}</span>
                </td>
                <td>
                  <button
                    class="icon-button danger"
                    :disabled="Boolean(token.revokedAt)"
                    @click="revoke(token.id)"
                  >
                    <Trash2 :size="16" />
                  </button>
                </td>
              </tr>
              <tr v-if="store.tokens.length === 0">
                <td colspan="6" class="empty">
                  <KeyRound :size="26" />{{ $t("tokenUi.empty") }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>
    </AuthGate>

    <BaseDialog
      v-if="creating"
      :title="$t('tokenUi.create')"
      eyebrow="LEAST PRIVILEGE"
      @close="creating = false"
    >
      <form @submit.prevent="create">
        <label
          >{{ $t("common.name")
          }}<input v-model="name" required maxlength="128"
        /></label>
        <fieldset>
          <legend>{{ $t("tokenUi.transports") }}</legend>
          <div class="check-grid">
            <label
              v-for="value in [
                'http',
                'websocket',
                'tcp',
                'tls',
              ] as TransportV1[]"
              :key="value"
              class="check-row"
              ><input
                type="checkbox"
                :checked="transports.includes(value)"
                @change="toggleTransport(value)"
              />{{ value }}</label
            >
          </div>
        </fieldset>
        <label
          >{{ $t("tokenUi.origins")
          }}<textarea
            v-model="origins"
            rows="3"
            placeholder="https://api.example.com"
          />
        </label>
        <label
          >{{ $t("tokenUi.ports")
          }}<input v-model="ports" placeholder="443, 8443"
        /></label>
        <div class="form-grid">
          <label
            >Requests/min<input
              v-model.number="requestsPerMinute"
              type="number"
              min="1" /></label
          ><label
            >Burst<input v-model.number="burst" type="number" min="1" /></label
          ><label
            >Concurrent HTTP<input
              v-model.number="concurrentHttp"
              type="number"
              min="0" /></label
          ><label
            >Concurrent tunnels<input
              v-model.number="concurrentTunnels"
              type="number"
              min="0"
          /></label>
        </div>
        <label
          >Bytes/day<input v-model.number="bytesPerDay" type="number" min="1"
        /></label>
        <label
          >{{ $t("tokenUi.expires")
          }}<input v-model="expiresAt" type="datetime-local"
        /></label>
        <div class="dialog-actions">
          <button class="ghost" type="button" @click="creating = false">
            {{ $t("cancel") }}</button
          ><button
            class="primary"
            type="submit"
            :disabled="store.busy || transports.length === 0"
          >
            {{ $t("common.create") }}
          </button>
        </div>
      </form>
    </BaseDialog>

    <BaseDialog
      v-if="created"
      :title="$t('tokenUi.oneTime')"
      eyebrow="SHOWN ONCE"
      @close="created = null"
    >
      <div class="secret-box">
        <code>{{ created.token }}</code
        ><button class="ghost" @click="copyToken">
          <Copy :size="15" />{{ copied ? $t("copied") : $t("copy") }}
        </button>
      </div>
      <p class="inline-warning">{{ $t("tokenUi.oneTimeHint") }}</p>
      <div class="dialog-actions">
        <button class="primary" @click="created = null">
          {{ $t("tokenUi.saved") }}
        </button>
      </div>
    </BaseDialog>
  </section>
</template>
