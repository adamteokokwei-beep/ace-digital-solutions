// Production cannot inherit the staging access mode or mock provider.
import worker from "./chat-worker.js";
export { ChatUsage } from "./chat-worker.js";
export default {
  fetch(request, env) { return worker.fetch(request, { ...env, STAGING: "false", AI_MOCK: "false" }); },
};
