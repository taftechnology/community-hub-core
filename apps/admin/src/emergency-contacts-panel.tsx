import { Alert, Button, Field, Input, Panel, Select, Skeleton } from "@community-hub/ui";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";

import { post } from "./api";

// The list and the cap are copies of packages/contracts/src/households.ts; the panel test compares them.
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
const MAX_NAME_LENGTH = 100;
const MAX_PHONE_LENGTH = 50;

const RELATIONSHIP_LABELS: Record<EmergencyContactRelationship, string> = {
  spouse: "Spouse",
  grandparent: "Grandparent",
  relative: "Relative",
  neighbour: "Neighbour",
  friend: "Friend",
  carer: "Carer",
  other: "Other",
};

export const CONTACTS_LABEL = "Adult to contact if guardians cannot be reached";
export const CONTACTS_HELP = "Do not enter a child's name.";
export const MESSAGE_LOAD_FAILED = "Unable to load emergency contacts. Try again.";
export const MESSAGE_CONFLICT =
  "Someone else changed this family. Your changes are still here. Check them and save again.";
export const MESSAGE_SAVE_FAILED = "Unable to save. Try again.";
export const MESSAGE_CHECK = "Check the name and phone of each contact.";
export const MESSAGE_READ_ONLY = "Read-only until billing is settled";

const READ_PATH = "/v1/households/emergency-contacts/read";
const SAVE_PATH = "/v1/households/emergency-contacts/save";

type Contact = {
  name: string;
  relationship: EmergencyContactRelationship | null;
  phone: string;
};

type Row = {
  key: number;
  name: string;
  relationship: string;
  phone: string;
};

type RowErrors = { name?: string; phone?: string };
type Phase = "hidden" | "loading" | "loaded" | "failed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRelationship(value: unknown): EmergencyContactRelationship | null | undefined {
  if (value === null) {
    return null;
  }
  return EMERGENCY_CONTACT_RELATIONSHIPS.find((known) => known === value);
}

function parseContact(value: unknown): Contact | null {
  if (!isRecord(value)) {
    return null;
  }
  const { name, phone } = value;
  const relationship = readRelationship(value.relationship);
  if (
    typeof name !== "string" ||
    name.trim() === "" ||
    Array.from(name).length > MAX_NAME_LENGTH ||
    typeof phone !== "string" ||
    phone.trim() === "" ||
    phone.length > MAX_PHONE_LENGTH ||
    relationship === undefined
  ) {
    return null;
  }
  return { name, relationship, phone };
}

function readVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

// Anything that does not match the contract is a load failure, never a partial list.
function parseRead(
  value: unknown,
  householdId: string,
): { version: number; contacts: Contact[] } | null {
  if (!isRecord(value) || value.householdId !== householdId) {
    return null;
  }
  const version = readVersion(value.version);
  if (
    version === null ||
    !Array.isArray(value.contacts) ||
    value.contacts.length > MAX_EMERGENCY_CONTACTS
  ) {
    return null;
  }
  const contacts: Contact[] = [];
  for (const item of value.contacts) {
    const contact = parseContact(item);
    if (contact === null) {
      return null;
    }
    contacts.push(contact);
  }
  return { version, contacts };
}

function parseSaved(value: unknown, householdId: string): number | null {
  if (!isRecord(value) || value.householdId !== householdId) {
    return null;
  }
  return readVersion(value.version);
}

function validateRows(rows: Row[]): { errors: Record<number, RowErrors>; first: string | null } {
  const errors: Record<number, RowErrors> = {};
  let first: string | null = null;
  for (const row of rows) {
    const name = row.name.trim();
    const rowErrors: RowErrors = {};
    if (name === "") {
      rowErrors.name = "Enter a name.";
    } else if (Array.from(name).length > MAX_NAME_LENGTH) {
      rowErrors.name = `Name must be ${MAX_NAME_LENGTH} characters or fewer.`;
    }
    if (row.phone.trim() === "") {
      rowErrors.phone = "Enter a phone number.";
    }
    if (rowErrors.name !== undefined || rowErrors.phone !== undefined) {
      errors[row.key] = rowErrors;
      if (first === null) {
        first = rowErrors.name !== undefined ? `name-${row.key}` : `phone-${row.key}`;
      }
    }
  }
  return { errors, first };
}

export type EmergencyContactsParams = {
  slug: string;
  householdId: string | null;
  // The version of the open Family Details; a rename or a reload moves it.
  detailVersion: number;
  canRead: boolean;
  canEdit: boolean;
  // The open family was answered as not found.
  gone: boolean;
  onSaved: (householdId: string, version: number) => void;
  onConflict: () => void;
  onGone: () => void;
  onPaymentRequired: () => void;
};

// The contacts live only in this hook's state. reset() drops them, and a late answer that belongs
// to an earlier reset changes nothing. The page calls reset() when the community or the open family
// changes; a reload of the same family does not.
export function useEmergencyContacts(params: EmergencyContactsParams): {
  panel: ReactNode;
  reset: () => void;
} {
  const { slug, householdId, canRead, canEdit } = params;
  const baseId = useId();
  const [phase, setPhase] = useState<Phase>("hidden");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [knownVersion, setKnownVersion] = useState(0);
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [errors, setErrors] = useState<Record<number, RowErrors>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const generation = useRef(0);
  const loadingRef = useRef(false);
  const savingRef = useRef(false);
  const nextKey = useRef(0);
  const elements = useRef(new Map<string, HTMLElement>());
  const focusPlan = useRef<string | null>(null);
  const latest = useRef(params);
  useEffect(() => {
    latest.current = params;
  });

  function setRef(id: string) {
    return (element: HTMLElement | null) => {
      if (element === null) {
        elements.current.delete(id);
      } else {
        elements.current.set(id, element);
      }
    };
  }

  // A focus move waits until its target is on screen, for example after a detail reload.
  useEffect(() => {
    const id = focusPlan.current;
    if (id === null) {
      return;
    }
    const element = elements.current.get(id);
    if (element?.isConnected) {
      focusPlan.current = null;
      element.focus();
    }
  });

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  function reset() {
    generation.current += 1;
    loadingRef.current = false;
    savingRef.current = false;
    focusPlan.current = null;
    setPhase("hidden");
    setContacts([]);
    setKnownVersion(0);
    setEditing(false);
    setRows([]);
    setErrors({});
    setNotice(null);
    setSaving(false);
  }

  useEffect(() => {
    if (!canRead || params.gone) {
      reset();
    }
  }, [canRead, params.gone]);

  useEffect(() => {
    if (!canEdit && editing) {
      setEditing(false);
      setRows([]);
      setErrors({});
    }
  }, [canEdit, editing]);

  async function load() {
    if (!slug || householdId === null || loadingRef.current) {
      return;
    }
    const mine = generation.current;
    loadingRef.current = true;
    setPhase("loading");
    setNotice(null);

    const response = await post(READ_PATH, { communitySlug: slug, householdId });
    if (generation.current !== mine) {
      return;
    }
    let parsed: ReturnType<typeof parseRead> = null;
    if (response !== "unavailable" && response.status === 200) {
      try {
        const data: unknown = await response.json();
        if (generation.current !== mine) {
          return;
        }
        parsed = parseRead(data, householdId);
      } catch {
        if (generation.current !== mine) {
          return;
        }
      }
    }
    loadingRef.current = false;
    if (parsed === null) {
      setContacts([]);
      setPhase("failed");
      return;
    }
    setContacts(parsed.contacts);
    setKnownVersion(parsed.version);
    setPhase("loaded");
    focusPlan.current = "heading";
  }

  function startEdit() {
    const next = contacts.map((contact) => ({
      key: nextKey.current++,
      name: contact.name,
      relationship: contact.relationship ?? "",
      phone: contact.phone,
    }));
    setRows(next);
    setErrors({});
    setNotice(null);
    setEditing(true);
    const first = next[0];
    focusPlan.current = first === undefined ? "add" : `name-${first.key}`;
  }

  function cancelEdit() {
    if (savingRef.current) {
      return;
    }
    setEditing(false);
    setRows([]);
    setErrors({});
    setNotice(null);
    focusPlan.current = "edit";
  }

  function addRow() {
    if (rows.length >= MAX_EMERGENCY_CONTACTS) {
      return;
    }
    const key = nextKey.current++;
    setRows([...rows, { key, name: "", relationship: "", phone: "" }]);
    focusPlan.current = `name-${key}`;
  }

  function removeRow(key: number) {
    const index = rows.findIndex((row) => row.key === key);
    const following = rows[index + 1];
    setRows(rows.filter((row) => row.key !== key));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    focusPlan.current = following === undefined ? "add" : `remove-${following.key}`;
  }

  function changeRow(key: number, field: keyof Omit<Row, "key">, value: string) {
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, [field]: value } : row)));
    if (field === "name" || field === "phone") {
      setErrors((prev) => {
        const current = prev[key];
        if (current === undefined || current[field] === undefined) {
          return prev;
        }
        const next = { ...current };
        delete next[field];
        return { ...prev, [key]: next };
      });
    }
  }

  function showNotice(message: string) {
    setNotice(message);
    focusPlan.current = "alert";
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current || !slug || householdId === null) {
      return;
    }
    const checked = validateRows(rows);
    if (checked.first !== null) {
      setErrors(checked.errors);
      setNotice(null);
      focusPlan.current = checked.first;
      return;
    }
    const toSend: Contact[] = rows.map((row) => ({
      name: row.name.trim(),
      relationship: readRelationship(row.relationship === "" ? null : row.relationship) ?? null,
      phone: row.phone.trim(),
    }));
    // The newest version this screen knows: the contacts answer, or the open detail after a
    // rename, a status change or a reload, whichever is higher.
    const version = Math.max(knownVersion, params.detailVersion);
    const mine = generation.current;
    savingRef.current = true;
    setSaving(true);
    setNotice(null);
    setErrors({});
    let stale = false;

    try {
      const response = await post(SAVE_PATH, {
        communitySlug: slug,
        householdId,
        version,
        contacts: toSend,
      });
      if (generation.current !== mine) {
        stale = true;
        return;
      }
      if (response === "unavailable") {
        showNotice(MESSAGE_SAVE_FAILED);
        return;
      }
      if (response.status === 402) {
        latest.current.onPaymentRequired();
        showNotice(MESSAGE_READ_ONLY);
        return;
      }
      if (response.status === 409) {
        showNotice(MESSAGE_CONFLICT);
        // A detail reload brings the newer version; the typed rows stay.
        latest.current.onConflict();
        return;
      }
      if (response.status === 400) {
        showNotice(MESSAGE_CHECK);
        return;
      }
      if (response.status === 404) {
        reset();
        latest.current.onGone();
        return;
      }
      if (response.status !== 200) {
        showNotice(MESSAGE_SAVE_FAILED);
        return;
      }
      let savedVersion: number | null = null;
      try {
        const data: unknown = await response.json();
        if (generation.current !== mine) {
          stale = true;
          return;
        }
        savedVersion = parseSaved(data, householdId);
      } catch {
        if (generation.current !== mine) {
          stale = true;
          return;
        }
      }
      if (savedVersion === null) {
        showNotice(MESSAGE_SAVE_FAILED);
        return;
      }
      setContacts(toSend);
      setKnownVersion(savedVersion);
      setEditing(false);
      setRows([]);
      focusPlan.current = "heading";
      latest.current.onSaved(householdId, savedVersion);
    } finally {
      if (!stale) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }

  const panel: ReactNode =
    canRead && householdId !== null ? (
      <Panel
        title="Emergency contacts"
        level={3}
        headingRef={setRef("heading")}
        headingTabIndex={-1}
        actions={
          <div className="flex flex-wrap gap-2">
            {phase === "loaded" && !editing && canEdit ? (
              <Button
                type="button"
                variant="outline"
                ref={setRef("edit")}
                aria-label="Edit emergency contacts"
                onClick={startEdit}
              >
                Edit
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              onClick={phase === "hidden" ? () => void load() : reset}
            >
              {phase === "hidden" ? "Show emergency contacts" : "Hide emergency contacts"}
            </Button>
          </div>
        }
      >
        {editing ? null : (
          <div className="grid gap-1">
            <p className="m-0 font-semibold text-foreground">{CONTACTS_LABEL}</p>
            <p className="m-0 text-[13px] leading-[18px] text-muted-foreground">{CONTACTS_HELP}</p>
          </div>
        )}

        {phase === "loading" ? (
          <>
            <Skeleton />
            <span className="sr-only">Loading emergency contacts...</span>
          </>
        ) : null}

        {phase === "failed" ? (
          <Alert variant="destructive">
            <span>{MESSAGE_LOAD_FAILED}</span>{" "}
            <Button type="button" onClick={() => void load()}>
              Retry
            </Button>
          </Alert>
        ) : null}

        {phase === "loaded" && notice !== null ? (
          <Alert ref={setRef("alert")} tabIndex={-1} variant="destructive">
            <span>{notice}</span>
          </Alert>
        ) : null}

        {phase === "loaded" && !editing ? (
          contacts.length === 0 ? (
            <p className="m-0">No emergency contacts.</p>
          ) : (
            <ul className="m-0 grid list-none gap-2 p-0">
              {contacts.map((contact, index) => (
                <li key={index} className="flex flex-wrap gap-x-4 gap-y-1">
                  <span className="font-medium">{contact.name}</span>
                  {contact.relationship !== null ? (
                    <span>{RELATIONSHIP_LABELS[contact.relationship]}</span>
                  ) : null}
                  <span>{contact.phone}</span>
                </li>
              ))}
            </ul>
          )
        ) : null}

        {phase === "loaded" && editing && canEdit ? (
          <form className="grid gap-4" noValidate onSubmit={(event) => void save(event)}>
            <fieldset
              disabled={saving}
              aria-describedby={`${baseId}-help`}
              className="m-0 grid min-w-0 gap-4 border-0 p-0"
            >
              <legend className="p-0 font-semibold text-foreground">{CONTACTS_LABEL}</legend>
              <p
                id={`${baseId}-help`}
                className="m-0 text-[13px] leading-[18px] text-muted-foreground"
              >
                {CONTACTS_HELP}
              </p>
              {rows.map((row, index) => {
                const number = index + 1;
                const rowErrors = errors[row.key];
                return (
                  <div
                    key={row.key}
                    role="group"
                    aria-label={`Contact ${number}`}
                    className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-3"
                  >
                    <Field label={`Contact ${number} name`} error={rowErrors?.name ?? ""}>
                      <Input
                        id={`${baseId}-name-${row.key}`}
                        ref={setRef(`name-${row.key}`)}
                        autoComplete="off"
                        maxLength={MAX_NAME_LENGTH}
                        value={row.name}
                        onChange={(event) => changeRow(row.key, "name", event.target.value)}
                      />
                    </Field>
                    <Field label={`Contact ${number} relationship`}>
                      <Select
                        id={`${baseId}-relationship-${row.key}`}
                        autoComplete="off"
                        value={row.relationship}
                        onChange={(event) => changeRow(row.key, "relationship", event.target.value)}
                      >
                        <option value="">None</option>
                        {EMERGENCY_CONTACT_RELATIONSHIPS.map((relationship) => (
                          <option key={relationship} value={relationship}>
                            {RELATIONSHIP_LABELS[relationship]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={`Contact ${number} phone`} error={rowErrors?.phone ?? ""}>
                      <Input
                        id={`${baseId}-phone-${row.key}`}
                        ref={setRef(`phone-${row.key}`)}
                        type="tel"
                        autoComplete="off"
                        value={row.phone}
                        onChange={(event) => changeRow(row.key, "phone", event.target.value)}
                      />
                    </Field>
                    <div>
                      <Button
                        type="button"
                        variant="outline"
                        ref={setRef(`remove-${row.key}`)}
                        aria-label={`Remove contact ${number}`}
                        onClick={() => removeRow(row.key)}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                );
              })}
              {rows.length < MAX_EMERGENCY_CONTACTS ? (
                <div>
                  <Button type="button" variant="outline" ref={setRef("add")} onClick={addRow}>
                    Add contact
                  </Button>
                </div>
              ) : null}
            </fieldset>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={saving} aria-label="Save emergency contacts">
                Save
              </Button>
              <Button type="button" variant="outline" disabled={saving} onClick={cancelEdit}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </Panel>
    ) : null;

  return { panel, reset };
}
