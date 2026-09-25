import { describe, expect, it } from "vitest";
import catalog from "./catalog.json" with { type: "json" };
import { getCell, parseRegionId, regionalOnlyPackages, type EnabledRegionId } from "./index.js";

describe("catalog.json", () => {
  it("has exactly au, ca, eu, us with the required fields", () => {
    expect(Object.keys(catalog.cells).sort()).toEqual(["au", "ca", "eu", "us"]);
    for (const cell of Object.values(catalog.cells)) {
      expect(typeof cell.enabled).toBe("boolean");
      expect(cell.cloudflareRegionalServices.length).toBeGreaterThan(0);
      expect(cell.awsRegion.length).toBeGreaterThan(0);
    }
    expect(catalog.regionalOnlyPackages).toEqual(["@community-hub/db", "@community-hub/crypto"]);
    expect(regionalOnlyPackages).toEqual(catalog.regionalOnlyPackages);
  });

  it("locks EnabledRegionId to the JSON enabled set", () => {
    const enabled = Object.entries(catalog.cells)
      .filter(([, c]) => c.enabled)
      .map(([id]) => id);
    expect(enabled).toEqual(["au"] satisfies EnabledRegionId[]);
  });
});

function compileGetCellRejectsStub(): void {
  // @ts-expect-error stubs are not EnabledRegionId
  getCell("ca");
}

describe("getCell", () => {
  it("returns the AU cell", () => {
    expect(getCell("au")).toEqual({
      id: "au",
      enabled: true,
      cloudflareRegionalServices: "au",
      awsRegion: "ap-southeast-2",
    });
  });

  it("does not compile for a stub", () => {
    expect(compileGetCellRejectsStub).toBeTypeOf("function");
  });

  it("throws when the alias is mis-widened", () => {
    expect(() => getCell("ca" as EnabledRegionId)).toThrow(/not enabled/i);
  });
});

describe("parseRegionId", () => {
  it("accepts au", () => {
    expect(parseRegionId("au")).toBe("au");
  });

  it.each(["ca", "us", "", "nope"])("throws for %j", (id) => {
    expect(() => parseRegionId(id)).toThrow(/not enabled/i);
  });
});
