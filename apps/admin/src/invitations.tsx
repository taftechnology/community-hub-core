import { Button, Field, Input, Panel, Select } from "@community-hub/ui";
import {
  type FormEvent,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
  createContext,
} from "react";

import { post } from "./api";
import { useCommunity } from "./community";
import { roleLabel } from "./role-labels";

type InvitationAction = "create" | "resend" | "revoke" | "list";

type InvitationRow = {
  id: string;
  email: string | null;
  roleKey: string | null;
  customRoleId: string | null;
  linksContact: boolean;
  expiresAt: string;
};

type PersonHit = {
  id: string;
  name: string;
};

type RoleOption = {
  value: string;
  label: string;
};

export type InvitationRole = {
  roleKey: string;
};

export type InvitationCustomRole = {
  customRoleId: string;
  key: string;
};

export const CommunityEpochContext = createContext<RefObject<number>>({ current: 0 });

function useEpoch(): RefObject<number> {
  return useContext(CommunityEpochContext);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorCode(payload: unknown): string | undefined {
  if (!isRecord(payload) || typeof payload.error !== "string") {
    return undefined;
  }
  return payload.error;
}

function invitationSentence(
  status: number,
  code: string | undefined,
  action: InvitationAction,
): string {
  if (status === 400) {
    return "Enter a valid email address.";
  }
  if (status === 403) {
    return "You don't have permission to do that.";
  }
  if (status === 402) {
    return "Your organisation is read-only. Update billing to make changes.";
  }
  if (status === 503) {
    return "Invitations are not available yet.";
  }
  if (status === 409 && code === "already_invited") {
    return "This address already has a pending invitation.";
  }
  if (status === 409 && code === "too_many" && action === "create") {
    return "Too many invitations for now. Try again later.";
  }
  if (status === 409 && code === "too_many" && action === "resend") {
    return "This invitation has been resent too often. Try again tomorrow.";
  }
  if (status === 409 && code === "person_linked") {
    return "That contact is already linked to a user.";
  }
  if (status === 422 && code === "person_minor") {
    return "That contact is under 18 and can't be linked to a user.";
  }
  if (status === 404 && code === "person_not_found") {
    return "That contact can't be found.";
  }
  if (status === 404 && code === "role_not_found") {
    return "That role no longer exists.";
  }
  if (status === 404 && code === "invitation_not_found") {
    return "This invitation is no longer pending.";
  }
  return "Something went wrong. Try again.";
}

function readInvitation(value: unknown): InvitationRow | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.linksContact !== "boolean") {
    return undefined;
  }
  if (value.email !== null && typeof value.email !== "string") {
    return undefined;
  }
  if (value.roleKey !== null && typeof value.roleKey !== "string") {
    return undefined;
  }
  if (value.customRoleId !== null && typeof value.customRoleId !== "string") {
    return undefined;
  }
  if (typeof value.expiresAt !== "string") {
    return undefined;
  }
  return {
    id: value.id,
    email: value.email,
    roleKey: value.roleKey,
    customRoleId: value.customRoleId,
    linksContact: value.linksContact,
    expiresAt: value.expiresAt,
  };
}

function readInvitations(payload: unknown): InvitationRow[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.invitations)) {
    return undefined;
  }
  const rows: InvitationRow[] = [];
  for (const item of payload.invitations) {
    const row = readInvitation(item);
    if (row === undefined) {
      return undefined;
    }
    rows.push(row);
  }
  return rows;
}

function readPeople(payload: unknown): PersonHit[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return undefined;
  }
  const people: PersonHit[] = [];
  for (const item of payload.items) {
    if (!isRecord(item) || item.isMinor === true) {
      continue;
    }
    const id = typeof item.personId === "string" ? item.personId : item.id;
    if (typeof id !== "string") {
      continue;
    }
    const given = typeof item.givenName === "string" ? item.givenName : "";
    const family = typeof item.familyName === "string" ? item.familyName : "";
    const name = `${given} ${family}`.trim();
    if (name.length === 0) {
      continue;
    }
    people.push({ id, name });
  }
  return people;
}

function expiryLabel(expiresAt: string): string {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) {
    return expiresAt;
  }
  return date.toLocaleDateString();
}

function roleFields(roleValue: string): { roleKey?: string; customRoleId?: string } {
  if (roleValue.startsWith("role:")) {
    return { roleKey: roleValue.slice("role:".length) };
  }
  if (roleValue.startsWith("custom:")) {
    return { customRoleId: roleValue.slice("custom:".length) };
  }
  return {};
}

export function ContactPicker({ onSelect }: { onSelect: (personId: string | null) => void }) {
  const { slug, version } = useCommunity();
  const epoch = useEpoch();
  const searchGen = useRef(0);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PersonHit[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | undefined>(undefined);

  useEffect(() => {
    setQuery("");
    setResults([]);
    setSelectedId(null);
    setSelectedName(null);
    setSearchError(undefined);
    onSelectRef.current(null);
  }, [slug, version]);

  async function runSearch(): Promise<void> {
    const search = query.trim();
    if (!slug || search.length < 1 || search.length > 100) {
      return;
    }
    const searchEpoch = epoch.current;
    const searchMine = ++searchGen.current;
    const response = await post("/v1/people/list", {
      communitySlug: slug,
      kind: "adults",
      search,
      limit: 20,
    });
    // guard after post (people)
    if (epoch.current !== searchEpoch || searchGen.current !== searchMine) {
      return;
    }
    if (response === "unavailable") {
      setResults([]);
      setSearchError("Something went wrong. Try again.");
      return;
    }
    try {
      const payload: unknown = await response.json();
      // guard after json (people)
      if (epoch.current !== searchEpoch || searchGen.current !== searchMine) {
        return;
      }
      if (response.status !== 200) {
        setResults([]);
        setSearchError(
          response.status === 403
            ? "You don't have permission to do that."
            : "Something went wrong. Try again.",
        );
        return;
      }
      const people = readPeople(payload);
      if (people === undefined) {
        setResults([]);
        setSearchError("Something went wrong. Try again.");
        return;
      }
      setSearchError(undefined);
      setResults(people);
    } catch {
      // guard in catch (people)
      if (epoch.current !== searchEpoch || searchGen.current !== searchMine) {
        return;
      }
      setResults([]);
      setSearchError("Something went wrong. Try again.");
    }
  }

  return (
    <div className="grid gap-2">
      <Field label="Contact">
        <Input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void runSearch();
            }
          }}
        />
      </Field>
      <Button
        className="justify-self-start"
        type="button"
        onClick={() => {
          void runSearch();
        }}
      >
        Search
      </Button>
      {searchError ? <p role="alert">{searchError}</p> : null}
      {selectedName ? <p>Selected contact {selectedName}</p> : null}
      {results.length === 0 ? null : (
        <ul aria-label="Contact results">
          {results.map((person) => (
            <li key={person.id}>
              <Button
                type="button"
                aria-pressed={person.id === selectedId}
                onClick={() => {
                  setSelectedId(person.id);
                  setSelectedName(person.name);
                  onSelect(person.id);
                }}
              >
                {person.name}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function InvitationsSection({
  permissions,
  hideWrites,
  builtIn,
  customRoles,
}: {
  permissions: readonly string[];
  hideWrites: boolean;
  builtIn: readonly InvitationRole[];
  customRoles: readonly InvitationCustomRole[];
}) {
  const { slug, version } = useCommunity();
  const epoch = useEpoch();
  const listGen = useRef(0);
  const inviteGen = useRef(0);
  const resendGen = useRef(0);
  const revokeGen = useRef(0);
  const listLoadedKey = useRef<string | null>(null);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [listError, setListError] = useState<string | undefined>(undefined);
  const [inviteError, setInviteError] = useState<string | undefined>(undefined);
  const [inviteSuccess, setInviteSuccess] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [email, setEmail] = useState("");
  const [roleValue, setRoleValue] = useState("");
  const [personId, setPersonId] = useState<string | null>(null);
  const [pickerKey, setPickerKey] = useState(0);

  const showInvite = permissions.includes("access.users.manage");
  const showPending =
    permissions.includes("access.users.view") && permissions.includes("access.roles.view");
  const canChooseRole = permissions.includes("access.roles.manage");
  const canPickContact = permissions.includes("people.view");
  const canManageInvites = permissions.includes("access.users.manage");

  const roleOptions: RoleOption[] = [
    ...builtIn.map((role) => ({
      value: `role:${role.roleKey}`,
      label: roleLabel(role.roleKey),
    })),
    ...customRoles.map((role) => ({
      value: `custom:${role.customRoleId}`,
      label: roleLabel(role.key),
    })),
  ];

  function invitationRoleLabel(row: InvitationRow): string | undefined {
    if (row.roleKey) {
      return roleLabel(row.roleKey);
    }
    if (row.customRoleId) {
      const match = customRoles.find((role) => role.customRoleId === row.customRoleId);
      if (match) {
        return roleLabel(match.key);
      }
    }
    return undefined;
  }

  function reloadList(communitySlug: string): void {
    const listEpoch = epoch.current;
    const listMine = ++listGen.current;
    void loadInvitations(communitySlug, listEpoch, listMine);
  }

  async function loadInvitations(
    communitySlug: string,
    listEpoch: number,
    listMine: number,
  ): Promise<void> {
    const response = await post("/v1/access/invitations/list", { communitySlug });
    // guard after post (list)
    if (epoch.current !== listEpoch || listGen.current !== listMine) {
      return;
    }
    if (response === "unavailable") {
      setInvitations([]);
      setListError("Something went wrong. Try again.");
      return;
    }
    try {
      const payload: unknown = await response.json();
      // guard after json (list)
      if (epoch.current !== listEpoch || listGen.current !== listMine) {
        return;
      }
      if (response.status !== 200) {
        setInvitations([]);
        setListError(invitationSentence(response.status, errorCode(payload), "list"));
        return;
      }
      const rows = readInvitations(payload);
      if (rows === undefined) {
        setInvitations([]);
        setListError("Something went wrong. Try again.");
        return;
      }
      setListError(undefined);
      setInvitations(rows);
    } catch {
      // guard in catch (list)
      if (epoch.current !== listEpoch || listGen.current !== listMine) {
        return;
      }
      setInvitations([]);
      setListError(invitationSentence(response.status, undefined, "list"));
    }
  }

  useEffect(() => {
    const key = `${slug}|${version}|${showPending ? "1" : "0"}`;
    if (listLoadedKey.current === key) {
      return;
    }
    listLoadedKey.current = key;
    setInvitations([]);
    setListError(undefined);
    setInviteError(undefined);
    setInviteSuccess(undefined);
    setActionError(undefined);
    setEmail("");
    setRoleValue("");
    setPersonId(null);
    if (!slug || !showPending) {
      listGen.current += 1;
      return;
    }
    const listEpoch = epoch.current;
    const listMine = ++listGen.current;
    void loadInvitations(slug, listEpoch, listMine);
  }, [slug, version, showPending]);

  async function submitInvite(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!slug) {
      return;
    }
    const trimmed = email.trim();
    const chosen = canChooseRole ? roleFields(roleValue) : {};
    const contactId = canPickContact ? personId : null;
    if (trimmed.length === 0) {
      setInviteSuccess(undefined);
      setInviteError("Enter a valid email address.");
      return;
    }
    if (chosen.roleKey === undefined && chosen.customRoleId === undefined && contactId === null) {
      setInviteSuccess(undefined);
      setInviteError("Choose a role or a contact");
      return;
    }
    const body: Record<string, string> = {
      communitySlug: slug,
      email: trimmed,
    };
    if (chosen.roleKey !== undefined) {
      body.roleKey = chosen.roleKey;
    }
    if (chosen.customRoleId !== undefined) {
      body.customRoleId = chosen.customRoleId;
    }
    if (contactId !== null) {
      body.personId = contactId;
    }
    const inviteEpoch = epoch.current;
    const inviteMine = ++inviteGen.current;
    const response = await post("/v1/access/invitations/create", body);
    // guard after post (invite)
    if (epoch.current !== inviteEpoch || inviteGen.current !== inviteMine) {
      return;
    }
    if (response === "unavailable") {
      setInviteSuccess(undefined);
      setInviteError("Something went wrong. Try again.");
      return;
    }
    try {
      const payload: unknown = await response.json();
      // guard after json (invite)
      if (epoch.current !== inviteEpoch || inviteGen.current !== inviteMine) {
        return;
      }
      if (response.status === 201) {
        setInviteError(undefined);
        setInviteSuccess(`Invitation sent to ${trimmed}`);
        setEmail("");
        setRoleValue("");
        setPersonId(null);
        setPickerKey((key) => key + 1);
        reloadList(slug);
        return;
      }
      setInviteSuccess(undefined);
      setInviteError(invitationSentence(response.status, errorCode(payload), "create"));
    } catch {
      // guard in catch (invite)
      if (epoch.current !== inviteEpoch || inviteGen.current !== inviteMine) {
        return;
      }
      if (response.status === 201) {
        setInviteError(undefined);
        setInviteSuccess(`Invitation sent to ${trimmed}`);
        setEmail("");
        setRoleValue("");
        setPersonId(null);
        setPickerKey((key) => key + 1);
        reloadList(slug);
        return;
      }
      setInviteSuccess(undefined);
      setInviteError(invitationSentence(response.status, undefined, "create"));
    }
  }

  async function runResend(invitationId: string): Promise<void> {
    if (!slug) {
      return;
    }
    const resendEpoch = epoch.current;
    const resendMine = ++resendGen.current;
    const response = await post("/v1/access/invitations/resend", {
      communitySlug: slug,
      invitationId,
    });
    // guard after post (resend)
    if (epoch.current !== resendEpoch || resendGen.current !== resendMine) {
      return;
    }
    if (response === "unavailable") {
      setActionError("Something went wrong. Try again.");
      return;
    }
    try {
      const payload: unknown = await response.json();
      // guard after json (resend)
      if (epoch.current !== resendEpoch || resendGen.current !== resendMine) {
        return;
      }
      if (response.status === 204 || response.status === 200) {
        setActionError(undefined);
        reloadList(slug);
        return;
      }
      setActionError(invitationSentence(response.status, errorCode(payload), "resend"));
    } catch {
      // guard in catch (resend)
      if (epoch.current !== resendEpoch || resendGen.current !== resendMine) {
        return;
      }
      if (response.status === 204 || response.status === 200) {
        setActionError(undefined);
        reloadList(slug);
        return;
      }
      setActionError(invitationSentence(response.status, undefined, "resend"));
    }
  }

  async function runRevoke(invitationId: string): Promise<void> {
    if (!slug) {
      return;
    }
    const revokeEpoch = epoch.current;
    const revokeMine = ++revokeGen.current;
    const response = await post("/v1/access/invitations/revoke", {
      communitySlug: slug,
      invitationId,
    });
    // guard after post (revoke)
    if (epoch.current !== revokeEpoch || revokeGen.current !== revokeMine) {
      return;
    }
    if (response === "unavailable") {
      setActionError("Something went wrong. Try again.");
      return;
    }
    try {
      const payload: unknown = await response.json();
      // guard after json (revoke)
      if (epoch.current !== revokeEpoch || revokeGen.current !== revokeMine) {
        return;
      }
      if (response.status === 204 || response.status === 200) {
        setActionError(undefined);
        reloadList(slug);
        return;
      }
      setActionError(invitationSentence(response.status, errorCode(payload), "revoke"));
    } catch {
      // guard in catch (revoke)
      if (epoch.current !== revokeEpoch || revokeGen.current !== revokeMine) {
        return;
      }
      if (response.status === 204 || response.status === 200) {
        setActionError(undefined);
        reloadList(slug);
        return;
      }
      setActionError(invitationSentence(response.status, undefined, "revoke"));
    }
  }

  return (
    <>
      <div id="invite-user" hidden={!showInvite || hideWrites}>
        <Panel title="Invite user">
          {inviteSuccess ? <p role="status">{inviteSuccess}</p> : null}
          {inviteError ? <p role="alert">{inviteError}</p> : null}
          <form className="grid gap-4" noValidate onSubmit={(event) => void submitInvite(event)}>
            <Field label="Email">
              <Input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
              />
            </Field>
            {canChooseRole && showInvite && !hideWrites ? (
              <Field label="Role">
                <Select
                  value={roleValue}
                  onChange={(event) => {
                    setRoleValue(event.target.value);
                  }}
                >
                  <option value="">No role</option>
                  {roleOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <div hidden={!canPickContact}>
              <ContactPicker key={pickerKey} onSelect={setPersonId} />
            </div>
            <Button className="justify-self-start" type="submit">
              Send invitation
            </Button>
          </form>
        </Panel>
      </div>
      {showPending ? (
        <Panel title="Pending invitations">
          {listError ? <p role="alert">{listError}</p> : null}
          {actionError ? <p role="alert">{actionError}</p> : null}
          {invitations.length === 0 ? <p>No pending invitations</p> : null}
          {invitations.length === 0 ? null : (
            <ul>
              {invitations.map((row) => {
                const label = invitationRoleLabel(row);
                return (
                  <li key={row.id} className="flex flex-wrap items-center gap-2">
                    <span>{row.email === null ? "Address removed" : row.email}</span>
                    {label ? <span>{label}</span> : null}
                    {row.linksContact ? <span>Links a contact</span> : null}
                    <span>{expiryLabel(row.expiresAt)}</span>
                    {canManageInvites && !hideWrites ? (
                      <Button
                        type="button"
                        onClick={() => {
                          void runResend(row.id);
                        }}
                      >
                        Resend
                      </Button>
                    ) : null}
                    {canManageInvites && !hideWrites ? (
                      <Button
                        type="button"
                        onClick={() => {
                          void runRevoke(row.id);
                        }}
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      ) : null}
    </>
  );
}
