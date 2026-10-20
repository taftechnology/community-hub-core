import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { type BillingStatus, post } from "./api";
import { useCommunity } from "./community";

export type BillingStatusContextValue = {
  status: BillingStatus | null;
  refresh: () => Promise<void>;
  returnMessage: string | null;
};

export const BillingStatusContext = createContext<BillingStatusContextValue>({
  status: null,
  refresh: async () => {},
  returnMessage: null,
});

export function useBillingStatus(): BillingStatusContextValue {
  return useContext(BillingStatusContext);
}

function isBillingStatus(value: unknown): value is BillingStatus {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.state === "string";
}

function readAndStripBillingParam(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("billing")) {
      return null;
    }
    const billing = url.searchParams.get("billing");
    url.searchParams.delete("billing");
    const nextSearch = url.searchParams.toString();
    const nextUrl =
      url.pathname + (nextSearch ? `?${nextSearch}` : "") + url.hash;
    window.history.replaceState(window.history.state, "", nextUrl);
    return billing;
  } catch {
    return null;
  }
}

export function BillingStatusProvider({ children }: { children: ReactNode }) {
  const { slug, version } = useCommunity();
  const [stored, setStored] = useState<{ key: string; status: BillingStatus } | null>(null);
  const currentKey = `${slug ?? ""}|${version}`;
  const status = stored && stored.key === currentKey ? stored.status : null;

  const [billingParam] = useState(() => readAndStripBillingParam());
  const [returnMessage, setReturnMessage] = useState<string | null>(() => {
    if (billingParam === "done") {
      return "Payment received, your plan will appear shortly";
    }
    if (billingParam === "cancelled") {
      return "Checkout was cancelled";
    }
    return null;
  });
  const slugRef = useRef(slug);
  const versionRef = useRef(version);
  const generation = useRef(0);
  const portalRefreshed = useRef(false);

  useEffect(() => {
    slugRef.current = slug;
    versionRef.current = version;
  }, [slug, version]);

  const loadStatus = useCallback(
    async (
      communitySlug: string,
      requestKey: string,
      isCurrent: () => boolean = () => true,
    ): Promise<void> => {
      const response = await post("/v1/billing/status", { communitySlug });
      if (!isCurrent()) {
        return;
      }
      if (response === "unavailable" || response.status !== 200) {
        if (!isCurrent()) {
          return;
        }
        setStored(null);
        return;
      }
      try {
        const body: unknown = await response.json();
        if (!isCurrent()) {
          return;
        }
        if (isBillingStatus(body)) {
          setStored({ key: requestKey, status: body });
        } else {
          setStored(null);
        }
      } catch {
        if (!isCurrent()) {
          return;
        }
        setStored(null);
      }
    },
    [],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const currentSlug = slugRef.current;
    if (!currentSlug) {
      return;
    }
    const mine = generation.current;
    const reqKey = `${currentSlug}|${versionRef.current}`;
    await loadStatus(currentSlug, reqKey, () => generation.current === mine);
  }, [loadStatus]);

  const lastCommunity = useRef<string | null>(null);

  useEffect(() => {
    const mine = ++generation.current;
    setStored(null);
    const key = `${slug ?? ""}|${version}`;
    if (lastCommunity.current !== null && lastCommunity.current !== key) {
      setReturnMessage(null);
    }
    lastCommunity.current = key;
    if (!slug) {
      return;
    }
    void loadStatus(slug, key, () => generation.current === mine);
  }, [slug, version, loadStatus]);

  useEffect(() => {
    if (billingParam === "done") {
      const mine = generation.current;
      const timer = setTimeout(async () => {
        const currentSlug = slugRef.current;
        if (!currentSlug || generation.current !== mine) {
          return;
        }
        const reqKey = `${currentSlug}|${versionRef.current}`;
        await loadStatus(currentSlug, reqKey, () => generation.current === mine);
        if (generation.current === mine) {
          setReturnMessage(null);
        }
      }, 5000);
      return () => clearTimeout(timer);
    }
    if (billingParam === "portal" && !portalRefreshed.current) {
      portalRefreshed.current = true;
      void refresh();
    }
  }, [billingParam, refresh, loadStatus]);

  return (
    <BillingStatusContext.Provider value={{ status, refresh, returnMessage }}>
      {children}
    </BillingStatusContext.Provider>
  );
}
