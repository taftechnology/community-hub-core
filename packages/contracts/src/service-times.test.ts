import { describe, expect, it } from "vitest";

import {
  SERVICE_TIMES_ERROR_CODES,
  SERVICE_TIMES_HTML_MAX,
  SERVICE_TIMES_RAW_HTML_MAX,
  serviceTimesGetBody,
  serviceTimesPublicSchema,
  serviceTimesResponse,
  serviceTimesSaveBody,
  type ServiceTimesErrorCode,
  type ServiceTimesGetBody,
  type ServiceTimesPublic,
  type ServiceTimesResponse,
  type ServiceTimesSaveBody,
} from "./service-times.js";

describe("service times contract schemas", () => {
  describe("serviceTimesGetBody", () => {
    it("accepts valid request body with communitySlug", () => {
      const parsed = serviceTimesGetBody.safeParse({
        communitySlug: "parish-au",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        const body: ServiceTimesGetBody = parsed.data;
        expect(body.communitySlug).toBe("parish-au");
      }
    });

    it("rejects empty communitySlug", () => {
      expect(serviceTimesGetBody.safeParse({ communitySlug: "" }).success).toBe(false);
    });

    it("rejects missing communitySlug", () => {
      expect(serviceTimesGetBody.safeParse({}).success).toBe(false);
    });

    it("rejects extra keys (strict)", () => {
      expect(
        serviceTimesGetBody.safeParse({
          communitySlug: "parish-au",
          extra: "forbidden",
        }).success,
      ).toBe(false);
    });
  });

  describe("serviceTimesSaveBody", () => {
    it("accepts valid save body with version 0 and version 7", () => {
      const parsed0 = serviceTimesSaveBody.safeParse({
        communitySlug: "parish-au",
        html: "<p>Sunday Mass 9am</p>",
        version: 0,
      });
      expect(parsed0.success).toBe(true);
      if (parsed0.success) {
        const body: ServiceTimesSaveBody = parsed0.data;
        expect(body.version).toBe(0);
      }

      expect(
        serviceTimesSaveBody.safeParse({
          communitySlug: "parish-au",
          html: "<p>Sunday Mass 9am</p>",
          version: 7,
        }).success,
      ).toBe(true);
    });

    it("accepts html at raw cap of 120,000 UTF-16 units and rejects 120,001", () => {
      const atCap = "a".repeat(SERVICE_TIMES_RAW_HTML_MAX);
      const overCap = "a".repeat(SERVICE_TIMES_RAW_HTML_MAX + 1);

      expect(
        serviceTimesSaveBody.safeParse({
          communitySlug: "parish-au",
          html: atCap,
          version: 0,
        }).success,
      ).toBe(true);

      expect(
        serviceTimesSaveBody.safeParse({
          communitySlug: "parish-au",
          html: overCap,
          version: 0,
        }).success,
      ).toBe(false);
    });

    it("rejects negative, non-integer, or string versions", () => {
      expect(
        serviceTimesSaveBody.safeParse({
          communitySlug: "parish-au",
          html: "<p>Mass</p>",
          version: -1,
        }).success,
      ).toBe(false);

      expect(
        serviceTimesSaveBody.safeParse({
          communitySlug: "parish-au",
          html: "<p>Mass</p>",
          version: 1.5,
        }).success,
      ).toBe(false);

      expect(
        serviceTimesSaveBody.safeParse({
          communitySlug: "parish-au",
          html: "<p>Mass</p>",
          version: "3",
        }).success,
      ).toBe(false);
    });

    it("rejects missing required fields", () => {
      expect(
        serviceTimesSaveBody.safeParse({
          html: "<p>Mass</p>",
          version: 0,
        }).success,
      ).toBe(false);

      expect(
        serviceTimesSaveBody.safeParse({
          communitySlug: "parish-au",
          version: 0,
        }).success,
      ).toBe(false);

      expect(
        serviceTimesSaveBody.safeParse({
          communitySlug: "parish-au",
          html: "<p>Mass</p>",
        }).success,
      ).toBe(false);
    });

    it("rejects extra keys (strict)", () => {
      expect(
        serviceTimesSaveBody.safeParse({
          communitySlug: "parish-au",
          html: "<p>Mass</p>",
          version: 0,
          extra: "forbidden",
        }).success,
      ).toBe(false);
    });
  });

  describe("serviceTimesResponse", () => {
    it("accepts valid response with html and integer version >= 0", () => {
      const parsed0 = serviceTimesResponse.safeParse({
        html: "<p>Sunday Mass 9am</p>",
        version: 0,
      });
      expect(parsed0.success).toBe(true);

      const parsed7 = serviceTimesResponse.safeParse({
        html: "<p>Sunday Mass 9am</p>",
        version: 7,
      });
      expect(parsed7.success).toBe(true);
      if (parsed7.success) {
        const res: ServiceTimesResponse = parsed7.data;
        expect(res.version).toBe(7);
      }
    });

    it("rejects invalid versions", () => {
      expect(serviceTimesResponse.safeParse({ html: "", version: -1 }).success).toBe(false);
      expect(serviceTimesResponse.safeParse({ html: "", version: 1.5 }).success).toBe(false);
      expect(serviceTimesResponse.safeParse({ html: "", version: "1" }).success).toBe(false);
    });

    it("rejects missing fields", () => {
      expect(serviceTimesResponse.safeParse({ html: "" }).success).toBe(false);
      expect(serviceTimesResponse.safeParse({ version: 0 }).success).toBe(false);
    });

    it("rejects extra keys (strict)", () => {
      expect(
        serviceTimesResponse.safeParse({
          html: "",
          version: 0,
          orgId: "00000000-0000-4000-8000-000000000001",
        }).success,
      ).toBe(false);
    });
  });

  describe("serviceTimesPublicSchema", () => {
    it("accepts valid public payload with html only", () => {
      const parsed = serviceTimesPublicSchema.safeParse({
        html: "<p>Sunday Mass 9am</p>",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        const pub: ServiceTimesPublic = parsed.data;
        expect(pub.html).toBe("<p>Sunday Mass 9am</p>");
      }

      expect(serviceTimesPublicSchema.safeParse({ html: "" }).success).toBe(true);
    });

    it("rejects version key (public schema never carries a version)", () => {
      expect(
        serviceTimesPublicSchema.safeParse({
          html: "<p>Sunday Mass 9am</p>",
          version: 0,
        }).success,
      ).toBe(false);

      expect(
        serviceTimesPublicSchema.safeParse({
          html: "<p>Sunday Mass 9am</p>",
          version: 1,
        }).success,
      ).toBe(false);
    });

    it("rejects timestamps, IDs, and other extra keys (strict)", () => {
      expect(
        serviceTimesPublicSchema.safeParse({
          html: "<p>Sunday Mass 9am</p>",
          createdAt: new Date().toISOString(),
        }).success,
      ).toBe(false);

      expect(
        serviceTimesPublicSchema.safeParse({
          html: "<p>Sunday Mass 9am</p>",
          updatedAt: new Date().toISOString(),
        }).success,
      ).toBe(false);

      expect(
        serviceTimesPublicSchema.safeParse({
          html: "<p>Sunday Mass 9am</p>",
          org_id: "00000000-0000-4000-8000-000000000001",
        }).success,
      ).toBe(false);

      expect(
        serviceTimesPublicSchema.safeParse({
          html: "<p>Sunday Mass 9am</p>",
          community_id: "00000000-0000-4000-8000-000000000002",
        }).success,
      ).toBe(false);

      expect(
        serviceTimesPublicSchema.safeParse({
          html: "<p>Sunday Mass 9am</p>",
          orgId: "00000000-0000-4000-8000-000000000001",
        }).success,
      ).toBe(false);

      expect(
        serviceTimesPublicSchema.safeParse({
          html: "<p>Sunday Mass 9am</p>",
          extra: "forbidden",
        }).success,
      ).toBe(false);
    });

    it("rejects missing html", () => {
      expect(serviceTimesPublicSchema.safeParse({}).success).toBe(false);
    });
  });

  describe("constants and error codes", () => {
    it("exports exact constants and error codes array", () => {
      expect(SERVICE_TIMES_RAW_HTML_MAX).toBe(120_000);
      expect(SERVICE_TIMES_HTML_MAX).toBe(20_000);
      expect(SERVICE_TIMES_ERROR_CODES).toEqual(["version_conflict", "invalid_input"]);

      const code1: ServiceTimesErrorCode = "version_conflict";
      const code2: ServiceTimesErrorCode = "invalid_input";
      expect(SERVICE_TIMES_ERROR_CODES).toContain(code1);
      expect(SERVICE_TIMES_ERROR_CODES).toContain(code2);
    });
  });
});
