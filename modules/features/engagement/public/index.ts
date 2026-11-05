import { defineAuditAction, defineAuditPurpose } from "@community-hub/kernel/module";

defineAuditAction("engagement.service_times.saved");
defineAuditPurpose("engagement.service_times.saved");

export { sanitiseServiceTimesHtml } from "../domain/sanitise.js";
export { ServiceTimesError, type ServiceTimesErrorCode } from "../domain/error.js";
export {
  toPublicServiceTimes,
  PUBLIC_SERVICE_TIMES_COLUMNS,
  type PublicServiceTimes,
} from "../domain/projection.js";
export {
  getServiceTimes,
  saveServiceTimes,
  getPublishedServiceTimes,
  type ServiceTimesRecord,
  type SaveServiceTimesInput,
} from "../infrastructure/service-times.js";
