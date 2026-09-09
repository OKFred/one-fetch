import { createRouter, createWebHashHistory } from "vue-router";
import AlertsView from "./views/AlertsView.vue";
import AuditView from "./views/AuditView.vue";
import BackupView from "./views/BackupView.vue";
import OverviewView from "./views/OverviewView.vue";
import PolicyView from "./views/PolicyView.vue";
import SecurityView from "./views/SecurityView.vue";
import TokensView from "./views/TokensView.vue";

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "overview", component: OverviewView },
    { path: "/security", name: "security", component: SecurityView },
    { path: "/policy", name: "policy", component: PolicyView },
    { path: "/tokens", name: "tokens", component: TokensView },
    { path: "/audit", name: "audit", component: AuditView },
    { path: "/alerts", name: "alerts", component: AlertsView },
    { path: "/backup", name: "backup", component: BackupView },
  ],
});
