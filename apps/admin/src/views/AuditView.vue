<script setup lang="ts">
import { Download, FileCheck2, RefreshCw } from "@lucide/vue";
import { onMounted } from "vue";
import AuthGate from "../components/AuthGate.vue";
import { useControlStore } from "../store";

const emit = defineEmits<{ auth: [] }>();
const store = useControlStore();

onMounted(async () => {
  if (store.authenticated) await store.loadAudit();
});

async function downloadExport(): Promise<void> {
  const blob = await store.exportAudit();
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `one-fetch-audit-${new Date().toISOString().replaceAll(":", "-")}.jsonl`;
  anchor.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <section class="content">
    <AuthGate @auth="$emit('auth')">
      <article class="panel table-panel">
        <div class="panel-title">
          <div>
            <h3>{{ $t("auditUi.title") }}</h3>
            <p>{{ $t("auditUi.hint") }}</p>
          </div>
          <div class="button-row">
            <button
              class="ghost"
              :disabled="store.busy"
              @click="store.loadAudit()"
            >
              <RefreshCw :size="15" />{{ $t("common.reload") }}</button
            ><button
              class="ghost"
              :disabled="store.busy"
              @click="downloadExport"
            >
              <Download :size="15" />{{ $t("auditUi.export") }}
            </button>
          </div>
        </div>
        <div
          v-if="store.features['audit-export']?.available === false"
          class="unsupported-box"
        >
          {{ $t("auditUi.exportMissing") }}
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{{ $t("common.time") }}</th>
                <th>Category</th>
                <th>Action</th>
                <th>Outcome</th>
                <th>Actor</th>
                <th>Correlation</th>
                <th>Integrity</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="event in store.audit.events" :key="event.eventId">
                <td>{{ new Date(event.occurredAt).toLocaleString() }}</td>
                <td>{{ event.category }}</td>
                <td>{{ event.action }}</td>
                <td>
                  <span
                    :class="[
                      'pill',
                      event.outcome === 'success' ? 'allow' : 'deny',
                    ]"
                    >{{ event.outcome }}</span
                  >
                </td>
                <td>
                  {{ event.actor.type
                  }}<small class="block">{{
                    event.actor.actorId ?? "—"
                  }}</small>
                </td>
                <td>
                  {{
                    event.correlation.requestId ??
                    event.correlation.configVersion ??
                    "—"
                  }}
                </td>
                <td><FileCheck2 :size="16" /> {{ event.integrity.keyId }}</td>
              </tr>
              <tr v-if="store.audit.events.length === 0">
                <td colspan="7" class="empty">{{ $t("auditUi.empty") }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="pager">
          <span>{{ store.audit.events.length }}</span
          ><button
            v-if="store.audit.nextCursor"
            class="ghost"
            :disabled="store.busy"
            @click="store.loadAudit(store.audit.nextCursor)"
          >
            {{ $t("auditUi.older") }}
          </button>
        </div>
      </article>
    </AuthGate>
  </section>
</template>
