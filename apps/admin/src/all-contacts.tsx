import {
  Alert,
  Avatar,
  Button,
  DataTable,
  DescriptionList,
  EmptyState,
  Field,
  FilterBar,
  Input,
  Pagination,
  Panel,
  Skeleton,
} from "@community-hub/ui";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { post } from "./api";
import { useBillingStatus } from "./billing-status";
import { useCommunity } from "./community";
import { readAccessToken } from "./directory";
import { usePeopleAccess } from "./people-access";
import { ScreenTitle } from "./screen-title";

type ContactItem = {
  id: string;
  givenName: string;
  familyName: string;
};

type ListResponse = {
  items: ContactItem[];
  nextCursor: string | null;
};

type PersonDetail = {
  personId: string;
  isMinor: boolean;
  isAdultConfirmed: boolean;
  givenName: string;
  familyName: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  version: number;
};

type ContactFormData = {
  givenName: string;
  familyName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
};

const initialFormData: ContactFormData = {
  givenName: "",
  familyName: "",
  email: "",
  phone: "",
  dateOfBirth: "",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseContactItem(item: unknown): ContactItem | null {
  if (!isRecord(item) || typeof item.id !== "string") {
    return null;
  }
  return {
    id: item.id,
    givenName: typeof item.givenName === "string" ? item.givenName : "",
    familyName: typeof item.familyName === "string" ? item.familyName : "",
  };
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
    isMinor: Boolean(value.isMinor),
    isAdultConfirmed: value.isMinor === false,
    givenName: typeof value.givenName === "string" ? value.givenName : "",
    familyName: typeof value.familyName === "string" ? value.familyName : "",
    email: typeof value.email === "string" ? value.email : null,
    phone: typeof value.phone === "string" ? value.phone : null,
    dateOfBirth: typeof value.dateOfBirth === "string" ? value.dateOfBirth : null,
    version: typeof value.version === "number" ? value.version : 1,
  };
}

function ContactFields({
  prefix,
  data,
  onChange,
}: {
  prefix: "add" | "edit";
  data: ContactFormData;
  onChange: (data: ContactFormData) => void;
}) {
  return (
    <>
      <Field label="Given name">
        <Input
          id={`${prefix}-given-name`}
          value={data.givenName}
          onChange={(e) => onChange({ ...data, givenName: e.target.value })}
          required
        />
      </Field>
      <Field label="Family name">
        <Input
          id={`${prefix}-family-name`}
          value={data.familyName}
          onChange={(e) => onChange({ ...data, familyName: e.target.value })}
          required
        />
      </Field>
      <Field label="Email">
        <Input
          id={`${prefix}-email`}
          type="email"
          value={data.email}
          onChange={(e) => onChange({ ...data, email: e.target.value })}
        />
      </Field>
      <Field label="Phone">
        <Input
          id={`${prefix}-phone`}
          type="tel"
          value={data.phone}
          onChange={(e) => onChange({ ...data, phone: e.target.value })}
        />
      </Field>
      <Field label="Date of birth">
        <Input
          id={`${prefix}-dob`}
          type="date"
          value={data.dateOfBirth}
          onChange={(e) => onChange({ ...data, dateOfBirth: e.target.value })}
        />
      </Field>
    </>
  );
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

  // Add & Edit form fields
  const [addForm, setAddForm] = useState<ContactFormData>(initialFormData);
  const [addNotice, setAddNotice] = useState<string | null>(null);

  const [editForm, setEditForm] = useState<ContactFormData>(initialFormData);
  const [editConflict, setEditConflict] = useState(false);
  const [editNotice, setEditNotice] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const addHeadingRef = useRef<HTMLHeadingElement>(null);
  const editHeadingRef = useRef<HTMLHeadingElement>(null);
  const addAlertRef = useRef<HTMLDivElement>(null);
  const editAlertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (view === "list") {
      listHeadingRef.current?.focus();
    } else if (view === "detail") {
      detailHeadingRef.current?.focus();
    } else if (view === "add") {
      addHeadingRef.current?.focus();
    } else if (view === "edit") {
      editHeadingRef.current?.focus();
    }
  }, [view]);

  useEffect(() => {
    if (addNotice) {
      addAlertRef.current?.focus();
    }
  }, [addNotice]);

  useEffect(() => {
    if (editNotice || editConflict) {
      editAlertRef.current?.focus();
    }
  }, [editNotice, editConflict]);

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
    [],
  );

  const reload = useCallback(() => {
    const mine = ++generation.current;
    if (!slug || !access.entitlements["people.directory"] || !access.permissions["people.view"]) {
      return;
    }
    setError(false);
    void fetchContacts(slug, activeTab, submittedSearch, cursor, () => generation.current === mine);
  }, [
    slug,
    activeTab,
    submittedSearch,
    cursor,
    fetchContacts,
    access.entitlements["people.directory"],
    access.permissions["people.view"],
  ]);

  const previousSlugRef = useRef(slug);
  useEffect(() => {
    if (!slug) {
      setItems(null);
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
      detailGeneration.current += 1;
      setDetailNotFound(false);
      setDetailError(false);
      setAddForm(initialFormData);
      setAddNotice(null);
      setEditForm(initialFormData);
      setEditConflict(false);
      setEditNotice(null);
      setPaymentRequired(false);
      setError(false);
      submittingRef.current = false;
      setSubmitting(false);
      if (slug && access.entitlements["people.directory"] && access.permissions["people.view"]) {
        const mine = ++generation.current;
        void fetchContacts(slug, "adults", "", undefined, () => generation.current === mine);
      }
      return;
    }
    if (!access.entitlements["people.directory"] || !access.permissions["people.view"]) {
      return;
    }
    reload();
  }, [
    slug,
    version,
    reload,
    access.entitlements["people.directory"],
    access.permissions["people.view"],
    fetchContacts,
  ]);

  const loadPersonDetail = useCallback(
    async (
      communitySlug: string,
      personId: string,
      isCurrent: () => boolean,
      options?: { syncEditForm?: boolean },
    ) => {
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
        if (options?.syncEditForm) {
          setEditForm({
            givenName: parsed.givenName,
            familyName: parsed.familyName,
            email: parsed.email || "",
            phone: parsed.phone || "",
            dateOfBirth: parsed.dateOfBirth || "",
          });
          setEditConflict(false);
          setView("edit");
        }
      } catch {
        if (!isCurrent()) {
          return;
        }
        setDetailError(true);
      }
    },
    [],
  );

  const openDetail = useCallback(
    (personId: string) => {
      setSelectedPersonId(personId);
      setView("detail");
      setDetailPerson(null);
      const mine = ++detailGeneration.current;
      if (slug) {
        void loadPersonDetail(slug, personId, () => detailGeneration.current === mine);
      }
    },
    [slug, loadPersonDetail],
  );

  function reloadDetail() {
    if (selectedPersonId && slug) {
      const mine = ++detailGeneration.current;
      const syncEditForm = view === "edit";
      void loadPersonDetail(slug, selectedPersonId, () => detailGeneration.current === mine, {
        syncEditForm,
      });
    }
  }

  function openAdd() {
    setAddNotice(null);
    setView("add");
  }

  function openEdit(person: PersonDetail) {
    setEditForm({
      givenName: person.givenName,
      familyName: person.familyName,
      email: person.email || "",
      phone: person.phone || "",
      dateOfBirth: person.dateOfBirth || "",
    });
    setEditConflict(false);
    setEditNotice(null);
    setView("edit");
  }

  function backToList() {
    setAddForm(initialFormData);
    setEditForm(initialFormData);
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
        givenName: addForm.givenName.trim(),
        familyName: addForm.familyName.trim(),
      };
      if (addForm.email.trim()) {
        body.email = addForm.email.trim();
      }
      if (addForm.phone.trim()) {
        body.phone = addForm.phone.trim();
      }
      if (addForm.dateOfBirth.trim()) {
        body.dateOfBirth = addForm.dateOfBirth.trim();
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
        givenName: editForm.givenName.trim(),
        familyName: editForm.familyName.trim(),
        email: editForm.email.trim() || null,
        phone: editForm.phone.trim() || null,
        dateOfBirth: editForm.dateOfBirth.trim() || null,
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
    if (tab === activeTab) {
      return;
    }
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
        <ScreenTitle>All Contacts</ScreenTitle>
        <p>Sign in required</p>
        <Link to="/sign-in">Sign in</Link>
      </>
    );
  }

  if (!access.entitlements["people.directory"] || !access.permissions["people.view"]) {
    return (
      <>
        <ScreenTitle>All Contacts</ScreenTitle>
        <Alert live="polite">Not allowed</Alert>
      </>
    );
  }

  if (view === "detail") {
    const detailLoaded = !detailLoading && !detailNotFound && !detailError && detailPerson !== null;
    const canShowAvatar = detailLoaded && detailPerson.isAdultConfirmed;
    const canShowEdit =
      detailLoaded && !detailPerson.isMinor && access.permissions["people.manage"] && !hideWrites;
    const hasDetailActions = canShowAvatar || canShowEdit;

    return (
      <>
        <ScreenTitle>All Contacts</ScreenTitle>
        <Button type="button" className="justify-self-start self-start" onClick={backToList}>
          Back to list
        </Button>

        <Panel
          title="Contact Details"
          level={2}
          headingRef={detailHeadingRef}
          headingTabIndex={-1}
          actions={
            hasDetailActions ? (
              <div className="flex items-center gap-2">
                {canShowAvatar ? (
                  <Avatar name={`${detailPerson.givenName} ${detailPerson.familyName}`} />
                ) : null}
                {canShowEdit ? (
                  <Button type="button" onClick={() => openEdit(detailPerson)}>
                    Edit contact
                  </Button>
                ) : null}
              </div>
            ) : undefined
          }
        >
          {detailLoading ? (
            <>
              <Skeleton />
              <span className="sr-only">Loading contact details...</span>
            </>
          ) : null}

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

          {detailLoaded ? (
            <DescriptionList
              items={[
                { term: "Given name:", value: detailPerson.givenName },
                { term: "Family name:", value: detailPerson.familyName },
                {
                  term: "Email:",
                  value: detailPerson.email ?? <span className="text-muted-foreground">None</span>,
                },
                {
                  term: "Phone:",
                  value: detailPerson.phone ?? <span className="text-muted-foreground">None</span>,
                },
                {
                  term: "Date of birth:",
                  value: detailPerson.dateOfBirth ?? (
                    <span className="text-muted-foreground">None</span>
                  ),
                },
              ]}
            />
          ) : null}
        </Panel>
      </>
    );
  }

  if (view === "add") {
    return (
      <>
        <ScreenTitle>All Contacts</ScreenTitle>
        <Panel title="Add Contact" level={2} headingRef={addHeadingRef} headingTabIndex={-1}>
          {addNotice ? (
            <Alert ref={addAlertRef} tabIndex={-1} variant="destructive" role="alert">
              <span>{addNotice}</span>
            </Alert>
          ) : null}

          <form onSubmit={handleAddSubmit} className="grid gap-4">
            <ContactFields prefix="add" data={addForm} onChange={setAddForm} />

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={submitting}>
                Save contact
              </Button>
              <Button type="button" variant="outline" onClick={backToList}>
                Cancel
              </Button>
            </div>
          </form>
        </Panel>
      </>
    );
  }

  if (view === "edit") {
    return (
      <>
        <ScreenTitle>All Contacts</ScreenTitle>
        <Panel title="Edit Contact" level={2} headingRef={editHeadingRef} headingTabIndex={-1}>
          {editConflict ? (
            <Alert ref={editAlertRef} tabIndex={-1} role="alert">
              <span>
                This contact was changed by someone else, or that email or phone is already in use.
                Reload to see the latest details; your unsaved changes will be discarded.
              </span>
              <Button type="button" onClick={reloadDetail}>
                Reload
              </Button>
            </Alert>
          ) : null}

          {editNotice ? (
            <Alert ref={editAlertRef} tabIndex={-1} variant="destructive" role="alert">
              <span>{editNotice}</span>
            </Alert>
          ) : null}

          <form onSubmit={handleEditSubmit} className="grid gap-4">
            <ContactFields prefix="edit" data={editForm} onChange={setEditForm} />

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={submitting}>
                Save changes
              </Button>
              <Button type="button" variant="outline" onClick={() => setView("detail")}>
                Cancel
              </Button>
            </div>
          </form>
        </Panel>
      </>
    );
  }

  return (
    <>
      <ScreenTitle ref={listHeadingRef}>All Contacts</ScreenTitle>

      {isReadOnly ? (
        <Alert live="polite">
          <span>Read-only until billing is settled</span>{" "}
          <Link to="/settings/general">General Settings</Link>
        </Alert>
      ) : null}

      <div role="group" aria-label="Contact types" className="flex flex-wrap gap-2">
        <Button
          type="button"
          aria-pressed={activeTab === "adults"}
          variant={activeTab === "adults" ? "default" : "outline"}
          onClick={() => handleTabChange("adults")}
        >
          Adults
        </Button>
        {access.permissions["people.restricted.read"] ? (
          <Button
            type="button"
            aria-pressed={activeTab === "minors"}
            variant={activeTab === "minors" ? "default" : "outline"}
            onClick={() => handleTabChange("minors")}
          >
            Minors
          </Button>
        ) : null}
      </div>

      <Panel
        actions={
          !loading &&
          !error &&
          items !== null &&
          access.permissions["people.manage"] &&
          !hideWrites &&
          activeTab === "adults" &&
          (!submittedSearch || items.length > 0) ? (
            <Button type="button" onClick={openAdd}>
              Add contact
            </Button>
          ) : undefined
        }
        footer={
          !loading && !error && items !== null && items.length > 0 && nextCursor !== null ? (
            <Pagination cursor={nextCursor} onNext={handleNextPage} />
          ) : undefined
        }
      >
        {activeTab === "adults" ? (
          <FilterBar
            label="Search contacts"
            inputId="contact-search-input"
            value={searchDraft}
            onValueChange={setSearchDraft}
            onSubmit={handleSearchSubmit}
          />
        ) : null}

        {error ? (
          <Alert variant="destructive" live="assertive">
            <span>Failed to load contacts</span>
            <Button type="button" onClick={() => reload()}>
              Retry
            </Button>
          </Alert>
        ) : null}

        {loading ? <Skeleton /> : null}

        {!loading && !error && items !== null ? (
          items.length === 0 ? (
            <EmptyState message={submittedSearch ? "No contacts match" : "No contacts yet"} />
          ) : (
            <DataTable
              aria-label="Contacts"
              rowKey={(person) => person.id}
              columns={[
                {
                  key: "givenName",
                  header: "Given name",
                  primary: true,
                  render: (person) =>
                    activeTab === "adults" ? (
                      <span className="flex items-center gap-2">
                        <Avatar name={`${person.givenName} ${person.familyName}`} />
                        <span>{person.givenName}</span>
                      </span>
                    ) : (
                      person.givenName
                    ),
                },
                {
                  key: "familyName",
                  header: "Family name",
                  render: (person) => person.familyName,
                },
                {
                  key: "actions",
                  header: "Actions",
                  render: (person) => (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`View ${person.givenName} ${person.familyName}`}
                      onClick={() => openDetail(person.id)}
                    >
                      View
                    </Button>
                  ),
                },
              ]}
              rows={items}
            />
          )
        ) : null}
      </Panel>
    </>
  );
}
