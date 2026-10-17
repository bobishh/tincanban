import type { AutomationObservation } from "../domain/automationProtocol"
import type { LocalProfile } from "../domain/identity"
import { parseApplicationReviewReceipt, type ApplicationRetryReceipt } from "../domain/applicationReviewData"
import { observeAutomation, readAutomationEmail, retryAutomationEmail, type AutomationEmailSetup } from "./automationClient"
import { discoverApplicationReview, readApplicationReviewMailbox, UnsupportedApplicationReviewError,
  retryUnboundApplicationReview, type ApplicationReviewClientGuards } from "./applicationReviewClient"

export type AutomationMailboxInput = {
  origin: string
  workspaceId: string
  definitionId: string
  personId: string
  grantId: string
}
type AutomationMailboxSetup = Omit<AutomationEmailSetup, "receipt"> & {
  receipt: Omit<AutomationEmailSetup["receipt"], "events"> & {
    events: Array<AutomationEmailSetup["receipt"]["events"][number] & { bindingId?: string }>
  }
}
export type AutomationMailbox = {
  setup: AutomationMailboxSetup
  observation: AutomationObservation
  integrationId: string
}

/** Read signed mailbox state when supported, falling back only for an explicit capability absence. */
export async function readAutomationMailbox(profileValue: LocalProfile, inputValue: AutomationMailboxInput,
  guards?: ApplicationReviewClientGuards): Promise<AutomationMailbox> {
  const profile = structuredClone(profileValue)
  const input = structuredClone(inputValue)
  const guard = guards ? { ...guards } : undefined
  await guard?.ensureCurrent?.()
  const supported = await readSupportedMailbox(profile, input, guard)
  if (supported) return supported
  return readLegacyMailbox(profile, input, guard)
}

/** Retry a retained unbound event on its discovered route; only explicit feature absence allows the older path. */
export async function retryUnboundAutomationMailbox(profileValue: LocalProfile,
  inputValue: AutomationMailboxInput & { eventId: string }, guards?: ApplicationReviewClientGuards): Promise<ApplicationRetryReceipt> {
  const profile = structuredClone(profileValue)
  const input = structuredClone(inputValue)
  const guard = guards ? { ...guards } : undefined
  await guard?.ensureCurrent?.()
  const supported = await retrySupportedRoute(profile, input, guard)
  if (supported) return supported
  await guard?.ensureCurrent?.()
  const legacyValue = await retryAutomationEmail(profile, { origin: input.origin, integrationId: input.definitionId,
    workspaceId: input.workspaceId }, input.eventId)
  await guard?.ensureCurrent?.()
  const receipt = parseApplicationReviewReceipt("retry", legacyValue)
  if (receipt.eventId !== input.eventId) throw new Error("Processing receipt belongs to another saved message")
  return receipt
}

async function retrySupportedRoute(profile: LocalProfile, input: AutomationMailboxInput & { eventId: string },
  guard?: ApplicationReviewClientGuards): Promise<ApplicationRetryReceipt | undefined> {
  let route
  try {
    route = await discoverApplicationReview(profile, { origin: input.origin, workspaceId: input.workspaceId,
      definitionId: input.definitionId, personId: input.personId }, guard)
  } catch (error) {
    if (error instanceof UnsupportedApplicationReviewError) return undefined
    throw error
  }
  await guard?.ensureCurrent?.()
  let receipt: ApplicationRetryReceipt
  try {
    receipt = await retryUnboundApplicationReview(profile, { origin: input.origin, workspaceId: input.workspaceId,
      definitionId: input.definitionId, integrationId: route.integrationId, eventId: input.eventId }, guard)
  } catch (error) {
    if (error instanceof UnsupportedApplicationReviewError) return undefined
    throw error
  }
  await guard?.ensureCurrent?.()
  if (receipt.eventId !== input.eventId) throw new Error("Worker retry receipt belongs to another saved event")
  return structuredClone(receipt)
}

async function readSupportedMailbox(profile: LocalProfile, input: AutomationMailboxInput,
  guard?: ApplicationReviewClientGuards): Promise<AutomationMailbox | undefined> {
  let route: { integrationId: string; personId: string } | undefined
  try {
    route = await discoverApplicationReview(profile, { origin: input.origin, workspaceId: input.workspaceId,
      definitionId: input.definitionId, personId: input.personId }, guard)
  } catch (error) { if (!(error instanceof UnsupportedApplicationReviewError)) throw error }
  if (route) {
    await guard?.ensureCurrent?.()
    let mailbox
    try {
      mailbox = await readApplicationReviewMailbox(profile, { origin: input.origin, workspaceId: input.workspaceId,
        definitionId: input.definitionId, integrationId: route.integrationId, personId: input.personId, grantId: input.grantId }, guard)
    } catch (error) { if (!(error instanceof UnsupportedApplicationReviewError)) throw error }
    if (mailbox) {
      await guard?.ensureCurrent?.()
      return { integrationId: route.integrationId, observation: mailbox.verifiedObservation,
        setup: { route: mailbox.route, receipt: { ...mailbox.receipt,
          events: mailbox.receipt.events.map(event => ({ ...event })) } } }
    }
  }
  return undefined
}

async function readLegacyMailbox(profile: LocalProfile, input: AutomationMailboxInput,
  guard?: ApplicationReviewClientGuards): Promise<AutomationMailbox> {
  await guard?.ensureCurrent?.()
  const observation = await observeAutomation(profile, { origin: input.origin, workspaceId: input.workspaceId,
    personId: input.personId, grantId: input.grantId, integrationId: input.definitionId })
  await guard?.ensureCurrent?.()
  const setup = await readAutomationEmail(profile, { origin: input.origin, workspaceId: input.workspaceId,
    integrationId: input.definitionId })
  await guard?.ensureCurrent?.()
  return { integrationId: input.definitionId, observation, setup: structuredClone(setup) }
}
