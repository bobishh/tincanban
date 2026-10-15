import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { appendApplicationBinding, initializeApplicationBindingStorage, readApplicationBinding,
  readApplicationBindingAudit, readApplicationBindingHistory, appendApplicationBindingAppliedAudit } from "../src/applicationBindingStore";

const bindingNamespace = (env as unknown as { AUTOMATION: { getByName(name: string): unknown } }).AUTOMATION;

function input(eventId: string, overrides: Partial<Parameters<typeof appendApplicationBinding>[1]> = {}) {
  return {
    bindingId: crypto.randomUUID(),
    eventId,
    previousBindingId: null,
    proofHash: "A".repeat(43),
    encryptedRecord: `encrypted-${crypto.randomUUID()}`,
    createdAt: Date.now(),
    ...overrides,
  };
}

async function withStorage<T>(run: (storage: Parameters<typeof initializeApplicationBindingStorage>[0]) => Promise<T>) {
  const stub = bindingNamespace.getByName(`application-binding-${crypto.randomUUID()}`);
  return runInDurableObject(stub as never, async (_instance, state) => {
    await initializeApplicationBindingStorage(state.storage);
    return run(state.storage);
  }) as Promise<T>;
}

describe("durable application binding store", () => {
  it("Given a current binding and confirmed signed change, When recording delivery twice, Then audit once and reject another hash or stale head", async () => {
    await withStorage(async storage => {
      const first = input("event_abcdefghijklmnopqrst");
      const action = { bindingId: first.bindingId, eventId: first.eventId, changeHash: "a".repeat(64), createdAt: Date.now() };
      expect(() => appendApplicationBindingAppliedAudit(storage, action)).toThrow(/stale/);
      await appendApplicationBinding(storage, first);
      appendApplicationBindingAppliedAudit(storage, action);
      appendApplicationBindingAppliedAudit(storage, action);
      expect(readApplicationBindingAudit(storage, first.eventId).map(row => row.kind)).toEqual(["saved", "applied"]);
      expect(() => appendApplicationBindingAppliedAudit(storage, { ...action, changeHash: "b".repeat(64) })).toThrow(/different/);
      await appendApplicationBinding(storage, input(first.eventId, { previousBindingId: first.bindingId }));
      expect(() => appendApplicationBindingAppliedAudit(storage, action)).toThrow(/stale/);
    });
  });

  it("Given retained binding and saved audit, When SQL tries to rewrite or delete either, Then preserve immutable evidence", async () => {
    await withStorage(async storage => {
      const value = input("event_abcdefghijklmnopqrst");
      await appendApplicationBinding(storage, value);
      for (const query of ["UPDATE application_bindings SET encrypted_record = 'replacement'", "DELETE FROM application_bindings",
        "UPDATE application_binding_audit SET created_at = 1", "DELETE FROM application_binding_audit"]) {
        expect(() => storage.sql.exec(query)).toThrow(/immutable/);
      }
      expect(readApplicationBindingHistory(storage, value.eventId)).toHaveLength(1);
      expect(readApplicationBindingAudit(storage, value.eventId)).toHaveLength(1);
    });
  });
  it("Given a first binding and exact retry, When the retry has different ciphertext but same proof, Then original durable record and one audit remain", async () => {
    await withStorage(async storage => {
      const original = input("event_abcdefghijklmnopqrst");
      await expect(appendApplicationBinding(storage, original)).resolves.toEqual({ duplicate: false });
      await expect(appendApplicationBinding(storage, { ...original, encryptedRecord: "different ciphertext" }))
        .resolves.toEqual({ duplicate: true });

      expect(await readApplicationBinding(storage, original.eventId)).toMatchObject({
        bindingId: original.bindingId, eventId: original.eventId, proofHash: original.proofHash,
        encryptedRecord: original.encryptedRecord, previousBindingId: null,
      });
      expect(await readApplicationBindingHistory(storage, original.eventId)).toHaveLength(1);
      expect(await readApplicationBindingAudit(storage, original.eventId)).toEqual([
        { bindingId: original.bindingId, eventId: original.eventId, kind: "saved", createdAt: original.createdAt },
      ]);
    });
  });

  it("Given an existing binding ID, When its hash, event or parent is rebound, Then reject without altering stored history", async () => {
    await withStorage(async storage => {
      const original = input("event_abcdefghijklmnopqrst");
      await appendApplicationBinding(storage, original);
      for (const changed of [
        { ...original, proofHash: "B".repeat(43) },
        { ...original, eventId: "event_zyxwvutsrqponmlkjihg" },
        { ...original, previousBindingId: crypto.randomUUID() },
      ]) {
        await expect(appendApplicationBinding(storage, changed)).rejects.toThrow();
      }
      expect(await readApplicationBindingHistory(storage, original.eventId)).toHaveLength(1);
      expect(await readApplicationBindingAudit(storage, original.eventId)).toHaveLength(1);
    });
  });

  it("Given a current event binding, When an owner appends a correction, Then retain append-only history and advance the current head", async () => {
    await withStorage(async storage => {
      const first = input("event_abcdefghijklmnopqrst");
      const second = input(first.eventId, { previousBindingId: first.bindingId });
      await appendApplicationBinding(storage, first);
      await appendApplicationBinding(storage, second);

      expect(await readApplicationBinding(storage, first.eventId)).toMatchObject({ bindingId: second.bindingId,
        previousBindingId: first.bindingId, proofHash: second.proofHash });
      expect((await readApplicationBindingHistory(storage, first.eventId)).map(row => row.bindingId))
        .toEqual([first.bindingId, second.bindingId]);
      expect((await readApplicationBindingAudit(storage, first.eventId)).map(row => row.bindingId))
        .toEqual([first.bindingId, second.bindingId]);
    });
  });

  it("Given a stale or concurrent parent, When a correction is appended, Then reject and preserve the winning chain", async () => {
    await withStorage(async storage => {
      const first = input("event_abcdefghijklmnopqrst");
      const winner = input(first.eventId, { previousBindingId: first.bindingId });
      const stale = input(first.eventId, { previousBindingId: first.bindingId });
      await appendApplicationBinding(storage, first);
      await appendApplicationBinding(storage, winner);
      await expect(appendApplicationBinding(storage, stale)).rejects.toThrow();
      expect((await readApplicationBindingHistory(storage, first.eventId)).map(row => row.bindingId))
        .toEqual([first.bindingId, winner.bindingId]);
      expect((await readApplicationBindingAudit(storage, first.eventId))).toHaveLength(2);
    });
  });

  it("Given a parent binding for another event, When used for a correction, Then reject without creating the second event", async () => {
    await withStorage(async storage => {
      const first = input("event_abcdefghijklmnopqrst");
      const foreign = input("event_zyxwvutsrqponmlkjihg", { previousBindingId: first.bindingId });
      await appendApplicationBinding(storage, first);
      await expect(appendApplicationBinding(storage, foreign)).rejects.toThrow();
      expect(await readApplicationBinding(storage, foreign.eventId)).toBeNull();
      expect(await readApplicationBindingHistory(storage, foreign.eventId)).toEqual([]);
      expect(await readApplicationBindingAudit(storage, foreign.eventId)).toEqual([]);
    });
  });

  it("Given an audit insert failure, When a binding transaction is attempted, Then head, history and audit all roll back", async () => {
    await withStorage(async storage => {
      const value = input("event_abcdefghijklmnopqrst");
      storage.sql.exec(`CREATE TRIGGER fail_application_binding_audit
        BEFORE INSERT ON application_binding_audit BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`);
      await expect(appendApplicationBinding(storage, value)).rejects.toThrow();
      storage.sql.exec("DROP TRIGGER fail_application_binding_audit");
      expect(await readApplicationBinding(storage, value.eventId)).toBeNull();
      expect(await readApplicationBindingHistory(storage, value.eventId)).toEqual([]);
      expect(await readApplicationBindingAudit(storage, value.eventId)).toEqual([]);
    });
  });

  it("Given committed bindings and a fresh Durable Object handle, When reading storage again, Then complete history and current head survive restart-like reload", async () => {
    const id = `application-binding-${crypto.randomUUID()}`;
    const first = input("event_abcdefghijklmnopqrst");
    const second = input(first.eventId, { previousBindingId: first.bindingId });
    const stub = bindingNamespace.getByName(id);
    await runInDurableObject(stub as never, async (_instance, state) => {
      await initializeApplicationBindingStorage(state.storage);
      await appendApplicationBinding(state.storage, first);
      await appendApplicationBinding(state.storage, second);
    });
    await runInDurableObject(bindingNamespace.getByName(id) as never, async (_instance, state) => {
      await initializeApplicationBindingStorage(state.storage);
      expect(await readApplicationBinding(state.storage, first.eventId)).toMatchObject({ bindingId: second.bindingId });
      expect((await readApplicationBindingHistory(state.storage, first.eventId)).map(row => row.bindingId))
        .toEqual([first.bindingId, second.bindingId]);
      expect((await readApplicationBindingAudit(state.storage, first.eventId))).toHaveLength(2);
    });
  });
});
