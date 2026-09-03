<script setup lang="ts">
import { ArchiveRestore, DatabaseBackup, Upload } from "@lucide/vue";
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import AuthGate from "../components/AuthGate.vue";
import { useControlStore } from "../store";

interface BackupRow {
  id: string;
  createdAt: string;
  status: string;
  bytes?: number;
}

const emit = defineEmits<{ auth: [] }>();
const store = useControlStore();
const { t } = useI18n();
const backups = ref<BackupRow[]>([]);
const restoreFile = ref<File | null>(null);

function parseBackups(value: unknown): BackupRow[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && "backups" in value
      ? (value as { backups?: unknown }).backups
      : [];
  if (!Array.isArray(list)) return [];
  return list.flatMap((item, index) => {
    if (typeof item !== "object" || item === null) return [];
    const row = item as Record<string, unknown>;
    return [
      {
        id: String(row.id ?? index),
        createdAt: String(row.createdAt ?? ""),
        status: String(row.status ?? "unknown"),
        ...(typeof row.bytes === "number" ? { bytes: row.bytes } : {}),
      },
    ];
  });
}

async function load(): Promise<void> {
  backups.value = parseBackups(
    await store.invokeFeature("backup", "/api/v1/backups"),
  );
}

async function createBackup(): Promise<void> {
  const result = await store.invokeFeature("backup", "/api/v1/backups", {
    method: "POST",
  });
  if (result !== null) await load();
}

function chooseFile(event: Event): void {
  restoreFile.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

async function restore(): Promise<void> {
  if (!restoreFile.value) return;
  const source = await restoreFile.value.text();
  const document: unknown = JSON.parse(source);
  if (!confirm(t("backupUi.confirm"))) return;
  const result = await store.invokeFeature(
    "backup",
    "/api/v1/backups/restore",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(document),
    },
  );
  if (result !== null) {
    restoreFile.value = null;
    await store.refreshPublic();
    await load();
  }
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
          <h3><DatabaseBackup :size="18" /> {{ $t("backupUi.create") }}</h3>
          <p>{{ $t("backupUi.createHint") }}</p>
          <button class="primary" :disabled="store.busy" @click="createBackup">
            {{ $t("backupUi.serverCreate") }}
          </button>
          <div
            v-if="store.features.backup?.available === false"
            class="unsupported-box"
          >
            {{ store.features.backup.detail }}
          </div>
          <div class="event-list">
            <div v-for="item in backups" :key="item.id" class="event-row">
              <ArchiveRestore :size="18" />
              <div>
                <strong>{{ item.id }}</strong
                ><small
                  >{{
                    item.createdAt
                      ? new Date(item.createdAt).toLocaleString()
                      : "—"
                  }}
                  · {{ item.status
                  }}<template v-if="item.bytes">
                    · {{ item.bytes.toLocaleString() }} bytes</template
                  ></small
                >
              </div>
            </div>
            <p v-if="backups.length === 0" class="empty">
              {{ $t("backupUi.empty") }}
            </p>
          </div>
        </article>
        <article class="panel">
          <h3><Upload :size="18" /> {{ $t("backupUi.restore") }}</h3>
          <p>{{ $t("backupUi.restoreHint") }}</p>
          <label class="file-picker"
            >{{ $t("backupUi.choose")
            }}<input
              type="file"
              accept="application/json,.json"
              @change="chooseFile"
          /></label>
          <p v-if="restoreFile" class="hint">
            Selected: {{ restoreFile.name }} ·
            {{ restoreFile.size.toLocaleString() }} bytes
          </p>
          <button
            class="danger primary"
            :disabled="!restoreFile || store.busy"
            @click="restore"
          >
            {{ $t("backupUi.review") }}
          </button>
        </article>
      </div>
    </AuthGate>
  </section>
</template>
