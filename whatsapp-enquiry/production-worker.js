// Production-only entry point: inherited staging/development flags cannot enable test captcha paths.
import worker from "./worker.js";
export { EnquiryUsage } from "./worker.js";
export default {
  fetch(request, env) { return worker.fetch(request, { ...env, STAGING: "false", WHATSAPP_DRY_RUN: "false" }); },
};
