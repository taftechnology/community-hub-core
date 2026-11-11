import { Alert, Button, Checkbox, Field, Input, Panel } from "@community-hub/ui";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { post } from "./api";
import { useBillingStatus } from "./billing-status";
import { useCommunity } from "./community";
import { directoryOrigins, readAccessToken } from "./directory";
import { roleLabel } from "./role-labels";
import { ScreenTitle } from "./screen-title";

type UserNameView = {
  given: string;
  family: string;
};

type UserDetailView = {
  userId: string;
  personId: string | null;
  name: UserNameView | null;
  email: string | null;
  phone: string | null;
  minor: boolean;
};

type UsersView = {
  phoneVisible: boolean;
  users: UserDetailView[];
};

type GrantView = {
  grantId: string;
  scope: string;
  userId: string;
  roleKey: string | null;
  customRoleId: string | null;
  customRoleKey: string | null;
};

type CustomRoleView = {
  customRoleId: string;
  key: string;
  permissions: string[];
};

type BuiltInView = {
  roleKey: string;
  permissions: string[];
};

type UserLinkView = {
  userId: string;
  personId: string;
};

type Directory = {
  grants: GrantView[];
  customRoles: CustomRoleView[];
  catalogue: string[];
  builtIn: BuiltInView[];
  userLinks: UserLinkView[];
  permissions: string[];
};

type Notice = "forbidden" | "conflict" | "unavailable";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function readGrant(value: unknown): GrantView | undefined {
  if (!isRecord(value) || typeof value.grantId !== "string" || typeof value.userId !== "string") {
    return undefined;
  }
  return {
    grantId: value.grantId,
    scope: typeof value.scope === "string" ? value.scope : "",
    userId: value.userId,
    roleKey: textOrNull(value.roleKey),
    customRoleId: textOrNull(value.customRoleId),
    customRoleKey: textOrNull(value.customRoleKey),
  };
}

function readCustomRole(value: unknown): CustomRoleView | undefined {
  if (!isRecord(value) || typeof value.customRoleId !== "string" || typeof value.key !== "string") {
    return undefined;
  }
  return {
    customRoleId: value.customRoleId,
    key: value.key,
    permissions: readStrings(value.permissions),
  };
}

function readBuiltIn(value: unknown): BuiltInView | undefined {
  if (!isRecord(value) || typeof value.roleKey !== "string") {
    return undefined;
  }
  return { roleKey: value.roleKey, permissions: readStrings(value.permissions) };
}

function readLink(value: unknown): UserLinkView | undefined {
  if (!isRecord(value) || typeof value.userId !== "string" || typeof value.personId !== "string") {
    return undefined;
  }
  return { userId: value.userId, personId: value.personId };
}

function readDirectory(value: unknown): Directory | undefined {
  if (!isRecord(value) || !Array.isArray(value.grants)) {
    return undefined;
  }
  return {
    grants: value.grants.flatMap((grant) => {
      const read = readGrant(grant);
      return read === undefined ? [] : [read];
    }),
    customRoles: Array.isArray(value.customRoles)
      ? value.customRoles.flatMap((role) => {
          const read = readCustomRole(role);
          return read === undefined ? [] : [read];
        })
      : [],
    catalogue: readStrings(value.catalogue),
    builtIn: Array.isArray(value.builtIn)
      ? value.builtIn.flatMap((role) => {
          const read = readBuiltIn(role);
          return read === undefined ? [] : [read];
        })
      : [],
    userLinks: Array.isArray(value.userLinks)
      ? value.userLinks.flatMap((link) => {
          const read = readLink(link);
          return read === undefined ? [] : [read];
        })
      : [],
    permissions: readStrings(value.permissions),
  };
}

function readUserName(value: unknown): UserNameView | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value) || typeof value.given !== "string" || typeof value.family !== "string") {
    return undefined;
  }
  return { given: value.given, family: value.family };
}

function readUserItem(value: unknown): UserDetailView | undefined {
  if (!isRecord(value) || typeof value.userId !== "string" || typeof value.minor !== "boolean") {
    return undefined;
  }
  if (value.personId !== null && typeof value.personId !== "string") {
    return undefined;
  }
  if (value.email !== null && typeof value.email !== "string") {
    return undefined;
  }
  if (value.phone !== null && typeof value.phone !== "string") {
    return undefined;
  }
  const name = readUserName(value.name);
  if (name === undefined) {
    return undefined;
  }
  return {
    userId: value.userId,
    personId: value.personId,
    name: value.minor ? null : name,
    email: value.minor ? null : value.email,
    phone: value.minor ? null : value.phone,
    minor: value.minor,
  };
}

function readUsers(value: unknown): UsersView | undefined {
  if (!isRecord(value) || typeof value.phoneVisible !== "boolean" || !Array.isArray(value.users)) {
    return undefined;
  }
  const users: UserDetailView[] = [];
  for (const item of value.users) {
    const read = readUserItem(item);
    if (read === undefined) {
      return undefined;
    }
    users.push(read);
  }
  return {
    phoneVisible: value.phoneVisible,
    users,
  };
}

function renderUserDetails(
  userId: string,
  user: UserDetailView | undefined,
  phoneVisible: boolean,
) {
  if (user === undefined) {
    return null;
  }
  if (user.minor) {
    return (
      <>
        <span>Details hidden</span>
        <span className="text-xs text-muted-foreground">{userId}</span>
      </>
    );
  }
  const nameText = user.name
    ? `${user.name.given} ${user.name.family}`
    : user.personId === null
      ? "No contact linked"
      : "";
  const emailText = user.email ?? "No sign-in account";
  const phoneText = user.phone ?? "—";

  return (
    <>
      {nameText ? <span>{nameText}</span> : null}
      <span>
        <span className="sr-only">Email: </span>
        {emailText}
      </span>
      {phoneVisible ? (
        <span>
          <span className="sr-only">Phone: </span>
          {phoneText}
        </span>
      ) : null}
      <span className="text-xs text-muted-foreground">{userId}</span>
    </>
  );
}

function grantLine(grant: GrantView): string {
  const role = roleLabel(grant.roleKey ?? grant.customRoleKey ?? "");
  return `${grant.userId} ${role}`.trim();
}

type Outcome = "ok" | Notice | "signed-out" | "payment-required";

function outcomeOf(response: Response | "unavailable"): Outcome {
  if (response === "unavailable") {
    return "unavailable";
  }
  if (response.status === 401) {
    return "signed-out";
  }
  if (response.status === 402) {
    return "payment-required";
  }
  if (response.status === 403) {
    return "forbidden";
  }
  if (response.status === 409) {
    return "conflict";
  }
  if (response.status === 200) {
    return "ok";
  }
  return "unavailable";
}

export function UsersRolesPage() {
  const [token, setToken] = useState(() => readAccessToken());
  const { slug, version } = useCommunity();
  const { status, readiness, refresh } = useBillingStatus();
  const [readOnlyBlocked, setReadOnlyBlocked] = useState(false);
  const [directory, setDirectory] = useState<Directory | undefined>(undefined);
  const [users, setUsers] = useState<UsersView | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [usersMessage, setUsersMessage] = useState<string | undefined>(undefined);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("");
  const [personId, setPersonId] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const origins = directoryOrigins();
  const generation = useRef(0);

  const isReadOnly = status?.state === "none" || status?.state === "read_only" || readOnlyBlocked;
  const hideWrites = readiness === "loading" || isReadOnly;

  function show(outcome: Notice | "signed-out"): void {
    if (outcome === "signed-out") {
      setToken(null);
      setDirectory(undefined);
      setUsers(undefined);
      setUsersMessage(undefined);
      return;
    }
    setNotice(outcome);
  }

  async function load(communitySlug: string, isCurrent: () => boolean = () => true): Promise<void> {
    const response = await post("/v1/access/grants/list", { communitySlug });
    if (!isCurrent()) {
      return;
    }
    const outcome = outcomeOf(response);
    if (outcome !== "ok" || response === "unavailable") {
      if (!isCurrent()) {
        return;
      }
      show(outcome === "ok" || outcome === "payment-required" ? "unavailable" : outcome);
      return;
    }
    try {
      const body: unknown = await response.json();
      if (!isCurrent()) {
        return;
      }
      const parsed = readDirectory(body);
      if (parsed === undefined) {
        setNotice("unavailable");
        return;
      }
      setNotice(undefined);
      setDirectory(parsed);

      if (!parsed.permissions.includes("access.users.view")) {
        setUsers(undefined);
        setUsersMessage(undefined);
        return;
      }

      const usersResponse = await post("/v1/access/users/list", { communitySlug });
      if (!isCurrent()) {
        return;
      }

      if (usersResponse === "unavailable") {
        setUsers(undefined);
        setUsersMessage("Details unavailable. Try again.");
        return;
      }

      if (usersResponse.status === 401) {
        show("signed-out");
        return;
      }

      if (usersResponse.status === 403) {
        setUsers(undefined);
        setUsersMessage(undefined);
        return;
      }

      if (usersResponse.status === 409) {
        setUsers(undefined);
        setUsersMessage("Too many users to show details");
        return;
      }

      if (usersResponse.status !== 200) {
        setUsers(undefined);
        setUsersMessage("Details unavailable. Try again.");
        return;
      }

      try {
        const usersBody: unknown = await usersResponse.json();
        if (!isCurrent()) {
          return;
        }

        const parsedUsers = readUsers(usersBody);
        if (parsedUsers === undefined) {
          setUsers(undefined);
          setUsersMessage("Details unavailable. Try again.");
          return;
        }

        setUsers(parsedUsers);
        setUsersMessage(undefined);
      } catch {
        if (!isCurrent()) {
          return;
        }
        setUsers(undefined);
        setUsersMessage("Details unavailable. Try again.");
      }
    } catch {
      if (!isCurrent()) {
        return;
      }
      setNotice("unavailable");
    }
  }

  useEffect(() => {
    const mine = ++generation.current;
    setDirectory(undefined);
    setNotice(undefined);
    setUsers(undefined);
    setUsersMessage(undefined);
    setReadOnlyBlocked(false);
    if (slug) {
      void load(slug, () => generation.current === mine);
    }
  }, [slug, version]);

  async function mutate(path: string, body: unknown): Promise<void> {
    const mine = generation.current;
    const isCurrent = () => generation.current === mine;
    const response = await post(path, body);
    if (!isCurrent()) {
      return;
    }
    const outcome = outcomeOf(response);
    if (outcome === "payment-required") {
      setReadOnlyBlocked(true);
      setNotice(undefined);
      void refresh();
      return;
    }
    if (outcome !== "ok") {
      show(outcome);
      return;
    }
    await load(slug, isCurrent);
  }

  function toggle(permission: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(permission)) {
        next.delete(permission);
      } else {
        next.add(permission);
      }
      return next;
    });
  }

  if (origins === undefined) {
    return (
      <>
        <ScreenTitle>Users & Roles</ScreenTitle>
        <p>Directory unavailable</p>
      </>
    );
  }

  if (token === null) {
    return (
      <>
        <ScreenTitle>Users & Roles</ScreenTitle>
        <p>Sign in required</p>
        <Link to="/sign-in">Sign in</Link>
      </>
    );
  }

  const limitReached = directory !== undefined && directory.customRoles.length >= 20;
  const canManageRoles =
    directory !== undefined && directory.permissions.includes("access.roles.manage");
  const canManageUsers =
    directory !== undefined && directory.permissions.includes("access.users.manage");

  const usersById = new Map((users?.users ?? []).map((user) => [user.userId, user]));
  const phoneVisible = users?.phoneVisible ?? false;

  return (
    <>
      <ScreenTitle>Users & Roles</ScreenTitle>
      {isReadOnly ? (
        <Alert live="polite">
          <span>Read-only until billing is settled</span>{" "}
          <Link to="/settings/general">General Settings</Link>
        </Alert>
      ) : null}
      {notice === "forbidden" ? <p>You cannot manage roles</p> : null}
      {notice === "conflict" ? <p>That change was rejected</p> : null}
      {notice === "unavailable" ? <p>Directory unavailable</p> : null}
      {usersMessage ? <p>{usersMessage}</p> : null}
      {directory === undefined ? null : (
        <>
          {directory.grants.length === 0 ? (
            <Panel>
              <p>No role grants</p>
            </Panel>
          ) : (
            <Panel>
              <ul>
                {directory.grants.map((grant) => {
                  const user = usersById.get(grant.userId);
                  const roleText = roleLabel(grant.roleKey ?? grant.customRoleKey ?? "");
                  return (
                    <li key={grant.grantId} className="flex flex-wrap items-center gap-2">
                      {user ? (
                        <>
                          {renderUserDetails(grant.userId, user, phoneVisible)}
                          <span>{roleText}</span>
                        </>
                      ) : (
                        <span>{grantLine(grant)}</span>
                      )}
                      {canManageRoles && !hideWrites ? (
                        <Button
                          type="button"
                          onClick={() => {
                            void mutate("/v1/access/grants/revoke", {
                              communitySlug: slug,
                              grantId: grant.grantId,
                              scope: grant.scope === "community" ? "community" : "organisation",
                            });
                          }}
                        >
                          Revoke
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </Panel>
          )}
          {directory.customRoles.length === 0 ? null : (
            <Panel>
              <ul>
                {directory.customRoles.map((customRole) => (
                  <li key={customRole.customRoleId} className="flex flex-wrap items-center gap-2">
                    <span>
                      {customRole.key} {customRole.permissions.join(" ")}
                    </span>
                    {canManageRoles && !hideWrites ? (
                      <Button
                        type="button"
                        onClick={() => {
                          void mutate("/v1/access/custom-roles/delete", {
                            communitySlug: slug,
                            customRoleId: customRole.customRoleId,
                          });
                        }}
                      >
                        Delete custom role
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          {directory.builtIn.length === 0 ? null : (
            <Panel>
              <ul>
                {directory.builtIn.map((builtIn) => (
                  <li key={builtIn.roleKey} className="flex flex-wrap items-center gap-2">
                    {roleLabel(builtIn.roleKey)} {builtIn.permissions.join(" ")}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          {directory.userLinks.length === 0 ? null : (
            <Panel>
              <ul>
                {directory.userLinks.map((link) => {
                  const user = usersById.get(link.userId);
                  return (
                    <li key={link.userId} className="flex flex-wrap items-center gap-2">
                      {user ? (
                        renderUserDetails(link.userId, user, phoneVisible)
                      ) : (
                        <>
                          {link.userId} {link.personId}
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Panel>
          )}
          {limitReached ? <p>Custom role limit reached</p> : null}
          {limitReached || !canManageRoles || hideWrites ? null : (
            <Panel>
              <form
                className="grid gap-4"
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  void mutate("/v1/access/custom-roles", {
                    communitySlug: slug,
                    key: customKey,
                    permissions: [...selected],
                  });
                }}
              >
                <Field label="Custom role key">
                  <Input
                    value={customKey}
                    onChange={(event) => {
                      setCustomKey(event.target.value);
                    }}
                  />
                </Field>
                {directory.catalogue.map((permission) => (
                  <Checkbox
                    key={permission}
                    label={permission}
                    checked={selected.has(permission)}
                    onChange={() => {
                      toggle(permission);
                    }}
                  />
                ))}
                <Button className="justify-self-start" type="submit">
                  Create custom role
                </Button>
              </form>
            </Panel>
          )}
          {canManageRoles && !hideWrites ? (
            <Panel>
              <form
                className="grid gap-4"
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  const custom = directory.customRoles.find((item) => item.key === role);
                  void mutate(
                    "/v1/access/grants",
                    custom === undefined
                      ? { communitySlug: slug, userId, roleKey: role }
                      : { communitySlug: slug, userId, customRoleId: custom.customRoleId },
                  );
                }}
              >
                <Field label="User">
                  <Input
                    value={userId}
                    onChange={(event) => {
                      setUserId(event.target.value);
                    }}
                  />
                </Field>
                <Field label="Role">
                  <Input
                    value={role}
                    onChange={(event) => {
                      setRole(event.target.value);
                    }}
                  />
                </Field>
                <Button className="justify-self-start" type="submit">
                  Grant
                </Button>
              </form>
            </Panel>
          ) : null}
          {canManageUsers && !hideWrites ? (
            <Panel>
              <form
                className="grid gap-4"
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  void mutate("/v1/access/user-links", {
                    communitySlug: slug,
                    userId,
                    personId,
                  });
                }}
              >
                <Field label="Person">
                  <Input
                    value={personId}
                    onChange={(event) => {
                      setPersonId(event.target.value);
                    }}
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit">Link</Button>
                  <Button
                    type="button"
                    onClick={() => {
                      void mutate("/v1/access/user-links/delete", { communitySlug: slug, userId });
                    }}
                  >
                    Unlink
                  </Button>
                </div>
              </form>
            </Panel>
          ) : null}
        </>
      )}
    </>
  );
}
