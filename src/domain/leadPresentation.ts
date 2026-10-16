import type { Item } from "./model"
import type { Lead, LeadPriority, LeadStatus } from "../types"

export type LeadPresentationBindings = {
  columnStatuses: Record<string, LeadStatus>;
  fieldNames: Record<string, string>;
  optionValues: Record<string, string>;
};

export function leadPresentationBindings(bindings: Record<string, string>): LeadPresentationBindings {
  const result: LeadPresentationBindings = {
    columnStatuses: {},
    fieldNames: {},
    optionValues: {},
  };
  for (const [key, id] of Object.entries(bindings)) {
    if (key.startsWith("status."))
      result.columnStatuses[id] = key.slice("status.".length) as LeadStatus;
    if (key.startsWith("field."))
      result.fieldNames[id] = key.slice("field.".length);
    if (key.startsWith("option."))
      result.optionValues[id] = key.split(".").at(-1) ?? "";
  }
  return result;
}

function splitTitle(title: string): { company: string; role: string } {
  if (!title.includes(" — ")) return { company: title, role: "" };
  const [company, ...role] = title.split(" — ");
  return { company, role: role.join(" — ") };
}

function workMode(value: unknown): Lead["workMode"] {
  return ["remote", "hybrid", "onsite", "unknown"].includes(String(value))
    ? (String(value) as Lead["workMode"])
    : undefined;
}

function priority(value: unknown): LeadPriority | undefined {
  return ["p0", "p1", "p2", "p3"].includes(String(value))
    ? (String(value) as LeadPriority)
    : undefined;
}

function applyLeadValue(lead: Lead, fieldName: string, value: unknown): void {
  if (fieldName === "company") lead.company = String(value);
  else if (fieldName === "role") lead.role = String(value);
  else if (fieldName === "url") lead.url = String(value);
  else if (fieldName === "location") lead.location = String(value);
  else if (fieldName === "notes") lead.notes = String(value);
  else if (fieldName === "sourceText") lead.sourceText = String(value);
  else if (fieldName === "rejectionReason")
    lead.rejectionReason = String(value);
  else if (fieldName === "fitScore") lead.fitScore = Number(value);
  else if (fieldName === "workMode") lead.workMode = workMode(value);
  else if (fieldName === "priority") lead.priority = priority(value);
}

export function presentLead(item: Item, status: LeadStatus, bindings: LeadPresentationBindings): Lead {
  const lead: Lead = { id: item.id, ...splitTitle(item.title), status, description: item.body,
    createdAt: item.createdAt, updatedAt: item.updatedAt }
  for (const [fieldId, value] of Object.entries(item.values)) {
    const name = bindings.fieldNames[fieldId]
    if (name && value !== null) applyLeadValue(lead, name, bindings.optionValues[String(value)] ?? value)
  }
  return lead
}
