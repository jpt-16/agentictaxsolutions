import { describe, expect, it } from "vitest";
import { detectEntity, normalizeText, resolveEntity, type EntityRef } from "./entities";

const E = (id: string, code: string, name: string): EntityRef => ({ id, code, name });
const DE = E("de", "NWG", "Northwind GmbH"), FR = E("fr", "NWF", "Northwind France SAS"), UK = E("uk", "NWU", "Northwind UK Ltd."), US = E("us", "NWA", "Northwind America Inc.");
const ALL = [DE, FR, UK, US];

describe("detectEntity", () => {
  it("finds an entity by name, ignoring legal forms, case, accents and punctuation", () => {
    expect(detectEntity(ALL, ["Trial balance – NORTHWIND GMBH – 31 Dec"]).entity).toEqual(DE);
    expect(detectEntity(ALL, ["Northwind-France_TB_2025.xlsx"]).entity).toEqual(FR);
    expect(normalizeText("Société Générale, S.A.")).toBe("societe generale s a");
  });
  it("prefers the longer name when one entity's name is part of another's", () => {
    const a = E("a", "AAA", "Acme"), b = E("b", "ACF", "Acme France SAS");
    expect(detectEntity([a, b], ["Acme France trial balance"]).entity).toEqual(b);
    expect(detectEntity([a, b], ["Acme trial balance"]).entity).toEqual(a);
  });
  it("matches a code only as a whole word of three or more characters", () => {
    expect(detectEntity(ALL, ["TB NWU Q4"]).entity).toEqual(UK);
    expect(detectEntity(ALL, ["NWUX report"]).entity).toBeNull();
    expect(detectEntity([E("x", "AG", "Zeta")], ["AG report"]).entity).toBeNull();
  });
  it("names no entity when several are named equally well, and says which", () => {
    const r = detectEntity(ALL, ["Northwind France and Northwind UK combined"]);
    expect(r.entity).toBeNull();
    expect(r.ambiguous.map((e) => e.code).sort()).toEqual(["NWF", "NWU"]);
  });
  it("does not treat a brand shared by every entity as naming one of them", () => {
    expect(detectEntity(ALL, ["Northwind consolidated trial balance"]).entity).toBeNull();
    expect(detectEntity(ALL, ["Northwind GmbH trial balance"]).entity).toEqual(DE);
  });
  it("handles empty input", () => {
    expect(detectEntity(ALL, []).entity).toBeNull();
    expect(detectEntity([], ["Northwind GmbH"]).entity).toBeNull();
    expect(detectEntity(ALL, ["", "   "]).entity).toBeNull();
  });
});

describe("resolveEntity", () => {
  it("trusts the file when it names an entity that the request was sent to", () => {
    const r = resolveEntity({ entities: ALL, assignedEntityIds: ["de", "fr"], uploaderEntityId: "de", texts: ["Northwind France SAS"] });
    expect(r.status).toBe("suggested");
    expect(r.suggestion).toMatchObject({ source: "file", entity: FR });
    expect(r.note).toMatch(/uploader belongs to/);
  });
  it("is a conflict when the file names an entity the request was not sent to", () => {
    const r = resolveEntity({ entities: ALL, assignedEntityIds: ["de"], uploaderEntityId: "de", texts: ["Northwind UK Ltd"] });
    expect(r.status).toBe("conflict");
    expect(r.detected).toEqual(UK);
    expect(r.note).toMatch(/sent to Northwind GmbH/);
  });
  it("falls back to a request sent to exactly one entity", () => {
    const r = resolveEntity({ entities: ALL, assignedEntityIds: ["uk"], uploaderEntityId: null, texts: ["tb.xlsx"] });
    expect(r).toMatchObject({ status: "suggested", suggestion: { source: "assignment", entity: UK } });
  });
  it("then falls back to the uploader's entity", () => {
    const r = resolveEntity({ entities: ALL, assignedEntityIds: ["de", "uk"], uploaderEntityId: "uk", texts: ["tb.xlsx"] });
    expect(r).toMatchObject({ status: "suggested", suggestion: { source: "uploader", entity: UK } });
    expect(resolveEntity({ entities: ALL, assignedEntityIds: [], uploaderEntityId: "us", texts: [] }).suggestion?.entity).toEqual(US);
  });
  it("does not use an uploader whose entity the request was not sent to", () => {
    const r = resolveEntity({ entities: ALL, assignedEntityIds: ["de", "fr"], uploaderEntityId: "us", texts: ["tb.xlsx"] });
    expect(r.status).toBe("unknown");
    expect(r.suggestion).toBeNull();
  });
  it("is unknown when there is no evidence at all", () => {
    expect(resolveEntity({ entities: ALL, assignedEntityIds: [], uploaderEntityId: null, texts: [] }).status).toBe("unknown");
  });
  it("ignores ids that are not in the tenant's entity list", () => {
    const r = resolveEntity({ entities: ALL, assignedEntityIds: ["ghost"], uploaderEntityId: "also-ghost", texts: [] });
    expect(r.status).toBe("unknown");
  });
  it("mentions an ambiguous file in the note instead of guessing", () => {
    const r = resolveEntity({ entities: ALL, assignedEntityIds: ["fr"], uploaderEntityId: null, texts: ["Northwind France and Northwind UK"] });
    expect(r.suggestion?.source).toBe("assignment");
    expect(r.note).toMatch(/several entities/);
  });
});
