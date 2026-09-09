<script setup lang="ts">
import { ref } from "vue";
import { parseRuleDraft, type PolicyRuleDraft } from "../control/policy-ui";
import BaseDialog from "./BaseDialog.vue";

const props = defineProps<{ rule: PolicyRuleDraft | undefined }>();
const emit = defineEmits<{ close: []; save: [rule: PolicyRuleDraft] }>();
const id = ref(props.rule?.id ?? `rule-${crypto.randomUUID()}`);
const name = ref(props.rule?.name ?? "");
const action = ref<"allow" | "deny">(props.rule?.action ?? "deny");
const enabled = ref(props.rule?.enabled ?? true);
const match = ref(JSON.stringify(props.rule?.match ?? {}, null, 2));
const error = ref("");

function save(): void {
  try {
    const rule = parseRuleDraft({
      id: id.value.trim(),
      name: name.value.trim(),
      action: action.value,
      enabled: enabled.value,
      match: JSON.parse(match.value) as unknown,
    });
    emit("save", rule);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
</script>

<template>
  <BaseDialog
    :title="rule ? 'Edit rule' : $t('policyUi.add')"
    eyebrow="POLICY RULE"
    @close="$emit('close')"
  >
    <form @submit.prevent="save">
      <label>Rule ID<input v-model="id" required maxlength="128" /></label>
      <label
        >{{ $t("common.name") }}<input v-model="name" required maxlength="256"
      /></label>
      <div class="form-grid">
        <label
          >Action<select v-model="action">
            <option value="deny">Deny</option>
            <option value="allow">Allow</option>
          </select></label
        >
        <label class="check-row align-end"
          ><input v-model="enabled" type="checkbox" />Enabled</label
        >
      </div>
      <label
        >Match object<textarea
          v-model="match"
          class="code-editor"
          rows="12"
          spellcheck="false"
          required
        />
      </label>
      <p class="hint">
        The complete Request Policy V1 match model is accepted: transport,
        method, origin, path, query, headers, body, fetch options, redirect and
        tunnel fields.
      </p>
      <p v-if="error" class="field-error">{{ error }}</p>
      <div class="dialog-actions">
        <button class="ghost" type="button" @click="$emit('close')">
          {{ $t("cancel") }}</button
        ><button class="primary" type="submit">{{ $t("save") }}</button>
      </div>
    </form>
  </BaseDialog>
</template>
