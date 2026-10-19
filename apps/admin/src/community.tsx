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
  setSlug: (slug: string) => void;
};

const CommunityContext = createContext<CommunityContextValue>({
  slug: "",
  setSlug: () => {},
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

  function setSlug(nextSlug: string): void {
    setSlugState(nextSlug);
    try {
      sessionStorage.setItem(COMMUNITY_STORAGE_KEY, nextSlug);
    } catch {
      // Throwing sessionStorage means no crash
    }
  }

  return (
    <CommunityContext.Provider value={{ slug, setSlug }}>
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
