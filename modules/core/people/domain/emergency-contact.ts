import { PeopleError } from "./error.js";
import { normalisePhone } from "./person.js";

export const EMERGENCY_CONTACT_RELATIONSHIPS = [
  "spouse",
  "grandparent",
  "relative",
  "neighbour",
  "friend",
  "carer",
  "other",
] as const;

export type EmergencyContactRelationship = (typeof EMERGENCY_CONTACT_RELATIONSHIPS)[number];

export const MAX_EMERGENCY_CONTACTS = 5;

export type EmergencyContact = {
  name: string;
  relationship: EmergencyContactRelationship | null;
  phone: string;
};

export type RawEmergencyContactInput = {
  name: unknown;
  relationship?: unknown;
  phone: unknown;
};

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) {
      return true;
    }
  }
  return false;
}

export function validateEmergencyContacts(input: unknown): EmergencyContact[] {
  if (!Array.isArray(input)) {
    throw new PeopleError("invalid_input");
  }
  if (input.length > MAX_EMERGENCY_CONTACTS) {
    throw new PeopleError("invalid_input");
  }

  const clean: EmergencyContact[] = [];

  for (const item of input) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new PeopleError("invalid_input");
    }

    const raw = item as Record<string, unknown>;
    const keys = Object.keys(raw);
    for (const key of keys) {
      if (key !== "name" && key !== "relationship" && key !== "phone") {
        throw new PeopleError("invalid_input");
      }
    }

    if (typeof raw.name !== "string") {
      throw new PeopleError("invalid_name");
    }
    const trimmedName = raw.name.trim();
    if (
      trimmedName.length === 0 ||
      Array.from(trimmedName).length > 100 ||
      hasControlCharacter(trimmedName)
    ) {
      throw new PeopleError("invalid_name");
    }

    let relationship: EmergencyContactRelationship | null = null;
    if (raw.relationship !== undefined && raw.relationship !== null) {
      if (typeof raw.relationship !== "string") {
        throw new PeopleError("invalid_input");
      }
      if (
        !EMERGENCY_CONTACT_RELATIONSHIPS.includes(raw.relationship as EmergencyContactRelationship)
      ) {
        throw new PeopleError("invalid_input");
      }
      relationship = raw.relationship as EmergencyContactRelationship;
    }

    if (typeof raw.phone !== "string") {
      throw new PeopleError("invalid_phone");
    }
    const cleanPhone = normalisePhone(raw.phone);

    clean.push({
      name: trimmedName,
      relationship,
      phone: cleanPhone,
    });
  }

  return clean;
}
