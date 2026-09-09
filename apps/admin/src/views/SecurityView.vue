<script setup lang="ts">
import {
  Copy,
  KeyRound,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
} from "@lucide/vue";
import QRCode from "qrcode";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import AuthGate from "../components/AuthGate.vue";
import { useControlStore } from "../store";

const emit = defineEmits<{ auth: [] }>();
const store = useControlStore();
const { t } = useI18n();
const qrImage = ref("");
const totpCode = ref("");
const currentPassword = ref("");
const newPassword = ref("");
const confirmPassword = ref("");
const localError = ref("");
const copied = ref<"secret" | "codes" | null>(null);

watch(
  () => store.totpPreparation?.otpauthUri,
  async (uri) => {
    qrImage.value = "";
    if (!uri) return;
    const svg = await QRCode.toString(uri, {
      type: "svg",
      width: 220,
      margin: 1,
      color: { dark: "#07100eff", light: "#f1fffaff" },
    });
    qrImage.value = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  },
  { immediate: true },
);

onMounted(async () => {
  if (store.authenticated) await store.loadSecuritySessions();
});

onBeforeUnmount(() => {
  store.totpPreparation = null;
  store.recoveryCodes = [];
});

async function revokeSession(id: string): Promise<void> {
  if (confirm(t("securityUi.revokeConfirm")))
    await store.revokeSecuritySession(id);
}

async function prepareTotp(): Promise<void> {
  store.recoveryCodes = [];
  await store.prepareTotp();
}

async function enableTotp(): Promise<void> {
  if (!(await store.enableTotp(totpCode.value))) return;
  totpCode.value = "";
}

async function copy(value: string, kind: "secret" | "codes"): Promise<void> {
  await navigator.clipboard.writeText(value);
  copied.value = kind;
  window.setTimeout(() => (copied.value = null), 1500);
}

function dismissRecoveryCodes(): void {
  store.recoveryCodes = [];
}

async function submitPassword(): Promise<void> {
  localError.value = "";
  if (newPassword.value !== confirmPassword.value) {
    localError.value = t("securityUi.mismatch");
    return;
  }
  if (newPassword.value === currentPassword.value) {
    localError.value = t("securityUi.samePassword");
    return;
  }
  if (!(await store.changePassword(currentPassword.value, newPassword.value)))
    return;
  currentPassword.value = "";
  newPassword.value = "";
  confirmPassword.value = "";
}
</script>

<template>
  <section class="content">
    <AuthGate @auth="$emit('auth')">
      <div class="security-grid">
        <article class="panel security-sessions">
          <div class="panel-title">
            <div>
              <h3><Smartphone :size="18" /> {{ $t("securityUi.sessions") }}</h3>
              <p>{{ $t("securityUi.sessionsHint") }}</p>
            </div>
            <button
              class="ghost"
              type="button"
              :disabled="store.busy"
              @click="store.loadSecuritySessions"
            >
              <RefreshCw :size="15" />{{ $t("common.reload") }}
            </button>
          </div>
          <div
            v-if="store.features.sessions?.available === false"
            class="unsupported-box"
          >
            {{ store.features.sessions.detail }}
          </div>
          <div class="session-list">
            <div
              v-for="item in store.securitySessions"
              :key="item.id"
              class="session-row"
            >
              <span :class="['session-icon', { current: item.current }]">
                <Smartphone :size="18" />
              </span>
              <div class="session-main">
                <div class="button-row">
                  <strong>{{ item.deviceFingerprint ?? item.id }}</strong>
                  <span :class="['pill', item.current ? 'allow' : '']">
                    {{
                      item.current
                        ? $t("securityUi.current")
                        : $t("securityUi.active")
                    }}
                  </span>
                </div>
                <dl class="session-facts">
                  <div>
                    <dt>{{ $t("securityUi.created") }}</dt>
                    <dd>{{ new Date(item.createdAt).toLocaleString() }}</dd>
                  </div>
                  <div>
                    <dt>{{ $t("securityUi.lastSeen") }}</dt>
                    <dd>{{ new Date(item.lastSeenAt).toLocaleString() }}</dd>
                  </div>
                  <div>
                    <dt>{{ $t("securityUi.expires") }}</dt>
                    <dd>{{ new Date(item.expiresAt).toLocaleString() }}</dd>
                  </div>
                </dl>
              </div>
              <button
                class="ghost danger"
                type="button"
                :disabled="item.current || store.busy"
                @click="revokeSession(item.id)"
              >
                <Trash2 :size="15" />{{ $t("securityUi.revoke") }}
              </button>
            </div>
            <p v-if="store.securitySessions.length === 0" class="empty">
              {{ $t("securityUi.noSessions") }}
            </p>
          </div>
        </article>

        <article class="panel">
          <h3><ShieldCheck :size="18" /> {{ $t("securityUi.totp") }}</h3>
          <p>{{ $t("securityUi.totpHint") }}</p>
          <div
            v-if="store.features.totp?.available === false"
            class="unsupported-box"
          >
            {{ store.features.totp.detail }}
          </div>
          <button
            v-if="!store.totpPreparation && store.recoveryCodes.length === 0"
            class="primary"
            type="button"
            :disabled="store.busy"
            @click="prepareTotp"
          >
            <KeyRound :size="16" />{{ $t("securityUi.prepareTotp") }}
          </button>
          <div v-if="store.totpPreparation" class="totp-setup">
            <strong>{{ $t("securityUi.scan") }}</strong>
            <img v-if="qrImage" :src="qrImage" alt="TOTP setup QR code" />
            <label>
              {{ $t("securityUi.manualSecret") }}
              <span class="secret-inline">
                <code>{{ store.totpPreparation.secret }}</code>
                <button
                  class="icon-button"
                  type="button"
                  :aria-label="$t('copy')"
                  @click="copy(store.totpPreparation.secret, 'secret')"
                >
                  <Copy :size="15" />
                </button>
              </span>
            </label>
            <form class="stack-form" @submit.prevent="enableTotp">
              <label>
                {{ $t("securityUi.verificationCode") }}
                <input
                  v-model="totpCode"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  pattern="[0-9]{6}|[0-9]{8}"
                  required
                />
              </label>
              <button class="primary" :disabled="store.busy" type="submit">
                {{ $t("securityUi.enableTotp") }}
              </button>
            </form>
          </div>
          <div v-if="store.recoveryCodes.length" class="recovery-box">
            <h4>{{ $t("securityUi.recoveryTitle") }}</h4>
            <p>{{ $t("securityUi.recoveryHint") }}</p>
            <code v-for="code in store.recoveryCodes" :key="code">{{
              code
            }}</code>
            <div class="button-row">
              <button
                class="ghost"
                type="button"
                @click="copy(store.recoveryCodes.join('\n'), 'codes')"
              >
                <Copy :size="15" />
                {{
                  copied === "codes" ? $t("copied") : $t("securityUi.copyCodes")
                }}
              </button>
              <button
                class="primary"
                type="button"
                @click="dismissRecoveryCodes"
              >
                {{ $t("securityUi.savedCodes") }}
              </button>
            </div>
          </div>
        </article>

        <article class="panel password-panel">
          <h3><LockKeyhole :size="18" /> {{ $t("securityUi.password") }}</h3>
          <p>{{ $t("securityUi.passwordHint") }}</p>
          <div
            v-if="store.features['password-change']?.available === false"
            class="unsupported-box"
          >
            {{ store.features["password-change"].detail }}
          </div>
          <form class="password-form" @submit.prevent="submitPassword">
            <label>
              {{ $t("securityUi.currentPassword") }}
              <input
                v-model="currentPassword"
                type="password"
                autocomplete="current-password"
                required
              />
            </label>
            <label>
              {{ $t("securityUi.newPassword") }}
              <input
                v-model="newPassword"
                type="password"
                autocomplete="new-password"
                minlength="12"
                required
              />
            </label>
            <label>
              {{ $t("securityUi.confirmPassword") }}
              <input
                v-model="confirmPassword"
                type="password"
                autocomplete="new-password"
                minlength="12"
                required
              />
            </label>
            <p v-if="localError" class="field-error">{{ localError }}</p>
            <button class="primary" type="submit" :disabled="store.busy">
              {{ $t("securityUi.changePassword") }}
            </button>
          </form>
        </article>
      </div>
    </AuthGate>
  </section>
</template>
