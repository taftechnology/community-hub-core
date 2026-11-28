import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { post } from "./api";
import { useCommunity } from "./community";

export type PeopleAccess = {
  permissions: {
    "people.view": boolean;
    "people.manage": boolean;
    "people.restricted.read": boolean;
    "people.delete": boolean;
    "service_times.manage": boolean;
  };
  entitlements: {
    "people.directory": boolean;
    "people.households": boolean;
    "module.engagement": boolean;
  };
  // Which role the caller holds here, as the service answers it. A Community Admin is the only
  // caller who sees children, and no permission says so: an organisation admin holds the same keys.
  roles: {
    communityAdmin: boolean;
  };
};

export const defaultAccess: PeopleAccess = {
  permissions: {
    "people.view": false,
    "people.manage": false,
    "people.restricted.read": false,
    "people.delete": false,
    "service_times.manage": false,
  },
  entitlements: {
    "people.directory": false,
    "people.households": false,
    "module.engagement": false,
  },
  roles: {
    communityAdmin: false,
  },
};

export type PeopleAccessContextValue = {
  access: PeopleAccess;
};

export const PeopleAccessContext = createContext<PeopleAccessContextValue>({
  access: defaultAccess,
});

export function usePeopleAccess(): PeopleAccessContextValue {
  return useContext(PeopleAccessContext);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseAccess(value: unknown): PeopleAccess {
  if (!isRecord(value)) {
    return defaultAccess;
  }
  const perms = isRecord(value.permissions) ? value.permissions : {};
  const ents = isRecord(value.entitlements) ? value.entitlements : {};
  const roles = isRecord(value.roles) ? value.roles : {};
  return {
    permissions: {
      "people.view": perms["people.view"] === true,
      "people.manage": perms["people.manage"] === true,
      "people.restricted.read": perms["people.restricted.read"] === true,
      "people.delete": perms["people.delete"] === true,
      "service_times.manage": perms["service_times.manage"] === true,
    },
    entitlements: {
      "people.directory": ents["people.directory"] === true,
      "people.households": ents["people.households"] === true,
      "module.engagement": ents["module.engagement"] === true,
    },
    roles: {
      communityAdmin: roles.communityAdmin === true,
    },
  };
}

export function PeopleAccessProvider({ children }: { children: ReactNode }) {
  const { slug, version } = useCommunity();
  const [access, setAccess] = useState<PeopleAccess>(defaultAccess);
  const generation = useRef(0);

  const loadAccess = useCallback(
    async (communitySlug: string, isCurrent: () => boolean): Promise<void> => {
      if (!communitySlug) {
        setAccess(defaultAccess);
        return;
      }
      const response = await post("/v1/access/capabilities", { communitySlug });
      if (!isCurrent()) {
        return;
      }
      if (response === "unavailable" || response.status !== 200) {
        setAccess(defaultAccess);
        return;
      }
      try {
        const body: unknown = await response.json();
        if (!isCurrent()) {
          return;
        }
        setAccess(parseAccess(body));
      } catch {
        if (!isCurrent()) {
          return;
        }
        setAccess(defaultAccess);
      }
    },
    [],
  );

  useEffect(() => {
    const mine = ++generation.current;
    if (!slug) {
      setAccess(defaultAccess);
      return;
    }
    void loadAccess(slug, () => generation.current === mine);
  }, [slug, version, loadAccess]);

  return <PeopleAccessContext.Provider value={{ access }}>{children}</PeopleAccessContext.Provider>;
}
