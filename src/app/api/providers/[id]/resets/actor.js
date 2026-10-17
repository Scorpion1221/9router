// Identity the dashboard uses with the ops reset flow (src/lib/ops/resets.js).
// prepare/confirm bind a pending reset to the caller, so a dashboard prepare can
// only be confirmed from the dashboard and a 9r token can't confirm it (and back).
export const DASHBOARD_RESET_ACTOR = Object.freeze({ id: "dashboard", name: "dashboard" });
