import { describe, expectTypeOf, it } from "vitest";
import { defineModule, type ModuleDefinition, type ModuleWebsite } from "./module.js";

describe("ModuleDefinition.website", () => {
  it("accepts collections, islands and blocks", () => {
    expectTypeOf<ModuleDefinition["website"]>().toEqualTypeOf<ModuleWebsite | undefined>();
    expectTypeOf<ModuleWebsite>().toEqualTypeOf<{
      collections?: string[];
      islands?: string[];
      blocks?: string[];
    }>();
  });

  it("rejects the revision-19 websiteWidgets field", () => {
    expectTypeOf<ModuleDefinition>().not.toHaveProperty("websiteWidgets");
  });

  it("type-checks the architecture §8.2 manifest example", () => {
    expectTypeOf(
      defineModule({
        key: "giving",
        version: 1,
        requires: ["core.people", "core.consent"],
        publishes: [],
        subscribes: [],
        ports: ["PaymentProvider"],
        website: {
          collections: ["giving.campaigns"],
          islands: ["giving.donate", "giving.campaign_total"],
        },
      }),
    ).toEqualTypeOf<ModuleDefinition>();
  });
});
