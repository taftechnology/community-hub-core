import { Button } from "@community-hub/ui";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

const COMMUNITY_STORAGE_KEY = "community-hub.community";

type CommunityContextValue = {
  slug: string;
  version: number;
  setSlug: (slug: string) => void;
  refresh: () => void;
};

const CommunityContext = createContext<CommunityContextValue>({
  slug: "",
  version: 0,
  setSlug: () => {},
  refresh: () => {},
});

export function useCommunity(): CommunityContextValue {
  return useContext(CommunityContext);
}

function readStoredSlug(): string {
  try {
    const value = sessionStorage.getItem(COMMUNITY_STORAGE_KEY);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

export function CommunityProvider({ children }: { children: ReactNode }) {
  const [slug, setSlugState] = useState<string>(() => readStoredSlug());
  const [version, setVersion] = useState<number>(0);

  function setSlug(nextSlug: string): void {
    setSlugState(nextSlug);
    setVersion((v) => v + 1);
    try {
      sessionStorage.setItem(COMMUNITY_STORAGE_KEY, nextSlug);
    } catch {
      // Throwing sessionStorage means no crash
    }
  }

  function refresh(): void {
    setVersion((v) => v + 1);
  }

  return (
    <CommunityContext.Provider value={{ slug, version, setSlug, refresh }}>
      {children}
    </CommunityContext.Provider>
  );
}

export function CommunityPicker() {
  const { slug, setSlug } = useCommunity();
  const [draft, setDraft] = useState(slug);

  useEffect(() => {
    setDraft(slug);
  }, [slug]);

  return (
    <form
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setSlug(draft.trim());
      }}
    >
      <label htmlFor="community-picker-input">
        Community
        <input
          id="community-picker-input"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
      </label>
      <Button type="submit">Set</Button>
    </form>
  );
}
