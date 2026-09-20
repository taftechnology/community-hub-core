import catalog from "./catalog.json" with { type: "json" };

export type RegionId = keyof typeof catalog.cells;
export type EnabledRegionId = "au";
export type Cell = (typeof catalog.cells)[RegionId] & { id: RegionId };

export const regionalOnlyPackages: readonly string[] = catalog.regionalOnlyPackages;

const NOT_ENABLED = "region is not enabled";

export function parseRegionId(id: string): EnabledRegionId {
  if (id === "au" && catalog.cells.au.enabled === true) {
    return "au";
  }
  throw new Error(NOT_ENABLED);
}

export function getCell(id: EnabledRegionId): Cell & { id: EnabledRegionId } {
  const rec = catalog.cells[id];
  if (rec === undefined || rec.enabled !== true) {
    throw new Error(NOT_ENABLED);
  }
  return { ...rec, id };
}
