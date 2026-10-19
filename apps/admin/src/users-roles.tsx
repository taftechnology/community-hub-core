import { Button } from "@community-hub/ui";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { post } from "./api";
import { useCommunity } from "./community";
import { directoryOrigins, readAccessToken } from "./directory";

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

function grantLine(grant: GrantView): string {
  const role = grant.roleKey ?? grant.customRoleKey ?? "";
  return `${grant.userId} ${role}`.trim();
}

type Outcome = "ok" | Notice | "signed-out";

function outcomeOf(response: Response | "unavailable"): Outcome {
  if (response === "unavailable") {
    return "unavailable";
  }
  if (response.status === 401) {
    return "signed-out";
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
  const [directory, setDirectory] = useState<Directory | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("");
  const [personId, setPersonId] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const origins = directoryOrigins();
  const generation = useRef(0);

  function show(outcome: Notice | "signed-out"): void {
    if (outcome === "signed-out") {
      setToken(null);
      setDirectory(undefined);
      return;
    }
    setNotice(outcome);
  }

  async function load(
    communitySlug: string,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const response = await post("/v1/access/grants/list", { communitySlug });
    if (!isCurrent()) {
      return;
    }
    const outcome = outcomeOf(response);
    if (outcome !== "ok" || response === "unavailable") {
      if (!isCurrent()) {
        return;
      }
      show(outcome === "ok" ? "unavailable" : outcome);
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
        <h1>Users & Roles</h1>
        <p>Directory unavailable</p>
      </>
    );
  }

  if (token === null) {
    return (
      <>
        <h1>Users & Roles</h1>
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

  return (
    <>
      <h1>Users & Roles</h1>
      {notice === "forbidden" ? <p>You cannot manage roles</p> : null}
      {notice === "conflict" ? <p>That change was rejected</p> : null}
      {notice === "unavailable" ? <p>Directory unavailable</p> : null}
      {directory === undefined ? null : (
        <>
          {directory.grants.length === 0 ? (
            <p>No role grants</p>
          ) : (
            <ul>
              {directory.grants.map((grant) => (
                <li key={grant.grantId}>
                  <span>{grantLine(grant)}</span>
                  {canManageRoles ? (
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
              ))}
            </ul>
          )}
          {directory.customRoles.length === 0 ? null : (
            <ul>
              {directory.customRoles.map((customRole) => (
                <li key={customRole.customRoleId}>
                  <span>
                    {customRole.key} {customRole.permissions.join(" ")}
                  </span>
                  {canManageRoles ? (
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
          )}
          {directory.builtIn.length === 0 ? null : (
            <ul>
              {directory.builtIn.map((builtIn) => (
                <li key={builtIn.roleKey}>
                  {builtIn.roleKey} {builtIn.permissions.join(" ")}
                </li>
              ))}
            </ul>
          )}
          {directory.userLinks.length === 0 ? null : (
            <ul>
              {directory.userLinks.map((link) => (
                <li key={link.userId}>
                  {link.userId} {link.personId}
                </li>
              ))}
            </ul>
          )}
          {limitReached ? <p>Custom role limit reached</p> : null}
          {limitReached || !canManageRoles ? null : (
            <form
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                void mutate("/v1/access/custom-roles", {
                  communitySlug: slug,
                  key: customKey,
                  permissions: [...selected],
                });
              }}
            >
              <label>
                Custom role key
                <input
                  value={customKey}
                  onChange={(event) => {
                    setCustomKey(event.target.value);
                  }}
                />
              </label>
              {directory.catalogue.map((permission) => (
                <label key={permission}>
                  <input
                    type="checkbox"
                    checked={selected.has(permission)}
                    onChange={() => {
                      toggle(permission);
                    }}
                  />
                  {permission}
                </label>
              ))}
              <Button type="submit">Create custom role</Button>
            </form>
          )}
          {canManageRoles ? (
            <form
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
              <label>
                User
                <input
                  value={userId}
                  onChange={(event) => {
                    setUserId(event.target.value);
                  }}
                />
              </label>
              <label>
                Role
                <input
                  value={role}
                  onChange={(event) => {
                    setRole(event.target.value);
                  }}
                />
              </label>
              <Button type="submit">Grant</Button>
            </form>
          ) : null}
          {canManageUsers ? (
            <form
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                void mutate("/v1/access/user-links", {
                  communitySlug: slug,
                  userId,
                  personId,
                });
              }}
            >
              <label>
                Person
                <input
                  value={personId}
                  onChange={(event) => {
                    setPersonId(event.target.value);
                  }}
                />
              </label>
              <Button type="submit">Link</Button>
              <Button
                type="button"
                onClick={() => {
                  void mutate("/v1/access/user-links/delete", { communitySlug: slug, userId });
                }}
              >
                Unlink
              </Button>
            </form>
          ) : null}
        </>
      )}
    </>
  );
}
