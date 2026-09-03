<script setup lang="ts">
import { computed, ref } from "vue";
import { useControlStore } from "../store";
import BaseDialog from "./BaseDialog.vue";

const emit = defineEmits<{ close: [] }>();
const store = useControlStore();
const username = ref("");
const password = ref("");
const totpCode = ref("");
const recoveryCode = ref("");
const bootstrapSecret = ref("");
const rememberDevice = ref(false);
const recoveryMode = ref(false);
const needsBootstrap = computed(() => store.bootstrap?.initialized === false);

async function submit(): Promise<void> {
  const ok = needsBootstrap.value
    ? await store.createAdministrator({
        bootstrapSecret: bootstrapSecret.value,
        username: username.value,
        password: password.value,
      })
    : await store.login({
        username: username.value,
        password: password.value,
        rememberDevice: rememberDevice.value,
        ...(recoveryMode.value && recoveryCode.value
          ? { recoveryCode: recoveryCode.value }
          : {}),
        ...(!recoveryMode.value && totpCode.value
          ? { totpCode: totpCode.value }
          : {}),
      });
  password.value = "";
  bootstrapSecret.value = "";
  if (ok) emit("close");
}
</script>

<template>
  <BaseDialog
    :title="
      needsBootstrap ? $t('authUi.bootstrapTitle') : $t('authUi.loginTitle')
    "
    :eyebrow="needsBootstrap ? 'ONE-TIME BOOTSTRAP' : 'CONTROL AUTHENTICATION'"
    @close="$emit('close')"
  >
    <form @submit.prevent="submit">
      <label v-if="needsBootstrap"
        >{{ $t("authUi.bootstrapSecret")
        }}<input
          v-model="bootstrapSecret"
          type="password"
          autocomplete="off"
          minlength="32"
          required
      /></label>
      <label
        >{{ $t("authUi.username")
        }}<input v-model="username" autocomplete="username" required
      /></label>
      <label
        >{{ $t("authUi.password")
        }}<input
          v-model="password"
          type="password"
          :autocomplete="needsBootstrap ? 'new-password' : 'current-password'"
          :minlength="needsBootstrap ? 12 : 1"
          required
      /></label>
      <template v-if="!needsBootstrap">
        <label v-if="!recoveryMode"
          >{{ $t("authUi.totp")
          }}<input
            v-model="totpCode"
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9]{6}|[0-9]{8}"
        /></label>
        <label v-else
          >{{ $t("authUi.recovery")
          }}<input
            v-model="recoveryCode"
            autocomplete="one-time-code"
            minlength="8"
        /></label>
        <button
          class="link-button"
          type="button"
          @click="recoveryMode = !recoveryMode"
        >
          {{ recoveryMode ? $t("authUi.useTotp") : $t("authUi.useRecovery") }}
        </button>
        <label class="check-row"
          ><input v-model="rememberDevice" type="checkbox" />{{
            $t("authUi.remember")
          }}</label
        >
        <p class="hint">{{ $t("authUi.storageHint") }}</p>
      </template>
      <p v-if="store.error" class="field-error">{{ store.error }}</p>
      <div class="dialog-actions">
        <button class="ghost" type="button" @click="$emit('close')">
          {{ $t("cancel") }}
        </button>
        <button class="primary" type="submit" :disabled="store.busy">
          {{ needsBootstrap ? $t("authUi.bootstrap") : $t("signIn") }}
        </button>
      </div>
    </form>
  </BaseDialog>
</template>
