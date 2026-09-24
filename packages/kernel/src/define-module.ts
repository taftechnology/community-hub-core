/** Public-site participation (architecture §15.5, ADR 0006). Preference: collection → island → block. */
export type ModuleWebsite = {
  /** External collections: public-only data sources bound to Jellycube lists and detail pages. */
  collections?: string[];
  /** Host islands: web components for a write or a live value. */
  islands?: string[];
  /** Host block packs: exceptions only, with a written reason in the spec. */
  blocks?: string[];
};

export type ModuleDefinition = {
  key: string;
  version: number;
  requires: string[];
  publishes: string[];
  subscribes: string[];
  ports: string[];
  entitlement?: string;
  features?: string[];
  permissions?: string[];
  website?: ModuleWebsite;
  dataClasses?: Record<string, string>;
};

export function defineModule(def: ModuleDefinition): ModuleDefinition {
  return def;
}
