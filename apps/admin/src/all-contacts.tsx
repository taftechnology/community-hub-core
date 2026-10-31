import {
  Alert,
  Button,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@community-hub/ui";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { post } from "./api";
import { useBillingStatus } from "./billing-status";
import { useCommunity } from "./community";
import { readAccessToken } from "./directory";
import { usePeopleAccess } from "./people-access";

type ContactItem = {
  id: string;
  personId: string;
  isMinor: boolean;
  givenName: string;
  familyName: string;
  version: number;
};

type ListResponse = {
  items: ContactItem[];
  nextCursor: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseContactItem(item: unknown): ContactItem | null {
  if (!isRecord(item)) {
    return null;
  }
  const id =
    typeof item.id === "string"
      ? item.id
      : typeof item.personId === "string"
        ? item.personId
        : null;
  const personId = typeof item.personId === "string" ? item.personId : id;
  const givenName = typeof item.givenName === "string" ? item.givenName : "";
  const familyName = typeof item.familyName === "string" ? item.familyName : "";
  const isMinor = Boolean(item.isMinor);
  const version = typeof item.version === "number" ? item.version : 1;

  if (!id || !personId) {
    return null;
  }

  return { id, personId, isMinor, givenName, familyName, version };
}

function parseListResponse(value: unknown): ListResponse | null {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return null;
  }
  const items: ContactItem[] = [];
  for (const item of value.items) {
    const parsed = parseContactItem(item);
    if (parsed !== null) {
      items.push(parsed);
    }
  }
  const nextCursor = typeof value.nextCursor === "string" ? value.nextCursor : null;
  return { items, nextCursor };
}

export function AllContactsPage() {
  const token = readAccessToken();
  const { slug, version } = useCommunity();
  const { access } = usePeopleAccess();
  const { status, readiness, refresh: refreshBilling } = useBillingStatus();

  const [activeTab, setActiveTab] = useState<"adults" | "minors">("adults");
  const [searchDraft, setSearchDraft] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const [items, setItems] = useState<ContactItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [paymentRequired, setPaymentRequired] = useState(false);

  const generation = useRef(0);
  const isReadOnly = status?.state === "none" || status?.state === "read_only" || paymentRequired;
  const hideWrites = readiness === "loading" || isReadOnly;

  const fetchContacts = useCallback(
    async (
      communitySlug: string,
      kind: "adults" | "minors",
      searchTerm: string,
      cursorToken: string | undefined,
      isCurrent: () => boolean,
    ) => {
      setLoading(true);
      setError(false);

      const body: Record<string, unknown> = {
        communitySlug,
        kind,
      };
      if (searchTerm) {
        body.search = searchTerm;
      }
      if (cursorToken) {
        body.cursor = cursorToken;
      }

      const response = await post("/v1/people/list", body);
      if (!isCurrent()) {
        return;
      }
      setLoading(false);

      if (response === "unavailable") {
        setError(true);
        return;
      }

      if (response.status === 402) {
        setPaymentRequired(true);
        void refreshBilling();
        return;
      }

      if (response.status !== 200) {
        setError(true);
        return;
      }

      try {
        const data: unknown = await response.json();
        if (!isCurrent()) {
          return;
        }
        const parsed = parseListResponse(data);
        if (parsed === null) {
          setError(true);
          return;
        }
        setItems(parsed.items);
        setNextCursor(parsed.nextCursor);
      } catch {
        if (!isCurrent()) {
          return;
        }
        setError(true);
      }
    },
    [refreshBilling],
  );

  const reload = useCallback(() => {
    if (!slug) {
      setItems(null);
      return;
    }
    const mine = ++generation.current;
    void fetchContacts(slug, activeTab, submittedSearch, cursor, () => generation.current === mine);
  }, [slug, activeTab, submittedSearch, cursor, fetchContacts]);

  useEffect(() => {
    reload();
  }, [reload, version]);

  function handleTabChange(tab: "adults" | "minors") {
    setActiveTab(tab);
    setCursor(undefined);
    setItems(null);
  }

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmittedSearch(searchDraft.trim());
    setCursor(undefined);
  }

  function handleNextPage(token: string) {
    setCursor(token);
  }

  if (token === null) {
    return (
      <>
        <h1>All Contacts</h1>
        <p>Sign in required</p>
        <Link to="/sign-in">Sign in</Link>
      </>
    );
  }

  if (!access.directoryEnabled || (!access.canView && !access.canManage)) {
    return (
      <>
        <h1>All Contacts</h1>
        <Alert live="polite">Not allowed</Alert>
      </>
    );
  }

  return (
    <>
      <h1>All Contacts</h1>

      {isReadOnly ? (
        <Alert live="polite">
          <span>Read-only until billing is settled</span>{" "}
          <Link to="/settings/general">General Settings</Link>
        </Alert>
      ) : null}

      <div role="tablist" aria-label="Contact types">
        <Button
          type="button"
          role="tab"
          aria-selected={activeTab === "adults"}
          variant={activeTab === "adults" ? "default" : "outline"}
          onClick={() => handleTabChange("adults")}
        >
          Adults
        </Button>
        {access.canReadMinors ? (
          <Button
            type="button"
            role="tab"
            aria-selected={activeTab === "minors"}
            variant={activeTab === "minors" ? "default" : "outline"}
            onClick={() => handleTabChange("minors")}
          >
            Minors
          </Button>
        ) : null}
      </div>

      <form onSubmit={handleSearchSubmit}>
        <label htmlFor="contact-search-input">
          Search contacts
          <Input
            id="contact-search-input"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
          />
        </label>
        <Button type="submit">Search</Button>
      </form>

      {error ? (
        <Alert variant="destructive" live="assertive">
          <span>Failed to load contacts</span>
          <Button type="button" onClick={() => reload()}>
            Retry
          </Button>
        </Alert>
      ) : null}

      {!loading && !error && items !== null ? (
        items.length === 0 ? (
          submittedSearch ? (
            <p>No contacts match</p>
          ) : (
            <div>
              <p>No contacts yet</p>
              {access.canManage && !hideWrites ? <Button type="button">Add contact</Button> : null}
            </div>
          )
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Given name</TableHead>
                  <TableHead scope="col">Family name</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((person) => (
                  <TableRow key={person.id}>
                    <TableCell>{person.givenName}</TableCell>
                    <TableCell>{person.familyName}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {nextCursor !== null ? (
              <Button type="button" onClick={() => handleNextPage(nextCursor)}>
                Next page
              </Button>
            ) : null}
          </>
        )
      ) : null}
    </>
  );
}
