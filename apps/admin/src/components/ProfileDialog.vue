<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useControlStore } from "../store";
import BaseDialog from "./BaseDialog.vue";

const emit = defineEmits<{ close: [] }>();
const store = useControlStore();
const { t } = useI18n();
const editingId = ref<string | undefined>(store.profile?.id);
const name = ref(store.profile?.name ?? "Local one-fetch");
const controlUrl = ref(store.profile?.controlUrl ?? "http://127.0.0.1:8787");
const localError = ref("");
const canDelete = computed(() => editingId.value !== undefined);

watch(editingId, (id) => {
  const profile = store.profiles.find((item) => item.id === id);
  name.value = profile?.name ?? "";
  controlUrl.value = profile?.controlUrl ?? "";
});

async function save(): Promise<void> {
  try {
    store.saveProfile({
      ...(editingId.value ? { id: editingId.value } : {}),
      name: name.value,
      controlUrl: controlUrl.value,
    });
    await store.initialize();
    emit("close");
  } catch (cause) {
    localError.value = cause instanceof Error ? cause.message : String(cause);
  }
}

function createNew(): void {
  editingId.value = undefined;
  name.value = "";
  controlUrl.value = "";
}

function remove(): void {
  if (!editingId.value || !confirm(t("profileUi.removeConfirm"))) return;
  store.deleteProfile(editingId.value);
  createNew();
}
</script>

<template>
  <BaseDialog
    :title="$t('profileUi.title')"
    :eyebrow="$t('profileUi.eyebrow')"
    @close="$emit('close')"
  >
    <div v-if="store.profiles.length" class="profile-tabs">
      <button
        v-for="item in store.profiles"
        :key="item.id"
        type="button"
        :class="{ active: editingId === item.id }"
        @click="editingId = item.id"
      >
        {{ item.name }}
      </button>
      <button type="button" :class="{ active: !editingId }" @click="createNew">
        {{ $t("profileUi.new") }}
      </button>
    </div>
    <form @submit.prevent="save">
      <label
        >{{ $t("common.name")
        }}<input v-model="name" autocomplete="off" required maxlength="80"
      /></label>
      <label
        >{{ $t("profileUi.url")
        }}<input v-model="controlUrl" type="url" required
      /></label>
      <p class="hint">{{ $t("profileUi.hint") }}</p>
      <p v-if="localError" class="field-error">{{ localError }}</p>
      <div class="dialog-actions spread">
        <button
          v-if="canDelete"
          class="danger ghost"
          type="button"
          @click="remove"
        >
          {{ $t("profileUi.remove") }}
        </button>
        <span v-else></span>
        <div class="button-row">
          <button class="ghost" type="button" @click="$emit('close')">
            {{ $t("cancel") }}
          </button>
          <button class="primary" type="submit">{{ $t("connect") }}</button>
        </div>
      </div>
    </form>
  </BaseDialog>
</template>
