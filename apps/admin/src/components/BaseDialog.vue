<script setup lang="ts">
defineProps<{ title: string; eyebrow?: string }>();
defineEmits<{ close: [] }>();
</script>

<template>
  <div class="overlay" @click.self="$emit('close')">
    <section class="dialog" role="dialog" aria-modal="true" :aria-label="title">
      <p v-if="eyebrow" class="eyebrow">{{ eyebrow }}</p>
      <div class="dialog-heading">
        <h2>{{ title }}</h2>
        <button
          class="icon-button"
          type="button"
          aria-label="Close"
          @click="$emit('close')"
        >
          ×
        </button>
      </div>
      <slot />
    </section>
  </div>
</template>
