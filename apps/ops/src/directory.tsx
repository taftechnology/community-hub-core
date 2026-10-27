import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Alert, Button } from "@community-hub/ui";

import { useAuthState } from "./auth-state.js";
import { useFocusHeading } from "./focus.js";
import {
  DIRECTORY_COLUMN_COMMUNITIES,
  DIRECTORY_COLUMN_KIND,
  DIRECTORY_COLUMN_ORGANISATION,
  DIRECTORY_COLUMN_REGION,
  DIRECTORY_EMPTY_MESSAGE,
  DIRECTORY_FORBIDDEN_MESSAGE,
  DIRECTORY_HEADING,
  DIRECTORY_LOAD_ERROR_MESSAGE,
  DIRECTORY_LOADING_MESSAGE,
  DIRECTORY_TABLE_CAPTION,
  DIRECTORY_TRUNCATED_MESSAGE,
  TRY_AGAIN_BUTTON_LABEL,
} from "./messages.js";
import type { SessionClient } from "./session.js";

export type DirectoryCommunity = {
  id: string;
  slug: string;
};

export type DirectoryOrganisation = {
  id: string;
  slug: string;
  kind: string;
  region: string;
  communities: DirectoryCommunity[];
};

export type DirectoryData = {
  organisations: DirectoryOrganisation[];
  truncated: boolean;
};

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null;
}

export function isDirectoryResponse(value: unknown): value is DirectoryData {
  if (!isObject(value)) return false;
  if (typeof value.truncated !== "boolean") return false;
  if (!Array.isArray(value.organisations)) return false;
  for (const org of value.organisations) {
    if (!isObject(org)) return false;
    if (typeof org.id !== "string") return false;
    if (typeof org.slug !== "string") return false;
    if (typeof org.kind !== "string") return false;
    if (typeof org.region !== "string") return false;
    if (!Array.isArray(org.communities)) return false;
    for (const comm of org.communities) {
      if (!isObject(comm)) return false;
      if (typeof comm.id !== "string") return false;
      if (typeof comm.slug !== "string") return false;
    }
  }
  return true;
}

export type DirectoryProps = {
  sessionClient?: SessionClient;
};

type DirectoryState =
  | { status: "loading" }
  | { status: "loaded"; data: DirectoryData }
  | { status: "forbidden" }
  | { status: "failed" };

export function Directory({ sessionClient: propSessionClient }: DirectoryProps = {}) {
  const auth = useAuthState();
  const sessionClient = propSessionClient ?? auth.sessionClient;
  const { ended } = auth;
  const navigate = useNavigate();
  useFocusHeading();

  const [state, setState] = useState<DirectoryState>({ status: "loading" });

  const loadDirectory = useCallback(async () => {
    if (!sessionClient) {
      setState({ status: "failed" });
      return;
    }
    setState({ status: "loading" });
    const res = await sessionClient.authedGet("/v1/ops/directory");
    if (res.kind === "ended") {
      ended();
      void navigate("/sign-in");
      return;
    }
    if (res.kind === "response") {
      if (res.status === 200 && isDirectoryResponse(res.body)) {
        setState({ status: "loaded", data: res.body });
        return;
      }
      if (res.status === 403) {
        setState({ status: "forbidden" });
        return;
      }
    }
    setState({ status: "failed" });
  }, [sessionClient, ended, navigate]);

  useEffect(() => {
    void loadDirectory();
  }, [loadDirectory]);

  return (
    <div className="flex flex-col gap-4">
      <h1 tabIndex={-1} className="text-2xl font-bold tracking-tight text-foreground outline-none">
        {DIRECTORY_HEADING}
      </h1>
      {state.status === "loading" && (
        <p role="status" className="text-sm text-muted-foreground">
          {DIRECTORY_LOADING_MESSAGE}
        </p>
      )}
      {state.status === "forbidden" && (
        <Alert role="alert" variant="destructive">
          {DIRECTORY_FORBIDDEN_MESSAGE}
        </Alert>
      )}
      {state.status === "failed" && (
        <div className="flex flex-col gap-4">
          <Alert role="alert" variant="destructive">
            {DIRECTORY_LOAD_ERROR_MESSAGE}
          </Alert>
          <div>
            <Button type="button" onClick={() => void loadDirectory()}>
              {TRY_AGAIN_BUTTON_LABEL}
            </Button>
          </div>
        </div>
      )}
      {state.status === "loaded" && (
        <>
          {state.data.truncated && (
            <p className="text-sm text-muted-foreground">{DIRECTORY_TRUNCATED_MESSAGE}</p>
          )}
          {state.data.organisations.length === 0 ? (
            <p className="text-sm text-muted-foreground">{DIRECTORY_EMPTY_MESSAGE}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">{DIRECTORY_TABLE_CAPTION}</caption>
                <thead className="border-b border-border text-xs uppercase text-muted-foreground">
                  <tr>
                    <th scope="col" className="py-2 pr-4">
                      {DIRECTORY_COLUMN_ORGANISATION}
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      {DIRECTORY_COLUMN_KIND}
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      {DIRECTORY_COLUMN_REGION}
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      {DIRECTORY_COLUMN_COMMUNITIES}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {state.data.organisations.map((org) => (
                    <tr key={org.slug}>
                      <td className="py-2 pr-4 font-medium text-foreground">{org.slug}</td>
                      <td className="py-2 pr-4 text-foreground">{org.kind}</td>
                      <td className="py-2 pr-4 text-foreground">{org.region}</td>
                      <td className="py-2 pr-4 text-foreground">
                        {org.communities.length > 0 && (
                          <ul className="list-inside list-disc">
                            {org.communities.map((c) => (
                              <li key={c.slug}>{c.slug}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
