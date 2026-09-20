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
  websiteWidgets?: string[];
  dataClasses?: Record<string, string>;
};

export function defineModule(def: ModuleDefinition): ModuleDefinition {
  return def;
}
