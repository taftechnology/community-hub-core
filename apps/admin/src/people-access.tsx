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
  directoryEnabled: boolean;
  canView: boolean;
  canManage: boolean;
  canReadMinors: boolean;
};

const defaultAccess: PeopleAccess = {
  directoryEnabled: false,
  canView: false,
  canManage: false,
  canReadMinors: false,
};

export type PeopleAccessContextValue = {
  access: PeopleAccess;
  refresh: () => Promise<void>;
};

export const PeopleAccessContext = createContext<PeopleAccessContextValue>({
  access: defaultAccess,
  refresh: async () => {},
});

export function usePeopleAccess(): PeopleAccessContextValue {
  return useContext(PeopleAccessContext);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseAccess(value: unknown): PeopleAccess {
  if (!isRecord(value)) {
    return defaultAccess;
  }
  return {
    directoryEnabled: value.directoryEnabled === true,
    canView: value.canView === true,
    canManage: value.canManage === true,
    canReadMinors: value.canReadMinors === true,
  };
}

export function PeopleAccessProvider({ children }: { children: ReactNode }) {
  const { slug, version } = useCommunity();
  const [access, setAccess] = useState<PeopleAccess>(defaultAccess);
  const generation = useRef(0);
  const slugRef = useRef(slug);
  slugRef.current = slug;

  const loadAccess = useCallback(
    async (communitySlug: string, isCurrent: () => boolean): Promise<void> => {
      if (!communitySlug) {
        setAccess(defaultAccess);
        return;
      }
      const response = await post("/v1/people/access", { communitySlug });
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

  const refresh = useCallback(async (): Promise<void> => {
    const currentSlug = slugRef.current;
    if (!currentSlug) {
      setAccess(defaultAccess);
      return;
    }
    const mine = generation.current;
    await loadAccess(currentSlug, () => generation.current === mine);
  }, [loadAccess]);

  useEffect(() => {
    const mine = ++generation.current;
    if (!slug) {
      setAccess(defaultAccess);
      return;
    }
    void loadAccess(slug, () => generation.current === mine);
  }, [slug, version, loadAccess]);

  return (
    <PeopleAccessContext.Provider value={{ access, refresh }}>
      {children}
    </PeopleAccessContext.Provider>
  );
}
