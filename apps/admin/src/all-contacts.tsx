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

type PersonDetail = {
  personId: string;
  householdId: string | null;
  isMinor: boolean;
  ageBasis: string;
  birthdayMd: number | null;
  givenName: string;
  familyName: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  version: number;
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

function parsePersonDetail(value: unknown): PersonDetail | null {
  if (!isRecord(value) || typeof value.personId !== "string") {
    return null;
  }
  return {
    personId: value.personId,
    householdId: typeof value.householdId === "string" ? value.householdId : null,
    isMinor: Boolean(value.isMinor),
    ageBasis: typeof value.ageBasis === "string" ? value.ageBasis : "",
    birthdayMd: typeof value.birthdayMd === "number" ? value.birthdayMd : null,
    givenName: typeof value.givenName === "string" ? value.givenName : "",
    familyName: typeof value.familyName === "string" ? value.familyName : "",
    email: typeof value.email === "string" ? value.email : null,
    phone: typeof value.phone === "string" ? value.phone : null,
    dateOfBirth: typeof value.dateOfBirth === "string" ? value.dateOfBirth : null,
    version: typeof value.version === "number" ? value.version : 1,
  };
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

  // View state: "list" | "detail" | "add" | "edit"
  const [view, setView] = useState<"list" | "detail" | "add" | "edit">("list");
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [detailPerson, setDetailPerson] = useState<PersonDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailNotFound, setDetailNotFound] = useState(false);
  const [detailError, setDetailError] = useState(false);

  // Add form fields
  const [addGivenName, setAddGivenName] = useState("");
  const [addFamilyName, setAddFamilyName] = useState("");
  const [addEmail, setAddEmail] = useState("");
  const [addPhone, setAddPhone] = useState("");
  const [addDob, setAddDob] = useState("");
  const [addNotice, setAddNotice] = useState<string | null>(null);

  // Edit form fields
  const [editGivenName, setEditGivenName] = useState("");
  const [editFamilyName, setEditFamilyName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editDob, setEditDob] = useState("");
  const [editConflict, setEditConflict] = useState(false);
  const [editNotice, setEditNotice] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const generation = useRef(0);
  const detailGeneration = useRef(0);
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
      if (kind === "adults" && searchTerm) {
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
        setItems(null);
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
    if (!slug || !access.directoryEnabled || !access.canView) {
      setItems(null);
      return;
    }
    const mine = ++generation.current;
    void fetchContacts(slug, activeTab, submittedSearch, cursor, () => generation.current === mine);
  }, [
    slug,
    access.directoryEnabled,
    access.canView,
    activeTab,
    submittedSearch,
    cursor,
    fetchContacts,
  ]);

  const previousSlugRef = useRef<string | null>(null);
  useEffect(() => {
    if (previousSlugRef.current === null) {
      previousSlugRef.current = slug;
      reload();
      return;
    }
    if (previousSlugRef.current !== slug) {
      previousSlugRef.current = slug;
      setActiveTab("adults");
      setSearchDraft("");
      setSubmittedSearch("");
      setCursor(undefined);
      setNextCursor(null);
      setItems(null);
      setView("list");
      setSelectedPersonId(null);
      setDetailPerson(null);
      setDetailNotFound(false);
      setDetailError(false);
      setAddGivenName("");
      setAddFamilyName("");
      setAddEmail("");
      setAddPhone("");
      setAddDob("");
      setAddNotice(null);
      setEditGivenName("");
      setEditFamilyName("");
      setEditEmail("");
      setEditPhone("");
      setEditDob("");
      setEditConflict(false);
      setEditNotice(null);
      setPaymentRequired(false);
      setError(false);
      if (slug && access.directoryEnabled && access.canView) {
        const mine = ++generation.current;
        void fetchContacts(slug, "adults", "", undefined, () => generation.current === mine);
      }
      return;
    }
    reload();
  }, [slug, version, reload, access.directoryEnabled, access.canView, fetchContacts]);

  const loadPersonDetail = useCallback(
    async (communitySlug: string, personId: string, isCurrent: () => boolean) => {
      setDetailLoading(true);
      setDetailNotFound(false);
      setDetailError(false);

      const response = await post("/v1/people/read", { communitySlug, personId });
      if (!isCurrent()) {
        return;
      }
      setDetailLoading(false);

      if (response === "unavailable") {
        setDetailError(true);
        return;
      }

      if (response.status === 404) {
        setDetailNotFound(true);
        return;
      }

      if (response.status !== 200) {
        setDetailError(true);
        return;
      }

      try {
        const data: unknown = await response.json();
        if (!isCurrent()) {
          return;
        }
        const parsed = parsePersonDetail(data);
        if (parsed === null) {
          setDetailError(true);
          return;
        }
        setDetailPerson(parsed);
      } catch {
        if (!isCurrent()) {
          return;
        }
        setDetailError(true);
      }
    },
    [],
  );

  function openDetail(personId: string) {
    setSelectedPersonId(personId);
    setDetailPerson(null);
    setView("detail");
    if (slug) {
      const mine = ++detailGeneration.current;
      void loadPersonDetail(slug, personId, () => detailGeneration.current === mine);
    }
  }

  function reloadDetail() {
    if (slug && selectedPersonId) {
      const mine = ++detailGeneration.current;
      setEditConflict(false);
      void loadPersonDetail(slug, selectedPersonId, () => detailGeneration.current === mine);
    }
  }

  function openAdd() {
    setAddGivenName("");
    setAddFamilyName("");
    setAddEmail("");
    setAddPhone("");
    setAddDob("");
    setAddNotice(null);
    setView("add");
  }

  function openEdit(person: PersonDetail) {
    setEditGivenName(person.givenName);
    setEditFamilyName(person.familyName);
    setEditEmail(person.email ?? "");
    setEditPhone(person.phone ?? "");
    setEditDob(person.dateOfBirth ?? "");
    setEditConflict(false);
    setEditNotice(null);
    setView("edit");
  }

  function backToList() {
    setView("list");
    setSelectedPersonId(null);
    setDetailPerson(null);
    reload();
  }

  async function handleAddSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current || !slug) {
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setAddNotice(null);

    try {
      const body: Record<string, unknown> = {
        communitySlug: slug,
        givenName: addGivenName.trim(),
        familyName: addFamilyName.trim(),
      };
      if (addEmail.trim()) {
        body.email = addEmail.trim();
      }
      if (addPhone.trim()) {
        body.phone = addPhone.trim();
      }
      if (addDob.trim()) {
        body.dateOfBirth = addDob.trim();
      }

      const response = await post("/v1/people/create", body);
      if (response === "unavailable" || response.status === 402) {
        if (response !== "unavailable" && response.status === 402) {
          setPaymentRequired(true);
          void refreshBilling();
        }
        setAddNotice("Unable to save contact");
        return;
      }

      if (response.status === 201) {
        backToList();
        return;
      }

      setAddNotice("Unable to save contact");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function handleEditSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current || !slug || !detailPerson) {
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setEditConflict(false);
    setEditNotice(null);

    try {
      const body: Record<string, unknown> = {
        communitySlug: slug,
        personId: detailPerson.personId,
        version: detailPerson.version,
        givenName: editGivenName.trim(),
        familyName: editFamilyName.trim(),
        email: editEmail.trim() || null,
        phone: editPhone.trim() || null,
        dateOfBirth: editDob.trim() || null,
      };

      const response = await post("/v1/people/update", body);
      if (response === "unavailable") {
        setEditNotice("Unable to save changes");
        return;
      }

      if (response.status === 409) {
        setEditConflict(true);
        return;
      }

      if (response.status === 404) {
        setDetailNotFound(true);
        setView("detail");
        return;
      }

      if (response.status === 200) {
        openDetail(detailPerson.personId);
        return;
      }

      setEditNotice("Unable to save changes");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function handleTabChange(tab: "adults" | "minors") {
    setActiveTab(tab);
    setCursor(undefined);
    setSearchDraft("");
    setSubmittedSearch("");
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

  if (!access.directoryEnabled || !access.canView) {
    return (
      <>
        <h1>All Contacts</h1>
        <Alert live="polite">Not allowed</Alert>
      </>
    );
  }

  if (view === "detail") {
    return (
      <>
        <h1>All Contacts</h1>
        <h2>Contact Details</h2>

        <Button type="button" onClick={backToList}>
          Back to list
        </Button>

        {detailLoading ? <p>Loading contact details...</p> : null}

        {detailNotFound ? (
          <Alert live="polite">
            <span>Contact not found</span>
          </Alert>
        ) : null}

        {detailError ? (
          <Alert variant="destructive" live="assertive">
            <span>Failed to load contact</span>
            <Button type="button" onClick={reloadDetail}>
              Retry
            </Button>
          </Alert>
        ) : null}

        {!detailLoading && !detailNotFound && !detailError && detailPerson ? (
          <div>
            <p>
              <strong>Given name:</strong> {detailPerson.givenName}
            </p>
            <p>
              <strong>Family name:</strong> {detailPerson.familyName}
            </p>
            <p>
              <strong>Email:</strong> {detailPerson.email ?? "None"}
            </p>
            <p>
              <strong>Phone:</strong> {detailPerson.phone ?? "None"}
            </p>
            <p>
              <strong>Date of birth:</strong> {detailPerson.dateOfBirth ?? "None"}
            </p>
            <p>
              <strong>Version:</strong> {detailPerson.version}
            </p>

            {!detailPerson.isMinor && access.canManage && !hideWrites ? (
              <Button type="button" onClick={() => openEdit(detailPerson)}>
                Edit contact
              </Button>
            ) : null}
          </div>
        ) : null}
      </>
    );
  }

  if (view === "add") {
    return (
      <>
        <h1>All Contacts</h1>
        <h2>Add Contact</h2>

        {addNotice ? (
          <Alert variant="destructive" live="polite">
            <span>{addNotice}</span>
          </Alert>
        ) : null}

        <form onSubmit={handleAddSubmit}>
          <div>
            <label htmlFor="add-given-name">Given name</label>
            <Input
              id="add-given-name"
              value={addGivenName}
              onChange={(e) => setAddGivenName(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="add-family-name">Family name</label>
            <Input
              id="add-family-name"
              value={addFamilyName}
              onChange={(e) => setAddFamilyName(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="add-email">Email</label>
            <Input
              id="add-email"
              type="email"
              value={addEmail}
              onChange={(e) => setAddEmail(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="add-phone">Phone</label>
            <Input
              id="add-phone"
              type="tel"
              value={addPhone}
              onChange={(e) => setAddPhone(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="add-dob">Date of birth</label>
            <Input
              id="add-dob"
              type="date"
              value={addDob}
              onChange={(e) => setAddDob(e.target.value)}
            />
          </div>

          <div>
            <Button type="submit" disabled={submitting}>
              Save contact
            </Button>
            <Button type="button" variant="outline" onClick={backToList}>
              Cancel
            </Button>
          </div>
        </form>
      </>
    );
  }

  if (view === "edit") {
    return (
      <>
        <h1>All Contacts</h1>
        <h2>Edit Contact</h2>

        {editConflict ? (
          <Alert live="polite">
            <span>A conflict occurred while saving. Please reload.</span>
            <Button type="button" onClick={reloadDetail}>
              Reload
            </Button>
          </Alert>
        ) : null}

        {editNotice ? (
          <Alert variant="destructive" live="polite">
            <span>{editNotice}</span>
          </Alert>
        ) : null}

        <form onSubmit={handleEditSubmit}>
          <div>
            <label htmlFor="edit-given-name">Given name</label>
            <Input
              id="edit-given-name"
              value={editGivenName}
              onChange={(e) => setEditGivenName(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="edit-family-name">Family name</label>
            <Input
              id="edit-family-name"
              value={editFamilyName}
              onChange={(e) => setEditFamilyName(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="edit-email">Email</label>
            <Input
              id="edit-email"
              type="email"
              value={editEmail}
              onChange={(e) => setEditEmail(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="edit-phone">Phone</label>
            <Input
              id="edit-phone"
              type="tel"
              value={editPhone}
              onChange={(e) => setEditPhone(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="edit-dob">Date of birth</label>
            <Input
              id="edit-dob"
              type="date"
              value={editDob}
              onChange={(e) => setEditDob(e.target.value)}
            />
          </div>

          <div>
            <Button type="submit" disabled={submitting}>
              Save changes
            </Button>
            <Button type="button" variant="outline" onClick={() => setView("detail")}>
              Cancel
            </Button>
          </div>
        </form>
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

      {activeTab === "adults" ? (
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
      ) : null}

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
              {access.canManage && !hideWrites && activeTab === "adults" ? (
                <Button type="button" onClick={openAdd}>
                  Add contact
                </Button>
              ) : null}
            </div>
          )
        ) : (
          <>
            {access.canManage && !hideWrites && activeTab === "adults" ? (
              <div>
                <Button type="button" onClick={openAdd}>
                  Add contact
                </Button>
              </div>
            ) : null}

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Given name</TableHead>
                  <TableHead scope="col">Family name</TableHead>
                  <TableHead scope="col">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((person) => (
                  <TableRow key={person.id}>
                    <TableCell>{person.givenName}</TableCell>
                    <TableCell>{person.familyName}</TableCell>
                    <TableCell>
                      <Button type="button" variant="outline" onClick={() => openDetail(person.id)}>
                        View
                      </Button>
                    </TableCell>
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
