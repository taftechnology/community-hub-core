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
  const [status, setStatus] = useState<BillingStatus | null>(null);
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
  const generation = useRef(0);
  const portalRefreshed = useRef(false);

  useEffect(() => {
    slugRef.current = slug;
  }, [slug]);

  const loadStatus = useCallback(
    async (
      communitySlug: string,
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
        setStatus(null);
        return;
      }
      try {
        const body: unknown = await response.json();
        if (!isCurrent()) {
          return;
        }
        if (isBillingStatus(body)) {
          setStatus(body);
        } else {
          setStatus(null);
        }
      } catch {
        if (!isCurrent()) {
          return;
        }
        setStatus(null);
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
    await loadStatus(currentSlug, () => generation.current === mine);
  }, [loadStatus]);

  const isInitialMount = useRef(true);

  useEffect(() => {
    const mine = ++generation.current;
    setStatus(null);
    if (!isInitialMount.current) {
      setReturnMessage(null);
    }
    isInitialMount.current = false;
    if (!slug) {
      return;
    }
    void loadStatus(slug, () => generation.current === mine);
  }, [slug, version, loadStatus]);

  useEffect(() => {
    if (billingParam === "done") {
      const mine = generation.current;
      const timer = setTimeout(async () => {
        const currentSlug = slugRef.current;
        if (!currentSlug || generation.current !== mine) {
          return;
        }
        await loadStatus(currentSlug, () => generation.current === mine);
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
