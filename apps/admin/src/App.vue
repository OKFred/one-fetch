<script setup lang="ts">
import { onMounted, ref } from "vue";
import AppHeader from "./components/AppHeader.vue";
import AppSidebar from "./components/AppSidebar.vue";
import AuthDialog from "./components/AuthDialog.vue";
import ProfileDialog from "./components/ProfileDialog.vue";
import { useControlStore } from "./store";

const store = useControlStore();
const profileOpen = ref(false);
const authOpen = ref(false);

onMounted(async () => {
  if (!store.profile) {
    profileOpen.value = true;
    return;
  }
  await store.initialize();
  if (store.bootstrap?.initialized === false) authOpen.value = true;
});
</script>

<template>
  <div class="shell">
    <AppSidebar @profile="profileOpen = true" />
    <main>
      <AppHeader @auth="authOpen = true" />
      <div v-if="store.error && !authOpen" class="alert error">
        {{ store.error }}
      </div>
      <div v-if="store.notice" class="alert success">{{ store.notice }}</div>
      <RouterView v-slot="{ Component }"
        ><component :is="Component" @auth="authOpen = true"
      /></RouterView>
    </main>
    <ProfileDialog v-if="profileOpen" @close="profileOpen = false" />
    <AuthDialog v-if="authOpen" @close="authOpen = false" />
  </div>
</template>
