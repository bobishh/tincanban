export type ParticipantRequest = {
  operation: "reaction" | "tick";
  epoch: number; body?: unknown;
  traceparent?: string;
};
export interface ParticipantRuntime {
  call(integrationId: string, request: ParticipantRequest): Promise<unknown>;
}
