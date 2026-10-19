import { useEffect, useState } from "react";
import { Link } from "react-router";

import { post } from "./api";
import { useCommunity } from "./community";
import { directoryOrigins, readAccessToken } from "./directory";

type ModuleKey = {
  key: string;
  enabled: boolean;
};

type Notice = "forbidden" | "rejected" | "unavailable";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readModules(value: unknown): { keys: ModuleKey[]; canManage: boolean } | undefined {
  if (!isRecord(value) || !Array.isArray(value.keys)) {
    return undefined;
  }
  return {
    keys: value.keys.flatMap((item) => {
      if (!isRecord(item) || typeof item.key !== "string" || typeof item.enabled !== "boolean") {
        return [];
      }
      return [{ key: item.key, enabled: item.enabled }];
    }),
    canManage: value.canManage === true,
  };
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
  if (response.status === 400) {
    return "rejected";
  }
  if (response.status === 200) {
    return "ok";
  }
  return "unavailable";
}

export function ModuleTogglesPage() {
  const [token, setToken] = useState(() => readAccessToken());
  const { slug, version } = useCommunity();
  const [modules, setModules] = useState<ModuleKey[] | undefined>(undefined);
  const [canManage, setCanManage] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const origins = directoryOrigins();

  function show(outcome: Notice | "signed-out"): void {
    if (outcome === "signed-out") {
      setToken(null);
      setModules(undefined);
      return;
    }
    setNotice(outcome);
  }

  async function load(
    communitySlug: string,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const response = await post("/v1/entitlements/list", { communitySlug });
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
      const parsed = readModules(body);
      if (parsed === undefined) {
        setNotice("unavailable");
        return;
      }
      setNotice(undefined);
      setModules(parsed.keys);
      setCanManage(parsed.canManage);
    } catch {
      if (!isCurrent()) {
        return;
      }
      setNotice("unavailable");
    }
  }

  useEffect(() => {
    let current = true;
    setModules(undefined);
    setCanManage(false);
    setNotice(undefined);
    if (slug) {
      void load(slug, () => current);
    }
    return () => {
      current = false;
    };
  }, [slug, version]);

  async function turn(key: string, enabled: boolean): Promise<void> {
    const response = await post("/v1/entitlements/toggle", {
      communitySlug: slug,
      key,
      enabled,
    });
    const outcome = outcomeOf(response);
    if (outcome !== "ok") {
      show(outcome);
      return;
    }
    setNotice(undefined);
    setModules((current) => current?.map((row) => (row.key === key ? { key, enabled } : row)));
  }

  if (origins === undefined) {
    return (
      <>
        <h1>Module Toggles</h1>
        <p>Directory unavailable</p>
      </>
    );
  }

  if (token === null) {
    return (
      <>
        <h1>Module Toggles</h1>
        <p>Sign in required</p>
        <Link to="/sign-in">Sign in</Link>
      </>
    );
  }

  return (
    <>
      <h1>Module Toggles</h1>
      {notice === "forbidden" ? <p>You cannot manage modules</p> : null}
      {notice === "rejected" ? <p>That change was rejected</p> : null}
      {notice === "unavailable" ? <p>Directory unavailable</p> : null}
      {modules === undefined ? null : modules.length === 0 ? (
        <p>No modules are allocated.</p>
      ) : (
        <ul>
          {modules.map((row) => (
            <li key={row.key}>
              {canManage ? (
                <label>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={row.enabled}
                    onChange={(event) => {
                      void turn(row.key, event.target.checked);
                    }}
                  />
                  {row.key}
                </label>
              ) : (
                row.key
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
