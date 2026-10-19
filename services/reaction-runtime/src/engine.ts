export const engineCapabilities = { email: 1 } as const;

export { createParticipant } from "./participant";
export { handleAutomationInstanceApi } from "../../../workers/automation/src/automationInstanceApi";
export { handleApplicationReviewApi } from "../../../workers/automation/src/applicationReviewApi";
export { handleOwnerApi } from "../../../workers/automation/src/ownerApi";
