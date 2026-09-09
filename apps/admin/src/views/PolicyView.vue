<script setup lang="ts">
import { FilePlus2, Pencil, ShieldAlert, Trash2 } from "@lucide/vue";
import { computed, onMounted, ref, shallowRef, watch } from "vue";
import AuthGate from "../components/AuthGate.vue";
import RuleDialog from "../components/RuleDialog.vue";
import {
  parsePolicyDraft,
  type PolicyDraft,
  type PolicyRuleDraft,
} from "../control/policy-ui";
import {
  cloneRecommendedRules,
  RECOMMENDED_GLOBAL_BLOCKLIST,
} from "../control/recommended-policy";
import { useControlStore } from "../store";

const emit = defineEmits<{ auth: [] }>();
const store = useControlStore();
const draft = shallowRef<PolicyDraft | null>(null);
const editingIndex = ref<number | null>(null);
const showTemplate = ref(false);

watch(
  () => store.configuration?.policy,
  (policy) => {
    if (policy) draft.value = parsePolicyDraft(policy);
  },
  { immediate: true },
);

const dirty = computed(
  () =>
    JSON.stringify(draft.value) !== JSON.stringify(store.configuration?.policy),
);

onMounted(async () => {
  if (store.authenticated && !store.configuration)
    await store.loadConfiguration();
});

function addRecommended(): void {
  if (!draft.value) return;
  const current: PolicyDraft = structuredClone(draft.value);
  const identifiers = new Set<string>();
  for (const rule of current.rules) identifiers.add(rule.id);
  current.rules = current.rules.concat(cloneRecommendedRules(identifiers));
  draft.value = current;
  showTemplate.value = false;
}

function saveRule(rule: PolicyRuleDraft): void {
  if (!draft.value) return;
  const next = structuredClone(draft.value);
  if (editingIndex.value === -1) next.rules.push(rule);
  else if (editingIndex.value !== null) next.rules[editingIndex.value] = rule;
  draft.value = next;
  editingIndex.value = null;
}

function removeRule(index: number): void {
  if (!draft.value) return;
  const next = structuredClone(draft.value);
  next.rules.splice(index, 1);
  draft.value = next;
}

function setMode(event: Event): void {
  if (!draft.value) return;
  draft.value = {
    ...draft.value,
    mode: (event.target as HTMLSelectElement).value as
      | "allowlist"
      | "blocklist",
  };
}

function setEnabled(index: number, enabled: boolean): void {
  if (!draft.value) return;
  const next = structuredClone(draft.value);
  const rule = next.rules[index];
  if (rule) rule.enabled = enabled;
  draft.value = next;
}
</script>

<template>
  <section class="content">
    <AuthGate @auth="$emit('auth')">
      <div v-if="draft" class="stack">
        <article class="panel policy-head">
          <div>
            <p class="eyebrow">
              CONFIGURATION {{ store.configuration?.version }}
            </p>
            <h2>{{ $t("policyUi.title") }}</h2>
            <p>{{ $t("policyUi.order") }}</p>
          </div>
          <div class="policy-actions">
            <label
              >{{ $t("policyUi.mode")
              }}<select :value="draft.mode" @change="setMode">
                <option value="allowlist">Allowlist</option>
                <option value="blocklist">Blocklist</option>
              </select></label
            ><button
              class="primary"
              :disabled="!dirty || store.busy"
              @click="store.savePolicy(draft)"
            >
              {{ $t("policyUi.publish") }}
            </button>
          </div>
        </article>
        <div class="inline-warning">
          <ShieldAlert :size="18" /><span
            ><strong>{{
              draft.mode === "allowlist"
                ? $t("policyUi.allowlistEmpty")
                : $t("policyUi.blocklistOpen")
            }}</strong>
            {{ $t("policyUi.inspection") }}</span
          >
        </div>
        <article class="panel">
          <div class="panel-title">
            <div>
              <h3>{{ $t("policyUi.rules") }}</h3>
              <p>{{ draft.rules.length }} · revision {{ draft.revision }}</p>
            </div>
            <div class="button-row">
              <button class="ghost" @click="showTemplate = true">
                {{ $t("policyUi.template") }}</button
              ><button class="primary" @click="editingIndex = -1">
                <FilePlus2 :size="16" />{{ $t("policyUi.add") }}
              </button>
            </div>
          </div>
          <div class="rule-list">
            <div
              v-for="(rule, index) in draft.rules"
              :key="rule.id"
              class="rule-row"
            >
              <input
                :checked="rule.enabled"
                type="checkbox"
                :aria-label="`Enable ${rule.name}`"
                @change="
                  setEnabled(index, ($event.target as HTMLInputElement).checked)
                "
              />
              <span
                :class="['pill', rule.action === 'deny' ? 'deny' : 'allow']"
                >{{ rule.action }}</span
              >
              <div>
                <strong>{{ rule.name }}</strong
                ><small
                  >{{ rule.id }} ·
                  {{
                    Object.keys(rule.match).join(", ") ||
                    "matches every request"
                  }}</small
                >
              </div>
              <button
                class="icon-button"
                title="Edit"
                @click="editingIndex = index"
              >
                <Pencil :size="16" />
              </button>
              <button
                class="icon-button danger"
                title="Delete"
                @click="removeRule(index)"
              >
                <Trash2 :size="16" />
              </button>
            </div>
            <div v-if="draft.rules.length === 0" class="empty">
              {{ $t("policyUi.empty") }}
            </div>
          </div>
        </article>
      </div>
    </AuthGate>
    <RuleDialog
      v-if="editingIndex !== null"
      :rule="editingIndex >= 0 ? draft?.rules[editingIndex] : undefined"
      @save="saveRule"
      @close="editingIndex = null"
    />
    <div v-if="showTemplate" class="overlay" @click.self="showTemplate = false">
      <section class="dialog wide-dialog">
        <p class="eyebrow">OPTIONAL STARTING POINT</p>
        <h2>{{ $t("policyUi.templateTitle") }}</h2>
        <p class="hint">{{ $t("policyUi.templateHint") }}</p>
        <ul class="compact-list">
          <li v-for="rule in RECOMMENDED_GLOBAL_BLOCKLIST" :key="rule.id">
            <strong>{{ rule.name }}</strong
            ><code>{{ JSON.stringify(rule.match) }}</code>
          </li>
        </ul>
        <div class="dialog-actions">
          <button class="ghost" @click="showTemplate = false">
            {{ $t("cancel") }}</button
          ><button class="primary" @click="addRecommended">
            {{ $t("policyUi.apply") }}
          </button>
        </div>
      </section>
    </div>
  </section>
</template>
